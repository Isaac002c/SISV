'use strict';
// =============================================================================
// requireModule — gating de módulos por tenant (spec §16/§18).
//
// Um módulo desabilitado para o tenant não deve ser acessível nem pela API.
// A fonte de verdade é tenants.modules (JSONB). Regra:
//   • modules == NULL  → todos os módulos habilitados (padrão legado; preserva
//                        os tenants existentes do Nexos).
//   • modules == [..]  → só as chaves listadas estão habilitadas.
//
// Cache curto (por processo) para não consultar o banco a cada request.
// =============================================================================
const { getTenantModules } = require('../models/tenantModels');

const TTL_MS = 30 * 1000;
const cache = new Map(); // tenantId -> { modules, ts }

const isModuleEnabled = (modules, key) => modules == null || modules.includes(key);

async function resolveModules(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.modules;
  const modules = await getTenantModules(tenantId);
  cache.set(tenantId, { modules, ts: Date.now() });
  return modules;
}

function clearModuleCache(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

// Factory: bloqueia a rota se o módulo não estiver habilitado para o tenant.
function requireModule(moduleKey) {
  return async (req, res, next) => {
    try {
      if (!req.tenantId) {
        return res.status(401).json({ success: false, error: 'Tenant não identificado.' });
      }
      const modules = await resolveModules(req.tenantId);
      if (isModuleEnabled(modules, moduleKey)) return next();
      return res.status(403).json({
        success: false,
        error: 'Módulo não habilitado para esta empresa.',
        module: moduleKey,
      });
    } catch (err) {
      console.error('[requireModule] erro:', err.message);
      // Falha fechada só para o gating; não derruba o request por erro de infra.
      return res.status(500).json({ success: false, error: 'Erro ao validar módulo.' });
    }
  };
}

module.exports = { requireModule, isModuleEnabled, clearModuleCache };
