import { apiRequest } from './api.js';
 
// ============================================
// CLIENTS API - Standardized
// ============================================
 
// Listar todos os clientes
export const getClients = async ({ archived = false } = {}) => {
  const data = await apiRequest(`/api/clients${archived ? '?archived=1' : ''}`);
  return data.data;
};
 
// Buscar cliente por ID
export const getClientById = async (id) => {
  const data = await apiRequest(`/api/clients/${id}`);
  return data.data;
};
 
// Pesquisar clientes
export const searchClients = async (query) => {
  const data = await apiRequest(`/api/clients/search?q=${encodeURIComponent(query)}`);
  return data.data;
};
 
// Estatísticas de clientes
export const getClientStats = async () => {
  const data = await apiRequest('/api/clients/stats');
  return data.data;
};
 
// Criar cliente
export const createClient = async (clientData) => {
  const data = await apiRequest('/api/clients', {
    method: 'POST',
    body: clientData, // ← sem JSON.stringify, o api.js já faz isso
  });
  return data.data;
};
 
// Atualizar cliente
export const updateClient = async (id, clientData) => {
  const data = await apiRequest(`/api/clients/${id}`, {
    method: 'PUT',
    body: clientData, // ← sem JSON.stringify, o api.js já faz isso
  });
  return data.data;
};
 
// Deletar cliente
export const deleteClient = async (id, reason = '') => {
  const data = await apiRequest(`/api/clients/${id}`, {
    method: 'DELETE',
    body: { reason },
  });
  return data.data;
};

// Restaurar cliente excluído (admin)
export const restoreClient = async (id) => {
  const data = await apiRequest(`/api/clients/${id}/restore`, {
    method: 'POST',
  });
  return data.data;
};

// Campos adicionais e obrigatoriedade por servico.
const fieldQuery = ({ serviceIds = [], clientId } = {}) => {
  const params = new URLSearchParams();
  if (serviceIds.length) params.set('service_ids', serviceIds.join(','));
  if (clientId) params.set('client_id', clientId);
  const value = params.toString();
  return value ? `?${value}` : '';
};

export const getClientFields = async (context = {}) =>
  (await apiRequest(`/api/client-fields${fieldQuery(context)}`)).data;

export const createClientField = async (body) =>
  (await apiRequest('/api/client-fields', { method: 'POST', body })).data;

export const updateClientField = async (id, body) =>
  (await apiRequest(`/api/client-fields/${id}`, { method: 'PUT', body })).data;

export const getServiceClientFields = async (serviceId) =>
  (await apiRequest(`/api/client-fields/services/${serviceId}/requirements`)).data;

export const setServiceClientFields = async (serviceId, fields) =>
  (await apiRequest(`/api/client-fields/services/${serviceId}/requirements`, {
    method: 'PUT', body: { fields },
  })).data;

export const validateOrderClientFields = async (orderId) =>
  (await apiRequest(`/api/client-fields/orders/${orderId}/validation`)).data;
