'use strict';
// =============================================================================
// /api/processes — API operacional dos PROCESSOS de CNH (SISV).
//
// Opera sobre a mesma entidade `fines` (o "processo" do sistema), com semântica
// adaptada à Sinal Verde: etapas/status/tipos de serviço/setores configuráveis
// por tenant, responsável atual, movimentação, redistribuição, finalização,
// reabertura, observações, documentos e histórico automático (gerado no backend).
//
// Regras de segurança:
//   • Todo acesso é escopado por req.tenantId (isolamento multi-tenant).
//   • Etapa/status são validados contra o catálogo do próprio tenant.
//   • seller_id/department_id são validados como pertencentes ao tenant (anti-IDOR).
//   • Autorização crítica no backend (checkPermission / requireAdmin).
// =============================================================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const pool = require('../config/db');
const fineModel = require('../models/fineModels');
const fineDocumentModel = require('../models/fineDocumentModels');
const fineLogModel = require('../models/fineLogModels');
const fileStorage = require('../services/fileStorage');
const { checkPermission, requireAdmin } = require('../middlewares/checkPermission');

// Envia um documento (do disco) validando tenant e caminho. Usado no download
// controlado — nunca expõe caminho interno nem serve arquivo de outro tenant.
function streamDocument(res, tenantId, doc, disposition) {
  const storedName = doc.stored_name || fileStorage.storedNameFromUrl(doc.file_url);
  const resolved = fileStorage.resolvePath(tenantId, storedName);
  if (!resolved.ok || !fs.existsSync(resolved.filePath)) {
    return res.status(404).json({ success: false, error: 'Arquivo não encontrado.' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    `${disposition}; filename="${encodeURIComponent(doc.name || doc.original_name || storedName)}"`);
  if (doc.file_type) res.setHeader('Content-Type', doc.file_type);
  return res.sendFile(resolved.filePath);
}

const fail = (res, err, status = 500) => {
  // Loga o erro REAL no servidor (diagnóstico) mas NUNCA expõe detalhes internos
  // do banco ao usuário em erros 500. Mensagens de validação (4xx) são controladas.
  console.error('[processes] erro:', err && err.message ? err.message : err);
  const clientMsg = status >= 500 ? 'Erro interno do servidor.' : (err.message || 'Erro ao processar.');
  res.status(status).json({ success: false, error: clientMsg });
};

// ── Helpers de validação escopados por tenant ────────────────────────────────
async function stageExists(tenantId, code) {
  if (!code) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM process_stages WHERE tenant_id = $1 AND code = $2 AND active = TRUE',
    [tenantId, code]
  );
  return rows.length > 0;
}
async function statusExists(tenantId, code) {
  if (!code) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM process_statuses WHERE tenant_id = $1 AND code = $2 AND active = TRUE',
    [tenantId, code]
  );
  return rows.length > 0;
}
async function sellerName(tenantId, id) {
  if (!id) return null;
  const { rows } = await pool.query(
    'SELECT name FROM users WHERE id = $1 AND tenant_id = $2', [id, tenantId]
  );
  return rows[0] ? rows[0].name : undefined; // undefined = não pertence ao tenant
}
async function departmentName(tenantId, id) {
  if (!id) return null;
  const { rows } = await pool.query(
    'SELECT name FROM departments WHERE id = $1 AND tenant_id = $2', [id, tenantId]
  );
  return rows[0] ? rows[0].name : undefined;
}

// ── LISTA / FILA de processos ────────────────────────────────────────────────
// GET /api/processes?stage=&status=&seller_id=&department_id=&tenant_service_type_id=
//   &client_id=&q=&finalized=&pending=&stale_days=&date_from=&date_to=
//   &limit=&offset=&sort_by=&sort_dir=
router.get('/', checkPermission('fines:read'), async (req, res) => {
  try {
    const result = await fineModel.listProcesses(req.tenantId, req.query);
    res.json({ success: true, ...result });
  } catch (e) { fail(res, e); }
});

