'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const tasks = require('../models/taskModels');
const automation = require('../services/automationService');
const alerts = require('../models/alertModels');
const fineLogs = require('../models/fineLogModels');
const saas = require('../models/saasModels');
const { checkPermission, requireAdmin, requireAdminOrManager } = require('../middlewares/checkPermission');

const fail = (res, error, status = 500) => {
  console.error('[tasks]', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Erro interno do servidor.' : (error?.message || 'Nao foi possivel concluir a acao.'),
  });
};

async function logTaskEvent(req, task, action, oldValue = null, newValue = null, details = {}) {
  await Promise.all([
    fineLogs.createFineLog({
      tenant_id: req.tenantId,
      fine_id: task.fine_id,
      action,
      field_name: 'pendencia',
      old_value: oldValue,
      new_value: newValue || task.title,
      user_id: req.userId,
    }),
    saas.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action,
      entity_type: 'pendencia',
      entity_id: task.id,
      entity_name: task.title,
      description: `Pendencia ${task.title}`,
      metadata: { fine_id: task.fine_id, ...details },
    }),
    pool.query(
      'UPDATE fines SET last_moved_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2',
      [task.fine_id, req.tenantId]
    ),
  ]);
}

async function alertAssignment(req, task, previousAssignee = null) {
  if (!task.assignee_id || task.assignee_id === req.userId || task.assignee_id === previousAssignee) return;
  await alerts.createAlert({
    tenant_id: req.tenantId,
    recipient_id: task.assignee_id,
    type: 'pendencia_atribuida',
    title: 'Nova pendencia atribuida',
    message: task.title,
    entity_type: 'pendencia',
    entity_id: task.id,
    internal_link: `/dashboard?module=multas&tab=meu-trabalho&task=${task.id}`,
    dedupe_key: `task-assigned:${task.id}:${task.assignee_id}:${task.updated_at || task.created_at}`,
  });
}

router.get('/types', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await tasks.listTaskTypes(req.tenantId, { includeInactive: req.query.all === '1' && req.userRole === 'admin' }) });
  } catch (error) { fail(res, error); }
});

router.post('/types', requireAdmin, async (req, res) => {
  try {
    const type = await tasks.createTaskType(req.tenantId, req.body || {});
    res.status(201).json({ success: true, data: type });
  } catch (error) { fail(res, error, 400); }
});

router.put('/types/:id', requireAdmin, async (req, res) => {
  try {
    const type = await tasks.updateTaskType(req.tenantId, req.params.id, req.body || {});
    if (!type) return res.status(404).json({ success: false, error: 'Tipo nao encontrado.' });
    res.json({ success: true, data: type });
  } catch (error) { fail(res, error, 400); }
});

router.get('/', checkPermission('fines:read'), async (req, res) => {
  try {
    const filters = { ...req.query };
    // "mine=1" e sempre derivado do token, nunca de um user_id enviado pelo cliente.
    if (req.query.mine === '1' || req.query.mine === 'true') filters.assignee_id = req.userId;
    res.json({ success: true, ...(await tasks.listTasks(req.tenantId, filters)) });
  } catch (error) { fail(res, error); }
});

router.post('/', checkPermission('fines:update'), async (req, res) => {
  try {
    const result = await tasks.createTask(req.tenantId, req.userId, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    await logTaskEvent(req, result.task, 'task_created', null, result.task.title, {
      assignee_id: result.task.assignee_id,
      priority: result.task.priority,
      due_at: result.task.due_at,
    });
    await alertAssignment(req, result.task);
    const full = await tasks.getTask(req.tenantId, result.task.id);
    res.status(201).json({ success: true, data: full });
  } catch (error) { fail(res, error); }
});

router.get('/:id', checkPermission('fines:read'), async (req, res) => {
  try {
    const task = await tasks.getTask(req.tenantId, req.params.id);
    if (!task) return res.status(404).json({ success: false, error: 'Pendencia nao encontrada.' });
    res.json({ success: true, data: task });
  } catch (error) { fail(res, error); }
});

router.put('/:id', checkPermission('fines:update'), async (req, res) => {
  try {
    const result = await tasks.updateTask(req.tenantId, req.params.id, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    await logTaskEvent(req, result.task, 'task_updated', result.previous.title, result.task.title);
    await alertAssignment(req, result.task, result.previous.assignee_id);
    res.json({ success: true, data: await tasks.getTask(req.tenantId, req.params.id) });
  } catch (error) { fail(res, error, 400); }
});

async function transition(req, res, target) {
  try {
    const result = await tasks.transitionTask(req.tenantId, req.params.id, target, req.userId, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    if (result.changed) {
      const action = target === 'concluida' ? 'task_completed'
        : target === 'cancelada' ? 'task_cancelled'
          : target === 'aberta' ? 'task_reopened' : 'task_status_changed';
      await logTaskEvent(req, result.task, action, result.previous.status, target, {
        completion_result: result.task.completion_result,
      });
      if (target === 'concluida') {
        await automation.enqueueEvent(req.tenantId, {
          event_type: 'task_completed',
          entity_type: 'task',
          entity_id: result.task.id,
          fine_id: result.task.fine_id,
          actor_user_id: req.userId,
        }, `task-completed:${result.task.id}:${result.task.completed_at}`);
      }
    }
    res.json({ success: true, data: await tasks.getTask(req.tenantId, req.params.id) });
  } catch (error) { fail(res, error, 400); }
}

router.post('/:id/start', checkPermission('fines:update'), (req, res) => transition(req, res, 'em_andamento'));
router.post('/:id/wait', checkPermission('fines:update'), (req, res) => transition(req, res, 'aguardando_terceiro'));
router.post('/:id/complete', checkPermission('fines:update'), (req, res) => transition(req, res, 'concluida'));
router.post('/:id/cancel', checkPermission('fines:update'), (req, res) => transition(req, res, 'cancelada'));
router.post('/:id/reopen', requireAdminOrManager, (req, res) => transition(req, res, 'aberta'));

router.delete('/:id', requireAdminOrManager, async (req, res) => {
  try {
    const task = await tasks.softDeleteTask(req.tenantId, req.params.id, req.userId);
    if (!task) return res.status(404).json({ success: false, error: 'Pendencia nao encontrada.' });
    await logTaskEvent(req, task, 'task_archived', task.status, 'arquivada');
    res.json({ success: true, data: { id: task.id } });
  } catch (error) { fail(res, error); }
});

module.exports = router;
