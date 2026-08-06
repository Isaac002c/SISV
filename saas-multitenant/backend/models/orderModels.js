'use strict';

// =============================================================================
// orderModels.js — pedidos, itens e validacao do back office (§10, §11, §12, §17).
//
// Regras estruturais:
//   * O item do pedido guarda FOTOGRAFIA do catalogo (descricao, preco, custo,
//     comissao). Alterar catalogo ou tabela de preco depois NAO mexe no pedido.
//   * Totais sao sempre recalculados a partir dos itens no servidor; o valor que
//     o frontend envia nunca e aceito como total.
//   * Situacoes vivem no backend (SITUACOES abaixo) e as transicoes validas
//     estao em TRANSITIONS — o frontend nao decide fluxo.
//   * Devolucao e rejeicao exigem justificativa (§17).
// =============================================================================

const pool = require('../config/db');
const catalog = require('./catalogModels');
const clientFields = require('./clientFieldModels');
const {
  clean, cleanOrNull, money, qty, uuidOrNull, oneOf, dateOrNull, paging,
  nextNumber, recordHistory, lockRow, withTransaction,
  BusinessError, itemTotal, orderTotals, estimatedCost, suggestedCommission,
} = require('../services/commercialCommon');

const STATUSES = Object.freeze([
  'rascunho', 'aguardando_documentos', 'aguardando_pagamento', 'pagamento_parcial',
  'enviado_validacao', 'em_validacao', 'aprovado', 'convertido', 'cancelado',
]);

/** Situacoes em que o pedido ainda aceita edicao de itens e valores. */
const EDITABLE = Object.freeze([
  'rascunho', 'aguardando_documentos', 'aguardando_pagamento', 'pagamento_parcial',
]);

/** Transicoes permitidas. Qualquer caminho fora daqui e recusado com 400. */
const TRANSITIONS = Object.freeze({
  rascunho: ['aguardando_documentos', 'aguardando_pagamento', 'enviado_validacao', 'cancelado'],
  aguardando_documentos: ['rascunho', 'aguardando_pagamento', 'enviado_validacao', 'cancelado'],
  aguardando_pagamento: ['rascunho', 'pagamento_parcial', 'enviado_validacao', 'cancelado'],
  pagamento_parcial: ['rascunho', 'aguardando_pagamento', 'enviado_validacao', 'cancelado'],
  enviado_validacao: ['em_validacao', 'aprovado', 'rascunho', 'cancelado'],
  em_validacao: ['aprovado', 'rascunho', 'aguardando_documentos', 'cancelado'],
  aprovado: ['convertido', 'cancelado'],
  convertido: [],
  cancelado: [],
});

const DECISIONS = Object.freeze(['aprovado', 'devolvido', 'aguardando_informacao', 'rejeitado']);
const ORIGIN_CHANNELS = Object.freeze(['balcao', 'telefone', 'whatsapp', 'indicacao', 'site', 'parceiro', 'outro']);
const CONTRACTOR_TYPES = Object.freeze(['client', 'partner']);
const SORTABLE = Object.freeze(['created_at', 'updated_at', 'number', 'total', 'status']);

const canEdit = (status) => EDITABLE.includes(status);

