import { apiRequest } from './api.js';

// ✅ ROTAS CORRETAS - User Management

export const getUsers = async () =>
  await apiRequest('/api/users/management');

export const getUsersStats = async () =>
  await apiRequest('/api/users/management/stats');

export const getAccessOptions = async () =>
  await apiRequest('/api/users/management/access-options');

export const getRoles = async () =>
  await apiRequest('/api/users/management/roles');

export const getUserById = async (id) =>
  await apiRequest(`/api/users/management/${id}`);

export const createUser = async (userData) =>
  await apiRequest('/api/users/management', {
    method: 'POST',
    body: userData,
  });

export const updateUser = async (id, userData) =>
  await apiRequest(`/api/users/management/${id}`, {
    method: 'PUT',
    body: userData,
  });

export const changePassword = async (id, password) =>
  await apiRequest(`/api/users/management/${id}/password`, {
    method: 'PATCH',
    body: { password },
  });

export const deleteUser = async (id) =>
  await apiRequest(`/api/users/management/${id}`, {
    method: 'DELETE',
  });

export const getUserWorkload = async (id) =>
  await apiRequest(`/api/users/management/${id}/workload`);

export const deactivateUser = async (id, redistribute_to = null) =>
  await apiRequest(`/api/users/management/${id}/deactivate`, {
    method: 'POST',
    body: { redistribute_to },
  });
