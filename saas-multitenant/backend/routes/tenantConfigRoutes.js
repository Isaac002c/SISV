'use strict';
// =============================================================================
// /api/config — catálogos operacionais por tenant (setores, etapas, status,
// tipos de serviço). Leitura liberada a qualquer usuário autenticado (a
// operação de processos precisa das listas). Escrita restrita ao ADMIN/GESTOR.
// Tudo escopado por req.tenantId (nunca por id vindo do corpo/URL).
// =============================================================================
const express = require('express');
const router = express.Router();
const cfg = require('../models/tenantConfigModels');
const checklistModel = require('../models/serviceTypeDocModels');
const { requireAdmin } = require('../middlewares/checkPermission');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, err, status = 500) => {
  console.error('[config] erro:', err.message || err);
  const dup = /duplicate key|unique/i.test(err.message || '');
  res.status(dup ? 409 : status).json({
    success: false,
    error: dup ? 'Já existe um item com esse nome.' : (err.message || 'Erro ao processar.'),
  });
};

// ── Config completa (uma chamada) ────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.all === '1' && req.userRole === 'admin';
    ok(res, await cfg.getFullConfig(req.tenantId, { includeInactive }));
  } catch (e) { fail(res, e); }
});

// Cada catálogo tem o mesmo formato de rotas. Factory para não repetir código.
function mount(path, api) {
  router.get(`/${path}`, async (req, res) => {
    try {
      const includeInactive = req.query.all === '1' && req.userRole === 'admin';
      ok(res, await api.list(req.tenantId, { includeInactive }));
    } catch (e) { fail(res, e); }
  });
  router.post(`/${path}`, requireAdmin, async (req, res) => {
    try { ok(res, await api.create({ ...req.body, tenant_id: req.tenantId }), 201); }
    catch (e) { fail(res, e, 400); }
  });
  router.put(`/${path}/:id`, requireAdmin, async (req, res) => {
    try {
      const updated = await api.update(req.params.id, req.body, req.tenantId);
      if (!updated) return res.status(404).json({ success: false, error: 'Item não encontrado.' });
      ok(res, updated);
    } catch (e) { fail(res, e, 400); }
  });
  router.delete(`/${path}/:id`, requireAdmin, async (req, res) => {
    try {
      const removed = await api.remove(req.params.id, req.tenantId);
      if (!removed) return res.status(404).json({ success: false, error: 'Item não encontrado.' });
      ok(res, removed);
    } catch (e) { fail(res, e); }
  });
}

mount('departments', {
  list: cfg.listDepartments, create: cfg.createDepartment,
  update: cfg.updateDepartment, remove: cfg.deleteDepartment,
});
mount('stages', {
  list: cfg.listStages, create: cfg.createStage,
  update: cfg.updateStage, remove: cfg.deleteStage,
});
mount('statuses', {
  list: cfg.listStatuses, create: cfg.createStatus,
  update: cfg.updateStatus, remove: cfg.deleteStatus,
});
mount('service-types', {
  list: cfg.listServiceTypes, create: cfg.createServiceType,
  update: cfg.updateServiceType, remove: cfg.deleteServiceType,
});
mount('document-categories', {
  list: cfg.listDocumentCategories, create: cfg.createDocumentCategory,
  update: cfg.updateDocumentCategory, remove: cfg.deleteDocumentCategory,
});

// ── Checklist documental por tipo de serviço ─────────────────────────────────
router.get('/service-types/:id/checklist', async (req, res) => {
  try { ok(res, await checklistModel.getChecklist(req.tenantId, req.params.id)); }
  catch (e) { fail(res, e); }
});
router.put('/service-types/:id/checklist', requireAdmin, async (req, res) => {
  try {
    const r = await checklistModel.setChecklist(req.tenantId, req.params.id, req.body?.items || []);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    ok(res, await checklistModel.getChecklist(req.tenantId, req.params.id));
  } catch (e) { fail(res, e, 400); }
});

module.exports = router;
