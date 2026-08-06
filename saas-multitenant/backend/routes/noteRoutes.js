'use strict';

const express = require('express');
const router = express.Router();
const notes = require('../models/noteModels');
const fineLogs = require('../models/fineLogModels');
const saas = require('../models/saasModels');
const { checkPermission } = require('../middlewares/checkPermission');

const fail = (res, error, status = 500) => {
  console.error('[notes]', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Erro interno do servidor.' : (error?.message || 'Nao foi possivel concluir a acao.'),
  });
};

async function audit(req, note, action, oldValue = null) {
  await Promise.all([
    fineLogs.createFineLog({
      tenant_id: req.tenantId,
      fine_id: note.fine_id,
      action,
      field_name: 'nota',
      old_value: oldValue,
      new_value: note.content,
      user_id: req.userId,
    }),
    saas.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action,
      entity_type: 'nota',
      entity_id: note.id,
      description: 'Nota interna do processo',
      metadata: { fine_id: note.fine_id },
    }),
  ]);
}

router.get('/process/:fineId', checkPermission('fines:read'), async (req, res) => {
  try {
    const includeDeleted = req.query.all === '1' && (req.userRole === 'admin' || req.userRole === 'manager');
    res.json({ success: true, data: await notes.listNotes(req.tenantId, req.params.fineId, { includeDeleted }) });
  } catch (error) { fail(res, error); }
});

router.post('/process/:fineId', checkPermission('fines:update'), async (req, res) => {
  try {
    const result = await notes.createNote(req.tenantId, req.params.fineId, req.userId, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    await audit(req, result.note, 'note_created');
    const all = await notes.listNotes(req.tenantId, req.params.fineId);
    res.status(201).json({ success: true, data: all.find((item) => item.id === result.note.id) || result.note });
  } catch (error) { fail(res, error); }
});

router.put('/:id', checkPermission('fines:update'), async (req, res) => {
  try {
    const result = await notes.updateNote(req.tenantId, req.params.id, req.userId, req.userRole, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    await audit(req, result.note, 'note_updated', result.previous.content);
    res.json({ success: true, data: result.note });
  } catch (error) { fail(res, error, 400); }
});

router.delete('/:id', checkPermission('fines:update'), async (req, res) => {
  try {
    const result = await notes.deleteNote(req.tenantId, req.params.id, req.userId, req.userRole);
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    await audit(req, result.note, 'note_archived');
    res.json({ success: true, data: { id: result.note.id } });
  } catch (error) { fail(res, error); }
});

module.exports = router;
