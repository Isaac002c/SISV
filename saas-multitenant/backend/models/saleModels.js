'use strict';

// =============================================================================
// saleModels.js — contas a receber operacionais (§18), pagamentos do cliente e
// sua validacao manual (§19, §20), e vendas (§21, §22).
//
// PRINCIPIO CENTRAL DESTA RODADA (§55/§56): nada acontece sozinho.
//   * Anexar comprovante NAO aprova pagamento — a aprovacao e um ato explicito.
//   * Aprovar pagamento NAO cria venda — apenas LIBERA a acao "Confirmar venda".
//   * Confirmar venda NAO gera pagamentos a fornecedor nem comissoes — a venda
//     apenas passa a permitir a acao guiada "Preparar pagamentos".
// A prevacao (previewSaleConfirmation) calcula e mostra; nao persiste nada.
// =============================================================================

const pool = require('../config/db');
const clientFields = require('./clientFieldModels');
const {
  clean, cleanOrNull, money, uuidOrNull, oneOf, dateOrNull, paging,
  nextNumber, recordHistory, lockRow, withTransaction,
  BusinessError, estimatedCost, suggestedCommission,
} = require('../services/commercialCommon');

const RECEIVABLE_STATUSES = Object.freeze(['pendente', 'parcial', 'recebido', 'vencido', 'cancelado', 'estornado']);
const PAYMENT_STATUSES = Object.freeze(['informado', 'em_validacao', 'aprovado', 'rejeitado', 'estornado']);
const SALE_STATUSES = Object.freeze(['pendente', 'confirmada', 'em_execucao', 'concluida', 'cancelada', 'estornada']);
const PAYMENT_METHODS = Object.freeze(['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia', 'outro']);

// ── Contas a receber ─────────────────────────────────────────────────────────

const pendingAmount = (row) =>
  Math.max(0, Math.round((Number(row.total_amount) - Number(row.received_amount)) * 100) / 100);

const withPending = (row) => (row ? { ...row, pending_amount: pendingAmount(row) } : row);

async function listReceivables(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['r.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, RECEIVABLE_STATUSES, null);
  if (status) filters.push(`r.status = ${push(status)}`);
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`r.client_id = ${push(clientId)}`);
  const orderId = uuidOrNull(query.order_id);
  if (orderId) filters.push(`r.order_id = ${push(orderId)}`);
  const saleId = uuidOrNull(query.sale_id);
  if (saleId) filters.push(`r.sale_id = ${push(saleId)}`);
  const dueFrom = dateOrNull(query.due_from);
  if (dueFrom) filters.push(`r.due_date >= ${push(dueFrom)}::date`);
  const dueTo = dateOrNull(query.due_to);
  if (dueTo) filters.push(`r.due_date <= ${push(dueTo)}::date`);
  if (query.overdue === 'true') filters.push("r.due_date < CURRENT_DATE AND r.status IN ('pendente','parcial')");
  const term = clean(query.q, 120);
  if (term) {
    const like = push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(r.description) LIKE ${like} OR LOWER(c.name) LIKE ${like}
                  OR LOWER(COALESCE(o.number,'')) LIKE ${like})`);
  }
  const where = filters.join(' AND ');
  const from = `
      FROM receivables r
      JOIN clients c ON c.id = r.client_id AND c.tenant_id = r.tenant_id
      LEFT JOIN orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
      LEFT JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT r.*, c.name AS client_name, o.number AS order_number, s.number AS sale_number
       ${from} ORDER BY r.due_date NULLS LAST, r.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows: rows.map(withPending), total: countRows[0].total, page, limit };
}

async function getReceivable(tenantId, id) {
  const receivableId = uuidOrNull(id);
  if (!receivableId) return null;
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS client_name, o.number AS order_number, s.number AS sale_number
       FROM receivables r
       JOIN clients c ON c.id = r.client_id AND c.tenant_id = r.tenant_id
       LEFT JOIN orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
       LEFT JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [receivableId, tenantId]
  );
  if (!rows[0]) return null;
  const { rows: payments } = await pool.query(
    `SELECT p.*, reg.name AS registered_by_name, val.name AS validated_by_name
       FROM customer_payments p
       LEFT JOIN users reg ON reg.id = p.registered_by
       LEFT JOIN users val ON val.id = p.validated_by
      WHERE p.tenant_id = $1 AND p.receivable_id = $2 ORDER BY p.created_at DESC`,
    [tenantId, receivableId]
  );
  return { ...withPending(rows[0]), payments };
}

