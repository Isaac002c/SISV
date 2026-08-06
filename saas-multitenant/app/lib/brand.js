// =============================================================================
// brand.js — Identidade institucional do sistema (SISV) e metadados de módulos.
//
// A identidade padrão é do SISV (Sinal Verde) / desenvolvido pela TELUN, mas é
// CONFIGURÁVEL por variáveis de ambiente (NEXT_PUBLIC_*) — sem logo fabricada;
// a marca é por tema (cor) até os arquivos definitivos chegarem.
//
// A identidade específica do tenant (nome/logo/cor) continua vindo do registro
// do tenant após o login (sidebar/header). Este arquivo cobre a "casca"
// institucional (login, rodapé, metadados) e o catálogo de módulos.
// =============================================================================

export const APP_BRAND = {
  name: process.env.NEXT_PUBLIC_APP_NAME || 'SISV',
  tagline: process.env.NEXT_PUBLIC_APP_TAGLINE || 'Sistema Integrado da Sinal Verde',
  developer: process.env.NEXT_PUBLIC_APP_DEVELOPER || 'TELUN',
  color: process.env.NEXT_PUBLIC_BRAND_COLOR || '#A56FFF',
  colorDark: process.env.NEXT_PUBLIC_BRAND_COLOR_DARK || '#3B1F6A',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'contato@chronostek.com.br',
  assets: {
    logo: process.env.NEXT_PUBLIC_TELUN_LOGO_URL || '/brand/telun/logo_telun.jpeg',
    symbol: process.env.NEXT_PUBLIC_TELUN_SYMBOL_URL || '/brand/telun/logo_telun.jpeg',
    favicon: process.env.NEXT_PUBLIC_SISV_FAVICON_URL || '/brand/telun/logo_telun.jpeg',
  },
};

export const APP_INITIAL = (APP_BRAND.name || 'S').charAt(0).toUpperCase();

// Rótulo institucional discreto para rodapé/login.
export const DEVELOPED_BY = `Desenvolvido pela ${APP_BRAND.developer}`;
export const SOLUTION_BY = `Uma solução ${APP_BRAND.developer}`;

// Módulos conhecidos do sistema. `modules == null` no tenant = todos habilitados.
export function isModuleEnabled(tenantModules, key) {
  if (tenantModules == null) return true;          // legado/sem restrição
  if (!Array.isArray(tenantModules)) return true;
  return tenantModules.includes(key);
}

// Lê os módulos habilitados do tenant a partir do objeto salvo no login.
export function getTenantModules(tenant) {
  const m = tenant?.modules;
  if (m == null) return null;
  if (Array.isArray(m)) return m;
  try { const p = JSON.parse(m); return Array.isArray(p) ? p : null; }
  catch { return null; }
}

// Acesso individual salvo no login. `null` preserva usuários legados até que
// um administrador atribua um perfil modular pela tela de usuários.
export function getUserModules(user) {
  const modules = user?.module_access;
  if (modules == null) return null;
  if (Array.isArray(modules)) return modules;
  try {
    const parsed = JSON.parse(modules);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isUserModuleEnabled(userModules, key) {
  if (userModules == null) return true;
  if (!Array.isArray(userModules)) return true;
  return userModules.includes(key);
}

export function hasAnyUserModule(userModules, keys) {
  if (userModules == null) return true;
  if (!Array.isArray(keys) || keys.length === 0) return true;
  return keys.some((key) => userModules.includes(key));
}

// Recursos comerciais exibidos em seletores e atalhos. A interface replica a
// mesma combinação role + module_access validada pelo backend; assim uma opção
// indisponível não aparece para depois terminar em 403.
const COMMERCIAL_ENTITY_ACCESS = {
  client: {
    modules: ['sales', 'backoffice', 'payments', 'operations'],
    roles: ['admin', 'manager', 'operator', 'seller', 'viewer', 'front_office', 'back_office', 'sales_backoffice', 'finance', 'operations'],
  },
  order: {
    modules: ['sales', 'backoffice'],
    roles: ['admin', 'manager', 'viewer', 'front_office', 'back_office', 'sales_backoffice', 'finance', 'operations'],
  },
  sale: {
    modules: ['sales', 'backoffice'],
    roles: ['admin', 'manager', 'viewer', 'front_office', 'back_office', 'sales_backoffice', 'finance', 'operations'],
  },
  service_order: {
    modules: ['operations'],
    roles: ['admin', 'manager', 'viewer', 'front_office', 'back_office', 'sales_backoffice', 'finance', 'operations'],
  },
};

export function canUserAccessCommercialEntity(user, entityType) {
  const rule = COMMERCIAL_ENTITY_ACCESS[entityType];
  if (!rule || !user) return false;
  if (user.role === 'admin') return true;
  if (!rule.roles.includes(user.role)) return false;
  return hasAnyUserModule(getUserModules(user), rule.modules);
}
