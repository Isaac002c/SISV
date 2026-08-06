'use strict';

const express = require('express');
const sla = require('../services/slaService');
const { checkPermission } = require('../middlewares/checkPermission');

const router = express.Router();
const fail = (res, error) => {
  console.error('[sla]', error?.message || error);
  res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
};
const send = (res, result, status = 200) => {
  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false, code: result.code, error: result.error,
      current_version: result.current_version,
    });
  }
  return res.status(status).json({ success: true, data: result.data });
};

router.get('/calendars', checkPermission('sla:view'), async (req, res) => {
  try { res.json({ success: true, data: await sla.listCalendars(req.tenantId) }); }
  catch (error) { fail(res, error); }
});

router.post('/calendars', checkPermission('sla:configure'), async (req, res) => {
  try { send(res, await sla.saveCalendar(req.tenantId, req.userId, req.body || {}), 201); }
  catch (error) { fail(res, error); }
});

router.put('/calendars/:id', checkPermission('sla:configure'), async (req, res) => {
  try { send(res, await sla.saveCalendar(req.tenantId, req.userId, req.body || {}, req.params.id)); }
  catch (error) { fail(res, error); }
});

router.get('/rules', checkPermission('sla:view'), async (req, res) => {
  try { res.json({ success: true, data: await sla.listRules(req.tenantId) }); }
  catch (error) { fail(res, error); }
});

router.post('/rules', checkPermission('sla:configure'), async (req, res) => {
  try { send(res, await sla.saveRule(req.tenantId, req.userId, req.body || {}), 201); }
  catch (error) { fail(res, error); }
});

router.put('/rules/:id', checkPermission('sla:configure'), async (req, res) => {
  try { send(res, await sla.saveRule(req.tenantId, req.userId, req.body || {}, req.params.id)); }
  catch (error) { fail(res, error); }
});

router.get('/instances', checkPermission('sla:view'), async (req, res) => {
  try { res.json({ success: true, data: await sla.listInstances(req.tenantId, req.query) }); }
  catch (error) { fail(res, error); }
});

router.post('/instances/:id/pause', checkPermission('sla:pause'), async (req, res) => {
  try { send(res, await sla.pauseInstance(req.tenantId, req.params.id, req.userId, req.body || {})); }
  catch (error) { fail(res, error); }
});

router.post('/instances/:id/resume', checkPermission('sla:resume'), async (req, res) => {
  try { send(res, await sla.resumeInstance(req.tenantId, req.params.id, req.userId, req.body || {})); }
  catch (error) { fail(res, error); }
});

router.post('/instances/:id/complete', checkPermission('sla:pause'), async (req, res) => {
  try { send(res, await sla.finishInstance(req.tenantId, req.params.id, req.userId, 'met')); }
  catch (error) { fail(res, error); }
});

router.post('/instances/:id/cancel', checkPermission('sla:cancel'), async (req, res) => {
  try { send(res, await sla.finishInstance(req.tenantId, req.params.id, req.userId, 'cancelled')); }
  catch (error) { fail(res, error); }
});

router.post('/evaluate', checkPermission('sla:configure'), async (req, res) => {
  try { res.json({ success: true, data: await sla.evaluateDue(req.tenantId) }); }
  catch (error) { fail(res, error); }
});

router.get('/dashboard', checkPermission('sla:dashboard'), async (req, res) => {
  try { res.json({ success: true, data: await sla.dashboard(req.tenantId, req.query) }); }
  catch (error) { fail(res, error); }
});

module.exports = router;