async function contractorSnapshot(client, tenantId, input, attendedClient, fallback = {}) {
  const contractorType = oneOf(
    input.contractor_type ?? fallback.contractor_type, CONTRACTOR_TYPES, 'client'
  );
  if (contractorType === 'client') {
    return {
      contractor_type: 'client',
      contractor_partner_id: null,
      price_table_id: Object.prototype.hasOwnProperty.call(input, 'price_table_id')
        ? uuidOrNull(input.price_table_id) : uuidOrNull(fallback.price_table_id),
      applied_commercial_terms: {
        contractor_type: 'client', contractor_name: attendedClient.name,
        captured_at: new Date().toISOString(),
      },
    };
  }

  const partnerId = uuidOrNull(input.contractor_partner_id ?? fallback.contractor_partner_id);
  if (!partnerId) throw new BusinessError('Selecione o parceiro contratante.');
  const { rows } = await client.query(
    `SELECT s.id, s.legal_name, s.document, s.active, s.kind,
            s.default_price_table_id, p.name AS default_price_table_name,
            s.discount_type, s.discount_value, s.payment_terms, s.payment_method,
            s.commission_type, s.commission_value, s.commercial_notes
       FROM suppliers s
       LEFT JOIN price_tables p ON p.id = s.default_price_table_id AND p.tenant_id = s.tenant_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [partnerId, tenantId]
  );
  const partner = rows[0];
  if (!partner || partner.kind !== 'parceiro') throw new BusinessError('Parceiro contratante nao encontrado neste tenant.');
  if (!partner.active) throw new BusinessError('Parceiro inativo nao pode ser usado em nova contratacao.');
  const explicitPrice = Object.prototype.hasOwnProperty.call(input, 'price_table_id');
  const priceTableId = explicitPrice
    ? uuidOrNull(input.price_table_id)
    : (uuidOrNull(partner.default_price_table_id) || uuidOrNull(fallback.price_table_id));
  return {
    contractor_type: 'partner',
    contractor_partner_id: partner.id,
    price_table_id: priceTableId,
    applied_commercial_terms: {
      contractor_type: 'partner', partner_id: partner.id, partner_name: partner.legal_name,
      partner_document: partner.document || null, price_table_id: priceTableId,
      price_table_name: priceTableId === partner.default_price_table_id ? partner.default_price_table_name : null,
      discount_type: partner.discount_type || null,
      discount_value: partner.discount_value === null ? null : Number(partner.discount_value),
      payment_terms: partner.payment_terms || null, payment_method: partner.payment_method || null,
      commission_type: partner.commission_type || null,
      commission_value: partner.commission_value === null ? null : Number(partner.commission_value),
      commercial_notes: partner.commercial_notes || null, captured_at: new Date().toISOString(),
    },
  };
}

async function assertPriceTable(client, tenantId, priceTableId) {
  if (!priceTableId) return;
  const { rows } = await client.query(
    'SELECT id FROM price_tables WHERE id = $1 AND tenant_id = $2', [priceTableId, tenantId]
  );
  if (!rows[0]) throw new BusinessError('Tabela de precos nao encontrada neste tenant.');
}

// ── Itens ────────────────────────────────────────────────────────────────────

/**
 * Monta a fotografia do item a partir do catalogo/tabela de preco vigente.
 * O usuario pode sobrescrever preco e descricao; o desconto e limitado pelo
 * desconto maximo da tabela (§8) — quem quiser mais precisa mudar a tabela.
 */
async function buildItemSnapshot(tenantId, input, priceTableId) {
  const catalogItemId = uuidOrNull(input.catalog_item_id);
  const quantity = qty(input.quantity) ?? 1;
  const discount = money(input.discount) ?? 0;
  const surcharge = money(input.surcharge) ?? 0;

  let base = null;
  if (catalogItemId) {
    base = await catalog.resolvePrice(tenantId, catalogItemId, priceTableId);
    if (!base) throw new BusinessError('Item do catalogo nao encontrado neste tenant.');
  }

  const description = clean(input.description, 255) || (base ? base.description : '');
  if (!description) throw new BusinessError('Informe a descricao do item.');

  const overridePrice = money(input.unit_price);
  const unitPrice = overridePrice !== null ? overridePrice : (base ? base.unit_price : 0);
  const overrideCost = Object.prototype.hasOwnProperty.call(input, 'unit_cost')
    ? money(input.unit_cost) : undefined;
  const unitCost = overrideCost !== undefined ? overrideCost : (base ? base.unit_cost : null);

  // Desconto acima do teto da tabela e barrado no servidor (§9 fala em "aplicar
  // desconto conforme permissao"; o teto vem da tabela de precos).
  const gross = Math.round(quantity * unitPrice * 100) / 100;
  if (base && gross > 0) {
    const maxDiscount = Math.round(gross * (Number(base.max_discount_percent) / 100) * 100) / 100;
    if (discount > maxDiscount) {
      throw new BusinessError(
        `Desconto de ${discount.toFixed(2)} excede o maximo permitido para "${description}" (${maxDiscount.toFixed(2)}).`
      );
    }
  }

  const commissionType = input.commission_type
    ? oneOf(input.commission_type, ['percentual', 'fixo'], null) : null;

  return {
    catalog_item_id: catalogItemId,
    description,
    item_type: oneOf(input.item_type, catalog.ITEM_TYPES, base ? base.item_type : 'servico'),
    unit: clean(input.unit, 20) || (base ? base.unit : 'un'),
    quantity,
    unit_price: unitPrice,
    unit_cost: unitCost,
    discount,
    surcharge,
    total: itemTotal({ quantity, unit_price: unitPrice, discount, surcharge }),
    supplier_id: uuidOrNull(input.supplier_id),
    commission_type: commissionType,
    commission_value: commissionType ? (money(input.commission_value) ?? 0) : null,
    requires_process: input.requires_process === undefined
      ? Boolean(base && base.requires_process) : input.requires_process === true || input.requires_process === 'true',
    tenant_service_type_id: uuidOrNull(input.tenant_service_type_id)
      || (base ? base.tenant_service_type_id : null),
    notes: cleanOrNull(input.notes, 1000),
  };
}

/** Recalcula e grava os totais do pedido a partir dos itens ativos. */
async function refreshTotals(client, tenantId, orderId) {
  const { rows: items } = await client.query(
    `SELECT quantity, unit_price, unit_cost, discount, surcharge, status
       FROM order_items WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, orderId]
  );
  const totals = orderTotals(items);
  await client.query(
    `UPDATE orders SET subtotal = $3, discount = $4, surcharge = $5, total = $6, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId, totals.subtotal, totals.discount, totals.surcharge, totals.total]
  );
  return totals;
}

// ── Consulta ─────────────────────────────────────────────────────────────────

async function list(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['o.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const term = clean(query.q, 120);
  if (term) {
    const like = push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(o.number) LIKE ${like} OR LOWER(c.name) LIKE ${like}
                  OR COALESCE(c.cpf,'') LIKE ${like}
                  OR LOWER(COALESCE(cp.legal_name,'')) LIKE ${like})`);
  }
  const status = oneOf(query.status, STATUSES, null);
  if (status) filters.push(`o.status = ${push(status)}`);
  else filters.push("o.status <> 'cancelado'");
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`o.client_id = ${push(clientId)}`);
  const ownerId = uuidOrNull(query.owner_id);
  if (ownerId) filters.push(`o.owner_id = ${push(ownerId)}`);
  const departmentId = uuidOrNull(query.department_id);
  if (departmentId) filters.push(`o.department_id = ${push(departmentId)}`);
  const dateFrom = dateOrNull(query.date_from);
  if (dateFrom) filters.push(`o.created_at >= ${push(dateFrom)}::date`);
  const dateTo = dateOrNull(query.date_to);
  if (dateTo) filters.push(`o.created_at < (${push(dateTo)}::date + INTERVAL '1 day')`);
  const minValue = money(query.min_value);
  if (minValue !== null) filters.push(`o.total >= ${push(minValue)}`);
  const maxValue = money(query.max_value);
  if (maxValue !== null) filters.push(`o.total <= ${push(maxValue)}`);
  if (query.has_sale === 'true') filters.push('s.id IS NOT NULL');
  if (query.has_sale === 'false') filters.push('s.id IS NULL');
  const paymentStatus = oneOf(query.payment_status, ['pendente', 'parcial', 'recebido', 'vencido'], null);
  if (paymentStatus) filters.push(`r.payment_status = ${push(paymentStatus)}`);

  const sortField = SORTABLE.includes(clean(query.sort, 40)) ? clean(query.sort, 40) : 'created_at';
  const sortDir = clean(query.dir, 4).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = filters.join(' AND ');

  // A consulta expoe pagamento, venda e execucao na mesma linha (§12) sem N+1.
  // Venda e ordem sao 1:1 (indices UNIQUE), mas um pedido pode ter mais de um
  // recebivel: por isso o financeiro entra AGREGADO, para nao multiplicar linhas.
  const from = `
      FROM orders o
      JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
      LEFT JOIN suppliers cp ON cp.id = o.contractor_partner_id AND cp.tenant_id = o.tenant_id
      LEFT JOIN users u ON u.id = o.owner_id
      LEFT JOIN sales s ON s.order_id = o.id AND s.tenant_id = o.tenant_id
      LEFT JOIN (
        SELECT rr.order_id,
               COALESCE(SUM(rr.total_amount), 0) AS total_amount,
               COALESCE(SUM(rr.received_amount), 0) AS received_amount,
               CASE
                 WHEN COUNT(*) = COUNT(CASE WHEN rr.status = 'recebido' THEN 1 END) THEN 'recebido'
                 WHEN COUNT(CASE WHEN rr.status = 'vencido' THEN 1 END) > 0 THEN 'vencido'
                 WHEN SUM(rr.received_amount) > 0 THEN 'parcial'
                 ELSE 'pendente'
               END AS payment_status
          FROM receivables rr
         WHERE rr.tenant_id = $1 AND rr.status <> 'cancelado' AND rr.order_id IS NOT NULL
         GROUP BY rr.order_id
      ) r ON r.order_id = o.id
      LEFT JOIN service_orders so ON so.sale_id = s.id AND so.tenant_id = o.tenant_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT o.*, c.name AS client_name, c.cpf AS client_cpf, u.name AS owner_name,
            CASE WHEN o.contractor_type = 'partner' THEN cp.legal_name ELSE c.name END AS contractor_name,
            s.id AS sale_id, s.number AS sale_number, s.status AS sale_status,
            r.payment_status, r.received_amount, r.total_amount AS receivable_total,
            so.id AS service_order_id, so.number AS service_order_number, so.status AS execution_status
       ${from}
      ORDER BY o.${sortField} ${sortDir}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function getById(tenantId, id) {
  const orderId = uuidOrNull(id);
  if (!orderId) return null;
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS client_name, c.cpf AS client_cpf, c.phone AS client_phone,
            c.email AS client_email, u.name AS owner_name, d.name AS department_name,
             p.name AS price_table_name, cp.legal_name AS contractor_partner_name,
            s.id AS sale_id, s.number AS sale_number, s.status AS sale_status
       FROM orders o
       JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
       LEFT JOIN suppliers cp ON cp.id = o.contractor_partner_id AND cp.tenant_id = o.tenant_id
       LEFT JOIN users u ON u.id = o.owner_id
       LEFT JOIN departments d ON d.id = o.department_id
       LEFT JOIN price_tables p ON p.id = o.price_table_id
       LEFT JOIN sales s ON s.order_id = o.id AND s.tenant_id = o.tenant_id
      WHERE o.id = $1 AND o.tenant_id = $2`,
    [orderId, tenantId]
  );
  if (!rows[0]) return null;

  const [itemsResult, validationsResult, receivablesResult, documentsResult, fieldValidation] = await Promise.all([
    pool.query(
      `SELECT i.*, s.legal_name AS supplier_name, t.label AS service_type_label
         FROM order_items i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN tenant_service_types t ON t.id = i.tenant_service_type_id
        WHERE i.tenant_id = $1 AND i.order_id = $2 AND i.status = 'ativo'
        ORDER BY i.sort_order ASC, i.created_at ASC`,
      [tenantId, orderId]),
    pool.query(
      `SELECT v.*, u.name AS reviewed_by_name FROM order_validations v
         LEFT JOIN users u ON u.id = v.reviewed_by
        WHERE v.tenant_id = $1 AND v.order_id = $2 ORDER BY v.created_at DESC`,
      [tenantId, orderId]),
    pool.query(
      `SELECT * FROM receivables WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at ASC`,
      [tenantId, orderId]),
    pool.query(
      `SELECT id, doc_type, title, status, stage, created_at FROM generated_documents
        WHERE tenant_id = $1 AND order_id = $2 AND status <> 'cancelado'
        ORDER BY created_at DESC`,
      [tenantId, orderId]),
    clientFields.validateOrderClient(pool, tenantId, orderId),
  ]);

  const items = itemsResult.rows.map((item) => ({
    ...item,
    suggested_commission: suggestedCommission(item, Number(item.total)),
  }));
  return {
    ...rows[0],
    items,
    validations: validationsResult.rows,
    receivables: receivablesResult.rows,
    documents: documentsResult.rows,
    estimated_cost: estimatedCost(items),
    can_edit: canEdit(rows[0].status),
    client_field_validation: fieldValidation,
  };
}

