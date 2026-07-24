'use strict';
// =============================================================================
// /api/tenant — identidade e configuração do tenant atual.
//   GET  /api/tenant/me   → identidade + módulos habilitados (qualquer usuário).
//   PUT  /api/tenant      → atualizar identidade/branding/módulos (ADMIN/GESTOR).
// Sempre escopado por req.tenantId — nunca aceita tenant_id do corpo/URL.
// =============================================================================
const express = require('express');
const router = express.Router();
const tenantModel = require('../models/tenantModels');
const { getUsersByTenant } = require('../models/userModels');
const { requireAdmin } = require('../middlewares/checkPermission');
const { clearModuleCache } = require('../middlewares/requireModule');

// Identidade que o frontend consome (branding + módulos habilitados).
router.get('/me', async (req, res) => {
  try {
    const t = await tenantModel.getTenantFull(req.tenantId);
    if (!t) return res.status(404).json({ success: false, error: 'Empresa não encontrada.' });
    res.json({
      success: true,
      data: {
        id: t.id,
        name: t.name,
        slug: t.slug,
        logo_url: t.logo_url,
        brand_color: t.brand_color,
        brand_color_dark: t.brand_color_dark,
        tagline: t.tagline,
        developer: t.developer || null,
        // NULL no banco = todos habilitados; devolve null para o frontend liberar tudo.
        modules: t.modules ?? null,
      },
    });
  } catch (err) {
    console.error('[tenant/me] erro:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar empresa.' });
  }
});

// Usuários atribuíveis (responsáveis) do tenant — id/nome/role. Liberado a
// qualquer usuário autenticado: a operação precisa da lista para redistribuir.
router.get('/users', async (req, res) => {
  try {
    const users = await getUsersByTenant(req.tenantId);
    res.json({ success: true, data: users.map((u) => ({ id: u.id, name: u.name, role: u.role })) });
  } catch (err) {
    console.error('[tenant/users] erro:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar usuários.' });
  }
});

// Atualiza identidade/branding/módulos (admin do próprio tenant).
router.put('/', requireAdmin, async (req, res) => {
  try {
    const allowed = ['name', 'logo_url', 'brand_color', 'brand_color_dark', 'tagline', 'developer', 'modules'];
    const fields = {};
    for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
    const updated = await tenantModel.updateTenant(req.tenantId, fields);
    clearModuleCache(req.tenantId);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[tenant PUT] erro:', err.message);
    res.status(400).json({ success: false, error: 'Erro ao atualizar empresa.' });
  }
});

module.exports = router;