async function createReceivable(tenantId, userId, input) {
  const clientId = uuidOrNull(input.client_id);
  const orderId = uuidOrNull(input.order_id);
  const total = money(input.total_amount);
  const description = clean(input.description, 255);
  if (!clientId) throw new BusinessError('Selecione o cliente do recebivel.');
  if (!description) throw new BusinessError('Informe a descricao do recebivel.');
  if (total === null || total <= 0) throw new BusinessError('Informe um valor total maior que zero.');

  return withTransaction(async (client) => {
    const { rows: clientRows } = await client.query(
      'SELECT id FROM clients WHERE id = $1 AND tenant_id = $2', [clientId, tenantId]);
    if (!clientRows[0]) throw new BusinessError('Cliente nao encontrado neste tenant.', 404);
    if (orderId) {
      const { rows: orderRows } = await client.query(
        'SELECT id FROM orders WHERE id = $1 AND tenant_id = $2', [orderId, tenantId]);
      if (!orderRows[0]) throw new BusinessError('Pedido nao encontrado neste tenant.', 404);
    }
    const { rows } = await client.query(
      `INSERT INTO receivables
         (tenant_id, client_id, order_id, description, total_amount, due_date,
          payment_method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tenantId, clientId, orderId, description, total, dateOrNull(input.due_date),
       oneOf(input.payment_method, PAYMENT_METHODS, null), cleanOrNull(input.notes, 2000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'receivable', entity_id: rows[0].id,
      action: 'criado', to_status: 'pendente',
      details: { total_amount: total, order_id: orderId }, user_id: userId,
    });
    return withPending(rows[0]);
  });
}

// ── Pagamentos do cliente ────────────────────────────────────────────────────

/**
 * Registra um pagamento INFORMADO. Nao altera o recebivel e nao aprova nada:
 * o valor so entra no saldo depois da validacao explicita (§19).
 */
async function registerPayment(tenantId, userId, input) {
  const receivableId = uuidOrNull(input.receivable_id);
  const amount = money(input.amount);
  if (!receivableId) throw new BusinessError('Selecione o recebivel.');
  if (amount === null || amount <= 0) throw new BusinessError('Informe um valor maior que zero.');

  return withTransaction(async (client) => {
    const receivable = await lockRow(client, 'receivables', tenantId, receivableId);
    if (!receivable) throw new BusinessError('Recebivel nao encontrado.', 404);
    if (['cancelado', 'estornado'].includes(receivable.status)) {
      throw new BusinessError('Recebivel cancelado ou estornado nao aceita novos pagamentos.');
    }

    const { rows } = await client.query(
      `INSERT INTO customer_payments
         (tenant_id, receivable_id, order_id, sale_id, client_id, amount, paid_at,
          payment_method, reference, proof_url, notes, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tenantId, receivableId, receivable.order_id, receivable.sale_id, receivable.client_id,
       amount, dateOrNull(input.paid_at) || new Date().toISOString().slice(0, 10),
       oneOf(input.payment_method, PAYMENT_METHODS, 'pix'), cleanOrNull(input.reference, 120),
       cleanOrNull(input.proof_url, 2000), cleanOrNull(input.notes, 2000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'customer_payment', entity_id: rows[0].id,
      action: 'informado', to_status: 'informado',
      details: { amount, receivable_id: receivableId, has_proof: Boolean(rows[0].proof_url) },
      user_id: userId,
    });
    return rows[0];
  });
}

async function listPayments(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['p.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, PAYMENT_STATUSES, null);
  if (status) filters.push(`p.status = ${push(status)}`);
  const receivableId = uuidOrNull(query.receivable_id);
  if (receivableId) filters.push(`p.receivable_id = ${push(receivableId)}`);
  const orderId = uuidOrNull(query.order_id);
  if (orderId) filters.push(`p.order_id = ${push(orderId)}`);
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`p.client_id = ${push(clientId)}`);
  if (query.awaiting === 'true') filters.push("p.status IN ('informado','em_validacao')");
  const where = filters.join(' AND ');
  const from = `
      FROM customer_payments p
      JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
      JOIN receivables r ON r.id = p.receivable_id AND r.tenant_id = p.tenant_id
      LEFT JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
      LEFT JOIN users reg ON reg.id = p.registered_by
      LEFT JOIN users val ON val.id = p.validated_by
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name, o.number AS order_number,
            r.description AS receivable_description, r.total_amount AS receivable_total,
            r.received_amount AS receivable_received,
            reg.name AS registered_by_name, val.name AS validated_by_name
       ${from} ORDER BY p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

/**
 * Validacao manual do pagamento (§20). Somente aqui o saldo do recebivel muda.
 * Aprovar NAO cria venda: apenas devolve `sale_ready`, que a interface usa para
 * liberar o botao "Confirmar venda".
 */
async function decidePayment(tenantId, userId, id, input) {
  const paymentId = uuidOrNull(id);
  if (!paymentId) throw new BusinessError('Pagamento nao encontrado.', 404);
  const decision = oneOf(input.decision, ['aprovado', 'rejeitado', 'em_validacao'], null);
  if (!decision) throw new BusinessError('Decisao invalida.');
  const reason = cleanOrNull(input.reason, 2000);
  if (decision === 'rejeitado' && !reason) {
    throw new BusinessError('Rejeicao de pagamento exige justificativa.');
  }

  return withTransaction(async (client) => {
    const payment = await lockRow(client, 'customer_payments', tenantId, paymentId, input.row_version);
    if (!payment) throw new BusinessError('Pagamento nao encontrado.', 404);
    if (!['informado', 'em_validacao'].includes(payment.status)) {
      throw new BusinessError(`Pagamento em "${payment.status}" nao pode ser validado novamente.`);
    }

    const { rows: updated } = await client.query(
      `UPDATE customer_payments
          SET status = $3, decision_reason = $4,
              validated_by = CASE WHEN $3 = 'em_validacao' THEN validated_by ELSE $5 END,
              validated_at = CASE WHEN $3 = 'em_validacao' THEN validated_at ELSE NOW() END,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [paymentId, tenantId, decision, reason, userId]
    );

    let receivable = null;
    if (decision === 'aprovado') {
      receivable = await applyApprovedPayments(client, tenantId, payment.receivable_id);
    }
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'customer_payment', entity_id: paymentId,
      action: `pagamento_${decision}`, from_status: payment.status, to_status: decision,
      reason, details: { amount: Number(payment.amount) }, user_id: userId,
    });

    // Libera a ACAO de confirmar venda; nao cria venda nenhuma aqui (§20).
    let saleReady = false;
    if (decision === 'aprovado' && payment.order_id) {
      const { rows: orderRows } = await client.query(
        `SELECT o.status, s.id AS sale_id
           FROM orders o
           LEFT JOIN sales s ON s.order_id = o.id AND s.tenant_id = o.tenant_id
          WHERE o.id = $1 AND o.tenant_id = $2`,
        [payment.order_id, tenantId]);
      const order = orderRows[0];
      saleReady = Boolean(order && !order.sale_id && ['aprovado', 'enviado_validacao', 'em_validacao',
        'aguardando_pagamento', 'pagamento_parcial'].includes(order.status));
    }
    return { payment: updated[0], receivable, sale_ready: saleReady };
  });
}

