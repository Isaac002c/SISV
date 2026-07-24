import { apiRequest, openDocument } from './api.js';

// =============================================================================
// processesAPI — operação dos processos de CNH (SISV). Fala com /api/processes.
// A listagem devolve { rows, total, limit, offset } (paginação no backend).
// =============================================================================

// Fila/lista com filtros combináveis. Retorna { rows, total, limit, offset }.
export const listProcesses = async (filters = {}) => {
  const clean = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined && v !== null)
  );
  const qs = new URLSearchParams(clean).toString();
  const res = await apiRequest(`/api/processes${qs ? `?${qs}` : ''}`);
  return { rows: res.rows || [], total: res.total || 0, limit: res.limit, offset: res.offset };
};

export const getProcess = async (id) => (await apiRequest(`/api/processes/${id}`)).data;

export const getProcessDashboard = async () =>
  (await apiRequest('/api/processes/dashboard')).data;

// Distribuição em lote: aplica responsável e/ou setor a vários processos.
// Passe apenas as chaves que quer alterar (seller_id/department_id; null = limpar).
export const batchAssign = async (ids, changes = {}) => {
  const body = { ids };
  if ('seller_id' in changes) body.seller_id = changes.seller_id;
  if ('department_id' in changes) body.department_id = changes.department_id;
  return (await apiRequest('/api/processes/batch/assign', { method: 'POST', body })).data;
};

export const createProcess = async (body) =>
  (await apiRequest('/api/processes', { method: 'POST', body })).data;

export const updateProcess = async (id, body) =>
  (await apiRequest(`/api/processes/${id}`, { method: 'PUT', body })).data;

export const moveStage = async (id, stage) =>
  (await apiRequest(`/api/processes/${id}/stage`, { method: 'PATCH', body: { stage } })).data;

export const changeStatus = async (id, status) =>
  (await apiRequest(`/api/processes/${id}/status`, { method: 'PATCH', body: { status } })).data;

export const changeSeller = async (id, seller_id) =>
  (await apiRequest(`/api/processes/${id}/seller`, { method: 'PATCH', body: { seller_id } })).data;

export const changeDepartment = async (id, department_id) =>
  (await apiRequest(`/api/processes/${id}/department`, { method: 'PATCH', body: { department_id } })).data;

export const addNote = async (id, note) =>
  (await apiRequest(`/api/processes/${id}/notes`, { method: 'POST', body: { note } })).data;

export const finalizeProcess = async (id, body = {}) =>
  (await apiRequest(`/api/processes/${id}/finalize`, { method: 'POST', body })).data;

export const reopenProcess = async (id, body = {}) =>
  (await apiRequest(`/api/processes/${id}/reopen`, { method: 'POST', body })).data;

export const deleteProcess = async (id) =>
  (await apiRequest(`/api/processes/${id}`, { method: 'DELETE' })).data;

export const addDocument = async (id, body) =>
  (await apiRequest(`/api/processes/${id}/documents`, { method: 'POST', body })).data;

export const removeDocument = async (id, documentId) =>
  (await apiRequest(`/api/processes/${id}/documents/${documentId}`, { method: 'DELETE' })).data;

export const updateDocumentMeta = async (id, documentId, meta) =>
  (await apiRequest(`/api/processes/${id}/documents/${documentId}`, { method: 'PATCH', body: meta })).data;

export const archiveDocument = async (id, documentId) =>
  (await apiRequest(`/api/processes/${id}/documents/${documentId}/archive`, { method: 'POST' })).data;

export const restoreDocument = async (id, documentId) =>
  (await apiRequest(`/api/processes/${id}/documents/${documentId}/restore`, { method: 'POST' })).data;

// Visualiza (inline) ou baixa via endpoint controlado (envia token no header).
export const viewDocument = (id, documentId) =>
  openDocument(`/api/processes/${id}/documents/${documentId}/download?inline=1`);
export const downloadDocument = (id, documentId, filename) =>
  openDocument(`/api/processes/${id}/documents/${documentId}/download`, { download: true, filename });

export const getLogs = async (id) => (await apiRequest(`/api/processes/${id}/logs`)).data;
