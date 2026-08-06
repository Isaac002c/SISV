'use strict';

const express = require('express');
const workflow = require('../services/workflowService');
const { checkPermission } = require('../middlewares/checkPermission');

const router = express.Router();

const fail = (res, error) => {
  console.error('[workflow]', error?.message || error);
  res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
};

const send = (res, result, successStatus = 200) => {
  if (!result?.ok) {
    return res.status(result?.status || 400).json({
      success: false,
      code: result?.code,
      error: result?.error || result?.message,
      message: result?.message,
      requirements: result?.requirements,
      allowed_transitions: result?.allowed_transitions,
      validation: result?.validation,
      current_version: result?.current_version,
    });
  }
  return res.status(result.status || successStatus).json({
    success: true,
    data: result.flow || result.data,
    transition: result.transition,
    requirements: result.requirements,
    migration: result.migration,
    validation: result.validation,
    replayed: Boolean(result.replayed),
  });
};

router.get('/flows', checkPermission('workflow:view'), async (req, res) => {
  try {
    res.json({ success: true, data: await workflow.listFlows(req.tenantId, req.query) });
  } catch (error) { fail(res, error); }
});

router.post('/flows/validate', checkPermission('workflow:create'), (req, res) => {
  res.json({ success: true, data: workflow.validateStructure(req.body || {}) });
});

router.post('/flows', checkPermission('workflow:create'), async (req, res) => {
  try { send(res, await workflow.createDraft(req.tenantId, req.userId, req.body || {}), 201); }
  catch (error) { fail(res, error); }
});

router.get('/flows/:id', checkPermission('workflow:view'), async (req, res) => {
  try {
    const data = await workflow.loadDefinition(req.tenantId, req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Fluxo nao encontrado.' });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
});

router.put('/flows/:id', checkPermission('workflow:edit'), async (req, res) => {
  try {
    send(res, await workflow.updateDraft(
      req.tenantId, req.userId, req.params.id,
      req.body?.expected_version, req.body || {}
    ));
  } catch (error) { fail(res, error); }
});

router.post('/flows/:id/publish', checkPermission('workflow:publish'), async (req, res) => {
  try {
    send(res, await workflow.publish(
      req.tenantId, req.userId, req.params.id, req.body?.expected_version
    ));
  } catch (error) { fail(res, error); }
});

router.post('/flows/:id/clone', checkPermission('workflow:create'), async (req, res) => {
  try { send(res, await workflow.cloneVersion(req.tenantId, req.userId, req.params.id), 201); }
  catch (error) { fail(res, error); }
});

router.post('/flows/:id/disable', checkPermission('workflow:disable'), async (req, res) => {
  try { send(res, await workflow.disable(req.tenantId, req.userId, req.params.id)); }
  catch (error) { fail(res, error); }
});

router.get('/processes/:id/context', checkPermission('workflow:view'), async (req, res) => {
  try {
    const data = await workflow.getProcessContext(req.tenantId, req.params.id, {
      id: req.userId, role: req.userRole,
    });
    if (!data) return res.status(404).json({ success: false, error: 'Processo nao encontrado.' });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
});

router.post('/processes/:id/transitions/:transitionId', checkPermission('workflow:transition'), async (req, res) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key;
    send(res, await workflow.transitionProcess(
      req.tenantId, req.params.id, req.params.transitionId,
      { id: req.userId, role: req.userRole },
      { ...(req.body || {}), idempotency_key: idempotencyKey }
    ));
  } catch (error) { fail(res, error); }
});

router.post('/migrations/preview', checkPermission('workflow:migrate'), async (req, res) => {
  try { send(res, await workflow.previewMigration(req.tenantId, req.userId, req.body || {}), 201); }
  catch (error) { fail(res, error); }
});

router.post('/migrations/:id/confirm', checkPermission('workflow:migrate'), async (req, res) => {
  try { send(res, await workflow.confirmMigration(req.tenantId, req.userId, req.params.id, req.body || {})); }
  catch (error) { fail(res, error); }
});

module.exports = router;