/**
 * Recalcula o recebivel a partir da SOMA dos pagamentos aprovados.
 * Somar do zero (em vez de incrementar) torna a operacao idempotente: reprocessar
 * a mesma aprovacao nao aplica o valor duas vezes (§51).
 */
async function applyApprovedPayments(client, tenantId, receivableId) {
  const { rows: sums } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS received
       FROM customer_payments
      WHERE tenant_id = $1 AND receivable_id = $2 AND status = 'aprovado'`,
    [tenantId, receivableId]
  );
  const received = Math.round(Number(sums[0].received) * 100) / 100;
  const { rows: current } = await client.query(
    'SELECT * FROM receivables WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [receivableId, tenantId]);
  if (!current[0]) return null;

  const total = Number(current[0].total_amount);
  let status = current[0].status;
  if (!['cancelado', 'estornado'].includes(status)) {
    if (received >= total && total > 0) status = 'recebido';
    else if (received > 0) status = 'parcial';
    else if (current[0].due_date && new Date(current[0].due_date) < new Date()) status = 'vencido';
    else status = 'pendente';
  }

  const { rows } = await client.query(
    `UPDATE receivables
        SET received_amount = $3, status = $4,
            settled_at = CASE WHEN $4 = 'recebido' THEN NOW() ELSE NULL END,
            row_version = row_version + 1, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [receivableId, tenantId, received, status]
  );

  // O pedido acompanha o pagamento apenas informativamente; nao muda de fase.
  if (current[0].order_id) {
    const orderStatus = status === 'recebido' ? null : (status === 'parcial' ? 'pagamento_parcial' : null);
    if (orderStatus) {
      await client.query(
        `UPDATE orders SET status = $3, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status = 'aguardando_pagamento'`,
        [current[0].order_id, tenantId, orderStatus]
      );
    }
  }
  return withPending(rows[0]);
}

