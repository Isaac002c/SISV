'use strict';

const express = require('express');
const automation = require('../services/automationService');
const queue = require('../services/queueService');
const { checkPermission } = require('../middlewares/checkPermission');

const router = express.Router();
const fail = (res, error) => {
  console.error('[automations]', error?.message || error);
  res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
};
const send = (res, result, status = 200) => {
  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false, code: result.code, error: result.error, validation: result.validation,
    });
  }
  return res.status(status).json({ success: true, data: result.data });
};

router.get('/', checkPermission('automation:view'), async (req, res) => {
  try { res.json({ success: true, data: await automation.listDefinitions(req.tenantId) }); }
  catch (error) { fail(res, error); }
});

router.post('/validate', checkPermission('automation:create'), (req, res) => {
  res.json({ success: true, data: automation.validateDefinition(req.body || {}) });
});

router.post('/', checkPermission('automation:create'), async (req, res) => {
  try { send(res, await automation.createDefinition(req.tenantId, req.userId, req.body || {}), 201); }
  catch (error) { fail(res, error); }
});

router.get('/executions', checkPermission('automation:view'), async (req, res) => {
  try { res.json({ success: true, data: await automation.listExecutions(req.tenantId, req.query) }); }
  catch (error) { fail(res, error); }
});

router.get('/monitoring', checkPermission('automation:view'), async (req, res) => {
  try { res.json({ success: true, data: await queue.monitoring(req.tenantId) }); }
  catch (error) { fail(res, error); }
});

router.get('/jobs', checkPermission('automation:view'), async (req, res) => {
  try { res.json({ success: true, data: await queue.listJobs(req.tenantId, req.query) }); }
  catch (error) { fail(res, error); }
});

router.post('/jobs/:id/retry', checkPermission('automation:reprocess'), async (req, res) => {
  try { send(res, await queue.retry(req.tenantId, req.userId, req.params.id)); }
  catch (error) { fail(res, error); }
});

router.post('/jobs/:id/cancel', checkPermission('automation:disable'), async (req, res) => {
  try { send(res, await queue.cancel(req.tenantId, req.userId, req.params.id)); }
  catch (error) { fail(res, error); }
});

router.get('/:id', checkPermission('automation:view'), async (req, res) => {
  try {
    const data = await automation.loadDefinition(req.tenantId, req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Automacao nao encontrada.' });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
});

router.put('/:id', checkPermission('automation:edit'), async (req, res) => {
  try { send(res, await automation.updateDefinition(req.tenantId, req.userId, req.params.id, req.body || {})); }
  catch (error) { fail(res, error); }
});

router.post('/:id/activate', checkPermission('automation:activate'), async (req, res) => {
  try { send(res, await automation.setStatus(req.tenantId, req.userId, req.params.id, 'active')); }
  catch (error) { fail(res, error); }
});

router.post('/:id/disable', checkPermission('automation:disable'), async (req, res) => {
  try { send(res, await automation.setStatus(req.tenantId, req.userId, req.params.id, 'disabled')); }
  catch (error) { fail(res, error); }
});

module.exports = router;
