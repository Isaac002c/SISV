'use strict';

// =============================================================================
// executionRoutes.js — execucao e financeiro operacional:
//   /api/service-orders  ordens de servico e execucao (§23, §24, §25, §26)
//   /api/payables        contas a pagar operacionais (§27, §28)
//   /api/commissions     comissoes (§29)
//
// "Preparar pagamentos" e um par explicito:
//   GET  /api/service-orders/obligations/:saleId   -> previa calculada
//   POST /api/service-orders/obligations/:saleId   -> grava o que o usuario
//                                                     revisou e confirmou
// Nao existe endpoint que gere obrigacao sozinho.
// =============================================================================

const express = require('express');
const router = express.Router();

const execution = require('../models/executionModels');
const { listHistory } = require('../services/commercialCommon');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, audit, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'execution';

// ── Ordens de servico ────────────────────────────────────────────────────────

const serviceOrders = express.Router();

serviceOrders.get('/meta', checkPermission('service_orders:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: {
      statuses: execution.SO_STATUSES,
      transitions: execution.SO_TRANSITIONS,
      priorities: execution.PRIORITIES,
      cost_statuses: execution.COST_STATUSES,
    },
  });
}));

serviceOrders.get('/', checkPermission('service_orders:read'), handle(scope, async (req, res) => {
  const result = await execution.listServiceOrders(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-ordens-servico.csv');
  res.json({ success: true, ...result });
}));

// Registrada antes de "/:id" para nao ser capturada como um id.
serviceOrders.get('/obligations/:saleId', checkPermission('payables:read'), handle(scope, async (req, res) => {
  const preview = await execution.prepareObligations(req.tenantId, req.params.saleId);
  if (!preview) return res.status(404).json({ success: false, error: 'Venda nao encontrada.' });
  res.json({ success: true, data: preview });
}));

serviceOrders.post('/obligations/:saleId', checkPermission('payables:manage'), handle(scope, async (req, res) => {
  const created = await execution.confirmObligations(
    req.tenantId, req.userId, req.params.saleId, req.body || {});
  await audit(req, {
    action: 'obligations_confirmed', entity_type: 'venda', entity_id: req.params.saleId,
    description: 'Obrigacoes confirmadas pelo usuario',
    metadata: { payables: created.payables.length, commissions: created.commissions.length },
  });
  res.status(201).json({ success: true, data: created });
}));

serviceOrders.get('/:id', checkPermission('service_orders:read'), handle(scope, async (req, res) => {
  const serviceOrder = await execution.getServiceOrder(req.tenantId, req.params.id);
  if (!serviceOrder) return res.status(404).json({ success: false, error: 'Ordem de servico nao encontrada.' });
  const history = await listHistory(req.tenantId, 'service_order', req.params.id, { limit: 50 });
  res.json({ success: true, data: { ...serviceOrder, history } });
}));

serviceOrders.post('/', checkPermission('service_orders:manage'), handle(scope, async (req, res) => {
  const serviceOrder = await execution.createServiceOrder(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'service_order_created', entity_type: 'ordem_servico', entity_id: serviceOrder.id,
    entity_name: serviceOrder.number, description: 'Ordem de servico criada',
    metadata: { sale_id: serviceOrder.sale_id, processes: serviceOrder.processes_created },
  });
  res.status(201).json({ success: true, data: serviceOrder });
}));

serviceOrders.post('/:id/status', checkPermission('service_orders:execute'), handle(scope, async (req, res) => {
  const { status, reason, row_version: rowVersion } = req.body || {};
  const serviceOrder = await execution.changeServiceOrderStatus(
    req.tenantId, req.userId, req.params.id, status, reason, rowVersion);
  await audit(req, {
    action: status === 'em_execucao' ? 'execution_started' : 'service_order_status_changed',
    entity_type: 'ordem_servico', entity_id: serviceOrder.id, entity_name: serviceOrder.number,
    description: `Ordem movida para ${serviceOrder.status}`,
    metadata: { status: serviceOrder.status, reason: reason || null },
  });
  res.json({ success: true, data: serviceOrder });
}));

serviceOrders.post('/:id/assign', checkPermission('service_orders:manage'), handle(scope, async (req, res) => {
  const serviceOrder = await execution.assignServiceOrder(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'service_order_assigned', entity_type: 'ordem_servico', entity_id: serviceOrder.id,
    entity_name: serviceOrder.number, description: 'Responsavel definido/redistribuido',
    metadata: { owner_id: serviceOrder.owner_id },
  });
  res.json({ success: true, data: serviceOrder });
}));

