'use strict';

const pool = require('../config/db');

const PRIORITIES = Object.freeze(['baixa', 'normal', 'alta', 'critica']);
const STATUSES = Object.freeze(['aberta', 'em_andamento', 'aguardando_terceiro', 'concluida', 'cancelada']);
const OPEN_STATUSES = Object.freeze(['aberta', 'em_andamento', 'aguardando_terceiro']);

const cleanText = (value, max) => {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text.slice(0, max);
};

async function processExists(tenantId, fineId, client = pool) {
  const { rows } = await client.query(
    'SELECT id FROM fines WHERE id = $1 AND tenant_id = $2',
    [fineId, tenantId]
  );
  return Boolean(rows[0]);
}

async function validateReferences(tenantId, input, client = pool) {
  if (input.task_type_id) {
    const { rows } = await client.query(
      'SELECT id FROM task_types WHERE id = $1 AND tenant_id = $2 AND active = TRUE',
      [input.task_type_id, tenantId]
    );
    if (!rows[0]) return 'Tipo de pendencia invalido.';
  }
  if (input.assignee_id) {
    const { rows } = await client.query(
      `SELECT id FROM users
       WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
      [input.assignee_id, tenantId]
    );
    if (!rows[0]) return 'Responsavel invalido ou inativo.';
  }
  if (input.department_id) {
    const { rows } = await client.query(
      'SELECT id FROM departments WHERE id = $1 AND tenant_id = $2 AND active = TRUE',
      [input.department_id, tenantId]
    );
    if (!rows[0]) return 'Setor invalido.';
  }
  return null;
}

async function listTaskTypes(tenantId, { includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, code, label, sort_order, active
     FROM task_types
     WHERE tenant_id = $1${includeInactive ? '' : ' AND active = TRUE'}
     ORDER BY sort_order, label`,
    [tenantId]
  );
  return rows;
}

async function createTaskType(tenantId, input) {
  const label = cleanText(input.label, 120);
  const code = cleanText(input.code || label, 60)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!label || !code) throw new Error('Nome do tipo e obrigatorio.');
  const { rows } = await pool.query(
    `INSERT INTO task_types (tenant_id, code, label, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, code, label, Number(input.sort_order) || 0]
  );
  return rows[0];
}

async function updateTaskType(tenantId, id, input) {
  const { rows } = await pool.query(
    `UPDATE task_types
     SET label = COALESCE($1, label),
         sort_order = COALESCE($2, sort_order),
         active = COALESCE($3, active),
         updated_at = NOW()
     WHERE id = $4 AND tenant_id = $5
     RETURNING *`,
    [
      input.label === undefined ? null : cleanText(input.label, 120),
      input.sort_order === undefined ? null : Number(input.sort_order),
      input.active === undefined ? null : Boolean(input.active),
      id,
      tenantId,
    ]
  );
  return rows[0];
}

function taskWhere(tenantId, filters = {}) {
  const clauses = ['t.tenant_id = $1', 't.deleted_at IS NULL'];
  const params = [tenantId];
  let index = 2;
  const add = (sql, value) => {
    clauses.push(sql.replace('$$', `$${index}`));
    params.push(value);
    index += 1;
  };

  if (filters.fine_id) add('t.fine_id = $$', filters.fine_id);
  if (filters.assignee_id === 'none') clauses.push('t.assignee_id IS NULL');
  else if (filters.assignee_id) add('t.assignee_id = $$', filters.assignee_id);
  if (filters.department_id === 'none') clauses.push('t.department_id IS NULL');
  else if (filters.department_id) add('t.department_id = $$', filters.department_id);
  if (filters.status && STATUSES.includes(filters.status)) add('t.status = $$', filters.status);
  if (filters.priority && PRIORITIES.includes(filters.priority)) add('t.priority = $$', filters.priority);
  if (filters.task_type_id) add('t.task_type_id = $$', filters.task_type_id);
  if (filters.open === true || filters.open === 'true') {
    clauses.push(`t.status IN ('aberta','em_andamento','aguardando_terceiro')`);
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (filters.overdue === true || filters.overdue === 'true') {
    clauses.push(`t.status IN ('aberta','em_andamento','aguardando_terceiro')`);
    add('t.due_at < $$', now.toISOString());
  }
  if (filters.due_today === true || filters.due_today === 'true') {
    add('CAST(t.due_at AS DATE) = $$', today);
  }
  if (filters.due_from) add('t.due_at >= $$', filters.due_from);
  if (filters.due_to) add('t.due_at <= $$', filters.due_to);
  if (filters.q) {
    clauses.push(`(
      t.title ILIKE $${index} OR t.description ILIKE $${index}
      OR f.fine_number ILIKE $${index} OR f.protocol_number ILIKE $${index}
      OR c.name ILIKE $${index}
    )`);
    params.push(`%${cleanText(filters.q, 100)}%`);
    index += 1;
  }
  return { where: clauses.join(' AND '), params, nextIndex: index };
}

async function listTasks(tenantId, filters = {}) {
  const { where, params, nextIndex } = taskWhere(tenantId, filters);
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 25, 1), 200);
  const offset = Math.max(Number.parseInt(filters.offset, 10) || 0, 0);
  const sortMap = {
    due_at: 't.due_at',
    created_at: 't.created_at',
    updated_at: 't.updated_at',
    priority: `CASE t.priority WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END`,
  };
  const sort = sortMap[filters.sort_by] || `CASE t.priority WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END`;
  const direction = String(filters.sort_dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const joins = `
    JOIN fines f ON f.id = t.fine_id AND f.tenant_id = t.tenant_id
    LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
    LEFT JOIN task_types tt ON tt.id = t.task_type_id AND tt.tenant_id = t.tenant_id
    LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
    LEFT JOIN departments d ON d.id = t.department_id AND d.tenant_id = t.tenant_id`;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT t.*, tt.code AS task_type_code, tt.label AS task_type_label,
              f.fine_number, f.protocol_number, f.stage, f.status AS process_status,
              c.name AS client_name, u.name AS assignee_name, d.name AS department_name,
              CASE WHEN t.due_at IS NOT NULL
                         AND t.due_at < NOW()
                         AND t.status IN ('aberta','em_andamento','aguardando_terceiro')
                   THEN TRUE ELSE FALSE END AS overdue
       FROM process_tasks t${joins}
       WHERE ${where}
       ORDER BY ${sort} ${direction}, t.due_at ASC NULLS LAST, t.created_at DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...params, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM process_tasks t${joins} WHERE ${where}`,
      params
    ),
  ]);
  return { rows: items.rows, total: count.rows[0].total, limit, offset };
}

