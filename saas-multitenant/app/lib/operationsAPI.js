import { apiRequest, downloadAuthenticated } from './api';

const query = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined && value !== null));
  const qs = new URLSearchParams(clean).toString();
  return qs ? `?${qs}` : '';
};

export const getMyWork = async () => (await apiRequest('/api/operations/my-work')).data;
export const getAttention = async () => (await apiRequest('/api/operations/attention')).data;
export const getDashboardV2 = async (filters = {}) =>
  (await apiRequest(`/api/operations/dashboard${query(filters)}`)).data;
export const getQuality = async (filters = {}) =>
  (await apiRequest(`/api/operations/quality${query(filters)}`)).data;
export const getOperationSettings = async () => (await apiRequest('/api/operations/settings')).data;
export const updateOperationSettings = async (body) =>
  (await apiRequest('/api/operations/settings', { method: 'PUT', body })).data;

export const listTasks = async (filters = {}) => {
  const response = await apiRequest(`/api/tasks${query(filters)}`);
  return { rows: response.rows || [], total: response.total || 0 };
};
export const listTaskTypes = async () => (await apiRequest('/api/tasks/types')).data;
export const createTask = async (body) => (await apiRequest('/api/tasks', { method: 'POST', body })).data;
export const updateTask = async (id, body) => (await apiRequest(`/api/tasks/${id}`, { method: 'PUT', body })).data;
export const taskAction = async (id, action, body = {}) =>
  (await apiRequest(`/api/tasks/${id}/${action}`, { method: 'POST', body })).data;

export const listAlerts = async (filters = {}) => {
  const response = await apiRequest(`/api/alerts${query(filters)}`);
  return { rows: response.rows || [], total: response.total || 0, unread: response.unread || 0 };
};
export const readAlert = async (id) => (await apiRequest(`/api/alerts/${id}/read`, { method: 'PATCH' })).data;
export const readAllAlerts = async () => (await apiRequest('/api/alerts/mark-all-read', { method: 'POST' })).data;
export const refreshDeadlineAlerts = async () => (await apiRequest('/api/alerts/refresh-deadlines', { method: 'POST' })).data;

export const listViews = async (type = 'processos') =>
  (await apiRequest(`/api/operations/saved-views?type=${encodeURIComponent(type)}`)).data;
export const createView = async (body) => (await apiRequest('/api/operations/saved-views', { method: 'POST', body })).data;
export const updateView = async (id, body) => (await apiRequest(`/api/operations/saved-views/${id}`, { method: 'PUT', body })).data;
export const deleteView = async (id) => (await apiRequest(`/api/operations/saved-views/${id}`, { method: 'DELETE' })).data;

export const globalSearch = async (q) =>
  (await apiRequest(`/api/operations/search?q=${encodeURIComponent(q)}`)).data;
export const getAudit = async (filters = {}) => {
  const response = await apiRequest(`/api/operations/audit${query(filters)}`);
  return { rows: response.rows || [], total: response.total || 0 };
};
export const getReport = async (type, filters = {}) =>
  (await apiRequest(`/api/operations/reports/${type}${query(filters)}`)).data;
export const exportReport = (type, filters = {}) =>
  downloadAuthenticated(`/api/operations/reports/${type}${query({ ...filters, format: 'csv' })}`, {
    filename: `sisv-${type}.csv`,
  });
export const exportProcesses = (body) =>
  downloadAuthenticated('/api/operations/export/processes', {
    method: 'POST',
    body,
    filename: `processos-${new Date().toISOString().slice(0, 10)}.csv`,
  });

export const createNote = async (fineId, body) =>
  (await apiRequest(`/api/notes/process/${fineId}`, { method: 'POST', body })).data;
export const updateNote = async (id, body) =>
  (await apiRequest(`/api/notes/${id}`, { method: 'PUT', body })).data;
export const deleteNote = async (id) =>
  (await apiRequest(`/api/notes/${id}`, { method: 'DELETE' })).data;

export const advancedBatch = async (ids, body) =>
  (await apiRequest('/api/processes/batch/actions', {
    method: 'POST',
    body: { ids, request_id: crypto.randomUUID(), ...body },
  })).data;
