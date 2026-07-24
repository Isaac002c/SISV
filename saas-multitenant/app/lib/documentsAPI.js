import { apiRequest, openDocument } from './api.js';

// Listar todos os documentos
export const getDocuments = async (filters = {}) => {
  const params = new URLSearchParams(filters).toString();
  return (await apiRequest(`/api/documents${params ? `?${params}` : ''}`)).data;
};

// Buscar documento por ID
export const getDocumentById = async (id) =>
  (await apiRequest(`/api/documents/${id}`)).data;

// Buscar documentos por contrato
export const getDocumentsByContract = async (contractId) =>
  (await apiRequest(`/api/documents/contract/${contractId}`)).data;

// Buscar documentos por cliente
export const getDocumentsByClient = async (clientId) =>
  (await apiRequest(`/api/documents/client/${clientId}`)).data;

// Estatísticas de documentos
export const getDocumentStats = async () =>
  (await apiRequest('/api/documents/stats')).data;

// Criar documento
export const createDocument = async (documentData) =>
  (await apiRequest('/api/documents', {
    method: 'POST',
    body: documentData,
  })).data;

// Atualizar documento
export const updateDocument = async (id, documentData) =>
  (await apiRequest(`/api/documents/${id}`, {
    method: 'PUT',
    body: documentData,
  })).data;

// Renomear documento — atualiza SOMENTE o nome de exibição (não reenvia o arquivo).
export const renameDocument = async (id, displayName) =>
  (await apiRequest(`/api/documents/${id}/rename`, {
    method: 'PATCH',
    body: { display_name: displayName },
  })).data;

// Deletar documento (hard — mantido para compatibilidade; SISV usa soft-delete)
export const deleteDocument = async (id) =>
  (await apiRequest(`/api/documents/${id}`, {
    method: 'DELETE',
  })).data;

// Soft-delete (SISV): arquivar / restaurar / remover logicamente
export const archiveDocument = async (id) =>
  (await apiRequest(`/api/documents/${id}/archive`, { method: 'POST' })).data;
export const restoreDocument = async (id) =>
  (await apiRequest(`/api/documents/${id}/restore`, { method: 'POST' })).data;
export const removeDocument = async (id) =>
  (await apiRequest(`/api/documents/${id}/remove`, { method: 'POST' })).data;

// Download/visualização controlados pelo backend
export const viewDocument = (id) => openDocument(`/api/documents/${id}/download?inline=1`);
export const downloadDocument = (id, filename) => openDocument(`/api/documents/${id}/download`, { download: true, filename });
