'use strict';

const crypto = require('node:crypto');
const pool = require('../config/db');
const taskModels = require('../models/taskModels');
const alertModels = require('../models/alertModels');
const slaService = require('./slaService');

const EVENTS = new Set([
  'process_created', 'process_moved', 'stage_changed', 'status_changed',
  'assignee_changed', 'due_date_changed', 'due_date_expired',
  'document_uploaded', 'document_approved', 'document_rejected',
  'task_completed', 'process_reopened', 'process_finalized',
  'aging_reached', 'sla_warning', 'sla_violated',
]);
const CONDITION_TYPES = new Set([
  'service_type', 'stage', 'status', 'priority', 'department', 'assignee',
  'aging', 'due_date', 'sla_status', 'document_present', 'document_missing',
  'document_approved', 'task_open', 'task_overdue', 'custom_field', 'data_quality',
]);
const OPERATORS = new Set([
  'equals', 'not_equals', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists',
]);
const ACTION_TYPES = new Set([
  'create_task', 'assign_user', 'assign_department', 'set_priority', 'set_due_date',
  'create_alert', 'add_system_note', 'mark_attention', 'start_sla', 'pause_sla',
  'complete_sla', 'request_confirmation',
]);
const PRIORITIES = new Set(['baixa', 'normal', 'alta', 'critica']);

