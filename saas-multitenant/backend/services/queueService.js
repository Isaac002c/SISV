'use strict';

const os = require('node:os');
const pool = require('../config/db');
const automation = require('./automationService');
const sla = require('./slaService');

const workerId = `${os.hostname()}:${process.pid}`;

async function claimNext(client = pool, id = workerId) {
  const result = await client.query(
    `WITH candidate AS (
       SELECT id FROM internal_queue_jobs
        WHERE status='pending' AND next_attempt_at<=NOW()
        ORDER BY priority DESC,created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE internal_queue_jobs j
        SET status='processing',locked_by=$1,locked_at=NOW(),started_at=NOW(),
            attempts=attempts+1,updated_at=NOW()
       FROM candidate c WHERE j.id=c.id
     RETURNING j.*`,
    [String(id).slice(0, 120)]
  );
  return result.rows[0] || null;
}

async function processJob(job) {
  if (job.job_type === 'automation') {
    return automation.dispatchEvent(job.tenant_id, job.payload, job.idempotency_key);
  }
  if (job.job_type === 'sla_evaluation') {
    return sla.evaluateDue(job.tenant_id);
  }
  // Tipos reservados existem na fila, mas so sao executados quando um handler
  // seguro for implementado. Falhar e mais seguro que descartar silenciosamente.
  throw new Error(`Handler indisponivel para ${job.job_type}.`);
}

async function complete(job, result) {
  const duration = job.started_at ? Date.now() - new Date(job.started_at).getTime() : null;
  await pool.query(
    `UPDATE internal_queue_jobs SET status='completed',completed_at=NOW(),duration_ms=$1,
            error_summary=NULL,locked_by=NULL,locked_at=NULL,updated_at=NOW(),
            payload=jsonb_build_object(
              'event_type',payload->>'event_type',
              'entity_type',payload->>'entity_type',
              'entity_id',payload->>'entity_id',
              'result_summary',$2::jsonb
            )
      WHERE id=$3 AND tenant_id=$4 AND status='processing'`,
    [duration, JSON.stringify({ matched: result?.matched ?? null, status: 'completed' }), job.id, job.tenant_id]
  );
}

async function fail(job, error) {
  const retry = Number(job.attempts) < Number(job.max_attempts);
  const backoffSeconds = Math.min(3600, 5 * (2 ** Math.max(0, Number(job.attempts) - 1)));
  await pool.query(
    `UPDATE internal_queue_jobs SET status=$1,error_summary=$2,
            next_attempt_at=CASE WHEN $1='pending' THEN NOW()+($3 * INTERVAL '1 second') ELSE next_attempt_at END,
            completed_at=CASE WHEN $1='failed' THEN NOW() ELSE NULL END,
            locked_by=NULL,locked_at=NULL,updated_at=NOW()
      WHERE id=$4 AND tenant_id=$5`,
    [
      retry ? 'pending' : 'failed',
      String(error?.message || 'Falha no job').replace(/[\r\n]+/g, ' ').slice(0, 500),
      backoffSeconds, job.id, job.tenant_id,
    ]
  );
}

async function runOnce(id = workerId) {
  const job = await claimNext(pool, id);
  if (!job) return { claimed: false };
  try {
    const result = await processJob(job);
    await complete(job, result);
    return { claimed: true, completed: true, job_id: job.id, result };
  } catch (error) {
    await fail(job, error);
    return { claimed: true, completed: false, job_id: job.id, error: String(error.message).slice(0, 500) };
  }
}

async function listJobs(tenantId, filters = {}) {
  const params = [tenantId];
  const clauses = ['tenant_id=$1'];
  if (filters.status) { params.push(filters.status); clauses.push(`status=$${params.length}`); }
  if (filters.job_type) { params.push(filters.job_type); clauses.push(`job_type=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id,job_type,status,priority,attempts,max_attempts,next_attempt_at,locked_by,locked_at,
            started_at,completed_at,duration_ms,error_summary,idempotency_key,created_at,updated_at,
            jsonb_build_object(
              'event_type',payload->>'event_type',
              'entity_type',payload->>'entity_type',
              'entity_id',payload->>'entity_id',
              'fine_id',payload->>'fine_id'
            ) AS safe_context
       FROM internal_queue_jobs WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

async function monitoring(tenantId) {
  const [jobs, executions] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='processing')::int AS processing,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              ROUND(AVG(duration_ms) FILTER (WHERE status='completed'),1) AS avg_duration_ms
         FROM internal_queue_jobs WHERE tenant_id=$1`,
      [tenantId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              COUNT(*) FILTER (WHERE status='loop_blocked')::int AS loops_blocked,
              ROUND(AVG(duration_ms) FILTER (WHERE status='completed'),1) AS avg_duration_ms
         FROM automation_executions WHERE tenant_id=$1`,
      [tenantId]
    ),
  ]);
  return { jobs: jobs.rows[0], executions: executions.rows[0], worker_strategy: 'postgres_skip_locked' };
}

async function retry(tenantId, userId, id) {
  const result = await pool.query(
    `UPDATE internal_queue_jobs SET status='pending',next_attempt_at=NOW(),completed_at=NULL,
            locked_by=NULL,locked_at=NULL,error_summary=NULL,updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND status='failed' RETURNING *`,
    [id, tenantId]
  );
  if (!result.rows[0]) return { ok: false, status: 409, error: 'Somente tarefa falha pode ser reprocessada.' };
  await pool.query(
    `INSERT INTO governance_audit_events
       (tenant_id,actor_user_id,event_type,entity_type,entity_id,summary,safe_details)
     VALUES($1,$2,'queue_job_retried','queue_job',$3,'Tarefa interna reenfileirada',$4::jsonb)`,
    [tenantId, userId, id, JSON.stringify({ previous_attempts: result.rows[0].attempts })]
  );
  return { ok: true, data: result.rows[0] };
}

async function cancel(tenantId, userId, id) {
  const result = await pool.query(
    `UPDATE internal_queue_jobs SET status='cancelled',completed_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING *`,
    [id, tenantId]
  );
  if (!result.rows[0]) return { ok: false, status: 409, error: 'Somente tarefa pendente pode ser cancelada.' };
  await pool.query(
    `INSERT INTO governance_audit_events
       (tenant_id,actor_user_id,event_type,entity_type,entity_id,summary)
     VALUES($1,$2,'queue_job_cancelled','queue_job',$3,'Tarefa interna cancelada')`,
    [tenantId, userId, id]
  );
  return { ok: true, data: result.rows[0] };
}

module.exports = {
  workerId,
  claimNext,
  processJob,
  complete,
  fail,
  runOnce,
  listJobs,
  monitoring,
  retry,
  cancel,
};
