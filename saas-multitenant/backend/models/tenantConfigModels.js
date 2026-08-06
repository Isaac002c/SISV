'use strict';
const pool = require('../config/db');

// =============================================================================
// TENANT CONFIG MODEL — catálogos operacionais isolados por tenant.
// Cobre: setores (departments), etapas (process_stages), status
// (process_statuses) e tipos de serviço (tenant_service_types).
//
// TODA query filtra por tenant_id: um tenant nunca lê/escreve o catálogo de
// outro. As funções seguem o mesmo formato em cada catálogo para reaproveitar a
// mesma rota/model genérica.
// =============================================================================

const norm = (v) => (v === '' || v === undefined ? null : v);
const slugCode = (v) =>
  String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const CUSTOM_FIELD_TYPES = new Set(['texto_curto', 'texto_longo', 'numero', 'data', 'selecao', 'booleano']);

const validateCustomFields = (value) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30) throw new Error('Campos personalizados invalidos.');
  const keys = new Set();
  return value.map((field, index) => {
    const name = String(field?.name || '').trim().slice(0, 120);
    const key = String(field?.key || slugCode(name).toLowerCase()).trim().slice(0, 60);
    const type = String(field?.type || '');
    if (!name || !/^[a-z][a-z0-9_]{1,59}$/.test(key) || !CUSTOM_FIELD_TYPES.has(type) || keys.has(key)) {
      throw new Error(`Campo personalizado invalido na posicao ${index + 1}.`);
    }
    keys.add(key);
    const options = type === 'selecao'
      ? [...new Set((Array.isArray(field.options) ? field.options : []).map((item) => String(item).trim().slice(0, 100)).filter(Boolean))].slice(0, 50)
      : [];
    if (type === 'selecao' && options.length === 0) throw new Error(`O campo ${name} precisa de opcoes.`);
    return {
      name,
      key,
      type,
      required: Boolean(field.required),
      options,
      order: Number.isFinite(Number(field.order)) ? Number(field.order) : index,
      active: field.active !== false,
      default_value: field.default_value ?? null,
    };
  });
};

const validateSuggestedTasks = (value) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30) throw new Error('Pendencias sugeridas invalidas.');
  return value.map((task, index) => {
    const title = String(task?.title || '').trim().slice(0, 200);
    const priority = ['baixa', 'normal', 'alta', 'critica'].includes(task?.priority) ? task.priority : 'normal';
    const dueDays = task?.due_days === null || task?.due_days === undefined ? null : Number(task.due_days);
    if (!title || (dueDays !== null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365))) {
      throw new Error(`Pendencia sugerida invalida na posicao ${index + 1}.`);
    }
    return {
      title,
      description: String(task.description || '').trim().slice(0, 2000) || null,
      priority,
      due_days: dueDays,
      task_type_id: task.task_type_id || null,
      department_id: task.department_id || null,
    };
  });
};

const validateServiceReferences = async (tenant_id, input) => {
  const checks = [
    ['initial_stage', 'process_stages', 'code', 'Etapa inicial invalida.'],
    ['initial_status', 'process_statuses', 'code', 'Status inicial invalido.'],
    ['initial_department_id', 'departments', 'id', 'Setor inicial invalido.'],
  ];
  for (const [field, table, column, message] of checks) {
    if (!input[field]) continue;
    const { rows } = await pool.query(
      `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND ${column} = $2 AND active = TRUE`,
      [tenant_id, input[field]]
    );
    if (!rows[0]) throw new Error(message);
  }
};

const validateSuggestedTaskReferences = async (tenant_id, tasks) => {
  for (const task of tasks || []) {
    if (task.task_type_id) {
      const { rows } = await pool.query(
        'SELECT 1 FROM task_types WHERE id = $1 AND tenant_id = $2 AND active = TRUE',
        [task.task_type_id, tenant_id]
      );
      if (!rows[0]) throw new Error('Tipo de pendencia sugerida invalido.');
    }
    if (task.department_id) {
      const { rows } = await pool.query(
        'SELECT 1 FROM departments WHERE id = $1 AND tenant_id = $2 AND active = TRUE',
        [task.department_id, tenant_id]
      );
      if (!rows[0]) throw new Error('Setor de pendencia sugerida invalido.');
    }
  }
};

// ── Setores / departamentos ──────────────────────────────────────────────────
const listDepartments = async (tenant_id, { includeInactive = false } = {}) => {
  const where = includeInactive ? '' : ' AND active = TRUE';
  const { rows } = await pool.query(
    `SELECT * FROM departments WHERE tenant_id = $1${where} ORDER BY sort_order ASC, name ASC`,
    [tenant_id]
  );
  return rows;
};

const createDepartment = async ({ tenant_id, name, color, sort_order }) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!name) throw new Error('nome do setor é obrigatório');
  const { rows } = await pool.query(
    `INSERT INTO departments (tenant_id, name, color, sort_order)
     VALUES ($1, $2, $3, COALESCE($4, 0)) RETURNING *`,
    [tenant_id, name, norm(color), sort_order]
  );
  return rows[0];
};