// GET /api/processes/dashboard — dashboard operacional
router.get('/dashboard', checkPermission('fines:read'), async (req, res) => {
  try {
    const data = await fineModel.getProcessDashboard(req.tenantId);
    res.json({ success: true, data });
  } catch (e) { fail(res, e); }
});

// POST /api/processes/batch/assign — distribuição em lote (responsável e/ou setor).
// Corpo: { ids: string[], seller_id?, department_id? }. Só toca os campos enviados.
// Escopado por tenant (ids de outro tenant são ignorados) e loga cada transferência.
router.post('/batch/assign', checkPermission('fines:update'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Selecione ao menos um processo.' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ success: false, error: 'Limite de 200 processos por lote.' });
    }
    const changeSeller = Object.prototype.hasOwnProperty.call(req.body, 'seller_id');
    const changeDept = Object.prototype.hasOwnProperty.call(req.body, 'department_id');

    // Operação transacional (all-or-nothing em caso de erro no meio).
    const result = await fineModel.batchAssign(req.tenantId, ids, {
      changeSeller, seller_id: req.body.seller_id,
      changeDept, department_id: req.body.department_id,
    });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });

    // Histórico por processo, apenas para o que mudou de fato.
    for (const c of result.changes) {
      if (c.seller) await fineLogModel.logSellerChange(req.tenantId, c.fine_id, c.seller.old, c.seller.new, req.userId);
      if (c.department) await fineLogModel.logDepartmentChange(req.tenantId, c.fine_id, c.department.old, c.department.new, req.userId);
    }
    res.json({ success: true, data: { updated: result.updated, skipped: result.skipped.length } });
  } catch (e) { fail(res, e, 400); }
});

// GET /api/processes/:id — detalhe + documentos + histórico
router.get('/:id', checkPermission('fines:read'), async (req, res) => {
  try {
    const proc = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!proc) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    const [documents, logs] = await Promise.all([
      fineDocumentModel.getDocumentsByFine(req.params.id, req.tenantId),
      fineLogModel.getLogsByFine(req.params.id, req.tenantId),
    ]);
    res.json({ success: true, data: { ...proc, documents, logs } });
  } catch (e) { fail(res, e); }
});

// POST /api/processes — criar processo
router.post('/', checkPermission('fines:create'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id) return res.status(400).json({ success: false, error: 'Cliente é obrigatório.' });

    if (b.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida para esta empresa.' });
    if (b.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status inválido para esta empresa.' });

    if (b.seller_id && (await sellerName(req.tenantId, b.seller_id)) === undefined)
      return res.status(400).json({ success: false, error: 'Responsável inválido.' });
    if (b.department_id && (await departmentName(req.tenantId, b.department_id)) === undefined)
      return res.status(400).json({ success: false, error: 'Setor inválido.' });

    const proc = await fineModel.createFine({
      tenant_id: req.tenantId,
      client_id: b.client_id,
      fine_number: b.fine_number,
      protocol_number: b.protocol_number,
      plate: b.plate,
      stage: b.stage,
      status: b.status,
      seller_id: b.seller_id || req.userId,
      department_id: b.department_id,
      tenant_service_type_id: b.tenant_service_type_id,
      infraction_date: b.opened_at || b.infraction_date,
      due_date: b.due_date,
      notes: b.notes,
    });

    await fineLogModel.logProcessCreated(
      req.tenantId, proc.id, `Processo ${b.fine_number || b.protocol_number || ''}`.trim(), req.userId
    );
    res.status(201).json({ success: true, data: proc });
  } catch (e) { fail(res, e, 400); }
});

