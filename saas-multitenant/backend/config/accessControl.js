'use strict';

const USER_MODULES = [
  {
    key: 'sales',
    label: 'Vendas',
    description: 'Clientes, pedidos, propostas e acompanhamento comercial.',
    permissionPrefixes: ['clients', 'companies', 'contracts', 'suppliers', 'catalog', 'pricing', 'orders', 'sales', 'commercial_docs'],
  },
  {
    key: 'backoffice',
    label: 'Back Office',
    description: 'Conferência documental, validação e organização das filas.',
    permissionPrefixes: ['clients', 'documents', 'fines', 'tasks', 'workflow', 'sla', 'backoffice', 'orders', 'receivables', 'sales', 'commercial_docs'],
  },
  {
    key: 'payments',
    label: 'Pagamentos',
    description: 'Recebimentos, pagamentos, comissões e documentos fiscais.',
    permissionPrefixes: ['clients', 'reports', 'billing', 'finance', 'receivables', 'payments', 'payables', 'commissions', 'fiscal'],
  },
  {
    key: 'operations',
    label: 'Operação',
    description: 'Processos, tarefas, ordens de serviço e execução.',
    permissionPrefixes: ['clients', 'documents', 'fines', 'tasks', 'operations', 'service_orders', 'closure', 'workflow', 'sla', 'commercial_docs'],
  },
];

const ACCESS_PROFILES = [
  {
    key: 'sales',
    label: 'Vendas',
    description: 'Atendimento comercial e criação de pedidos.',
    role: 'front_office',
    modules: ['sales'],
    backofficeLevel: 0,
  },
  {
    key: 'sales_backoffice_l1',
    label: 'Vendas + Back Office N1',
    description: 'Vende e executa a conferência operacional de primeiro nível.',
    role: 'sales_backoffice',
    modules: ['sales', 'backoffice'],
    backofficeLevel: 1,
  },
  {
    key: 'backoffice_l1',
    label: 'Back Office N1',
    description: 'Confere documentos e organiza filas, sem aprovações críticas.',
    role: 'back_office',
    modules: ['backoffice'],
    backofficeLevel: 1,
  },
  {
    key: 'admin',
    label: 'Administrador',
    description: 'Acesso total, pagamentos e aprovações de segundo nível.',
    role: 'admin',
    modules: USER_MODULES.map((module) => module.key),
    backofficeLevel: 2,
  },
  {
    key: 'custom',
    label: 'Personalizado',
    description: 'Módulos definidos individualmente pelo administrador.',
    role: 'operator',
    modules: [],
    backofficeLevel: 0,
  },
];

const ELEVATED_LEVEL_2_PERMISSIONS = new Set([
  'backoffice:validate',
  'payments:validate',
  'payments:reverse',
  'sales:confirm',
  'sales:cancel',
  'payables:pay',
  'commissions:confirm',
  'closure:archive',
  'closure:reopen',
]);

const moduleKeys = new Set(USER_MODULES.map((module) => module.key));

function normalizeModules(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((key) => moduleKeys.has(key)))];
}

function getProfile(key) {
  return ACCESS_PROFILES.find((profile) => profile.key === key) || null;
}

function modulesForPermission(permission) {
  const prefix = String(permission || '').split(':')[0];
  return USER_MODULES
    .filter((module) => module.permissionPrefixes.includes(prefix))
    .map((module) => module.key);
}

function hasModuleForPermission(userModules, permission) {
  if (!Array.isArray(userModules)) return true;
  const acceptedModules = modulesForPermission(permission);
  if (acceptedModules.length === 0) return true;
  return acceptedModules.some((module) => userModules.includes(module));
}

module.exports = {
  USER_MODULES,
  ACCESS_PROFILES,
  ELEVATED_LEVEL_2_PERMISSIONS,
  normalizeModules,
  getProfile,
  modulesForPermission,
  hasModuleForPermission,
};