const updateDepartment = async (id, { name, color, sort_order, active }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE departments SET
       name = COALESCE($1, name),
       color = COALESCE($2, color),
       sort_order = COALESCE($3, sort_order),
       active = COALESCE($4, active),
       updated_at = NOW()
     WHERE id = $5 AND tenant_id = $6 RETURNING *`,
    [norm(name), norm(color), sort_order, active, id, tenant_id]
  );
  return rows[0];
};

const deleteDepartment = async (id, tenant_id) => {
  const { rows } = await pool.query(
    'DELETE FROM departments WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return rows[0];
};

// ── Etapas ────────────────────────────────────────────────────────────────────
const listStages = async (tenant_id, { includeInactive = false } = {}) => {
  const where = includeInactive ? '' : ' AND active = TRUE';
  const { rows } = await pool.query(
    `SELECT * FROM process_stages WHERE tenant_id = $1${where} ORDER BY sort_order ASC, label ASC`,
    [tenant_id]
  );
  return rows;
};

const createStage = async ({ tenant_id, code, label, color, sort_order, is_final }) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!label) throw new Error('nome da etapa é obrigatório');
  const finalCode = code ? slugCode(code) : slugCode(label);
  const { rows } = await pool.query(
    `INSERT INTO process_stages (tenant_id, code, label, color, sort_order, is_final)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, FALSE)) RETURNING *`,
    [tenant_id, finalCode, label, norm(color), sort_order, is_final]
  );
  return rows[0];
};

const updateStage = async (id, { label, color, sort_order, is_final, active }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE process_stages SET
       label = COALESCE($1, label),
       color = COALESCE($2, color),
       sort_order = COALESCE($3, sort_order),
       is_final = COALESCE($4, is_final),
       active = COALESCE($5, active),
       updated_at = NOW()
     WHERE id = $6 AND tenant_id = $7 RETURNING *`,
    [norm(label), norm(color), sort_order, is_final, active, id, tenant_id]
  );
  return rows[0];
};

const deleteStage = async (id, tenant_id) => {
  const { rows } = await pool.query(
    'DELETE FROM process_stages WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return rows[0];
};

// ── Status ────────────────────────────────────────────────────────────────────
const listStatuses = async (tenant_id, { includeInactive = false } = {}) => {
  const where = includeInactive ? '' : ' AND active = TRUE';
  const { rows } = await pool.query(
    `SELECT * FROM process_statuses WHERE tenant_id = $1${where} ORDER BY sort_order ASC, label ASC`,
    [tenant_id]
  );
  return rows;
};

const createStatus = async ({ tenant_id, code, label, color, sort_order, is_pending }) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!label) throw new Error('nome do status é obrigatório');
  const finalCode = code ? slugCode(code) : slugCode(label);
  const { rows } = await pool.query(
    `INSERT INTO process_statuses (tenant_id, code, label, color, sort_order, is_pending)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, FALSE)) RETURNING *`,
    [tenant_id, finalCode, label, norm(color), sort_order, is_pending]
  );
  return rows[0];
};

