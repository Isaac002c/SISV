'use strict';

// =============================================================================
// salesRoutes.js — recebimentos, validacao de pagamento e vendas.
//   /api/receivables       contas a receber operacionais (§18)
//   /api/customer-payments pagamentos do cliente e validacao manual (§19, §20)
//   /api/sales             vendas confirmadas por acao explicita (§21, §22)
//
// Estas rotas materializam a regra de ouro da rodada: aprovar pagamento NAO cria
// venda; confirmar venda NAO cria obrigacao. Cada passo e um POST proprio,
// disparado pelo usuario, com previa antes e historico depois.
// =============================================================================

const express = require('express');
const router = express.Router();

const sales = require('../models/saleModels');
const { listHistory } = require('../services/commercialCommon');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, audit, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'sales';

// ── Recebiveis ───────────────────────────────────────────────────────────────

const receivables = express.Router();

receivables.get('/meta', checkPermission('receivables:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: {
      receivable_statuses: sales.RECEIVABLE_STATUSES,
      payment_statuses: sales.PAYMENT_STATUSES,
      payment_methods: sales.PAYMENT_METHODS,
    },
  });
}));

receivables.get('/', checkPermission('receivables:read'), handle(scope, async (req, res) => {
  const result = await sales.listReceivables(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-recebimentos.csv');
  res.json({ success: true, ...result });
}));

receivables.get('/:id', checkPermission('receivables:read'), handle(scope, async (req, res) => {
  const receivable = await sales.getReceivable(req.tenantId, req.params.id);
  if (!receivable) return res.status(404).json({ success: false, error: 'Recebivel nao encontrado.' });
  res.json({ success: true, data: receivable });
}));

receivables.post('/', checkPermission('receivables:manage'), handle(scope, async (req, res) => {
  const receivable = await sales.createReceivable(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'receivable_created', entity_type: 'recebivel', entity_id: receivable.id,
    entity_name: receivable.description, description: 'Recebivel criado',
    metadata: { total_amount: Number(receivable.total_amount) },
  });
  res.status(201).json({ success: true, data: receivable });
}));

// ── Pagamentos do cliente ────────────────────────────────────────────────────

const payments = express.Router();

payments.get('/', checkPermission('receivables:read'), handle(scope, async (req, res) => {
  const result = await sales.listPayments(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-pagamentos-cliente.csv');
  res.json({ success: true, ...result });
}));

// Informar pagamento NAO aprova nada: entra como "informado" (§19).
payments.post('/', checkPermission('payments:register'), handle(scope, async (req, res) => {
  const payment = await sales.registerPayment(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'customer_payment_reported', entity_type: 'pagamento', entity_id: payment.id,
    description: 'Pagamento informado pelo atendimento',
    metadata: { amount: Number(payment.amount), has_proof: Boolean(payment.proof_url) },
  });
  res.status(201).json({ success: true, data: payment });
}));

// Validacao explicita (§20). `sale_ready` apenas LIBERA o botao "Confirmar venda".
payments.post('/:id/decision', checkPermission('payments:validate'), handle(scope, async (req, res) => {
  const result = await sales.decidePayment(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: `customer_payment_${req.body.decision}`, entity_type: 'pagamento',
    entity_id: req.params.id, description: `Pagamento ${req.body.decision}`,
    metadata: {
      amount: Number(result.payment.amount),
      reason: (req.body && req.body.reason) || null,
    },
  });
  res.json({ success: true, data: result });
}));

payments.post('/:id/reverse', checkPermission('payments:reverse'), handle(scope, async (req, res) => {
  const result = await sales.reversePayment(
    req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'customer_payment_reversed', entity_type: 'pagamento', entity_id: req.params.id,
    description: 'Pagamento estornado',
    metadata: { amount: Number(result.payment.amount), reason: req.body.reason },
  });
  res.json({ success: true, data: result });
}));

// ── Vendas ───────────────────────────────────────────────────────────────────

const salesRouter = express.Router();

salesRouter.get('/meta', checkPermission('sales:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: { statuses: sales.SALE_STATUSES } });
}));

salesRouter.get('/', checkPermission('sales:read'), handle(scope, async (req, res) => {
  const result = await sales.listSales(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-vendas.csv');
  res.json({ success: true, ...result });
}));

salesRouter.get('/:id', checkPermission('sales:read'), handle(scope, async (req, res) => {
  const sale = await sales.getSale(req.tenantId, req.params.id);
  if (!sale) return res.status(404).json({ success: false, error: 'Venda nao encontrada.' });
  const history = await listHistory(req.tenantId, 'sale', req.params.id, { limit: 50 });
  res.json({ success: true, data: { ...sale, history } });
}));

/**
 * Previa da confirmacao (§22) — SOMENTE LEITURA.
 * A interface mostra esta previa e so entao habilita o POST de confirmacao.
 */
salesRouter.get('/preview/:orderId', checkPermission('sales:read'), handle(scope, async (req, res) => {
  const preview = await sales.previewSaleConfirmation(req.tenantId, req.params.orderId);
  if (!preview) return res.status(404).json({ success: false, error: 'Pedido nao encontrado.' });
  res.json({ success: true, data: preview });
}));

/** Confirmacao consciente da venda: acao explicita do usuario autorizado. */
salesRouter.post('/confirm/:orderId', checkPermission('sales:confirm'), handle(scope, async (req, res) => {
  const sale = await sales.confirmSale(req.tenantId, req.userId, req.params.orderId, req.body || {});
  await audit(req, {
    action: 'sale_confirmed', entity_type: 'venda', entity_id: sale.id, entity_name: sale.number,
    description: 'Venda confirmada a partir do pedido',
    metadata: { order_id: req.params.orderId, net_amount: Number(sale.net_amount) },
  });
  res.status(201).json({ success: true, data: sale });
}));

salesRouter.post('/:id/status', checkPermission('sales:cancel'), handle(scope, async (req, res) => {
  const { status, reason, row_version: rowVersion } = req.body || {};
  const sale = await sales.changeSaleStatus(req.tenantId, req.userId, req.params.id, status, reason, rowVersion);
  await audit(req, {
    action: 'sale_status_changed', entity_type: 'venda', entity_id: sale.id, entity_name: sale.number,
    description: `Venda movida para ${sale.status}`,
    metadata: { status: sale.status, reason: reason || null },
  });
  res.json({ success: true, data: sale });
}));

router.use('/receivables', receivables);
router.use('/customer-payments', payments);
router.use('/sales', salesRouter);

module.exports = router;
