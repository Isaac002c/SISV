'use strict';

const express = require('express');
const router = express.Router();
const alerts = require('../models/alertModels');
const { checkPermission } = require('../middlewares/checkPermission');

const fail = (res, error) => {
  console.error('[alerts]', error?.message || error);
  res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
};

router.get('/', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, ...(await alerts.listAlerts(req.tenantId, req.userId, req.query)) });
  } catch (error) { fail(res, error); }
});

router.post('/mark-all-read', checkPermission('fines:read'), async (req, res) => {
  try {
    const updated = await alerts.markAllRead(req.tenantId, req.userId);
    res.json({ success: true, data: { updated } });
  } catch (error) { fail(res, error); }
});

// Rotina idempotente controlada, restrita ao contexto autenticado. Ela cria
// alertas apenas para responsaveis do mesmo tenant e usa dedupe_key.
router.post('/refresh-deadlines', checkPermission('fines:read'), async (req, res) => {
  try {
    const result = await alerts.generateDeadlineAlerts(req.tenantId, {
      dueSoonDays: req.body?.due_soon_days,
    });
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error); }
});

router.patch('/:id/read', checkPermission('fines:read'), async (req, res) => {
  try {
    const alert = await alerts.markRead(req.tenantId, req.userId, req.params.id);
    if (!alert) return res.status(404).json({ success: false, error: 'Alerta nao encontrado.' });
    res.json({ success: true, data: alert });
  } catch (error) { fail(res, error); }
});

module.exports = router;
