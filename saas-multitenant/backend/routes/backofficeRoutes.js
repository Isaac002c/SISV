'use strict';

// =============================================================================
// backofficeRoutes.js — /api/backoffice
//   /queues          filas operacionais com contador e itens (§16, §36)
//   /dashboard       dashboard executivo (§36)
//   /reports/:type   relatorios com filtro de periodo e CSV seguro (§37)
//   /clients/:id     visao 360 do cliente, carregada por aba (§34)
//   /search          busca global ampliada (§35)
// =============================================================================

const express = require('express');
const router = express.Router();

const backoffice = require('../models/backofficeModels');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'backoffice';

/** Contadores de todas as filas — cada um abre a fila correspondente. */
router.get('/queues', checkPermission('backoffice:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: await backoffice.queueSummary(req.tenantId) });
}));

router.get('/queues/:key', checkPermission('backoffice:read'), handle(scope, async (req, res) => {
  const queue = await backoffice.queueItems(req.tenantId, req.params.key, req.query);
  if (!queue) return res.status(404).json({ success: false, error: 'Fila nao encontrada.' });
  res.json({ success: true, ...queue });
}));

router.get('/dashboard', checkPermission('backoffice:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: await backoffice.executiveDashboard(req.tenantId, req.query) });
}));

router.get('/reports', checkPermission('reports:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: backoffice.REPORT_KEYS.map((key) => ({ key, label: backoffice.REPORTS[key].label })),
  });
}));

router.get('/reports/:type', checkPermission('reports:read'), handle(scope, async (req, res) => {
  const result = await backoffice.report(req.tenantId, req.params.type, req.query);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  if (req.query.format === 'csv') {
    // Exportacao exige permissao propria, alem da leitura do relatorio.
    const { rolePermissions } = require('../middlewares/checkPermission');
    const role = req.userRole || 'viewer';
    const allowed = role === 'admin' || (rolePermissions[role] || []).includes('reports:export');
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'Sem permissao para exportar relatorios.' });
    }
    return sendCsv(res, result.rows, `sisv-${req.params.type}.csv`);
  }
  res.json({ success: true, data: result });
}));

// ── Visao 360 do cliente ─────────────────────────────────────────────────────

router.get('/clients/:id/overview', checkPermission('clients:read'), handle(scope, async (req, res) => {
  const overview = await backoffice.clientOverview(req.tenantId, req.params.id);
  if (!overview) return res.status(404).json({ success: false, error: 'Cliente nao encontrado.' });
  res.json({ success: true, data: { ...overview, tabs: backoffice.CLIENT_TABS } });
}));

/** Uma aba por requisicao: a tela carrega sob demanda, sem puxar tudo (§34). */
router.get('/clients/:id/tabs/:tab', checkPermission('clients:read'), handle(scope, async (req, res) => {
  const tab = await backoffice.clientTab(req.tenantId, req.params.id, req.params.tab, req.query);
  if (!tab) return res.status(404).json({ success: false, error: 'Aba nao encontrada.' });
  res.json({ success: true, ...tab });
}));

router.get('/search', checkPermission('clients:read'), handle(scope, async (req, res) => {
  const rows = await backoffice.globalSearch(req.tenantId, req.query.q, req.query);
  res.json({ success: true, data: rows });
}));

module.exports = router;
