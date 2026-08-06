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
const taskModel = require('../models/taskModels');
const noteModel = require('../models/noteModels');
const alertModel = require('../models/alertModels');
const batchModel = require('../models/batchModels');
const saasModel = require('../models/saasModels');
const fileStorage = require('../services/fileStorage');
const workflowService = require('../services/workflowService');
const slaService = require('../services/slaService');
const automationService = require('../services/automationService');
const { checkPermission, requireAdminOrManager } = require('../middlewares/checkPermission');

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
    `SELECT name FROM users
     WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
    [id, tenantId]
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

async function getServiceTemplate(tenantId, id) {
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT * FROM tenant_service_types
     WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
    [id, tenantId]
  );
  return rows[0];
}

async function clientExists(tenantId, id) {
  const { rows } = await pool.query(
    'SELECT 1 FROM clients WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  return Boolean(rows[0]);
}

function validateCustomData(definitions, raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  const fields = Array.isArray(definitions) ? definitions.filter((field) => field?.active !== false) : [];
  for (const field of fields) {
    const value = data[field.key];
    const empty = value === undefined || value === null || value === '';
    if (field.required && empty) return { ok: false, error: `Campo obrigatorio: ${field.name}.` };
    if (empty) continue;
    if (field.type === 'numero') {
      const number = Number(value);
      if (!Number.isFinite(number)) return { ok: false, error: `Valor invalido em ${field.name}.` };
      result[field.key] = number;
    } else if (field.type === 'booleano') {
      if (typeof value !== 'boolean') return { ok: false, error: `Valor invalido em ${field.name}.` };
      result[field.key] = value;
    } else if (field.type === 'data') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return { ok: false, error: `Data invalida em ${field.name}.` };
      result[field.key] = String(value);
    } else if (field.type === 'selecao') {
      if (!Array.isArray(field.options) || !field.options.includes(value)) return { ok: false, error: `Opcao invalida em ${field.name}.` };
      result[field.key] = String(value).slice(0, 100);
    } else {
      result[field.key] = String(value).replace(/\u0000/g, '').trim().slice(0, field.type === 'texto_longo' ? 5000 : 500);
    }
  }
  return { ok: true, data: result };
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
      if (c.seller?.id && c.seller.id !== req.userId) {
        await alertModel.createAlert({
          tenant_id: req.tenantId,
          recipient_id: c.seller.id,
          type: 'processo_redistribuido',
          title: 'Processo redistribuido em lote',
          message: 'Um processo foi atribuido a voce.',
          entity_type: 'processo',
          entity_id: c.fine_id,
          internal_link: `/dashboard?module=multas&tab=processos&process=${c.fine_id}`,
          dedupe_key: `batch-process-assigned:${c.fine_id}:${c.seller.id}:${Date.now()}`,
        });
      }
    }
    res.json({ success: true, data: { updated: result.updated, skipped: result.skipped.length } });
  } catch (e) { fail(res, e, 400); }
});

// POST /api/processes/batch/actions - alteracoes operacionais avancadas,
// transacionais e idempotentes. Nunca exclui processos.
router.post('/batch/actions', requireAdminOrManager, async (req, res) => {
  try {
    const result = await batchModel.advancedBatch(req.tenantId, req.userId, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    for (const item of result.detail || []) {
      if (item.assignee_id && item.assignee_id !== req.userId) {
        await alertModel.createAlert({
          tenant_id: req.tenantId,
          recipient_id: item.assignee_id,
          type: 'processo_redistribuido',
          title: 'Processo redistribuido em lote',
          message: 'Um processo foi atribuido a voce.',
          entity_type: 'processo',
          entity_id: item.id,
          internal_link: `/dashboard?module=multas&tab=processos&process=${item.id}`,
          dedupe_key: `advanced-batch-assigned:${req.body.request_id}:${item.id}:${item.assignee_id}`,
        });
      }
    }
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error); }
});

// GET /api/processes/:id — detalhe + documentos + histórico
router.get('/:id', checkPermission('fines:read'), async (req, res) => {
  try {
    const proc = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!proc) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    const [documents, logs, taskResult, notes] = await Promise.all([
      fineDocumentModel.getDocumentsByFine(req.params.id, req.tenantId),
      fineLogModel.getLogsByFine(req.params.id, req.tenantId),
      taskModel.listTasks(req.tenantId, { fine_id: req.params.id, limit: 200 }),
      noteModel.listNotes(req.tenantId, req.params.id),
    ]);
    const workflowContext = await workflowService.getProcessContext(req.tenantId, req.params.id, {
      id: req.userId,
      role: req.userRole,
    });
    res.json({
      success: true,
      data: {
        ...proc,
        documents,
        logs,
        tasks: taskResult.rows,
        internal_notes: notes,
        workflow_context: workflowContext,
      },
    });
  } catch (e) { fail(res, e); }
});

// POST /api/processes — criar processo
router.post('/', checkPermission('fines:create'), async (req, res) => {
  let client;
  try {
    const b = req.body || {};
    if (!b.client_id || !(await clientExists(req.tenantId, b.client_id))) {
      return res.status(400).json({ success: false, error: 'Cliente invalido.' });
    }
    const template = b.tenant_service_type_id
      ? await getServiceTemplate(req.tenantId, b.tenant_service_type_id)
      : null;
    if (b.tenant_service_type_id && !template) {
      return res.status(400).json({ success: false, error: 'Tipo de servico invalido.' });
    }
    const publishedWorkflow = await workflowService.findPublishedFlow(
      req.tenantId,
      b.tenant_service_type_id
    );
    const stage = publishedWorkflow?.initial_stage_code || b.stage || template?.initial_stage || undefined;
    const status = b.status || template?.initial_status || undefined;
    const sellerId = Object.prototype.hasOwnProperty.call(b, 'seller_id') ? (b.seller_id || null) : req.userId;
    const departmentId = Object.prototype.hasOwnProperty.call(b, 'department_id')
      ? (b.department_id || null)
      : (template?.initial_department_id || null);
    let dueDate = b.due_date || null;
    if (!dueDate && Number.isInteger(Number(template?.default_due_days))) {
      const base = b.opened_at || b.infraction_date || new Date().toISOString().slice(0, 10);
      const date = new Date(`${base}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Number(template.default_due_days));
      dueDate = date.toISOString().slice(0, 10);
    }

    if (stage && !(await stageExists(req.tenantId, stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida para esta empresa.' });
    if (status && !(await statusExists(req.tenantId, status)))
      return res.status(400).json({ success: false, error: 'Status inválido para esta empresa.' });

    if (sellerId && (await sellerName(req.tenantId, sellerId)) === undefined)
      return res.status(400).json({ success: false, error: 'Responsável inválido.' });
    if (departmentId && (await departmentName(req.tenantId, departmentId)) === undefined)
      return res.status(400).json({ success: false, error: 'Setor inválido.' });

    const custom = validateCustomData(template?.custom_fields, b.custom_data);
    if (!custom.ok) return res.status(400).json({ success: false, error: custom.error });

    client = await pool.connect();
    await client.query('BEGIN');
    const proc = await fineModel.createFine({
      tenant_id: req.tenantId,
      client_id: b.client_id,
      fine_number: b.fine_number,
      protocol_number: b.protocol_number,
      plate: b.plate,
      stage,
      status,
      seller_id: sellerId,
      department_id: departmentId,
      tenant_service_type_id: b.tenant_service_type_id,
      infraction_date: b.opened_at || b.infraction_date,
      due_date: dueDate,
      notes: b.notes,
      custom_data: custom.data,
    }, client);

    if (publishedWorkflow) {
      await client.query(
        `UPDATE fines SET workflow_id=$1,workflow_version=$2,workflow_assigned_at=NOW(),
                row_version=row_version+1,updated_at=NOW()
          WHERE id=$3 AND tenant_id=$4`,
        [publishedWorkflow.id, publishedWorkflow.version, proc.id, req.tenantId]
      );
      proc.workflow_id = publishedWorkflow.id;
      proc.workflow_version = publishedWorkflow.version;
      proc.workflow_assigned_at = new Date().toISOString();
      proc.row_version = Number(proc.row_version || 1) + 1;
    }
    await slaService.startMatchingForProcess(client, req.tenantId, proc, req.userId);
    await automationService.enqueueEvent(req.tenantId, {
      event_type: 'process_created',
      entity_type: 'process',
      entity_id: proc.id,
      fine_id: proc.id,
      actor_user_id: req.userId,
      depth: 0,
      chain: [],
    }, `process-created:${proc.id}`, client);

    await client.query(
      `INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id)
       VALUES ($1,$2,'created','processo',$3,$4)`,
      [req.tenantId, proc.id, `Processo ${b.fine_number || b.protocol_number || ''}`.trim(), req.userId]
    );

    const createdTasks = [];
    if (b.create_suggested_tasks === true && Array.isArray(template?.suggested_tasks)) {
      for (const suggested of template.suggested_tasks) {
        let taskDue = null;
        if (Number.isInteger(Number(suggested.due_days))) {
          taskDue = new Date(Date.now() + Number(suggested.due_days) * 86400000).toISOString();
        }
        const result = await taskModel.createTask(req.tenantId, req.userId, {
          fine_id: proc.id,
          title: suggested.title,
          description: suggested.description,
          task_type_id: suggested.task_type_id,
          priority: suggested.priority,
          assignee_id: sellerId,
          department_id: suggested.department_id || departmentId,
          due_at: taskDue,
        }, client);
        if (!result.ok) throw new Error(result.error);
        createdTasks.push(result.task);
        await client.query(
          `INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id)
           VALUES ($1,$2,'task_created','pendencia',$3,$4)`,
          [req.tenantId, proc.id, result.task.title, req.userId]
        );
      }
    }
    await client.query('COMMIT');
    client.release();
    client = null;

    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'process_created',
      entity_type: 'processo',
      entity_id: proc.id,
      entity_name: b.fine_number || b.protocol_number || null,
      description: 'Processo criado',
      metadata: {
        template_id: template?.id || null,
        workflow_id: publishedWorkflow?.id || null,
        workflow_version: publishedWorkflow?.version || null,
        suggested_tasks_created: createdTasks.length,
      },
    });
    for (const task of createdTasks) {
      if (task.assignee_id && task.assignee_id !== req.userId) {
        await alertModel.createAlert({
          tenant_id: req.tenantId,
          recipient_id: task.assignee_id,
          type: 'pendencia_atribuida',
          title: 'Nova pendencia atribuida',
          message: task.title,
          entity_type: 'pendencia',
          entity_id: task.id,
          internal_link: `/dashboard?module=multas&tab=meu-trabalho&task=${task.id}`,
          dedupe_key: `task-assigned:${task.id}:${task.assignee_id}`,
        });
      }
    }
    res.status(201).json({ success: true, data: { ...proc, suggested_tasks_created: createdTasks.length } });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      client.release();
    }
    fail(res, e, 400);
  }
});