// PUT /api/processes/:id — editar campos gerais (loga mudanças relevantes)
router.put('/:id', checkPermission('fines:update'), async (req, res) => {
  try {
    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    const b = req.body || {};

    if (b.stage && b.stage !== existing.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    if (b.status && b.status !== existing.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status inválido.' });

    const updated = await fineModel.updateFine(req.params.id, {
      fine_number: b.fine_number ?? existing.fine_number,
      plate: b.plate ?? existing.plate,
      organ: existing.organ,
      infraction_type: existing.infraction_type,
      vehicle_model: existing.vehicle_model,
      infraction_date: b.opened_at ?? existing.infraction_date,
      due_date: b.due_date ?? existing.due_date,
      defense_date: existing.defense_date,
      stage: b.stage ?? existing.stage,
      status: b.status ?? existing.status,
      value: existing.value,
      cost: existing.cost,
      paid_value: existing.paid_value,
      seller_id: existing.seller_id,
      notes: b.notes ?? existing.notes,
    }, req.tenantId);

    if (b.stage && b.stage !== existing.stage)
      await fineLogModel.logStageChange(req.tenantId, req.params.id, existing.stage, b.stage, req.userId);
    if (b.status && b.status !== existing.status)
      await fineLogModel.logStatusChange(req.tenantId, req.params.id, existing.status, b.status, req.userId);

    // protocol_number vive na tabela fines; grava direto quando enviado.
    if (b.protocol_number !== undefined && b.protocol_number !== existing.protocol_number) {
      await pool.query('UPDATE fines SET protocol_number = $1 WHERE id = $2 AND tenant_id = $3',
        [b.protocol_number || null, req.params.id, req.tenantId]);
    }
    if (b.tenant_service_type_id !== undefined && b.tenant_service_type_id !== existing.tenant_service_type_id) {
      await pool.query('UPDATE fines SET tenant_service_type_id = $1 WHERE id = $2 AND tenant_id = $3',
        [b.tenant_service_type_id || null, req.params.id, req.tenantId]);
    }

    const fresh = await fineModel.getProcessById(req.params.id, req.tenantId);
    res.json({ success: true, data: fresh });
  } catch (e) { fail(res, e, 400); }
});

// PATCH /api/processes/:id/stage — movimentar etapa
router.patch('/:id/stage', checkPermission('fines:update'), async (req, res) => {
  try {
    const { stage } = req.body || {};
    if (!stage) return res.status(400).json({ success: false, error: 'Etapa é obrigatória.' });
    if (!(await stageExists(req.tenantId, stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida para esta empresa.' });

    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const updated = await fineModel.moveProcessStage(req.params.id, stage, req.tenantId);
    if (stage !== existing.stage)
      await fineLogModel.logStageChange(req.tenantId, req.params.id, existing.stage, stage, req.userId);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// PATCH /api/processes/:id/status — mudar status
router.patch('/:id/status', checkPermission('fines:update'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ success: false, error: 'Status é obrigatório.' });
    if (!(await statusExists(req.tenantId, status)))
      return res.status(400).json({ success: false, error: 'Status inválido para esta empresa.' });

    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const updated = await fineModel.moveProcessStatus(req.params.id, status, req.tenantId);
    if (status !== existing.status)
      await fineLogModel.logStatusChange(req.tenantId, req.params.id, existing.status, status, req.userId);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// PATCH /api/processes/:id/seller — redistribuir (trocar responsável)
router.patch('/:id/seller', checkPermission('fines:update'), async (req, res) => {
  try {
    const sellerId = req.body?.seller_id || null;
    const newName = await sellerName(req.tenantId, sellerId);
    if (newName === undefined) return res.status(400).json({ success: false, error: 'Responsável inválido.' });

    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const updated = await fineModel.changeProcessSeller(req.params.id, sellerId, req.tenantId);
    await fineLogModel.logSellerChange(req.tenantId, req.params.id, existing.seller_name, newName, req.userId);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// PATCH /api/processes/:id/department — trocar setor
router.patch('/:id/department', checkPermission('fines:update'), async (req, res) => {
  try {
    const deptId = req.body?.department_id || null;
    const newName = await departmentName(req.tenantId, deptId);
    if (newName === undefined) return res.status(400).json({ success: false, error: 'Setor inválido.' });

    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const updated = await fineModel.changeProcessDepartment(req.params.id, deptId, req.tenantId);
    await fineLogModel.logDepartmentChange(req.tenantId, req.params.id, existing.department_name, newName, req.userId);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// POST /api/processes/:id/notes — registrar observação (acrescenta ao processo)
router.post('/:id/notes', checkPermission('fines:update'), async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ success: false, error: 'Observação vazia.' });

    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const merged = [existing.notes, `[${stamp}] ${note}`].filter(Boolean).join('\n');
    await pool.query('UPDATE fines SET notes = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
      [merged, req.params.id, req.tenantId]);
    await fineLogModel.logNoteAdded(req.tenantId, req.params.id, note, req.userId);
    res.status(201).json({ success: true, data: { notes: merged } });
  } catch (e) { fail(res, e, 400); }
});

// POST /api/processes/:id/finalize — finalizar
router.post('/:id/finalize', checkPermission('fines:update'), async (req, res) => {
  try {
    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const b = req.body || {};
    if (b.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa de encerramento inválida.' });
    if (b.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status de encerramento inválido.' });

    const updated = await fineModel.finalizeProcess(req.params.id, { stage: b.stage, status: b.status }, req.tenantId);
    await fineLogModel.logFinalized(req.tenantId, req.params.id, req.userId, b.reason || null);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// POST /api/processes/:id/reopen — reabrir (somente ADMIN/GESTOR)
router.post('/:id/reopen', requireAdmin, async (req, res) => {
  try {
    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    const b = req.body || {};
    if (b.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    if (b.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status inválido.' });

    const updated = await fineModel.reopenProcess(req.params.id, { stage: b.stage, status: b.status }, req.tenantId);
    await fineLogModel.logReopened(req.tenantId, req.params.id, req.userId, b.reason || null);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// DELETE /api/processes/:id — excluir (somente ADMIN/GESTOR)
router.delete('/:id', checkPermission('fines:delete'), async (req, res) => {
  try {
    const removed = await fineModel.deleteFine(req.params.id, req.tenantId);
    if (!removed) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    await fineDocumentModel.deleteDocumentsByFine(req.params.id, req.tenantId);
    res.json({ success: true, data: removed });
  } catch (e) { fail(res, e); }
});

// ── Documentos do processo ───────────────────────────────────────────────────
// Valida que category_id (quando enviado) pertence ao tenant.
async function categoryExists(tenantId, id) {
  if (!id) return true; // categoria opcional
  const { rows } = await pool.query(
    'SELECT 1 FROM document_categories WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return rows.length > 0;
}

router.get('/:id/documents', checkPermission('fines:read'), async (req, res) => {
  try {
    const includeRemoved = req.query.all === '1';
    const docs = await fineDocumentModel.getDocumentsByFine(req.params.id, req.tenantId, { includeRemoved });
    res.json({ success: true, data: docs });
  } catch (e) { fail(res, e); }
});

router.post('/:id/documents', checkPermission('fines:update'), async (req, res) => {
  try {
    const { name, file_url, file_type, file_size, category, category_id, notes, stored_name, original_name } = req.body || {};
    if (!name || !file_url) return res.status(400).json({ success: false, error: 'Nome e arquivo são obrigatórios.' });
    const proc = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!proc) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    if (!(await categoryExists(req.tenantId, category_id)))
      return res.status(400).json({ success: false, error: 'Categoria de documento inválida.' });

    const doc = await fineDocumentModel.createFineDocument({
      tenant_id: req.tenantId, fine_id: req.params.id, name, file_url, file_type, file_size,
      category: category || 'outro', category_id, notes, stored_name, original_name, uploaded_by: req.userId,
    });
    await fineLogModel.logDocumentAdded(req.tenantId, req.params.id, name, req.userId);
    res.status(201).json({ success: true, data: doc });
  } catch (e) { fail(res, e, 400); }
});

// GET download controlado — stream pelo backend, valida tenant/caminho
router.get('/:id/documents/:documentId/download', checkPermission('fines:read'), async (req, res) => {
  try {
    const doc = await fineDocumentModel.getDocumentById(req.params.documentId, req.tenantId);
    if (!doc || doc.fine_id !== req.params.id) return res.status(404).json({ success: false, error: 'Documento não encontrado.' });
    const inline = req.query.inline === '1';
    return streamDocument(res, req.tenantId, doc, inline ? 'inline' : 'attachment');
  } catch (e) { fail(res, e); }
});

// PATCH metadados (nome, categoria, observação)
router.patch('/:id/documents/:documentId', checkPermission('fines:update'), async (req, res) => {
  try {
    const existing = await fineDocumentModel.getDocumentById(req.params.documentId, req.tenantId);
    if (!existing || existing.fine_id !== req.params.id) return res.status(404).json({ success: false, error: 'Documento não encontrado.' });
    const { name, category_id, notes } = req.body || {};
    if (!(await categoryExists(req.tenantId, category_id)))
      return res.status(400).json({ success: false, error: 'Categoria inválida.' });
    const updated = await fineDocumentModel.updateFineDocumentMeta(req.params.documentId, { name, category_id, notes }, req.tenantId);
    if ((existing.category_id || null) !== (category_id || null)) {
      await fineLogModel.logFineChange({
        tenant_id: req.tenantId, fine_id: req.params.id, action: 'document_category_changed',
        field_name: 'documento', old_value: existing.category_name || 'Sem categoria',
        new_value: updated.category_id ? '(nova categoria)' : 'Sem categoria', user_id: req.userId,
      });
    }
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// POST arquivar
router.post('/:id/documents/:documentId/archive', checkPermission('fines:update'), async (req, res) => {
  try {
    const doc = await fineDocumentModel.archiveFineDocument(req.params.documentId, req.tenantId);
    if (!doc) return res.status(404).json({ success: false, error: 'Documento não encontrado.' });
    await fineLogModel.logFineChange({ tenant_id: req.tenantId, fine_id: req.params.id, action: 'document_archived', field_name: 'documento', old_value: null, new_value: doc.name, user_id: req.userId });
    res.json({ success: true, data: doc });
  } catch (e) { fail(res, e); }
});

// POST restaurar
router.post('/:id/documents/:documentId/restore', checkPermission('fines:update'), async (req, res) => {
  try {
    const doc = await fineDocumentModel.restoreFineDocument(req.params.documentId, req.tenantId);
    if (!doc) return res.status(404).json({ success: false, error: 'Documento não encontrado.' });
    await fineLogModel.logFineChange({ tenant_id: req.tenantId, fine_id: req.params.id, action: 'document_restored', field_name: 'documento', old_value: null, new_value: doc.name, user_id: req.userId });
    res.json({ success: true, data: doc });
  } catch (e) { fail(res, e); }
});

// DELETE — remoção LÓGICA (soft-delete), preservando o histórico. Admin/gestor.
router.delete('/:id/documents/:documentId', checkPermission('fines:delete'), async (req, res) => {
  try {
    const removed = await fineDocumentModel.softRemoveFineDocument(req.params.documentId, req.tenantId, req.userId);
    if (!removed) return res.status(404).json({ success: false, error: 'Documento não encontrado.' });
    await fineLogModel.logDocumentRemoved(req.tenantId, req.params.id, removed.name, req.userId);
    res.json({ success: true, data: removed });
  } catch (e) { fail(res, e); }
});

// GET /api/processes/:id/logs — histórico
router.get('/:id/logs', checkPermission('fines:read'), async (req, res) => {
  try {
    const logs = await fineLogModel.getLogsByFine(req.params.id, req.tenantId);
    res.json({ success: true, data: logs });
  } catch (e) { fail(res, e); }
});

module.exports = router;
