const pool = require('../config/db');

// ============================================
// FINE DOCUMENTS MODEL - Documentos dos Processos
// Metadados: categoria, nome original/armazenado, observação, e SOFT-DELETE
// (status ativo/arquivado/removido) preservando o histórico.
// ============================================

const norm = (v) => (v === '' || v === undefined ? null : v);

const SELECT_COLS = `fd.*, u.name as uploaded_by_name, dc.name as category_name, dc.color as category_color`;
const JOINS = `
  LEFT JOIN users u ON fd.uploaded_by = u.id
  LEFT JOIN document_categories dc ON fd.category_id = dc.id AND dc.tenant_id = fd.tenant_id`;

// CREATE - Criar novo documento do processo
const createFineDocument = async ({
  tenant_id, fine_id, name, file_url, file_type, file_size, category,
  category_id, notes, stored_name, original_name, uploaded_by
}) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!fine_id) throw new Error('fine_id é obrigatório');
  if (!name) throw new Error('nome é obrigatório');
  if (!file_url) throw new Error('URL do arquivo é obrigatória');

  const result = await pool.query(
    `INSERT INTO fine_documents(
      tenant_id, fine_id, name, file_url, file_type, file_size, category,
      category_id, notes, stored_name, original_name, uploaded_by, status
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ativo') RETURNING *`,
    [
      tenant_id, fine_id, name, file_url, file_type, file_size, category || 'outro',
      norm(category_id), norm(notes), norm(stored_name), norm(original_name), uploaded_by
    ]
  );
  return result.rows[0];
};

// READ - Listar documentos por processo (por padrão, exclui removidos).
const getDocumentsByFine = async (fine_id, tenant_id, { includeRemoved = false } = {}) => {
  const statusFilter = includeRemoved ? '' : ` AND fd.status <> 'removido'`;
  const result = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM fine_documents fd ${JOINS}
     WHERE fd.fine_id = $1 AND fd.tenant_id = $2${statusFilter}
     ORDER BY fd.uploaded_at DESC`,
    [fine_id, tenant_id]
  );
  return result.rows;
};

// READ - Buscar documento por ID (tenant-scoped)
const getDocumentById = async (id, tenant_id) => {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} FROM fine_documents fd ${JOINS}
     WHERE fd.id = $1 AND fd.tenant_id = $2`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// READ - Listar documentos por categoria
const getDocumentsByCategory = async (fine_id, category, tenant_id) => {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} FROM fine_documents fd ${JOINS}
     WHERE fd.fine_id = $1 AND fd.category = $2 AND fd.tenant_id = $3 AND fd.status <> 'removido'
     ORDER BY fd.uploaded_at DESC`,
    [fine_id, category, tenant_id]
  );
  return result.rows;
};

// READ - Contar documentos ativos por processo
const countDocumentsByFine = async (fine_id, tenant_id) => {
  const result = await pool.query(
    `SELECT COUNT(*) as total FROM fine_documents
     WHERE fine_id = $1 AND tenant_id = $2 AND status <> 'removido'`,
    [fine_id, tenant_id]
  );
  return result.rows[0].total;
};

// UPDATE - Editar metadados (nome, categoria, observação)
const updateFineDocumentMeta = async (id, { name, category_id, notes }, tenant_id) => {
  const result = await pool.query(
    `UPDATE fine_documents SET
       name = COALESCE($1, name),
       category_id = $2,
       notes = $3,
       updated_at = NOW()
     WHERE id = $4 AND tenant_id = $5 RETURNING *`,
    [norm(name), norm(category_id), norm(notes), id, tenant_id]
  );
  return result.rows[0];
};

// UPDATE - Arquivar (soft): status='arquivado'
const archiveFineDocument = async (id, tenant_id) => {
  const result = await pool.query(
    `UPDATE fine_documents SET status='arquivado', archived_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 AND status<>'removido' RETURNING *`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// UPDATE - Restaurar para ativo
const restoreFineDocument = async (id, tenant_id) => {
  const result = await pool.query(
    `UPDATE fine_documents SET status='ativo', archived_at=NULL, removed_at=NULL, removed_by=NULL, updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// UPDATE - Remoção LÓGICA (soft-delete): status='removido', preserva histórico
const softRemoveFineDocument = async (id, tenant_id, removed_by) => {
  const result = await pool.query(
    `UPDATE fine_documents SET status='removido', removed_at=NOW(), removed_by=$3, updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [id, tenant_id, norm(removed_by)]
  );
  return result.rows[0];
};

// DELETE - Remoção física (hard) — usado apenas na cascata de exclusão do processo
const deleteFineDocument = async (id, tenant_id) => {
  const result = await pool.query(
    'DELETE FROM fine_documents WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return result.rows[0];
};

const deleteDocumentsByFine = async (fine_id, tenant_id) => {
  const result = await pool.query(
    'DELETE FROM fine_documents WHERE fine_id = $1 AND tenant_id = $2 RETURNING *',
    [fine_id, tenant_id]
  );
  return result.rows;
};

module.exports = {
  createFineDocument,
  getDocumentsByFine,
  getDocumentById,
  getDocumentsByCategory,
  countDocumentsByFine,
  updateFineDocumentMeta,
  archiveFineDocument,
  restoreFineDocument,
  softRemoveFineDocument,
  deleteFineDocument,
  deleteDocumentsByFine,
};
