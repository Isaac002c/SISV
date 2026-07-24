import { apiRequest } from './api.js';

// =============================================================================
// tenantConfigAPI — catálogos operacionais do tenant (setores, etapas, status,
// tipos de serviço) e identidade do tenant. Tudo escopado pelo backend ao tenant
// autenticado.
// =============================================================================

// Config completa numa chamada. all=1 inclui inativos (somente admin).
export const getConfig = async (all = false) =>
  (await apiRequest(`/api/config${all ? '?all=1' : ''}`)).data;

const catalog = (path) => ({
  list: async (all = false) => (await apiRequest(`/api/config/${path}${all ? '?all=1' : ''}`)).data,
  create: async (body) => (await apiRequest(`/api/config/${path}`, { method: 'POST', body })).data,
  update: async (id, body) => (await apiRequest(`/api/config/${path}/${id}`, { method: 'PUT', body })).data,
  remove: async (id) => (await apiRequest(`/api/config/${path}/${id}`, { method: 'DELETE' })).data,
});

export const departments = catalog('departments');
export const stages = catalog('stages');
export const statuses = catalog('statuses');
export const serviceTypes = catalog('service-types');
export const documentCategories = catalog('document-categories');

// Checklist documental por tipo de serviço.
export const getChecklist = async (serviceTypeId) =>
  (await apiRequest(`/api/config/service-types/${serviceTypeId}/checklist`)).data;
export const setChecklist = async (serviceTypeId, items) =>
  (await apiRequest(`/api/config/service-types/${serviceTypeId}/checklist`, { method: 'PUT', body: { items } })).data;

// Usuários atribuíveis (responsáveis) do tenant.
export const getAssignees = async () => (await apiRequest('/api/tenant/users')).data;

// Identidade do tenant (branding + módulos habilitados).
export const getTenant = async () => (await apiRequest('/api/tenant/me')).data;
export const updateTenant = async (body) =>
  (await apiRequest('/api/tenant', { method: 'PUT', body })).data;
