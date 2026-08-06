'use strict';

// =============================================================================
// orderRoutes.js — /api/orders — pedidos do front office (§10, §11, §12, §17).
//
// As situacoes e transicoes vivem no backend (orderModels.STATUSES/TRANSITIONS):
// GET /api/orders/meta entrega essa lista ao frontend, para que a interface nao
// tenha regra de fluxo propria (§10: "nao deixar situacoes fixas apenas no
// frontend").
// =============================================================================

const express = require('express');
const router = express.Router();

const orders = require('../models/orderModels');
const { listHistory } = require('../services/commercialCommon');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, audit, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'orders';

/** Metadados do dominio: situacoes, transicoes, canais e decisoes de validacao. */
router.get('/meta', checkPermission('orders:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: {
      statuses: orders.STATUSES,
      editable_statuses: orders.EDITABLE,
      transitions: orders.TRANSITIONS,
      origin_channels: orders.ORIGIN_CHANNELS,
      contractor_types: orders.CONTRACTOR_TYPES,
      decisions: orders.DECISIONS,
    },
  });
}));

router.get('/', checkPermission('orders:read'), handle(scope, async (req, res) => {
  const result = await orders.list(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-pedidos.csv');
  res.json({ success: true, ...result });
}));

router.get('/:id', checkPermission('orders:read'), handle(scope, async (req, res) => {
  const order = await orders.getById(req.tenantId, req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Pedido nao encontrado.' });
  const history = await listHistory(req.tenantId, 'order', req.params.id, { limit: 50 });
  res.json({ success: true, data: { ...order, history } });
}));

router.get('/:id/history', checkPermission('orders:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: await listHistory(req.tenantId, 'order', req.params.id, req.query) });
}));

router.post('/', checkPermission('orders:create'), handle(scope, async (req, res) => {
  const order = await orders.create(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'order_created', entity_type: 'pedido', entity_id: order.id,
    entity_name: order.number, description: 'Pedido criado',
    metadata: { client_id: order.client_id },
  });
  res.status(201).json({ success: true, data: order });
}));

router.put('/:id', checkPermission('orders:update'), handle(scope, async (req, res) => {
  const order = await orders.update(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'order_updated', entity_type: 'pedido', entity_id: order.id,
    entity_name: order.number, description: 'Pedido atualizado',
  });
  res.json({ success: true, data: order });
}));

// ── Itens ────────────────────────────────────────────────────────────────────

router.post('/:id/items', checkPermission('orders:update'), handle(scope, async (req, res) => {
  const result = await orders.addItem(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'order_item_added', entity_type: 'pedido', entity_id: req.params.id,
    description: 'Item adicionado ao pedido',
    metadata: { description: result.item.description, total: Number(result.item.total) },
  });
  res.status(201).json({ success: true, data: result });
}));

router.put('/:id/items/:itemId', checkPermission('orders:update'), handle(scope, async (req, res) => {
  const result = await orders.updateItem(
    req.tenantId, req.userId, req.params.id, req.params.itemId, req.body || {});
  await audit(req, {
    action: 'order_item_updated', entity_type: 'pedido', entity_id: req.params.id,
    description: 'Item do pedido alterado',
    metadata: { item_id: req.params.itemId, discount: Number(result.item.discount) },
  });
  res.json({ success: true, data: result });
}));

router.delete('/:id/items/:itemId', checkPermission('orders:update'), handle(scope, async (req, res) => {
  const result = await orders.removeItem(req.tenantId, req.userId, req.params.id, req.params.itemId);
  await audit(req, {
    action: 'order_item_removed', entity_type: 'pedido', entity_id: req.params.id,
    description: 'Item removido do pedido', metadata: { item_id: req.params.itemId },
  });
  res.json({ success: true, data: result });
}));

// ── Situacao ─────────────────────────────────────────────────────────────────

router.post('/:id/status', checkPermission('orders:update'), handle(scope, async (req, res) => {
  const { status, reason, row_version: rowVersion } = req.body || {};
  // Cancelar exige permissao propria, alem da de edicao.
  if (status === 'cancelado' && !hasPermission(req, 'orders:cancel')) {
    return res.status(403).json({ success: false, error: 'Sem permissao para cancelar pedidos.' });
  }
  const order = await orders.changeStatus(req.tenantId, req.userId, req.params.id, status, reason, rowVersion);
  await audit(req, {
    action: status === 'cancelado' ? 'order_deleted'
      : (status === 'enviado_validacao' ? 'order_sent_to_validation' : 'order_status_changed'),
    entity_type: 'pedido', entity_id: order.id, entity_name: order.number,
    description: status === 'cancelado' ? 'Pedido excluido' : `Pedido movido para ${order.status}`,
    metadata: { status: order.status, reason: reason || null },
  });
  res.json({ success: true, data: order });
}));

// Decisao do back office — devolucao/rejeicao exigem justificativa (§17).
router.post('/:id/validate', checkPermission('backoffice:validate'), handle(scope, async (req, res) => {
  const order = await orders.validateOrder(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'order_validation_decision', entity_type: 'pedido', entity_id: order.id,
    entity_name: order.number, description: `Decisao do back office: ${req.body.decision}`,
    metadata: { decision: req.body.decision, status: order.status },
  });
  res.json({ success: true, data: order });
}));

router.post('/:id/claim', checkPermission('backoffice:validate'), handle(scope, async (req, res) => {
  const order = await orders.claimForReview(req.tenantId, req.userId, req.params.id);
  res.json({ success: true, data: order });
}));

/** Consulta local de permissao (a role admin recebe tudo, como no middleware). */
function hasPermission(req, permission) {
  const { rolePermissions } = require('../middlewares/checkPermission');
  const role = req.userRole || 'viewer';
  if (role === 'admin') return true;
  return (rolePermissions[role] || []).includes(permission);
}

module.exports = router;