async function getTask(tenantId, id, client = pool) {
  const { rows } = await client.query(
    `SELECT t.*, tt.code AS task_type_code, tt.label AS task_type_label,
            f.fine_number, c.name AS client_name,
            u.name AS assignee_name, d.name AS department_name,
            creator.name AS created_by_name, completer.name AS completed_by_name
     FROM process_tasks t
     JOIN fines f ON f.id = t.fine_id AND f.tenant_id = t.tenant_id
     LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
     LEFT JOIN task_types tt ON tt.id = t.task_type_id AND tt.tenant_id = t.tenant_id
     LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
     LEFT JOIN users creator ON creator.id = t.created_by AND creator.tenant_id = t.tenant_id
     LEFT JOIN users completer ON completer.id = t.completed_by AND completer.tenant_id = t.tenant_id
     LEFT JOIN departments d ON d.id = t.department_id AND d.tenant_id = t.tenant_id
     WHERE t.id = $1 AND t.tenant_id = $2 AND t.deleted_at IS NULL`,
    [id, tenantId]
  );
  return rows[0];
}

async function createTask(tenantId, userId, input, client = pool) {
  const title = cleanText(input.title, 200);
  if (!title) return { ok: false, error: 'Titulo e obrigatorio.' };
  if (!input.fine_id || !(await processExists(tenantId, input.fine_id, client))) {
    return { ok: false, error: 'Processo nao encontrado.' };
  }
  if (input.priority && !PRIORITIES.includes(input.priority)) {
    return { ok: false, error: 'Prioridade invalida.' };
  }
  const refError = await validateReferences(tenantId, input, client);
  if (refError) return { ok: false, error: refError };
  const { rows } = await client.query(
    `INSERT INTO process_tasks (
       tenant_id, fine_id, title, description, task_type_id, priority,
       assignee_id, department_id, due_at, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberta',$10)
     RETURNING *`,
    [
      tenantId,
      input.fine_id,
      title,
      cleanText(input.description, 5000) || null,
      input.task_type_id || null,
      input.priority || 'normal',
      input.assignee_id || null,
      input.department_id || null,
      input.due_at || null,
      userId || null,
    ]
  );
  return { ok: true, task: rows[0] };
}