/** Estorno de pagamento aprovado — recalcula o recebivel e exige justificativa. */
async function reversePayment(tenantId, userId, id, reason) {
  const paymentId = uuidOrNull(id);
  if (!paymentId) throw new BusinessError('Pagamento nao encontrado.', 404);
  const justification = cleanOrNull(reason, 2000);
  if (!justification) throw new BusinessError('Estorno exige justificativa.');

  return withTransaction(async (client) => {
    const payment = await lockRow(client, 'customer_payments', tenantId, paymentId);
    if (!payment) throw new BusinessError('Pagamento nao encontrado.', 404);
    if (payment.status !== 'aprovado') {
      throw new BusinessError('Somente pagamentos aprovados podem ser estornados.');
    }
    const { rows } = await client.query(
      `UPDATE customer_payments SET status = 'estornado', decision_reason = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [paymentId, tenantId, justification]
    );
    const receivable = await applyApprovedPayments(client, tenantId, payment.receivable_id);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'customer_payment', entity_id: paymentId,
      action: 'pagamento_estornado', from_status: 'aprovado', to_status: 'estornado',
      reason: justification, details: { amount: Number(payment.amount) }, user_id: userId,
    });
    return { payment: rows[0], receivable };
  });
}

// ── Vendas ───────────────────────────────────────────────────────────────────

/**
 * Previa da confirmacao (§22). SOMENTE LEITURA: calcula cliente, itens, totais,
 * recebido/pendente, fornecedores, custos, comissoes sugeridas e destino
 * operacional para que o usuario confirme conscientemente. Nada e persistido.
 */
async function previewSaleConfirmation(tenantId, orderId) {
  const id = uuidOrNull(orderId);
  if (!id) return null;
  const { rows: orderRows } = await pool.query(
    `SELECT o.*, c.name AS client_name, c.cpf AS client_cpf, u.name AS owner_name,
            cp.legal_name AS contractor_partner_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
       LEFT JOIN suppliers cp ON cp.id = o.contractor_partner_id AND cp.tenant_id = o.tenant_id
       LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.id = $1 AND o.tenant_id = $2`,
    [id, tenantId]
  );
  const order = orderRows[0];
  if (!order) return null;

  const [itemsResult, receivablesResult, saleResult, documentsResult] = await Promise.all([
    pool.query(
      `SELECT i.*, s.legal_name AS supplier_name, s.commission_type AS supplier_commission_type,
              s.commission_value AS supplier_commission_value, t.label AS service_type_label
         FROM order_items i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN tenant_service_types t ON t.id = i.tenant_service_type_id
        WHERE i.tenant_id = $1 AND i.order_id = $2 AND i.status = 'ativo'
        ORDER BY i.sort_order ASC`,
      [tenantId, id]),
    pool.query(
      `SELECT * FROM receivables WHERE tenant_id = $1 AND order_id = $2 AND status <> 'cancelado'`,
      [tenantId, id]),
    pool.query('SELECT id, number FROM sales WHERE tenant_id = $1 AND order_id = $2', [tenantId, id]),
    pool.query(
      `SELECT id, doc_type, title, status FROM generated_documents
        WHERE tenant_id = $1 AND order_id = $2 AND status <> 'cancelado'`,
      [tenantId, id]),
  ]);

  const items = itemsResult.rows;
  const clientValidation = await clientFields.validateOrderClient(pool, tenantId, id);
  const totalReceivable = receivablesResult.rows.reduce((sum, row) => sum + Number(row.total_amount), 0);
  const totalReceived = receivablesResult.rows.reduce((sum, row) => sum + Number(row.received_amount), 0);
  const cost = estimatedCost(items);
  const gross = Number(order.subtotal);
  const net = Number(order.total);

  // Comissoes SUGERIDAS: preferem a regra do item; se ausente, a do fornecedor.
  const commissions = items
    .map((item) => {
      const rule = item.commission_type
        ? { commission_type: item.commission_type, commission_value: item.commission_value }
        : { commission_type: item.supplier_commission_type, commission_value: item.supplier_commission_value };
      const amount = suggestedCommission(rule, Number(item.total));
      if (!amount) return null;
      return {
        sale_item_description: item.description,
        order_item_id: item.id,
        beneficiary_supplier_id: item.supplier_id,
        beneficiary_name: item.supplier_name || 'Beneficiario nao definido',
        base_amount: Number(item.total),
        rate_type: rule.commission_type,
        rate_value: Number(rule.commission_value),
        amount,
      };
    })
    .filter(Boolean);

  const suppliers = items
    .filter((item) => item.supplier_id)
    .map((item) => ({
      supplier_id: item.supplier_id,
      supplier_name: item.supplier_name,
      item_description: item.description,
      planned_cost: Math.round(Number(item.quantity) * Number(item.unit_cost || 0) * 100) / 100,
    }));

  const requiresProcess = items.filter((item) => item.requires_process);
  const blockers = [];
  if (saleResult.rows[0]) blockers.push(`Este pedido ja gerou a venda ${saleResult.rows[0].number}.`);
  if (order.status === 'cancelado') blockers.push('Pedido cancelado nao pode virar venda.');
  if (!items.length) blockers.push('O pedido nao possui itens ativos.');
  if (clientValidation.missing_service) blockers.push('O pedido deve possuir ao menos um servico.');
  if (clientValidation.missing_fields.length) {
    blockers.push(`Dados obrigatorios do cliente pendentes: ${[...new Set(clientValidation.missing_fields.map((field) => field.label))].join(', ')}.`);
  }
  if (clientValidation.invalid_fields.length) blockers.push('Existem dados obrigatorios do cliente com formato invalido.');
  if (!['aprovado', 'enviado_validacao', 'em_validacao', 'aguardando_pagamento', 'pagamento_parcial'].includes(order.status)) {
    blockers.push(`Pedido em "${order.status}" nao esta pronto para virar venda.`);
  }

  return {
    order: {
      id: order.id, number: order.number, status: order.status,
      client_id: order.client_id, client_name: order.client_name, client_cpf: order.client_cpf,
      owner_id: order.owner_id, owner_name: order.owner_name,
      contractor_type: order.contractor_type,
      contractor_partner_id: order.contractor_partner_id,
      contractor_name: order.contractor_type === 'partner'
        ? order.contractor_partner_name : order.client_name,
      applied_commercial_terms: order.applied_commercial_terms || {},
      subtotal: gross, discount: Number(order.discount), total: net,
    },
    items,
    documents: documentsResult.rows,
    financeiro: {
      total_previsto: Math.round(totalReceivable * 100) / 100,
      total_recebido: Math.round(totalReceived * 100) / 100,
      total_pendente: Math.round(Math.max(0, totalReceivable - totalReceived) * 100) / 100,
      sem_recebivel: receivablesResult.rows.length === 0,
    },
    custos: { estimado: cost, margem_estimada: Math.round((net - cost) * 100) / 100 },
    fornecedores: suppliers,
    comissoes_sugeridas: commissions,
    destino_operacional: {
      gera_ordem_servico: true,
      itens_com_processo: requiresProcess.length,
      descricao: requiresProcess.length
        ? `${requiresProcess.length} item(ns) exigem processo com tramitacao detalhada.`
        : 'Execucao direta pela ordem de servico, sem processo separado.',
    },
    existing_sale: saleResult.rows[0] || null,
    blockers,
    can_confirm: blockers.length === 0,
  };
}

/**
 * Confirma a venda a partir do pedido — SEMPRE por acao explicita (§22).
 * Copia os valores do pedido (nao recalcula do catalogo) e libera a ordem de
 * servico. NAO cria obrigacoes nem comissoes: isso e a acao guiada da §28.
 */
async function confirmSale(tenantId, userId, orderId, input = {}) {
  const id = uuidOrNull(orderId);
  if (!id) throw new BusinessError('Pedido nao encontrado.', 404);

  return withTransaction(async (client) => {
    const order = await lockRow(client, 'orders', tenantId, id, input.row_version);
    if (!order) throw new BusinessError('Pedido nao encontrado.', 404);
    if (order.status === 'cancelado') throw new BusinessError('Pedido cancelado nao pode virar venda.');

    // Barreira contra venda duplicada, alem do indice UNIQUE (tenant, order).
    const { rows: existing } = await client.query(
      'SELECT id, number FROM sales WHERE tenant_id = $1 AND order_id = $2', [tenantId, id]);
    if (existing[0]) {
      throw new BusinessError(`Este pedido ja gerou a venda ${existing[0].number}.`, 409);
    }

    const { rows: items } = await client.query(
      `SELECT * FROM order_items
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'ativo' ORDER BY sort_order ASC`,
      [tenantId, id]);
    if (!items.length) throw new BusinessError('O pedido nao possui itens ativos.');
    await clientFields.assertOrderClientReady(client, tenantId, id);

    const cost = estimatedCost(items);
    const gross = Number(order.subtotal);
    const net = Number(order.total);
    const commissionForecast = items.reduce(
      (sum, item) => sum + suggestedCommission(item, Number(item.total)), 0);

    const number = await nextNumber(client, tenantId, 'sale');
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales
         (tenant_id, number, order_id, client_id, gross_amount, discount_amount, net_amount,
          estimated_cost, estimated_margin, commission_forecast, owner_id, partner_id,
          status, notes, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmada',$13,$14,NOW())
       RETURNING *`,
      [tenantId, number, id, order.client_id, gross, Number(order.discount), net,
       cost, Math.round((net - cost) * 100) / 100, Math.round(commissionForecast * 100) / 100,
       order.owner_id, uuidOrNull(order.contractor_partner_id) || uuidOrNull(input.partner_id),
       cleanOrNull(input.notes, 2000), userId]
    );
    const sale = saleRows[0];

    // Fotografia dos itens: a venda preserva os valores do pedido (§21).
    let sortOrder = 0;
    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items
           (tenant_id, sale_id, order_item_id, catalog_item_id, description, item_type, quantity,
            unit_price, unit_cost, discount, total, supplier_id, commission_type, commission_value,
            requires_process, tenant_service_type_id, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [tenantId, sale.id, item.id, item.catalog_item_id, item.description, item.item_type,
         item.quantity, item.unit_price, item.unit_cost, item.discount, item.total,
         item.supplier_id, item.commission_type, item.commission_value, item.requires_process,
         item.tenant_service_type_id, sortOrder++]
      );
    }

    // Recebiveis do pedido passam a apontar tambem para a venda (rastreabilidade).
    await client.query(
      `UPDATE receivables SET sale_id = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND order_id = $2 AND sale_id IS NULL`,
      [tenantId, id, sale.id]);
    await client.query(
      `UPDATE customer_payments SET sale_id = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND order_id = $2 AND sale_id IS NULL`,
      [tenantId, id, sale.id]);

    await client.query(
      `UPDATE orders SET status = 'convertido', row_version = row_version + 1,
              updated_by = $3, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId, userId]);

    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'sale', entity_id: sale.id,
      action: 'venda_confirmada', to_status: 'confirmada',
      details: { number, order_number: order.number, net_amount: net, items: items.length },
      user_id: userId,
    });
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'order', entity_id: id,
      action: 'convertido_em_venda', from_status: order.status, to_status: 'convertido',
      details: { sale_number: number }, user_id: userId,
    });
    return sale;
  });
}

async function listSales(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['s.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, SALE_STATUSES, null);
  if (status) filters.push(`s.status = ${push(status)}`);
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`s.client_id = ${push(clientId)}`);
  const ownerId = uuidOrNull(query.owner_id);
  if (ownerId) filters.push(`s.owner_id = ${push(ownerId)}`);
  const dateFrom = dateOrNull(query.date_from);
  if (dateFrom) filters.push(`s.confirmed_at >= ${push(dateFrom)}::date`);
  const dateTo = dateOrNull(query.date_to);
  if (dateTo) filters.push(`s.confirmed_at < (${push(dateTo)}::date + INTERVAL '1 day')`);
  if (query.without_service_order === 'true') filters.push('so.id IS NULL');
  const term = clean(query.q, 120);
  if (term) {
    const like = push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(s.number) LIKE ${like} OR LOWER(c.name) LIKE ${like})`);
  }
  const where = filters.join(' AND ');
  const from = `
      FROM sales s
      JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
      LEFT JOIN orders o ON o.id = s.order_id AND o.tenant_id = s.tenant_id
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN service_orders so ON so.sale_id = s.id AND so.tenant_id = s.tenant_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT s.*, c.name AS client_name, o.number AS order_number, u.name AS owner_name,
            so.id AS service_order_id, so.number AS service_order_number, so.status AS service_order_status
       ${from} ORDER BY s.confirmed_at DESC NULLS LAST, s.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function getSale(tenantId, id) {
  const saleId = uuidOrNull(id);
  if (!saleId) return null;
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS client_name, c.cpf AS client_cpf, o.number AS order_number,
            u.name AS owner_name, p.legal_name AS partner_name,
            so.id AS service_order_id, so.number AS service_order_number, so.status AS service_order_status
       FROM sales s
       JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
       LEFT JOIN orders o ON o.id = s.order_id AND o.tenant_id = s.tenant_id
       LEFT JOIN users u ON u.id = s.owner_id
       LEFT JOIN suppliers p ON p.id = s.partner_id
       LEFT JOIN service_orders so ON so.sale_id = s.id AND so.tenant_id = s.tenant_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [saleId, tenantId]
  );
  if (!rows[0]) return null;
  const [items, receivables, commissions, fiscal] = await Promise.all([
    pool.query(
      `SELECT i.*, sup.legal_name AS supplier_name FROM sale_items i
         LEFT JOIN suppliers sup ON sup.id = i.supplier_id
        WHERE i.tenant_id = $1 AND i.sale_id = $2 ORDER BY i.sort_order ASC`,
      [tenantId, saleId]),
    pool.query('SELECT * FROM receivables WHERE tenant_id = $1 AND sale_id = $2', [tenantId, saleId]),
    pool.query('SELECT * FROM commissions WHERE tenant_id = $1 AND sale_id = $2 ORDER BY created_at DESC', [tenantId, saleId]),
    pool.query('SELECT * FROM fiscal_documents WHERE tenant_id = $1 AND sale_id = $2', [tenantId, saleId]),
  ]);
  return {
    ...rows[0],
    items: items.rows,
    receivables: receivables.rows.map(withPending),
    commissions: commissions.rows,
    fiscal_document: fiscal.rows[0] || null,
  };
}

/** Cancela ou estorna a venda; sempre com justificativa e historico. */
async function changeSaleStatus(tenantId, userId, id, targetStatus, reason, expectedVersion) {
  const saleId = uuidOrNull(id);
  if (!saleId) throw new BusinessError('Venda nao encontrada.', 404);
  const target = oneOf(targetStatus, SALE_STATUSES, null);
  if (!target) throw new BusinessError('Situacao invalida.');
  const justification = cleanOrNull(reason, 2000);
  if (['cancelada', 'estornada'].includes(target) && !justification) {
    throw new BusinessError('Cancelamento e estorno exigem justificativa.');
  }

  return withTransaction(async (client) => {
    const sale = await lockRow(client, 'sales', tenantId, saleId, expectedVersion);
    if (!sale) throw new BusinessError('Venda nao encontrada.', 404);
    if (['cancelada', 'estornada'].includes(sale.status)) {
      throw new BusinessError('Venda ja cancelada ou estornada.');
    }
    if (['cancelada', 'estornada'].includes(target)) {
      const { rows: soRows } = await client.query(
        `SELECT number FROM service_orders
          WHERE tenant_id = $1 AND sale_id = $2 AND status NOT IN ('cancelada','rascunho')`,
        [tenantId, saleId]);
      if (soRows[0]) {
        throw new BusinessError(`Cancele antes a ordem de servico ${soRows[0].number}.`);
      }
    }

    const { rows } = await client.query(
      `UPDATE sales SET status = $3,
              cancelled_at = CASE WHEN $3 IN ('cancelada','estornada') THEN NOW() ELSE cancelled_at END,
              cancel_reason = COALESCE($4, cancel_reason),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [saleId, tenantId, target, justification]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'sale', entity_id: saleId,
      action: 'situacao_alterada', from_status: sale.status, to_status: target,
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

module.exports = {
  RECEIVABLE_STATUSES,
  PAYMENT_STATUSES,
  SALE_STATUSES,
  PAYMENT_METHODS,
  listReceivables,
  getReceivable,
  createReceivable,
  registerPayment,
  listPayments,
  decidePayment,
  reversePayment,
  applyApprovedPayments,
  previewSaleConfirmation,
  confirmSale,
  listSales,
  getSale,
  changeSaleStatus,
};