const clean = (value, max = 500) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const array = (value) => Array.isArray(value) ? value : [];
const json = (value, fallback = {}) => JSON.parse(JSON.stringify(value ?? fallback));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateDefinition(input) {
  const errors = [];
  if (!clean(input.name, 160)) errors.push('Nome e obrigatorio.');
  if (!EVENTS.has(input.event_type)) errors.push('Evento nao permitido.');
  for (const condition of array(input.conditions)) {
    if (!CONDITION_TYPES.has(condition.condition_type)) errors.push(`Condicao nao permitida: ${condition.condition_type}.`);
    if (!OPERATORS.has(condition.operator)) errors.push(`Operador nao permitido: ${condition.operator}.`);
  }
  for (const action of array(input.actions)) {
    if (!ACTION_TYPES.has(action.action_type)) errors.push(`Acao nao permitida: ${action.action_type}.`);
    if (!action.config || typeof action.config !== 'object' || Array.isArray(action.config)) {
      errors.push(`Configuracao invalida para ${action.action_type}.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

async function audit(client, tenantId, userId, eventType, entityId, summary, details = {}, outcome = 'success') {
  await client.query(
    `INSERT INTO governance_audit_events
       (tenant_id,actor_user_id,event_type,entity_type,entity_id,outcome,summary,safe_details)
     VALUES($1,$2,$3,'automation',$4,$5,$6,$7::jsonb)`,
    [tenantId, userId || null, eventType, entityId || null, outcome, summary, JSON.stringify(details)]
  );
}

async function loadDefinition(tenantId, id, client = pool) {
  const result = await client.query(
    `SELECT a.*,
            COALESCE((SELECT json_agg(c ORDER BY c.sort_order) FROM automation_conditions c
                       WHERE c.automation_id=a.id),'[]') AS conditions,
            COALESCE((SELECT json_agg(x ORDER BY x.sort_order) FROM automation_actions x
                       WHERE x.automation_id=a.id),'[]') AS actions
       FROM automation_definitions a WHERE a.id=$1 AND a.tenant_id=$2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

async function listDefinitions(tenantId) {
  const { rows } = await pool.query(
    `SELECT a.*,u.name AS created_by_name,
            (SELECT COUNT(*)::int FROM automation_conditions c WHERE c.automation_id=a.id) AS condition_count,
            (SELECT COUNT(*)::int FROM automation_actions x WHERE x.automation_id=a.id) AS action_count
       FROM automation_definitions a
       LEFT JOIN users u ON u.id=a.created_by AND u.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 ORDER BY a.status='active' DESC,a.sort_order,a.name`,
    [tenantId]
  );
  return rows;
}

async function insertChildren(client, tenantId, automationId, input) {
  for (const [index, condition] of array(input.conditions).entries()) {
    await client.query(
      `INSERT INTO automation_conditions
         (tenant_id,automation_id,condition_type,operator,field_key,value,sort_order)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        tenantId, automationId, condition.condition_type, condition.operator,
        clean(condition.field_key, 120) || null, JSON.stringify(json(condition.value, null)),
        Number.isInteger(Number(condition.sort_order)) ? Number(condition.sort_order) : index,
      ]
    );
  }
  for (const [index, action] of array(input.actions).entries()) {
    await client.query(
      `INSERT INTO automation_actions(tenant_id,automation_id,action_type,config,sort_order)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [
        tenantId, automationId, action.action_type, JSON.stringify(json(action.config)),
        Number.isInteger(Number(action.sort_order)) ? Number(action.sort_order) : index,
      ]
    );
  }
}

async function createDefinition(tenantId, userId, input) {
  const validation = validateDefinition(input);
  if (!validation.valid) return { ok: false, status: 422, error: validation.errors.join(' '), validation };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO automation_definitions
         (tenant_id,name,description,event_type,status,sort_order,max_depth,created_by)
       VALUES($1,$2,$3,$4,'draft',$5,$6,$7) RETURNING *`,
      [
        tenantId, clean(input.name, 160), clean(input.description, 5000) || null,
        input.event_type, Number(input.sort_order) || 0,
        Math.max(1, Math.min(Number(input.max_depth) || 5, 10)), userId,
      ]
    );
    await insertChildren(client, tenantId, inserted.rows[0].id, input);
    await audit(client, tenantId, userId, 'automation_created', inserted.rows[0].id,
      'Automacao interna criada', { event_type: input.event_type });
    await client.query('COMMIT');
    return { ok: true, data: await loadDefinition(tenantId, inserted.rows[0].id) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally { client.release(); }
}

async function updateDefinition(tenantId, userId, id, input) {
  const validation = validateDefinition(input);
  if (!validation.valid) return { ok: false, status: 422, error: validation.errors.join(' '), validation };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM automation_definitions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [id, tenantId]
    );
    if (!current.rows[0]) { await client.query('ROLLBACK'); return { ok: false, status: 404, error: 'Automacao nao encontrada.' }; }
    if (Number(input.expected_version) !== current.rows[0].row_version) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Automacao alterada por outro usuario.' };
    }
    const updated = await client.query(
      `UPDATE automation_definitions SET name=$1,description=$2,event_type=$3,sort_order=$4,
              max_depth=$5,row_version=row_version+1,updated_at=NOW()
        WHERE id=$6 AND tenant_id=$7 RETURNING *`,
      [
        clean(input.name, 160), clean(input.description, 5000) || null, input.event_type,
        Number(input.sort_order) || 0, Math.max(1, Math.min(Number(input.max_depth) || 5, 10)),
        id, tenantId,
      ]
    );
    await client.query('DELETE FROM automation_conditions WHERE automation_id=$1 AND tenant_id=$2', [id, tenantId]);
    await client.query('DELETE FROM automation_actions WHERE automation_id=$1 AND tenant_id=$2', [id, tenantId]);
    await insertChildren(client, tenantId, id, input);
    await audit(client, tenantId, userId, 'automation_updated', id,
      'Automacao interna atualizada', { previous_row_version: current.rows[0].row_version });
    await client.query('COMMIT');
    return { ok: true, data: await loadDefinition(tenantId, updated.rows[0].id) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally { client.release(); }
}

async function setStatus(tenantId, userId, id, status) {
  if (!['active', 'disabled'].includes(status)) return { ok: false, status: 422, error: 'Situacao invalida.' };
  const definition = await loadDefinition(tenantId, id);
  if (!definition) return { ok: false, status: 404, error: 'Automacao nao encontrada.' };
  if (status === 'active' && !definition.actions.length) {
    return { ok: false, status: 422, error: 'Inclua ao menos uma acao antes de ativar.' };
  }
  const updated = await pool.query(
    `UPDATE automation_definitions SET status=$1,row_version=row_version+1,updated_at=NOW()
      WHERE id=$2 AND tenant_id=$3 RETURNING *`,
    [status, id, tenantId]
  );
  await audit(pool, tenantId, userId,
    status === 'active' ? 'automation_activated' : 'automation_disabled',
    id, status === 'active' ? 'Automacao ativada' : 'Automacao desativada');
  return { ok: true, data: updated.rows[0] };
}

async function enqueueEvent(tenantId, event, idempotencyKey, client = pool) {
  if (!EVENTS.has(event.event_type)) throw new Error('Evento de automacao invalido.');
  const safePayload = {
    event_type: event.event_type,
    entity_type: clean(event.entity_type, 30) || 'process',
    entity_id: event.entity_id,
    fine_id: event.fine_id || (event.entity_type === 'process' ? event.entity_id : null),
    actor_user_id: event.actor_user_id || null,
    previous_stage: clean(event.previous_stage, 60) || null,
    current_stage: clean(event.current_stage, 60) || null,
    previous_status: clean(event.previous_status, 60) || null,
    current_status: clean(event.current_status, 60) || null,
    depth: Math.max(0, Math.min(Number(event.depth) || 0, 10)),
    chain: array(event.chain).slice(0, 10).map(String),
    source_execution_id: event.source_execution_id || null,
  };
  const result = await client.query(
    `INSERT INTO internal_queue_jobs(tenant_id,job_type,payload,priority,idempotency_key)
     VALUES($1,'automation',$2::jsonb,$3,$4)
     ON CONFLICT (tenant_id,job_type,idempotency_key) DO NOTHING RETURNING *`,
    [tenantId, JSON.stringify(safePayload), Number(event.priority) || 60, clean(idempotencyKey, 180)]
  );
  return result.rows[0] || null;
}

function compare(actual, operator, expected) {
  if (operator === 'exists') return actual !== null && actual !== undefined && actual !== '';
  if (operator === 'not_exists') return actual === null || actual === undefined || actual === '';
  if (operator === 'equals') return String(actual ?? '') === String(expected ?? '');
  if (operator === 'not_equals') return String(actual ?? '') !== String(expected ?? '');
  if (operator === 'in') return array(expected).map(String).includes(String(actual));
  if (operator === 'not_in') return !array(expected).map(String).includes(String(actual));
  const left = Number(actual);
  const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  if (operator === 'lte') return left <= right;
  return false;
}

async function loadContext(client, tenantId, payload) {
  if (!payload.fine_id) return { event: payload };
  const processResult = await client.query(
    `SELECT f.*,COALESCE(EXTRACT(DAY FROM NOW()-COALESCE(f.last_moved_at,f.updated_at)),0)::int AS aging
       FROM fines f WHERE f.id=$1 AND f.tenant_id=$2`,
    [payload.fine_id, tenantId]
  );
  if (!processResult.rows[0]) return { event: payload };
  const [documents, tasks, sla] = await Promise.all([
    client.query(
      `SELECT category_id,review_status FROM fine_documents
        WHERE tenant_id=$1 AND fine_id=$2 AND COALESCE(status,'ativo')='ativo' AND removed_at IS NULL`,
      [tenantId, payload.fine_id]
    ),
    client.query(
      `SELECT status,due_at,blocks_transition FROM process_tasks
        WHERE tenant_id=$1 AND fine_id=$2 AND deleted_at IS NULL`,
      [tenantId, payload.fine_id]
    ),
    client.query(
      `SELECT status,rule_id FROM sla_instances
        WHERE tenant_id=$1 AND fine_id=$2 ORDER BY created_at DESC`,
      [tenantId, payload.fine_id]
    ),
  ]);
  return {
    event: payload,
    process: processResult.rows[0],
    documents: documents.rows,
    tasks: tasks.rows,
    sla: sla.rows,
  };
}

function conditionActual(condition, context) {
  const process = context.process || {};
  switch (condition.condition_type) {
    case 'service_type': return process.tenant_service_type_id;
    case 'stage': return process.stage;
    case 'status': return process.status;
    case 'priority': return process.operational_priority;
    case 'department': return process.department_id;
    case 'assignee': return process.seller_id;
    case 'aging': return process.aging;
    case 'due_date': return process.due_date;
    case 'sla_status': return context.sla?.[0]?.status;
    case 'document_present':
      return context.documents?.some((item) => String(item.category_id) === String(condition.field_key));
    case 'document_missing':
      return !context.documents?.some((item) => String(item.category_id) === String(condition.field_key));
    case 'document_approved':
      return context.documents?.some((item) =>
        String(item.category_id) === String(condition.field_key) && item.review_status === 'approved');
    case 'task_open':
      return context.tasks?.some((item) => ['aberta', 'em_andamento', 'aguardando_terceiro'].includes(item.status));
    case 'task_overdue':
      return context.tasks?.some((item) =>
        ['aberta', 'em_andamento', 'aguardando_terceiro'].includes(item.status)
        && item.due_at && new Date(item.due_at) < new Date());
    case 'custom_field': return process.custom_data?.[condition.field_key];
    case 'data_quality':
      return !process.client_id || !process.seller_id || !process.department_id;
    default: return undefined;
  }
}

function conditionsMatch(conditions, context) {
  return array(conditions).every((condition) =>
    compare(conditionActual(condition, context), condition.operator, condition.value));
}

async function validateUser(client, tenantId, userId) {
  if (!userId) return null;
  const result = await client.query(
    `SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND COALESCE(is_active,TRUE)=TRUE`,
    [userId, tenantId]
  );
  return result.rows[0]?.id || null;
}

async function validateDepartment(client, tenantId, departmentId) {
  if (!departmentId) return null;
  const result = await client.query(
    'SELECT id FROM departments WHERE id=$1 AND tenant_id=$2 AND active=TRUE',
    [departmentId, tenantId]
  );
  return result.rows[0]?.id || null;
}

async function enqueueFollowUp(client, tenantId, payload, execution, eventType, suffix) {
  return enqueueEvent(tenantId, {
    event_type: eventType,
    entity_type: payload.entity_type,
    entity_id: payload.entity_id,
    fine_id: payload.fine_id,
    actor_user_id: null,
    depth: Number(payload.depth || 0) + 1,
    chain: [...array(payload.chain), String(execution.automation_id)],
    source_execution_id: execution.id,
  }, `automation-follow:${execution.id}:${suffix}`, client);
}

async function executeAction(client, tenantId, action, context, execution) {
  const config = action.config || {};
  const process = context.process;
  if (!process && !['create_alert'].includes(action.action_type)) {
    throw new Error('Acao exige processo valido.');
  }
  switch (action.action_type) {
    case 'create_task': {
      const result = await taskModels.createTask(tenantId, null, {
        fine_id: process.id,
        title: clean(config.title || 'Pendencia automatica', 200),
        description: clean(config.description, 5000),
        task_type_id: config.task_type_id || null,
        priority: PRIORITIES.has(config.priority) ? config.priority : 'normal',
        assignee_id: await validateUser(client, tenantId, config.assignee_id || process.seller_id),
        department_id: await validateDepartment(client, tenantId, config.department_id || process.department_id),
        due_at: config.due_minutes
          ? new Date(Date.now() + Math.max(1, Number(config.due_minutes)) * 60000).toISOString()
          : null,
      }, client);
      if (!result.ok) throw new Error(result.error);
      return { action: 'create_task', resource_id: result.task.id };
    }
    case 'assign_user': {
      const userId = await validateUser(client, tenantId, config.user_id);
      if (!userId) throw new Error('Responsavel de automacao invalido.');
      await client.query(
        `UPDATE fines SET seller_id=$1,row_version=row_version+1,updated_at=NOW(),last_moved_at=NOW()
          WHERE id=$2 AND tenant_id=$3`,
        [userId, process.id, tenantId]
      );
      await enqueueFollowUp(client, tenantId, context.event, execution, 'assignee_changed', 'assignee');
      return { action: 'assign_user', resource_id: userId };
    }
    case 'assign_department': {
      const departmentId = await validateDepartment(client, tenantId, config.department_id);
      if (!departmentId) throw new Error('Setor de automacao invalido.');
      await client.query(
        `UPDATE fines SET department_id=$1,row_version=row_version+1,updated_at=NOW(),last_moved_at=NOW()
          WHERE id=$2 AND tenant_id=$3`,
        [departmentId, process.id, tenantId]
      );
      return { action: 'assign_department', resource_id: departmentId };
    }
    case 'set_priority': {
      if (!PRIORITIES.has(config.priority)) throw new Error('Prioridade de automacao invalida.');
      await client.query(
        `UPDATE fines SET operational_priority=$1,row_version=row_version+1,updated_at=NOW()
          WHERE id=$2 AND tenant_id=$3`,
        [config.priority, process.id, tenantId]
      );
      return { action: 'set_priority', value: config.priority };
    }
    case 'set_due_date': {
      const days = Math.max(0, Math.min(Number(config.days_from_now) || 0, 3650));
      const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      await client.query(
        `UPDATE fines SET due_date=$1,row_version=row_version+1,updated_at=NOW()
          WHERE id=$2 AND tenant_id=$3`,
        [due, process.id, tenantId]
      );
      await enqueueFollowUp(client, tenantId, context.event, execution, 'due_date_changed', 'due-date');
      return { action: 'set_due_date', value: due };
    }
    case 'create_alert': {
      const recipient = await validateUser(client, tenantId, config.recipient_id || process?.seller_id);
      if (!recipient) throw new Error('Destinatario de alerta invalido.');
      const created = await alertModels.createAlert({
        tenant_id: tenantId,
        recipient_id: recipient,
        type: 'automacao',
        title: clean(config.title || 'Acao automatica', 200),
        message: clean(config.message || 'Uma automacao requer sua atencao.', 2000),
        entity_type: context.event.entity_type,
        entity_id: context.event.entity_id,
        internal_link: process ? `/dashboard?module=multas&tab=processos&process=${process.id}` : '/dashboard',
        dedupe_key: `automation:${execution.id}:alert:${action.id}`,
      }, client);
      return { action: 'create_alert', resource_id: created?.id || null };
    }
    case 'add_system_note': {
      const inserted = await client.query(
        `INSERT INTO process_notes(tenant_id,fine_id,author_id,content)
         VALUES($1,$2,NULL,$3) RETURNING id`,
        [tenantId, process.id, clean(config.content || 'Nota registrada por automacao interna.', 5000)]
      );
      return { action: 'add_system_note', resource_id: inserted.rows[0].id };
    }
    case 'mark_attention': {
      await client.query(
        `INSERT INTO operation_attention_flags
           (tenant_id,entity_type,entity_id,reason_code,severity,title,source_type,source_id)
         VALUES($1,'process',$2,$3,$4,$5,'automation',$6)
         ON CONFLICT (tenant_id,entity_type,entity_id,reason_code)
           WHERE resolved_at IS NULL DO NOTHING`,
        [
          tenantId, process.id, clean(config.reason_code || `automation:${execution.automation_id}`, 80),
          ['information', 'attention', 'critical'].includes(config.severity) ? config.severity : 'attention',
          clean(config.title || 'Atencao gerada por automacao', 180), execution.id,
        ]
      );
      return { action: 'mark_attention' };
    }
    case 'start_sla': {
      const rule = await client.query(
        'SELECT * FROM sla_rules WHERE id=$1 AND tenant_id=$2 AND active=TRUE',
        [config.rule_id, tenantId]
      );
      if (!rule.rows[0]) throw new Error('Regra de SLA invalida.');
      const instance = await slaService.startInstance(client, tenantId, rule.rows[0], process);
      return { action: 'start_sla', resource_id: instance?.id || null };
    }
    case 'pause_sla': {
      const active = await client.query(
        `UPDATE sla_instances SET status='paused',paused_at=NOW(),pause_reason=$1,
                row_version=row_version+1,updated_at=NOW()
          WHERE tenant_id=$2 AND fine_id=$3 AND status IN ('running','warning')
          RETURNING id`,
        [clean(config.reason || 'suspended', 80), tenantId, process.id]
      );
      return { action: 'pause_sla', count: active.rowCount };
    }
    case 'complete_sla': {
      const active = await client.query(
        `UPDATE sla_instances SET status='met',completed_at=NOW(),result='automation',
                row_version=row_version+1,updated_at=NOW()
          WHERE tenant_id=$1 AND fine_id=$2 AND status IN ('running','warning','paused')
          RETURNING id`,
        [tenantId, process.id]
      );
      return { action: 'complete_sla', count: active.rowCount };
    }
    case 'request_confirmation': {
      const result = await taskModels.createTask(tenantId, null, {
        fine_id: process.id,
        title: clean(config.title || 'Confirmacao necessaria', 200),
        description: clean(config.description || 'Revise e confirme a acao sugerida pela automacao.', 5000),
        priority: 'alta',
        assignee_id: await validateUser(client, tenantId, config.assignee_id || process.seller_id),
        department_id: process.department_id,
      }, client);
      if (!result.ok) throw new Error(result.error);
      return { action: 'request_confirmation', resource_id: result.task.id };
    }
    default: throw new Error('Acao nao suportada.');
  }
}

async function executeAutomation(tenantId, definition, payload, context, eventKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chain = array(payload.chain).map(String);
    const loop = Number(payload.depth || 0) >= Number(definition.max_depth)
      || chain.includes(String(definition.id));
    const executionInsert = await client.query(
      `INSERT INTO automation_executions
         (tenant_id,automation_id,event_type,source_entity_type,source_entity_id,
          parent_execution_id,chain,depth,idempotency_key,status,safe_context)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
       ON CONFLICT (tenant_id,automation_id,idempotency_key) DO NOTHING RETURNING *`,
      [
        tenantId, definition.id, payload.event_type, payload.entity_type || null,
        payload.entity_id || null, payload.source_execution_id || null,
        JSON.stringify(chain), Number(payload.depth || 0), eventKey,
        loop ? 'loop_blocked' : 'running',
        JSON.stringify({
          fine_id: payload.fine_id || null,
          stage: context.process?.stage || null,
          status: context.process?.status || null,
        }),
      ]
    );
    if (!executionInsert.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'duplicate' };
    }
    const execution = executionInsert.rows[0];
    if (loop) {
      await client.query(
        `UPDATE automation_definitions SET failure_count=failure_count+1,updated_at=NOW()
          WHERE id=$1 AND tenant_id=$2`,
        [definition.id, tenantId]
      );
      await audit(client, tenantId, null, 'automation_loop_blocked', definition.id,
        'Loop de automacao bloqueado', { execution_id: execution.id, depth: payload.depth }, 'blocked');
      await client.query('COMMIT');
      return { status: 'loop_blocked', execution_id: execution.id };
    }
    const started = Date.now();
    const actionResults = [];
    for (const action of definition.actions) {
      actionResults.push(await executeAction(client, tenantId, action, context, execution));
    }
    const duration = Date.now() - started;
    await client.query(
      `UPDATE automation_executions SET status='completed',completed_at=NOW(),duration_ms=$1,
              safe_context=safe_context || $2::jsonb WHERE id=$3`,
      [duration, JSON.stringify({ action_count: actionResults.length }), execution.id]
    );
    await client.query(
      `UPDATE automation_definitions SET last_executed_at=NOW(),execution_count=execution_count+1,
              updated_at=NOW() WHERE id=$1 AND tenant_id=$2`,
      [definition.id, tenantId]
    );
    await audit(client, tenantId, null, 'automation_executed', definition.id,
      'Automacao interna executada', { execution_id: execution.id, action_count: actionResults.length, duration_ms: duration });
    await client.query('COMMIT');
    return { status: 'completed', execution_id: execution.id, actions: actionResults };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    await pool.query(
      `UPDATE automation_definitions SET failure_count=failure_count+1,updated_at=NOW()
        WHERE id=$1 AND tenant_id=$2`,
      [definition.id, tenantId]
    );
    throw error;
  } finally { client.release(); }
}

async function dispatchEvent(tenantId, payload, jobKey) {
  if (!EVENTS.has(payload.event_type)) throw new Error('Evento da fila nao permitido.');
  const context = await loadContext(pool, tenantId, payload);
  const definitions = await pool.query(
    `SELECT a.*,
            COALESCE((SELECT json_agg(c ORDER BY c.sort_order) FROM automation_conditions c
                       WHERE c.automation_id=a.id),'[]') AS conditions,
            COALESCE((SELECT json_agg(x ORDER BY x.sort_order) FROM automation_actions x
                       WHERE x.automation_id=a.id),'[]') AS actions
       FROM automation_definitions a
      WHERE a.tenant_id=$1 AND a.event_type=$2 AND a.status='active'
      ORDER BY a.sort_order,a.created_at`,
    [tenantId, payload.event_type]
  );
  const results = [];
  for (const definition of definitions.rows) {
    if (!conditionsMatch(definition.conditions, context)) {
      results.push({ automation_id: definition.id, status: 'conditions_false' });
      continue;
    }
    results.push({
      automation_id: definition.id,
      ...(await executeAutomation(
        tenantId, definition, payload, context,
        `${jobKey}:${definition.id}:${hash({ event: payload.event_type, entity: payload.entity_id })}`
      )),
    });
  }
  return { matched: definitions.rowCount, results };
}

async function listExecutions(tenantId, filters = {}) {
  const params = [tenantId];
  const clauses = ['e.tenant_id=$1'];
  if (filters.status) { params.push(filters.status); clauses.push(`e.status=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT e.id,e.automation_id,a.name AS automation_name,e.event_type,e.source_entity_type,
            e.source_entity_id,e.parent_execution_id,e.chain,e.depth,e.status,e.started_at,
            e.completed_at,e.duration_ms,e.error_summary,e.safe_context,e.created_at
       FROM automation_executions e
       LEFT JOIN automation_definitions a ON a.id=e.automation_id AND a.tenant_id=e.tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

module.exports = {
  EVENTS,
  CONDITION_TYPES,
  OPERATORS,
  ACTION_TYPES,
  validateDefinition,
  compare,
  conditionsMatch,
  loadDefinition,
  listDefinitions,
  createDefinition,
  updateDefinition,
  setStatus,
  enqueueEvent,
  dispatchEvent,
  listExecutions,
};