async function updateTask(tenantId, id, input) {
  const current = await getTask(tenantId, id);
  if (!current) return { ok: false, status: 404, error: 'Pendencia nao encontrada.' };
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) {
    return { ok: false, error: 'Prioridade invalida.' };
  }
  if (input.status !== undefined) {
    return { ok: false, error: 'Use uma acao de fluxo para alterar a situacao.' };
  }
  const mergedRefs = {
    task_type_id: input.task_type_id === undefined ? current.task_type_id : input.task_type_id,
    assignee_id: input.assignee_id === undefined ? current.assignee_id : input.assignee_id,
    department_id: input.department_id === undefined ? current.department_id : input.department_id,
  };
  const refError = await validateReferences(tenantId, mergedRefs);
  if (refError) return { ok: false, error: refError };
  const { rows } = await pool.query(
    `UPDATE process_tasks SET
       title = COALESCE($1, title),
       description = CASE WHEN $2::boolean THEN $3 ELSE description END,
       task_type_id = CASE WHEN $4::boolean THEN $5 ELSE task_type_id END,
       priority = COALESCE($6, priority),
       assignee_id = CASE WHEN $7::boolean THEN $8 ELSE assignee_id END,
       department_id = CASE WHEN $9::boolean THEN $10 ELSE department_id END,
       due_at = CASE WHEN $11::boolean THEN $12 ELSE due_at END,
       row_version = row_version + 1,
       updated_at = NOW()
     WHERE id = $13 AND tenant_id = $14 AND deleted_at IS NULL
       AND ($15::integer IS NULL OR row_version = $15)
     RETURNING *`,
    [
      input.title === undefined ? null : cleanText(input.title, 200),
      input.description !== undefined,
      input.description === undefined ? null : (cleanText(input.description, 5000) || null),
      input.task_type_id !== undefined,
      input.task_type_id || null,
      input.priority === undefined ? null : input.priority,
      input.assignee_id !== undefined,
      input.assignee_id || null,
      input.department_id !== undefined,
      input.department_id || null,
      input.due_at !== undefined,
      input.due_at || null,
      id,
      tenantId,
      input.expected_version === undefined ? null : Number(input.expected_version),
    ]
  );
  if (!rows[0] && input.expected_version !== undefined) {
    return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Pendencia alterada por outro usuario.' };
  }
  return { ok: true, task: rows[0], previous: current };
}

const ALLOWED_TRANSITIONS = Object.freeze({
  aberta: ['em_andamento', 'aguardando_terceiro', 'concluida', 'cancelada'],
  em_andamento: ['aguardando_terceiro', 'concluida', 'cancelada'],
  aguardando_terceiro: ['em_andamento', 'concluida', 'cancelada'],
  concluida: ['aberta'],
  cancelada: ['aberta'],
});

async function transitionTask(tenantId, id, target, userId, input = {}) {
  if (!STATUSES.includes(target)) return { ok: false, error: 'Situacao invalida.' };
  const current = await getTask(tenantId, id);
  if (!current) return { ok: false, status: 404, error: 'Pendencia nao encontrada.' };
  if (current.status === target) return { ok: true, task: current, previous: current, changed: false };
  if (!(ALLOWED_TRANSITIONS[current.status] || []).includes(target)) {
    return { ok: false, error: `Transicao de ${current.status} para ${target} nao permitida.` };
  }
  if (target === 'concluida' && !cleanText(input.completion_note || input.note, 5000)) {
    return { ok: false, error: 'Informe a observacao de conclusao.' };
  }
  const completing = target === 'concluida';
  const reopening = target === 'aberta';
  const { rows } = await pool.query(
    `UPDATE process_tasks SET
       status = $1,
       completed_by = CASE WHEN $2 THEN $3 ELSE CASE WHEN $4 THEN NULL ELSE completed_by END END,
       completed_at = CASE WHEN $2 THEN COALESCE($5, NOW()) ELSE CASE WHEN $4 THEN NULL ELSE completed_at END END,
       completion_result = CASE WHEN $2 THEN $6 ELSE CASE WHEN $4 THEN NULL ELSE completion_result END END,
       completion_note = CASE WHEN $2 THEN $7 ELSE CASE WHEN $4 THEN NULL ELSE completion_note END END,
       row_version = row_version + 1,
       updated_at = NOW()
     WHERE id = $8 AND tenant_id = $9 AND deleted_at IS NULL
       AND ($10::integer IS NULL OR row_version = $10)
     RETURNING *`,
    [
      target,
      completing,
      userId || null,
      reopening,
      input.completed_at || null,
      completing ? (cleanText(input.result, 200) || null) : null,
      completing ? cleanText(input.completion_note || input.note, 5000) : null,
      id,
      tenantId,
      input.expected_version === undefined ? null : Number(input.expected_version),
    ]
  );
  if (!rows[0] && input.expected_version !== undefined) {
    return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Pendencia alterada por outro usuario.' };
  }
  return { ok: true, task: rows[0], previous: current, changed: true };
}

async function softDeleteTask(tenantId, id, userId) {
  const { rows } = await pool.query(
    `UPDATE process_tasks
     SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
     RETURNING *`,
    [userId || null, id, tenantId]
  );
  return rows[0];
}

module.exports = {
  PRIORITIES,
  STATUSES,
  OPEN_STATUSES,
  cleanText,
  processExists,
  validateReferences,
  listTaskTypes,
  createTaskType,
  updateTaskType,
  listTasks,
  getTask,
  createTask,
  updateTask,
  transitionTask,
  softDeleteTask,
};
