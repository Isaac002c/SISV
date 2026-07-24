const pool = require('../config/db');

// ============================================
// FINE LOGS MODEL - Histórico das Multas
// ============================================

// CREATE - Criar novo log
const createFineLog = async ({ 
  tenant_id, fine_id, action, field_name, old_value, new_value, user_id
}) => {
  if (!tenant_id) {
    throw new Error('tenant_id é obrigatório');
  }
  if (!fine_id) {
    throw new Error('fine_id é obrigatório');
  }
  if (!action) {
    throw new Error('ação é obrigatória');
  }
  
  const result = await pool.query(
    `INSERT INTO fine_logs(
      tenant_id, fine_id, action, field_name, old_value, new_value, user_id
    ) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      tenant_id, fine_id, action, field_name, old_value, new_value, user_id
    ]
  );
  
  return result.rows[0];
};

// READ - Listar logs por multa
const getLogsByFine = async (fine_id, tenant_id) => {
  const result = await pool.query(
    `SELECT fl.*, u.name as user_name
     FROM fine_logs fl
     LEFT JOIN users u ON fl.user_id = u.id
     WHERE fl.fine_id = $1 AND fl.tenant_id = $2
     ORDER BY fl.created_at DESC`,
    [fine_id, tenant_id]
  );
  return result.rows;
};

// READ - Listar logs por ação
const getLogsByAction = async (tenant_id, action, limit = 50) => {
  const result = await pool.query(
    `SELECT fl.*, u.name as user_name, f.fine_number, c.name as client_name
     FROM fine_logs fl
     LEFT JOIN users u ON fl.user_id = u.id
     LEFT JOIN fines f ON fl.fine_id = f.id
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE fl.tenant_id = $1 AND fl.action = $2
     ORDER BY fl.created_at DESC
     LIMIT $3`,
    [tenant_id, action, limit]
  );
  return result.rows;
};

// READ - Listar todos os logs do tenant
const getAllLogs = async (tenant_id, limit = 100, offset = 0) => {
  const result = await pool.query(
    `SELECT fl.*, u.name as user_name, f.fine_number, c.name as client_name
     FROM fine_logs fl
     LEFT JOIN users u ON fl.user_id = u.id
     LEFT JOIN fines f ON fl.fine_id = f.id
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE fl.tenant_id = $1
     ORDER BY fl.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenant_id, limit, offset]
  );
  return result.rows;
};

// READ - Contar logs
const countLogs = async (tenant_id) => {
  const result = await pool.query(
    'SELECT COUNT(*) as total FROM fine_logs WHERE tenant_id = $1',
    [tenant_id]
  );
  return result.rows[0].total;
};

// READ - Estatísticas de logs
const getLogStats = async (tenant_id) => {
  const result = await pool.query(
    `SELECT 
      action,
      COUNT(*) as count
     FROM fine_logs
     WHERE tenant_id = $1
     GROUP BY action
     ORDER BY count DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Timeline de alterações (para exibir na página de detalhe)
const getFineTimeline = async (fine_id, tenant_id) => {
  const result = await pool.query(
    `SELECT fl.*, u.name as user_name
     FROM fine_logs fl
     LEFT JOIN users u ON fl.user_id = u.id
     WHERE fl.fine_id = $1 AND fl.tenant_id = $2
     ORDER BY fl.created_at ASC`,
    [fine_id, tenant_id]
  );
  return result.rows;
};

// Helper para criar log automaticamente
const logFineChange = async ({ 
  tenant_id, fine_id, action, field_name, old_value, new_value, user_id 
}) => {
  return createFineLog({
    tenant_id,
    fine_id,
    action,
    field_name,
    old_value: old_value ? String(old_value) : null,
    new_value: new_value ? String(new_value) : null,
    user_id
  });
};

// Helper para criar log de status
const logStatusChange = async (tenant_id, fine_id, old_status, new_status, user_id) => {
  return logFineChange({
    tenant_id,
    fine_id,
    action: 'status_changed',
    field_name: 'status',
    old_value: old_status,
    new_value: new_status,
    user_id
  });
};

// Helper para criar log de estágio
const logStageChange = async (tenant_id, fine_id, old_stage, new_stage, user_id) => {
  return logFineChange({
    tenant_id,
    fine_id,
    action: 'stage_changed',
    field_name: 'stage',
    old_value: old_stage,
    new_value: new_stage,
    user_id
  });
};

// Helper para criar log de documento adicionado
const logDocumentAdded = async (tenant_id, fine_id, document_name, user_id) => {
  return logFineChange({
    tenant_id,
    fine_id,
    action: 'document_added',
    field_name: 'document',
    old_value: null,
    new_value: document_name,
    user_id
  });
};

// Documento removido/inativado
const logDocumentRemoved = async (tenant_id, fine_id, document_name, user_id) => {
  return logFineChange({
    tenant_id, fine_id, action: 'document_removed', field_name: 'document',
    old_value: document_name, new_value: null, user_id
  });
};

// Troca de responsável (redistribuição). Recebe nomes legíveis para o histórico.
const logSellerChange = async (tenant_id, fine_id, old_name, new_name, user_id) => {
  return logFineChange({
    tenant_id, fine_id, action: 'seller_changed', field_name: 'responsavel',
    old_value: old_name || 'Sem responsável', new_value: new_name || 'Sem responsável', user_id
  });
};

// Troca de setor/departamento.
const logDepartmentChange = async (tenant_id, fine_id, old_name, new_name, user_id) => {
  return logFineChange({
    tenant_id, fine_id, action: 'department_changed', field_name: 'setor',
    old_value: old_name || 'Sem setor', new_value: new_name || 'Sem setor', user_id
  });
};

// Criação do processo.
const logProcessCreated = async (tenant_id, fine_id, label, user_id) => {
  return logFineChange({
    tenant_id, fine_id, action: 'created', field_name: 'processo',
    old_value: null, new_value: label || 'Processo criado', user_id
  });
};

// Observação incluída.
const logNoteAdded = async (tenant_id, fine_id, note, user_id) => {
  const snippet = String(note || '').slice(0, 240);
  return logFineChange({
    tenant_id, fine_id, action: 'note_added', field_name: 'observacao',
    old_value: null, new_value: snippet, user_id
  });
};

// Finalização.
const logFinalized = async (tenant_id, fine_id, user_id, context = null) => {
  return logFineChange({
    tenant_id, fine_id, action: 'finalized', field_name: 'processo',
    old_value: null, new_value: context || 'Processo finalizado', user_id
  });
};

// Reabertura.
const logReopened = async (tenant_id, fine_id, user_id, context = null) => {
  return logFineChange({
    tenant_id, fine_id, action: 'reopened', field_name: 'processo',
    old_value: null, new_value: context || 'Processo reaberto', user_id
  });
};

module.exports = {
  createFineLog,
  getLogsByFine,
  getLogsByAction,
  getAllLogs,
  countLogs,
  getLogStats,
  getFineTimeline,
  logFineChange,
  logStatusChange,
  logStageChange,
  logDocumentAdded,
  logDocumentRemoved,
  logSellerChange,
  logDepartmentChange,
  logProcessCreated,
  logNoteAdded,
  logFinalized,
  logReopened
};