// PUT /api/processes/:id — editar campos gerais (loga mudanças relevantes)
router.put('/:id', checkPermission('fines:update'), async (req, res) => {
  try {
    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });
    const b = req.body || {};

    if (existing.workflow_id
        && ((b.stage && b.stage !== existing.stage) || (b.status && b.status !== existing.status))) {
      return res.status(409).json({
        success: false,
        code: 'GOVERNED_TRANSITION_REQUIRED',
        error: 'Este processo utiliza fluxo governado. Use uma transicao permitida.',
      });
    }

    if (b.stage && b.stage !== existing.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    if (b.status && b.status !== existing.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status inválido.' });
    const serviceTypeId = b.tenant_service_type_id === undefined
      ? existing.tenant_service_type_id
      : (b.tenant_service_type_id || null);
    const template = serviceTypeId ? await getServiceTemplate(req.tenantId, serviceTypeId) : null;
    if (serviceTypeId && !template) {
      return res.status(400).json({ success: false, error: 'Tipo de servico invalido.' });
    }
    const custom = b.custom_data === undefined
      ? null
      : validateCustomData(template?.custom_fields, b.custom_data);
    if (custom && !custom.ok) return res.status(400).json({ success: false, error: custom.error });

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
    if (b.due_date !== undefined && String(b.due_date || '') !== String(existing.due_date || '')) {
      await fineLogModel.createFineLog({
        tenant_id: req.tenantId,
        fine_id: req.params.id,
        action: 'due_date_changed',
        field_name: 'due_date',
        old_value: existing.due_date,
        new_value: b.due_date || null,
        user_id: req.userId,
      });
      await automationService.enqueueEvent(req.tenantId, {
        event_type: 'due_date_changed',
        entity_type: 'process',
        entity_id: req.params.id,
        fine_id: req.params.id,
        actor_user_id: req.userId,
      }, `due-date:${req.params.id}:${String(b.due_date || 'none')}:${Date.now()}`);
    }

    // protocol_number vive na tabela fines; grava direto quando enviado.
    if (b.protocol_number !== undefined && b.protocol_number !== existing.protocol_number) {
      await pool.query('UPDATE fines SET protocol_number = $1 WHERE id = $2 AND tenant_id = $3',
        [b.protocol_number || null, req.params.id, req.tenantId]);
    }
    if (b.tenant_service_type_id !== undefined && b.tenant_service_type_id !== existing.tenant_service_type_id) {
      await pool.query('UPDATE fines SET tenant_service_type_id = $1 WHERE id = $2 AND tenant_id = $3',
        [b.tenant_service_type_id || null, req.params.id, req.tenantId]);
    }
    if (custom) {
      await pool.query(
        'UPDATE fines SET custom_data = $1::jsonb, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
        [JSON.stringify(custom.data), req.params.id, req.tenantId]
      );
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

    if (existing.workflow_id) {
      return res.status(409).json({
        success: false,
        code: 'GOVERNED_TRANSITION_REQUIRED',
        error: 'Este processo utiliza fluxo governado. Use uma transicao permitida.',
      });
    }
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

    if (existing.workflow_id) {
      return res.status(409).json({
        success: false,
        code: 'GOVERNED_TRANSITION_REQUIRED',
        error: 'Este processo utiliza fluxo governado. Use uma transicao permitida.',
      });
    }
    const updated = await fineModel.moveProcessStatus(req.params.id, status, req.tenantId);
    if (status !== existing.status)
      await fineLogModel.logStatusChange(req.tenantId, req.params.id, existing.status, status, req.userId);
    if (status !== existing.status) {
      await automationService.enqueueEvent(req.tenantId, {
        event_type: 'status_changed',
        entity_type: 'process',
        entity_id: req.params.id,
        fine_id: req.params.id,
        previous_status: existing.status,
        current_status: status,
        actor_user_id: req.userId,
      }, `status:${req.params.id}:${updated.updated_at}`);
    }
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
    if (String(existing.seller_id || '') !== String(sellerId || '')) {
      await fineLogModel.logSellerChange(req.tenantId, req.params.id, existing.seller_name, newName, req.userId);
      if (sellerId && sellerId !== req.userId) {
        await alertModel.createAlert({
          tenant_id: req.tenantId,
          recipient_id: sellerId,
          type: 'processo_redistribuido',
          title: 'Processo atribuido a voce',
          message: existing.fine_number || existing.client_name || 'Processo',
          entity_type: 'processo',
          entity_id: req.params.id,
          internal_link: `/dashboard?module=multas&tab=processos&process=${req.params.id}`,
          dedupe_key: `process-assigned:${req.params.id}:${sellerId}:${updated.updated_at}`,
        });
      }
      await automationService.enqueueEvent(req.tenantId, {
        event_type: 'assignee_changed',
        entity_type: 'process',
        entity_id: req.params.id,
        fine_id: req.params.id,
        actor_user_id: req.userId,
      }, `assignee:${req.params.id}:${updated.updated_at}`);
    }
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

    if (existing.workflow_id) {
      return res.status(409).json({
        success: false,
        code: 'GOVERNED_TRANSITION_REQUIRED',
        error: 'Finalize processos governados por uma transicao configurada.',
      });
    }
    const b = req.body || {};
    if (b.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa de encerramento inválida.' });
    if (b.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status de encerramento inválido.' });

    const updated = await fineModel.finalizeProcess(req.params.id, { stage: b.stage, status: b.status }, req.tenantId);
    await fineLogModel.logFinalized(req.tenantId, req.params.id, req.userId, b.reason || null);
    await automationService.enqueueEvent(req.tenantId, {
      event_type: 'process_finalized',
      entity_type: 'process',
      entity_id: req.params.id,
      fine_id: req.params.id,
      actor_user_id: req.userId,
    }, `finalized:${req.params.id}:${updated.finalized_at}`);
    res.json({ success: true, data: updated });
  } catch (e) { fail(res, e, 400); }
});

// POST /api/processes/:id/reopen — reabrir (somente ADMIN/GESTOR)
router.post('/:id/reopen', requireAdminOrManager, async (req, res) => {
  try {
    const existing = await fineModel.getProcessById(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ success: false, error: 'Processo não encontrado.' });

    if (existing.workflow_id) {
      return res.status(409).json({
        success: false,
        code: 'GOVERNED_TRANSITION_REQUIRED',
        error: 'Reabra processos governados por uma transicao configurada.',
      });
    }
    const b = req.body || {};
    if (b.stage && !(await stageExists(req.tenantId, b.stage)))
      return res.status(400).json({ success: false, error: 'Etapa inválida.' });
    if (b.status && !(await statusExists(req.tenantId, b.status)))
      return res.status(400).json({ success: false, error: 'Status inválido.' });

    const updated = await fineModel.reopenProcess(req.params.id, { stage: b.stage, status: b.status }, req.tenantId);
    await fineLogModel.logReopened(req.tenantId, req.params.id, req.userId, b.reason || null);
    await automationService.enqueueEvent(req.tenantId, {
      event_type: 'process_reopened',
      entity_type: 'process',
      entity_id: req.params.id,
      fine_id: req.params.id,
      actor_user_id: req.userId,
    }, `reopened:${req.params.id}:${updated.reopened_at}`);
    if (updated.seller_id && updated.seller_id !== req.userId) {
      await alertModel.createAlert({
        tenant_id: req.tenantId,
        recipient_id: updated.seller_id,
        type: 'processo_reaberto',
        title: 'Processo reaberto',
        message: existing.fine_number || existing.client_name || 'Processo',
        entity_type: 'processo',
        entity_id: req.params.id,
        internal_link: `/dashboard?module=multas&tab=processos&process=${req.params.id}`,
        dedupe_key: `process-reopened:${req.params.id}:${updated.reopened_at}`,
      });
    }
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
    await automationService.enqueueEvent(req.tenantId, {
      event_type: 'document_uploaded',
      entity_type: 'process',
      entity_id: req.params.id,
      fine_id: req.params.id,
      actor_user_id: req.userId,
    }, `document-uploaded:${doc.id}`);
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

// Revisao documental governada (aprovado/rejeitado), com concorrencia otimista.
router.post('/:id/documents/:documentId/review', requireAdminOrManager, async (req, res) => {
  try {
    const reviewStatus = req.body?.status;
    if (!['approved', 'rejected'].includes(reviewStatus)) {
      return res.status(422).json({ success: false, error: 'Situacao de revisao invalida.' });
    }
    const result = await pool.query(
      `UPDATE fine_documents SET review_status=$1,reviewed_by=$2,reviewed_at=NOW(),
              row_version=row_version+1,updated_at=NOW()
        WHERE id=$3 AND fine_id=$4 AND tenant_id=$5 AND row_version=$6
          AND COALESCE(status,'ativo')='ativo' AND removed_at IS NULL
        RETURNING *`,
      [
        reviewStatus, req.userId, req.params.documentId, req.params.id,
        req.tenantId, Number(req.body?.expected_version),
      ]
    );
    if (!result.rows[0]) {
      return res.status(409).json({
        success: false,
        code: 'VERSION_CONFLICT',
        error: 'Documento alterado por outro usuario. Recarregue antes de revisar.',
      });
    }
    await fineLogModel.logFineChange({
      tenant_id: req.tenantId,
      fine_id: req.params.id,
      action: reviewStatus === 'approved' ? 'document_approved' : 'document_rejected',
      field_name: 'documento',
      old_value: null,
      new_value: result.rows[0].name,
      user_id: req.userId,
    });
    await automationService.enqueueEvent(req.tenantId, {
      event_type: reviewStatus === 'approved' ? 'document_approved' : 'document_rejected',
      entity_type: 'process',
      entity_id: req.params.id,
      fine_id: req.params.id,
      actor_user_id: req.userId,
    }, `document-review:${result.rows[0].id}:${result.rows[0].row_version}`);
    res.json({ success: true, data: result.rows[0] });
  } catch (e) { fail(res, e); }
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
