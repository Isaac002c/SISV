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
  color: process.env.NEXT_PUBLIC_BRAND_COLOR || '#15803d',
  colorDark: process.env.NEXT_PUBLIC_BRAND_COLOR_DARK || '#052e16',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'suporte@telun.com.br',
};

export const APP_INITIAL = (APP_BRAND.name || 'S').charAt(0).toUpperCase();

// Rótulo institucional discreto para rodapé/login.
export const DEVELOPED_BY = `Desenvolvido pela ${APP_BRAND.developer}`;

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
