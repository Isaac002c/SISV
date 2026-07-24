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

const createServiceType = async ({ tenant_id, code, label, color, sort_order }) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!label) throw new Error('nome do tipo de serviço é obrigatório');
  const finalCode = code ? slugCode(code) : slugCode(label);
  const { rows } = await pool.query(
    `INSERT INTO tenant_service_types (tenant_id, code, label, color, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0)) RETURNING *`,
    [tenant_id, finalCode, label, norm(color), sort_order]
  );
  return rows[0];
};

const updateServiceType = async (id, { label, color, sort_order, active }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE tenant_service_types SET
       label = COALESCE($1, label),
       color = COALESCE($2, color),
       sort_order = COALESCE($3, sort_order),
       active = COALESCE($4, active),
       updated_at = NOW()
     WHERE id = $5 AND tenant_id = $6 RETURNING *`,
    [norm(label), norm(color), sort_order, active, id, tenant_id]
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
};
