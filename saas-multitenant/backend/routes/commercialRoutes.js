'use strict';

// =============================================================================
// commercialRoutes.js — cadastros mestres do SISV 2.0:
//   /api/commercial/suppliers    fornecedores, prestadores e parceiros (§5, §6)
//   /api/commercial/catalog      catalogo de servicos e produtos (§7)
//   /api/commercial/price-tables tabelas de preco (§8)
//
// Toda escrita exige permissao especifica (§38) e gera auditoria (§39).
// =============================================================================

const express = require('express');
const router = express.Router();

const suppliers = require('../models/supplierModels');
const catalog = require('../models/catalogModels');
const { listHistory } = require('../services/commercialCommon');
const { checkPermission, getPermissionsByRole } = require('../middlewares/checkPermission');
const { hasModuleForPermission } = require('../config/accessControl');
const { handle, audit, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'commercial';

const COMMERCIAL_FIELDS = [
  'default_price_table_id', 'discount_type', 'discount_value', 'payment_terms',
  'payment_method', 'commission_type', 'commission_value', 'commercial_notes',
];

function canRead(req, permission) {
  return getPermissionsByRole(req.userRole || 'viewer').includes(permission)
    && hasModuleForPermission(req.userModules, permission);
}

// A permissao ampla de consulta ao cadastro nao implica acesso a dados para
// pagamento nem a negociacoes comerciais. A mesma regra vale para JSON e CSV.
function supplierForViewer(row, req) {
  const visible = { ...row };
  if (!canRead(req, 'pricing:read')) {
    COMMERCIAL_FIELDS.forEach((field) => delete visible[field]);
  }
  if (!canRead(req, 'suppliers:manage')) {
    delete visible.bank_details;
    delete visible.pix_key;
  }
  return visible;
}

// ── Fornecedores / prestadores / parceiros ───────────────────────────────────

router.get('/suppliers', checkPermission('suppliers:read'), handle(scope, async (req, res) => {
  const result = await suppliers.list(req.tenantId, req.query);
  const rows = result.rows.map((row) => supplierForViewer(row, req));
  if (req.query.format === 'csv') {
    return sendCsv(res, rows, 'sisv-fornecedores.csv');
  }
  res.json({ success: true, ...result, rows });
}));

router.get('/suppliers/:id', checkPermission('suppliers:read'), handle(scope, async (req, res) => {
  const supplier = await suppliers.getById(req.tenantId, req.params.id);
  if (!supplier) return res.status(404).json({ success: false, error: 'Fornecedor nao encontrado.' });
  const [usage, history] = await Promise.all([
    suppliers.getUsage(req.tenantId, req.params.id),
    listHistory(req.tenantId, 'supplier', req.params.id, { limit: 30 }),
  ]);
  res.json({ success: true, data: { ...supplierForViewer(supplier, req), usage, history } });
}));

router.post('/suppliers', checkPermission('suppliers:manage'), handle(scope, async (req, res) => {
  const supplier = await suppliers.create(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'supplier_created', entity_type: 'fornecedor', entity_id: supplier.id,
    entity_name: supplier.legal_name, description: 'Fornecedor cadastrado',
    metadata: { kind: supplier.kind },
  });
  res.status(201).json({ success: true, data: supplier });
}));

router.put('/suppliers/:id', checkPermission('suppliers:manage'), handle(scope, async (req, res) => {
  const supplier = await suppliers.update(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'supplier_updated', entity_type: 'fornecedor', entity_id: supplier.id,
    entity_name: supplier.legal_name, description: 'Fornecedor atualizado',
  });
  res.json({ success: true, data: supplier });
}));

// Inativacao logica: §5 proibe exclusao fisica de fornecedor com historico.
router.post('/suppliers/:id/status', checkPermission('suppliers:manage'), handle(scope, async (req, res) => {
  const { active, reason } = req.body || {};
  const supplier = await suppliers.setActive(req.tenantId, req.userId, req.params.id, active, reason);
  await audit(req, {
    action: supplier.active ? 'supplier_restored' : 'supplier_deleted',
    entity_type: 'fornecedor', entity_id: supplier.id, entity_name: supplier.legal_name,
    description: supplier.active ? 'Fornecedor restaurado' : 'Fornecedor excluido',
    metadata: { reason: reason || null },
  });
  res.json({ success: true, data: supplier });
}));

// Selecao segura de parceiros ativos para novas contratacoes. Nao retorna dados
// bancarios/Pix; condicoes comerciais exigem tambem acesso a precificacao.
router.get('/partners', checkPermission('suppliers:read'), checkPermission('pricing:read'), handle(scope, async (req, res) => {
  const rows = await suppliers.listActivePartners(req.tenantId);
  res.json({ success: true, data: rows });
}));

// ── Catalogo de servicos e produtos ──────────────────────────────────────────

