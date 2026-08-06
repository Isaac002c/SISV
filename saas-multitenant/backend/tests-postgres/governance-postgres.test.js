'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

if (process.env.SISV_POSTGRES_TEST !== '1') {
  throw new Error('tests-postgres so pode executar pelo harness isolado.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  max: 8,
});

let seed;

test.before(async () => {
  const tenant = await pool.query(
    `INSERT INTO tenants(name,slug,developer) VALUES('SISV PG Test','sisv-pg-test','TELUN')
     RETURNING id`
  );
  const otherTenant = await pool.query(
    `INSERT INTO tenants(name,slug,developer) VALUES('SISV Other','sisv-pg-other','TELUN')
     RETURNING id`
  );
  const user = await pool.query(
    `INSERT INTO users(tenant_id,name,email,password_hash,role)
     VALUES($1,'Admin Test','admin@sisv.test','not-a-real-secret','admin') RETURNING id`,
    [tenant.rows[0].id]
  );
  const department = await pool.query(
    `INSERT INTO departments(tenant_id,name) VALUES($1,'Operacao') RETURNING id`,
    [tenant.rows[0].id]
  );
  await pool.query(
    `INSERT INTO process_stages(tenant_id,code,label,sort_order,is_final) VALUES
     ($1,'entrada','Entrada',1,FALSE),($1,'analise','Analise',2,FALSE),
     ($1,'finalizado','Finalizado',3,TRUE)`,
    [tenant.rows[0].id]
  );
  const service = await pool.query(
    `INSERT INTO tenant_service_types(tenant_id,code,label,initial_stage,initial_status)
     VALUES($1,'defesa','Defesa','entrada','pendente') RETURNING id`,
    [tenant.rows[0].id]
  );
  const client = await pool.query(
    `INSERT INTO clients(tenant_id,name,cpf) VALUES($1,'Cliente Teste','00000000000') RETURNING id`,
    [tenant.rows[0].id]
  );
  const fine = await pool.query(
    `INSERT INTO fines(tenant_id,client_id,fine_number,stage,status,department_id,tenant_service_type_id)
     VALUES($1,$2,'PG-001','entrada','pendente',$3,$4) RETURNING id,row_version`,
    [tenant.rows[0].id, client.rows[0].id, department.rows[0].id, service.rows[0].id]
  );
  seed = {
    tenantId: tenant.rows[0].id,
    otherTenantId: otherTenant.rows[0].id,
    userId: user.rows[0].id,
    departmentId: department.rows[0].id,
    serviceId: service.rows[0].id,
    fineId: fine.rows[0].id,
  };
});

test.after(async () => {
  await pool.end();
});