// ── Escrita ──────────────────────────────────────────────────────────────────

async function create(tenantId, userId, input) {
  const clientId = uuidOrNull(input.client_id);
  if (!clientId) throw new BusinessError('Selecione o cliente do pedido.');

  return withTransaction(async (client) => {
    const { rows: clientRows } = await client.query(
      'SELECT id, name FROM clients WHERE id = $1 AND tenant_id = $2', [clientId, tenantId]);
    if (!clientRows[0]) throw new BusinessError('Cliente nao encontrado neste tenant.', 404);

    const contractor = await contractorSnapshot(client, tenantId, input, clientRows[0]);
    const priceTableId = contractor.price_table_id;
    await assertPriceTable(client, tenantId, priceTableId);

    const number = await nextNumber(client, tenantId, 'order');
    const { rows } = await client.query(
      `INSERT INTO orders
         (tenant_id, number, client_id, price_table_id, origin_channel, owner_id,
          department_id, notes, created_by, updated_by, contractor_type,
          contractor_partner_id, applied_commercial_terms, commercial_terms_applied_at,
          contracting_model_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12::jsonb,NOW(),2) RETURNING *`,
      [tenantId, number, clientId, priceTableId,
       oneOf(input.origin_channel, ORIGIN_CHANNELS, 'balcao'),
       uuidOrNull(input.owner_id) || userId,
       uuidOrNull(input.department_id), cleanOrNull(input.notes, 4000), userId,
       contractor.contractor_type, contractor.contractor_partner_id,
       JSON.stringify(contractor.applied_commercial_terms)]
    );
    const order = rows[0];

    // Itens opcionais na criacao: o atendimento pode montar tudo de uma vez.
    const items = Array.isArray(input.items) ? input.items : [];
    let sortOrder = 0;
    for (const rawItem of items) {
      const snapshot = await buildItemSnapshot(tenantId, rawItem, priceTableId);
      await insertItem(client, tenantId, order.id, snapshot, sortOrder++);
    }
    if (items.length) await refreshTotals(client, tenantId, order.id);

    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: order.id,
      action: 'criado', to_status: 'rascunho',
      details: { number, client_name: clientRows[0].name, items: items.length }, user_id: userId,
    });
    return order;
  });
}