const updateStatus = async (id, { label, color, sort_order, is_pending, active }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE process_statuses SET
       label = COALESCE($1, label),
       color = COALESCE($2, color),
       sort_order = COALESCE($3, sort_order),
       is_pending = COALESCE($4, is_pending),
       active = COALESCE($5, active),
       updated_at = NOW()
     WHERE id = $6 AND tenant_id = $7 RETURNING *`,
    [norm(label), norm(color), sort_order, is_pending, active, id, tenant_id]
  );
  return rows[0];
};

const deleteStatus = async (id, tenant_id) => {
  const { rows } = await pool.query(
    'DELETE FROM process_statuses WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return rows[0];
};

// ── Tipos de serviço (por tenant) ─────────────────────────────────────────────
const listServiceTypes = async (tenant_id, { includeInactive = false } = {}) => {
  const where = includeInactive ? '' : ' AND active = TRUE';
  const { rows } = await pool.query(
    `SELECT * FROM tenant_service_types WHERE tenant_id = $1${where} ORDER BY sort_order ASC, label ASC`,
    [tenant_id]
  );
  return rows;
};

const createServiceType = async ({
  tenant_id, code, label, color, sort_order, description,
  initial_stage, initial_status, default_due_days, initial_department_id,
  suggested_tasks, custom_fields,
}) => {
  if (!tenant_id) throw new Error('tenant_id e obrigatorio');
  if (!label) throw new Error('nome do tipo de servico e obrigatorio');
  await validateServiceReferences(tenant_id, { initial_stage, initial_status, initial_department_id });
  const days = default_due_days === '' || default_due_days === undefined ? null : Number(default_due_days);
  if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) throw new Error('Prazo padrao invalido.');
  const tasks = validateSuggestedTasks(suggested_tasks) || [];
  const fields = validateCustomFields(custom_fields) || [];
  await validateSuggestedTaskReferences(tenant_id, tasks);
  const finalCode = code ? slugCode(code) : slugCode(label);
  const { rows } = await pool.query(
    `INSERT INTO tenant_service_types (
       tenant_id, code, label, color, sort_order, description,
       initial_stage, initial_status, default_due_days, initial_department_id,
       suggested_tasks, custom_fields
     )
     VALUES ($1,$2,$3,$4,COALESCE($5,0),$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
     RETURNING *`,
    [
      tenant_id, finalCode, label, norm(color), sort_order, norm(description),
      norm(initial_stage), norm(initial_status), days, norm(initial_department_id),
      JSON.stringify(tasks), JSON.stringify(fields),
    ]
  );
  return rows[0];
};

const updateServiceType = async (id, input, tenant_id) => {
  const {
    label, color, sort_order, active, description,
    initial_stage, initial_status, default_due_days, initial_department_id,
  } = input;
  await validateServiceReferences(tenant_id, input);
  const days = default_due_days === undefined ? undefined
    : (default_due_days === '' || default_due_days === null ? null : Number(default_due_days));
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) {
    throw new Error('Prazo padrao invalido.');
  }
  const tasks = validateSuggestedTasks(input.suggested_tasks);
  const fields = validateCustomFields(input.custom_fields);
  await validateSuggestedTaskReferences(tenant_id, tasks);
  const { rows } = await pool.query(
    `UPDATE tenant_service_types SET
       label = COALESCE($1, label),
       color = COALESCE($2, color),
       sort_order = COALESCE($3, sort_order),
       active = COALESCE($4, active),
       description = CASE WHEN $5::boolean THEN $6 ELSE description END,
       initial_stage = CASE WHEN $7::boolean THEN $8 ELSE initial_stage END,
       initial_status = CASE WHEN $9::boolean THEN $10 ELSE initial_status END,
       default_due_days = CASE WHEN $11::boolean THEN $12 ELSE default_due_days END,
       initial_department_id = CASE WHEN $13::boolean THEN $14 ELSE initial_department_id END,
       suggested_tasks = CASE WHEN $15::boolean THEN $16::jsonb ELSE suggested_tasks END,
       custom_fields = CASE WHEN $17::boolean THEN $18::jsonb ELSE custom_fields END,
       updated_at = NOW()
     WHERE id = $19 AND tenant_id = $20 RETURNING *`,
    [
      norm(label), norm(color), sort_order, active,
      description !== undefined, norm(description),
      initial_stage !== undefined, norm(initial_stage),
      initial_status !== undefined, norm(initial_status),
      default_due_days !== undefined, days ?? null,
      initial_department_id !== undefined, norm(initial_department_id),
      tasks !== undefined, JSON.stringify(tasks || []),
      fields !== undefined, JSON.stringify(fields || []),
      id, tenant_id,
    ]
  );
  return rows[0];
};

const deleteServiceType = async (id, tenant_id) => {
  const { rows } = await pool.query(
    'DELETE FROM tenant_service_types WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return rows[0];
};

// ── Categorias de documento (por tenant) ─────────────────────────────────────
const listDocumentCategories = async (tenant_id, { includeInactive = false } = {}) => {
  const where = includeInactive ? '' : ' AND active = TRUE';
  const { rows } = await pool.query(
    `SELECT * FROM document_categories WHERE tenant_id = $1${where} ORDER BY sort_order ASC, name ASC`,
    [tenant_id]
  );
  return rows;
};

const createDocumentCategory = async ({ tenant_id, name, description, color, sort_order }) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!name) throw new Error('nome da categoria é obrigatório');
  const { rows } = await pool.query(
    `INSERT INTO document_categories (tenant_id, name, description, color, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0)) RETURNING *`,
    [tenant_id, name, norm(description), norm(color), sort_order]
  );
  return rows[0];
};

const updateDocumentCategory = async (id, { name, description, color, sort_order, active }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE document_categories SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       color = COALESCE($3, color),
       sort_order = COALESCE($4, sort_order),
       active = COALESCE($5, active),
       updated_at = NOW()
     WHERE id = $6 AND tenant_id = $7 RETURNING *`,
    [norm(name), norm(description), norm(color), sort_order, active, id, tenant_id]
  );
  return rows[0];
};

const deleteDocumentCategory = async (id, tenant_id) => {
  const { rows } = await pool.query(
    'DELETE FROM document_categories WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return rows[0];
};

// ── Agregado: toda a configuração operacional do tenant numa chamada ──────────
const getFullConfig = async (tenant_id, opts = {}) => {
  const [departments, stages, statuses, serviceTypes, documentCategories] = await Promise.all([
    listDepartments(tenant_id, opts),
    listStages(tenant_id, opts),
    listStatuses(tenant_id, opts),
    listServiceTypes(tenant_id, opts),
    listDocumentCategories(tenant_id, opts),
  ]);
  return { departments, stages, statuses, serviceTypes, documentCategories };
};

module.exports = {
  slugCode,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listStages, createStage, updateStage, deleteStage,
  listStatuses, createStatus, updateStatus, deleteStatus,
  listServiceTypes, createServiceType, updateServiceType, deleteServiceType,
  listDocumentCategories, createDocumentCategory, updateDocumentCategory, deleteDocumentCategory,
  getFullConfig,
  CUSTOM_FIELD_TYPES, validateCustomFields, validateSuggestedTasks,
};