test('migration 05 cria tabelas, checks e indices essenciais no PostgreSQL real', async () => {
  const tables = await pool.query(
    `SELECT to_regclass('public.workflow_flows') AS flows,
            to_regclass('public.sla_instances') AS sla,
            to_regclass('public.automation_definitions') AS automations,
            to_regclass('public.internal_queue_jobs') AS jobs`
  );
  assert.deepEqual(Object.values(tables.rows[0]), [
    'workflow_flows', 'sla_instances', 'automation_definitions', 'internal_queue_jobs',
  ]);

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname IN
      ('idx_workflow_transitions_lookup','idx_sla_instances_monitor','idx_internal_queue_claim')`
  );
  assert.equal(indexes.rowCount, 3);
});

test('versao publicada e imutavel inclusive por acesso SQL direto', async () => {
  const flow = await pool.query(
    `INSERT INTO workflow_flows
       (tenant_id,tenant_service_type_id,name,version,status,initial_stage_code,created_by)
     VALUES($1,$2,'Fluxo Defesa',1,'draft','entrada',$3) RETURNING id`,
    [seed.tenantId, seed.serviceId, seed.userId]
  );
  const flowId = flow.rows[0].id;
  await pool.query(
    `INSERT INTO workflow_flow_stages(tenant_id,flow_id,stage_code,sort_order,is_initial,is_final)
     VALUES($1,$2,'entrada',1,TRUE,FALSE),($1,$2,'analise',2,FALSE,FALSE),
           ($1,$2,'finalizado',3,FALSE,TRUE)`,
    [seed.tenantId, flowId]
  );
  const transition = await pool.query(
    `INSERT INTO workflow_transitions
       (tenant_id,flow_id,name,from_stage_code,to_stage_code,justification_required)
     VALUES($1,$2,'Enviar para analise','entrada','analise',TRUE) RETURNING id`,
    [seed.tenantId, flowId]
  );
  await pool.query(
    `INSERT INTO workflow_transition_roles(transition_id,tenant_id,role)
     VALUES($1,$2,'admin')`,
    [transition.rows[0].id, seed.tenantId]
  );
  await pool.query(
    `UPDATE workflow_flows SET status='published',published_at=NOW(),published_by=$2
      WHERE id=$1`,
    [flowId, seed.userId]
  );
  await assert.rejects(
    pool.query(
      `UPDATE workflow_transitions SET name='Alteracao proibida' WHERE id=$1`,
      [transition.rows[0].id]
    ),
    (error) => error.code === '55000' && /WORKFLOW_IMMUTABLE/.test(error.message)
  );
  await pool.query(
    `UPDATE fines SET workflow_id=$1,workflow_version=1,workflow_assigned_at=NOW()
      WHERE id=$2 AND tenant_id=$3`,
    [flowId, seed.fineId, seed.tenantId]
  );
  seed.flowId = flowId;
  seed.transitionId = transition.rows[0].id;
});

test('concorrencia otimista preserva a alteracao mais recente', async () => {
  const initial = await pool.query(
    'SELECT row_version FROM fines WHERE id=$1 AND tenant_id=$2',
    [seed.fineId, seed.tenantId]
  );
  const expected = initial.rows[0].row_version;
  const first = await pool.query(
    `UPDATE fines SET status='em_andamento',row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND row_version=$3 RETURNING row_version`,
    [seed.fineId, seed.tenantId, expected]
  );
  const stale = await pool.query(
    `UPDATE fines SET status='sobrescrito',row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND row_version=$3 RETURNING row_version`,
    [seed.fineId, seed.tenantId, expected]
  );
  assert.equal(first.rowCount, 1);
  assert.equal(stale.rowCount, 0);
  const current = await pool.query('SELECT status FROM fines WHERE id=$1', [seed.fineId]);
  assert.equal(current.rows[0].status, 'em_andamento');
});

test('tenant_id impede leitura e escrita acidental por escopo de aplicacao', async () => {
  const hidden = await pool.query(
    'SELECT id FROM fines WHERE id=$1 AND tenant_id=$2',
    [seed.fineId, seed.otherTenantId]
  );
  const untouched = await pool.query(
    `UPDATE fines SET status='cross_tenant' WHERE id=$1 AND tenant_id=$2 RETURNING id`,
    [seed.fineId, seed.otherTenantId]
  );
  assert.equal(hidden.rowCount, 0);
  assert.equal(untouched.rowCount, 0);
});

test('dois workers reivindicam jobs distintos com SKIP LOCKED', async () => {
  await pool.query(
    `INSERT INTO internal_queue_jobs(tenant_id,job_type,payload,idempotency_key,priority)
     VALUES($1,'automation','{}','lock-1',80),($1,'automation','{}','lock-2',70)`,
    [seed.tenantId]
  );
  const one = await pool.connect();
  const two = await pool.connect();
  const claimSql = `
    WITH candidate AS (
      SELECT id FROM internal_queue_jobs
       WHERE status='pending' AND next_attempt_at <= NOW()
       ORDER BY priority DESC,created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE internal_queue_jobs j
       SET status='processing',locked_by=$1,locked_at=NOW(),started_at=NOW(),
           attempts=attempts+1,updated_at=NOW()
      FROM candidate c WHERE j.id=c.id
    RETURNING j.id`;
  try {
    await one.query('BEGIN');
    const first = await one.query(claimSql, ['worker-one']);
    await two.query('BEGIN');
    const second = await two.query(claimSql, ['worker-two']);
    assert.equal(first.rowCount, 1);
    assert.equal(second.rowCount, 1);
    assert.notEqual(first.rows[0].id, second.rows[0].id);
    await one.query('COMMIT');
    await two.query('COMMIT');
  } finally {
    try { await one.query('ROLLBACK'); } catch { /* already committed */ }
    try { await two.query('ROLLBACK'); } catch { /* already committed */ }
    one.release();
    two.release();
  }
});

test('idempotency key e unica por tenant e escopo', async () => {
  await pool.query(
    `INSERT INTO operation_idempotency
       (tenant_id,operation_scope,idempotency_key,request_hash,status)
     VALUES($1,'transition','same-request','hash-a','processing')`,
    [seed.tenantId]
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO operation_idempotency
         (tenant_id,operation_scope,idempotency_key,request_hash,status)
       VALUES($1,'transition','same-request','hash-a','processing')`,
      [seed.tenantId]
    ),
    (error) => error.code === '23505'
  );
  await pool.query(
    `INSERT INTO operation_idempotency
       (tenant_id,operation_scope,idempotency_key,request_hash,status)
     VALUES($1,'transition','same-request','hash-a','processing')`,
    [seed.otherTenantId]
  );
});