async function insertItem(client, tenantId, orderId, snapshot, sortOrder) {
  const { rows } = await client.query(
    `INSERT INTO order_items
       (tenant_id, order_id, catalog_item_id, description, item_type, unit, quantity,
        unit_price, unit_cost, discount, surcharge, total, supplier_id, commission_type,
        commission_value, requires_process, tenant_service_type_id, notes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [tenantId, orderId, snapshot.catalog_item_id, snapshot.description, snapshot.item_type,
     snapshot.unit, snapshot.quantity, snapshot.unit_price, snapshot.unit_cost, snapshot.discount,
     snapshot.surcharge, snapshot.total, snapshot.supplier_id, snapshot.commission_type,
     snapshot.commission_value, snapshot.requires_process, snapshot.tenant_service_type_id,
     snapshot.notes, sortOrder]
  );
  return rows[0];
}

async function update(tenantId, userId, id, input, expectedVersion) {
  const orderId = uuidOrNull(id);
  if (!orderId) throw new BusinessError('Pedido nao encontrado.', 404);

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'orders', tenantId, orderId, expectedVersion);
    if (!current) throw new BusinessError('Pedido nao encontrado.', 404);
    if (!canEdit(current.status)) {
      throw new BusinessError(`Pedido em "${current.status}" nao aceita edicao.`);
    }

    const data = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
    if (has('origin_channel')) data.origin_channel = oneOf(input.origin_channel, ORIGIN_CHANNELS, 'balcao');
    if (has('owner_id')) data.owner_id = uuidOrNull(input.owner_id);
    if (has('department_id')) data.department_id = uuidOrNull(input.department_id);
    if (has('notes')) data.notes = cleanOrNull(input.notes, 4000);
    const requestedContractorType = has('contractor_type')
      ? oneOf(input.contractor_type, CONTRACTOR_TYPES, current.contractor_type)
      : current.contractor_type;
    const requestedPartnerId = has('contractor_partner_id')
      ? uuidOrNull(input.contractor_partner_id) : uuidOrNull(current.contractor_partner_id);
    const requestedPriceTableId = has('price_table_id')
      ? uuidOrNull(input.price_table_id) : uuidOrNull(current.price_table_id);
    const contractorChanged = requestedContractorType !== current.contractor_type
      || requestedPartnerId !== uuidOrNull(current.contractor_partner_id);
    const priceTableChanged = requestedPriceTableId !== uuidOrNull(current.price_table_id);
    if (contractorChanged || priceTableChanged) {
      const { rows: attendedRows } = await client.query(
        'SELECT id, name FROM clients WHERE id = $1 AND tenant_id = $2', [current.client_id, tenantId]
      );
      const contractor = await contractorSnapshot(client, tenantId, {
        ...input,
        contractor_type: requestedContractorType,
        contractor_partner_id: requestedPartnerId,
        price_table_id: requestedPriceTableId,
      }, attendedRows[0], current);
      await assertPriceTable(client, tenantId, contractor.price_table_id);
      data.contractor_type = contractor.contractor_type;
      data.contractor_partner_id = contractor.contractor_partner_id;
      data.applied_commercial_terms = contractor.applied_commercial_terms;
      data.commercial_terms_applied_at = new Date();
      data.contracting_model_version = 2;
      data.price_table_id = contractor.price_table_id;
    }
    if (has('price_table_id')) {
      const priceTableId = uuidOrNull(input.price_table_id);
      await assertPriceTable(client, tenantId, priceTableId);
      // Trocar a tabela NAO recalcula os itens ja lancados (§8): a fotografia
      // de preco permanece. A tabela nova vale para os proximos itens.
      data.price_table_id = priceTableId;
    }
    if (!Object.keys(data).length) throw new BusinessError('Nenhum campo para atualizar.');

    const columns = Object.keys(data);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const { rows } = await client.query(
      `UPDATE orders SET ${assignments.join(', ')}, updated_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [orderId, tenantId, userId, ...columns.map((column) =>
        column === 'applied_commercial_terms' ? JSON.stringify(data[column]) : data[column])]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: 'atualizado', details: { fields: columns }, user_id: userId,
    });
    return rows[0];
  });
}