serviceOrders.post('/:id/progress', checkPermission('service_orders:execute'), handle(scope, async (req, res) => {
  await execution.addProgress(req.tenantId, req.userId, req.params.id, req.body && req.body.note);
  res.status(201).json({ success: true, data: { ok: true } });
}));

serviceOrders.post('/:id/items/:itemId/process', checkPermission('service_orders:manage'), handle(scope, async (req, res) => {
  const item = await execution.linkItemProcess(
    req.tenantId, req.userId, req.params.id, req.params.itemId, req.body && req.body.process_id);
  await audit(req, {
    action: 'service_order_process_linked', entity_type: 'ordem_servico', entity_id: req.params.id,
    description: 'Processo vinculado ao item da ordem',
    metadata: { item_id: req.params.itemId, process_id: item.process_id },
  });
  res.json({ success: true, data: item });
}));

// ── Custos da execucao ───────────────────────────────────────────────────────

serviceOrders.post('/:id/costs', checkPermission('service_orders:execute'), handle(scope, async (req, res) => {
  const cost = await execution.addExecutionCost(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'execution_cost_registered', entity_type: 'ordem_servico', entity_id: req.params.id,
    description: 'Custo de execucao registrado',
    metadata: {
      supplier_id: cost.supplier_id,
      planned: Number(cost.planned_cost),
      actual: cost.actual_cost === null ? null : Number(cost.actual_cost),
    },
  });
  res.status(201).json({ success: true, data: cost });
}));

serviceOrders.put('/costs/:costId', checkPermission('service_orders:execute'), handle(scope, async (req, res) => {
  const cost = await execution.updateExecutionCost(req.tenantId, req.userId, req.params.costId, req.body || {});
  await audit(req, {
    action: 'execution_cost_updated', entity_type: 'custo_execucao', entity_id: cost.id,
    description: 'Custo de execucao atualizado',
    metadata: { actual: cost.actual_cost === null ? null : Number(cost.actual_cost), status: cost.status },
  });
  res.json({ success: true, data: cost });
}));

// ── Contas a pagar ───────────────────────────────────────────────────────────

const payables = express.Router();

payables.get('/meta', checkPermission('payables:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: { statuses: execution.PAYABLE_STATUSES, kinds: execution.PAYABLE_KINDS },
  });
}));

payables.get('/', checkPermission('payables:read'), handle(scope, async (req, res) => {
  const result = await execution.listPayables(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-contas-pagar.csv');
  res.json({ success: true, ...result });
}));

payables.post('/', checkPermission('payables:manage'), handle(scope, async (req, res) => {
  const payable = await execution.createPayable(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'payable_created', entity_type: 'conta_pagar', entity_id: payable.id,
    entity_name: payable.payee_name, description: 'Obrigacao criada',
    metadata: { kind: payable.kind, amount: Number(payable.amount) },
  });
  res.status(201).json({ success: true, data: payable });
}));

payables.post('/:id/status', checkPermission('payables:pay'), handle(scope, async (req, res) => {
  const payable = await execution.decidePayable(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: payable.status === 'pago' ? 'payable_paid' : 'payable_status_changed',
    entity_type: 'conta_pagar', entity_id: payable.id, entity_name: payable.payee_name,
    description: `Obrigacao movida para ${payable.status}`,
    metadata: { amount: Number(payable.amount), status: payable.status },
  });
  res.json({ success: true, data: payable });
}));

// ── Comissoes ────────────────────────────────────────────────────────────────

const commissions = express.Router();

commissions.get('/meta', checkPermission('commissions:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: { statuses: execution.COMMISSION_STATUSES } });
}));

commissions.get('/', checkPermission('commissions:read'), handle(scope, async (req, res) => {
  const result = await execution.listCommissions(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-comissoes.csv');
  res.json({ success: true, ...result });
}));

commissions.post('/:id/status', checkPermission('commissions:confirm'), handle(scope, async (req, res) => {
  const { status, reason, row_version: rowVersion } = req.body || {};
  const commission = await execution.changeCommissionStatus(
    req.tenantId, req.userId, req.params.id, status, reason, rowVersion);
  await audit(req, {
    action: 'commission_status_changed', entity_type: 'comissao', entity_id: commission.id,
    entity_name: commission.beneficiary_name,
    description: `Comissao movida para ${commission.status}`,
    metadata: { amount: Number(commission.amount), status: commission.status },
  });
  res.json({ success: true, data: commission });
}));

router.use('/service-orders', serviceOrders);
router.use('/payables', payables);
router.use('/commissions', commissions);

module.exports = router;