router.get('/catalog', checkPermission('catalog:read'), handle(scope, async (req, res) => {
  const result = await catalog.listItems(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-catalogo.csv');
  res.json({ success: true, ...result });
}));

router.get('/catalog/:id', checkPermission('catalog:read'), handle(scope, async (req, res) => {
  const item = await catalog.getItem(req.tenantId, req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Item nao encontrado.' });
  const history = await listHistory(req.tenantId, 'catalog_item', req.params.id, { limit: 30 });
  res.json({ success: true, data: { ...item, history } });
}));

router.post('/catalog', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const item = await catalog.createItem(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'catalog_item_created', entity_type: 'catalogo', entity_id: item.id,
    entity_name: item.name, description: 'Item de catalogo criado',
    metadata: { code: item.code, default_price: Number(item.default_price) },
  });
  res.status(201).json({ success: true, data: item });
}));

router.put('/catalog/:id', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const item = await catalog.updateItem(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'catalog_item_updated', entity_type: 'catalogo', entity_id: item.id,
    entity_name: item.name, description: 'Item de catalogo atualizado',
    metadata: { default_price: Number(item.default_price) },
  });
  res.json({ success: true, data: item });
}));

router.delete('/catalog/:id', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const item = await catalog.deleteItem(req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'catalog_item_deleted', entity_type: 'catalogo', entity_id: item.id,
    entity_name: item.name, description: 'Item de catalogo excluido',
    metadata: { reason: req.body && req.body.reason },
  });
  res.json({ success: true, data: item });
}));

// ── Tabelas de preco ─────────────────────────────────────────────────────────

router.get('/price-tables', checkPermission('pricing:read'), handle(scope, async (req, res) => {
  res.json({ success: true, ...(await catalog.listTables(req.tenantId, req.query)) });
}));

router.get('/price-tables/:id', checkPermission('pricing:read'), handle(scope, async (req, res) => {
  const table = await catalog.getTable(req.tenantId, req.params.id);
  if (!table) return res.status(404).json({ success: false, error: 'Tabela nao encontrada.' });
  const history = await listHistory(req.tenantId, 'price_table', req.params.id, { limit: 30 });
  res.json({ success: true, data: { ...table, history } });
}));

router.post('/price-tables', checkPermission('pricing:manage'), handle(scope, async (req, res) => {
  const table = await catalog.createTable(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'price_table_created', entity_type: 'tabela_preco', entity_id: table.id,
    entity_name: table.name, description: 'Tabela de precos criada',
  });
  res.status(201).json({ success: true, data: table });
}));

router.put('/price-tables/:id', checkPermission('pricing:manage'), handle(scope, async (req, res) => {
  const table = await catalog.updateTable(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'price_table_updated', entity_type: 'tabela_preco', entity_id: table.id,
    entity_name: table.name, description: 'Tabela de precos atualizada',
    metadata: { status: table.status },
  });
  res.json({ success: true, data: table });
}));

router.delete('/price-tables/:id', checkPermission('pricing:manage'), handle(scope, async (req, res) => {
  const table = await catalog.deleteTable(req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'price_table_deleted', entity_type: 'tabela_preco', entity_id: table.id,
    entity_name: table.name, description: 'Tabela de precos excluida',
    metadata: { reason: req.body && req.body.reason },
  });
  res.json({ success: true, data: table });
}));

router.put('/price-tables/:id/items', checkPermission('pricing:manage'), handle(scope, async (req, res) => {
  const result = await catalog.setTableItems(
    req.tenantId, req.userId, req.params.id, (req.body && req.body.items) || []);
  await audit(req, {
    action: 'price_table_items_updated', entity_type: 'tabela_preco', entity_id: req.params.id,
    description: 'Itens da tabela de precos atualizados', metadata: result,
  });
  res.json({ success: true, data: result });
}));

// Duplicar preserva a original intacta (§8: tabela usada nunca e apagada).
router.post('/price-tables/:id/duplicate', checkPermission('pricing:manage'), handle(scope, async (req, res) => {
  const table = await catalog.duplicateTable(
    req.tenantId, req.userId, req.params.id, req.body && req.body.name);
  await audit(req, {
    action: 'price_table_duplicated', entity_type: 'tabela_preco', entity_id: table.id,
    entity_name: table.name, description: 'Tabela de precos duplicada',
    metadata: { source_id: req.params.id },
  });
  res.status(201).json({ success: true, data: table });
}));

/** Preco vigente de um item — usado pela tela de pedido ao adicionar item. */
router.get('/resolve-price', checkPermission('catalog:read'), handle(scope, async (req, res) => {
  const price = await catalog.resolvePrice(
    req.tenantId, req.query.catalog_item_id, req.query.price_table_id, req.query.date);
  if (!price) return res.status(404).json({ success: false, error: 'Item nao encontrado.' });
  res.json({ success: true, data: price });
}));

module.exports = router;