async function addItem(tenantId, userId, id, input) {
  const orderId = uuidOrNull(id);
  if (!orderId) throw new BusinessError('Pedido nao encontrado.', 404);

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, orderId);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (!canEdit(order.status)) throw new BusinessError(`Pedido em "${order.status}" nao aceita novos itens.`);

    const snapshot = await buildItemSnapshot(tenantId, input, order.price_table_id);
    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max FROM order_items WHERE tenant_id = $1 AND order_id = $2',
      [tenantId, orderId]);
    const item = await insertItem(client, tenantId, orderId, snapshot, Number(maxRows[0].max) + 1);
    const totals = await refreshTotals(client, tenantId, orderId);
    await client.query(
      'UPDATE orders SET row_version = row_version + 1, updated_by = $3 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, userId]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: 'item_adicionado',
      details: { description: item.description, total: Number(item.total), order_total: totals.total },
      user_id: userId,
    });
    return { item, totals };
  });
}

async function updateItem(tenantId, userId, id, itemId, input) {
  const orderId = uuidOrNull(id);
  const targetId = uuidOrNull(itemId);
  if (!orderId || !targetId) throw new BusinessError('Item nao encontrado.', 404);

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, orderId);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (!canEdit(order.status)) throw new BusinessError(`Pedido em "${order.status}" nao aceita edicao de itens.`);

    const { rows: currentRows } = await client.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 AND tenant_id = $3 FOR UPDATE`,
      [targetId, orderId, tenantId]);
    const current = currentRows[0];
    if (!current || current.status === 'removido') throw new BusinessError('Item nao encontrado.', 404);

    // Campos ausentes preservam o valor atual (a fotografia nao se perde).
    const merged = {
      catalog_item_id: current.catalog_item_id,
      description: input.description ?? current.description,
      item_type: input.item_type ?? current.item_type,
      unit: input.unit ?? current.unit,
      quantity: input.quantity ?? current.quantity,
      unit_price: input.unit_price ?? current.unit_price,
      unit_cost: Object.prototype.hasOwnProperty.call(input, 'unit_cost') ? input.unit_cost : current.unit_cost,
      discount: input.discount ?? current.discount,
      surcharge: input.surcharge ?? current.surcharge,
      supplier_id: Object.prototype.hasOwnProperty.call(input, 'supplier_id') ? input.supplier_id : current.supplier_id,
      commission_type: Object.prototype.hasOwnProperty.call(input, 'commission_type') ? input.commission_type : current.commission_type,
      commission_value: Object.prototype.hasOwnProperty.call(input, 'commission_value') ? input.commission_value : current.commission_value,
      requires_process: Object.prototype.hasOwnProperty.call(input, 'requires_process') ? input.requires_process : current.requires_process,
      tenant_service_type_id: Object.prototype.hasOwnProperty.call(input, 'tenant_service_type_id') ? input.tenant_service_type_id : current.tenant_service_type_id,
      notes: Object.prototype.hasOwnProperty.call(input, 'notes') ? input.notes : current.notes,
    };
    const snapshot = await buildItemSnapshot(tenantId, merged, order.price_table_id);

    const { rows } = await client.query(
      `UPDATE order_items
          SET description = $4, item_type = $5, unit = $6, quantity = $7, unit_price = $8,
              unit_cost = $9, discount = $10, surcharge = $11, total = $12, supplier_id = $13,
              commission_type = $14, commission_value = $15, requires_process = $16,
              tenant_service_type_id = $17, notes = $18, updated_at = NOW()
        WHERE id = $1 AND order_id = $2 AND tenant_id = $3 RETURNING *`,
      [targetId, orderId, tenantId, snapshot.description, snapshot.item_type, snapshot.unit,
       snapshot.quantity, snapshot.unit_price, snapshot.unit_cost, snapshot.discount,
       snapshot.surcharge, snapshot.total, snapshot.supplier_id, snapshot.commission_type,
       snapshot.commission_value, snapshot.requires_process, snapshot.tenant_service_type_id,
       snapshot.notes]
    );
    const totals = await refreshTotals(client, tenantId, orderId);
    await client.query(
      'UPDATE orders SET row_version = row_version + 1, updated_by = $3 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, userId]);

    const discountChanged = Number(current.discount) !== Number(rows[0].discount);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: discountChanged ? 'desconto_alterado' : 'item_alterado',
      details: discountChanged
        ? { description: rows[0].description, from: Number(current.discount), to: Number(rows[0].discount) }
        : { description: rows[0].description, total: Number(rows[0].total) },
      user_id: userId,
    });
    return { item: rows[0], totals };
  });
}

/** Remocao logica: o item some da soma mas continua no historico do pedido. */
async function removeItem(tenantId, userId, id, itemId) {
  const orderId = uuidOrNull(id);
  const targetId = uuidOrNull(itemId);
  if (!orderId || !targetId) throw new BusinessError('Item nao encontrado.', 404);

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, orderId);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (!canEdit(order.status)) throw new BusinessError(`Pedido em "${order.status}" nao aceita remocao de itens.`);

    const { rows } = await client.query(
      `UPDATE order_items SET status = 'removido', updated_at = NOW()
        WHERE id = $1 AND order_id = $2 AND tenant_id = $3 AND status = 'ativo' RETURNING *`,
      [targetId, orderId, tenantId]);
    if (!rows[0]) throw new BusinessError('Item nao encontrado.', 404);

    const totals = await refreshTotals(client, tenantId, orderId);
    await client.query(
      'UPDATE orders SET row_version = row_version + 1, updated_by = $3 WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId, userId]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: 'item_removido',
      details: { description: rows[0].description, order_total: totals.total }, user_id: userId,
    });
    return { item: rows[0], totals };
  });
}

/** Muda a situacao do pedido respeitando TRANSITIONS. */
async function changeStatus(tenantId, userId, id, targetStatus, reason, expectedVersion) {
  const orderId = uuidOrNull(id);
  if (!orderId) throw new BusinessError('Pedido nao encontrado.', 404);
  const target = oneOf(targetStatus, STATUSES, null);
  if (!target) throw new BusinessError('Situacao invalida.');

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, orderId, expectedVersion);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (order.status === target) return order;
    if (!TRANSITIONS[order.status].includes(target)) {
      throw new BusinessError(`Nao e possivel mudar de "${order.status}" para "${target}".`);
    }
    if (target === 'cancelado' && !cleanOrNull(reason, 1000)) {
      throw new BusinessError('Informe o motivo do cancelamento.');
    }
    if (target === 'enviado_validacao') {
      const { rows: itemRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM order_items
          WHERE tenant_id = $1 AND order_id = $2 AND status = 'ativo'`,
        [tenantId, orderId]);
      if (!itemRows[0].total) throw new BusinessError('Inclua ao menos um item antes de enviar para validacao.');
      await clientFields.assertOrderClientReady(client, tenantId, orderId);
    }

    const stamps = [];
    if (target === 'enviado_validacao') stamps.push('sent_at = NOW()');
    if (target === 'aprovado') stamps.push('approved_at = NOW()');
    if (target === 'cancelado') stamps.push('cancelled_at = NOW()', 'cancel_reason = $4');
    const params = [orderId, tenantId, userId];
    if (target === 'cancelado') params.push(cleanOrNull(reason, 1000));

    // `target` vem de oneOf(..., STATUSES): so pode ser um dos literais da lista
    // congelada, nunca entrada livre do usuario. O mesmo vale para os stamps.
    const { rows } = await client.query(
      `UPDATE orders SET status = '${target}', updated_by = $3,
              ${stamps.length ? `${stamps.join(', ')},` : ''}
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: 'situacao_alterada', from_status: order.status, to_status: target,
      reason: cleanOrNull(reason, 1000), user_id: userId,
    });
    return rows[0];
  });
}

/**
 * Decisao do back office (§17). Devolucao, pedido de informacao e rejeicao
 * exigem justificativa; a decisao entra no historico com a versao do pedido.
 */
async function validateOrder(tenantId, userId, id, input) {
  const orderId = uuidOrNull(id);
  if (!orderId) throw new BusinessError('Pedido nao encontrado.', 404);
  const decision = oneOf(input.decision, DECISIONS, null);
  if (!decision) throw new BusinessError('Decisao invalida.');
  const reason = cleanOrNull(input.reason, 2000);
  if (decision !== 'aprovado' && !reason) {
    throw new BusinessError('Devolucao, pendencia de informacao e rejeicao exigem justificativa.');
  }

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, orderId, input.row_version);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (!['enviado_validacao', 'em_validacao'].includes(order.status)) {
      throw new BusinessError('Somente pedidos enviados para validacao podem ser decididos.');
    }
    if (decision === 'aprovado') await clientFields.assertOrderClientReady(client, tenantId, orderId);

    const nextStatus = {
      aprovado: 'aprovado',
      devolvido: 'rascunho',
      aguardando_informacao: 'aguardando_documentos',
      rejeitado: 'cancelado',
    }[decision];

    await client.query(
      `INSERT INTO order_validations
         (tenant_id, order_id, decision, reason, checklist, order_version, reviewed_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [tenantId, orderId, decision, reason,
       JSON.stringify(sanitizeChecklist(input.checklist)), order.row_version, userId]
    );

    const stamps = [];
    if (nextStatus === 'aprovado') stamps.push('approved_at = NOW()');
    if (nextStatus === 'cancelado') stamps.push('cancelled_at = NOW()', `cancel_reason = ${'$4'}`);
    const params = [orderId, tenantId, userId];
    if (nextStatus === 'cancelado') params.push(reason);

    const { rows } = await client.query(
      `UPDATE orders SET status = '${nextStatus}', updated_by = $3,
              ${stamps.length ? `${stamps.join(', ')},` : ''}
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: orderId,
      action: `validacao_${decision}`, from_status: order.status, to_status: nextStatus,
      reason, details: { order_version: order.row_version }, user_id: userId,
    });
    return rows[0];
  });
}

/** Checklist de conferencia: apenas chaves conhecidas com valor booleano. */
function sanitizeChecklist(value) {
  const allowed = ['cliente', 'documentos', 'itens', 'precos', 'descontos',
    'forma_pagamento', 'comprovante', 'fornecedor', 'comissao', 'dados_obrigatorios'];
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of allowed) {
    if (key in value) result[key] = value[key] === true || value[key] === 'true';
  }
  return result;
}

/** Assume o pedido para conferencia (enviado_validacao -> em_validacao). */
async function claimForReview(tenantId, userId, id) {
  return changeStatus(tenantId, userId, id, 'em_validacao', null);
}

module.exports = {
  STATUSES,
  EDITABLE,
  TRANSITIONS,
  DECISIONS,
  ORIGIN_CHANNELS,
  CONTRACTOR_TYPES,
  canEdit,
  list,
  getById,
  create,
  update,
  addItem,
  updateItem,
  removeItem,
  changeStatus,
  validateOrder,
  claimForReview,
  refreshTotals,
  sanitizeChecklist,
};
