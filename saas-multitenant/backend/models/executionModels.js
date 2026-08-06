'use strict';

// =============================================================================
// executionModels.js — ordens de servico (§23), relacao com processos (§24),
// execucao (§25), custos de fornecedor (§26), contas a pagar operacionais (§27),
// geracao GUIADA de obrigacoes (§28) e comissoes (§29).
//
// Relacao ordem x processo (§24), sem duplicar informacao:
//   * a ORDEM organiza o compromisso operacional (responsavel, prazo, situacao);
//   * o PROCESSO (fines) controla a tramitacao detalhada quando o servico exige
//     etapas, e fica vinculado no ITEM da ordem (service_order_items.process_id);
//   * servico simples e executado na propria ordem, sem processo separado.
//
// "Preparar pagamentos" (§28) e uma ACAO GUIADA: prepareObligations() apenas
// CALCULA e devolve a previa; nada e gravado ate confirmObligations() receber a
// lista revisada pelo usuario.
// =============================================================================

const pool = require('../config/db');
const {
  clean, cleanOrNull, money, qty, uuidOrNull, oneOf, dateOrNull, paging,
  nextNumber, recordHistory, lockRow, withTransaction,
  BusinessError, suggestedCommission,
} = require('../services/commercialCommon');

const SO_STATUSES = Object.freeze([
  'rascunho', 'liberada', 'aguardando_execucao', 'em_execucao', 'pausada',
  'aguardando_terceiro', 'concluida', 'cancelada', 'arquivada',
]);
const SO_TRANSITIONS = Object.freeze({
  rascunho: ['liberada', 'cancelada'],
  liberada: ['aguardando_execucao', 'em_execucao', 'cancelada'],
  aguardando_execucao: ['em_execucao', 'liberada', 'cancelada'],
  em_execucao: ['pausada', 'aguardando_terceiro', 'concluida', 'cancelada'],
  pausada: ['em_execucao', 'cancelada'],
  aguardando_terceiro: ['em_execucao', 'cancelada'],
  concluida: ['arquivada', 'em_execucao'],
  cancelada: [],
  arquivada: [],
});
const PRIORITIES = Object.freeze(['baixa', 'normal', 'alta', 'urgente']);
const COST_STATUSES = Object.freeze(['previsto', 'confirmado', 'cancelado']);
const PAYABLE_STATUSES = Object.freeze(['previsto', 'aprovado', 'agendado', 'pago', 'vencido', 'cancelado', 'estornado']);
const PAYABLE_KINDS = Object.freeze(['fornecedor', 'prestador', 'parceiro', 'comissao', 'despesa']);
const COMMISSION_STATUSES = Object.freeze(['prevista', 'confirmada', 'paga', 'cancelada', 'estornada']);

// ── Ordens de servico ────────────────────────────────────────────────────────

/**
 * Cria a ordem a partir de uma venda confirmada, por acao explicita.
 * Um item que exige tramitacao pode gerar um processo (fines) — mas somente
 * quando o usuario pedir (`create_processes`), nunca em segundo plano.
 */
async function createServiceOrder(tenantId, userId, input) {
  const saleId = uuidOrNull(input.sale_id);
  if (!saleId) throw new BusinessError('Selecione a venda de origem.');

  return withTransaction(async (client) => {
    const sale = await lockRow(client, 'sales', tenantId, saleId);
    if (!sale) throw new BusinessError('Venda nao encontrada.', 404);
    if (!['confirmada', 'em_execucao'].includes(sale.status)) {
      throw new BusinessError(`Venda em "${sale.status}" nao pode gerar ordem de servico.`);
    }
    const { rows: existing } = await client.query(
      'SELECT id, number FROM service_orders WHERE tenant_id = $1 AND sale_id = $2', [tenantId, saleId]);
    if (existing[0]) {
      throw new BusinessError(`Esta venda ja possui a ordem ${existing[0].number}.`, 409);
    }

    const { rows: items } = await client.query(
      'SELECT * FROM sale_items WHERE tenant_id = $1 AND sale_id = $2 ORDER BY sort_order ASC',
      [tenantId, saleId]);
    if (!items.length) throw new BusinessError('A venda nao possui itens.');

    const number = await nextNumber(client, tenantId, 'service_order');
    const { rows: soRows } = await client.query(
      `INSERT INTO service_orders
         (tenant_id, number, sale_id, order_id, client_id, department_id, owner_id,
          priority, due_date, planned_date, status, instructions, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'rascunho',$11,$12,$13) RETURNING *`,
      [tenantId, number, saleId, sale.order_id, sale.client_id,
       uuidOrNull(input.department_id), uuidOrNull(input.owner_id) || sale.owner_id,
       oneOf(input.priority, PRIORITIES, 'normal'), dateOrNull(input.due_date),
       dateOrNull(input.planned_date), cleanOrNull(input.instructions, 4000),
       cleanOrNull(input.notes, 2000), userId]
    );
    const serviceOrder = soRows[0];

    const createProcesses = input.create_processes === true || input.create_processes === 'true';
    let processesCreated = 0;
    let sortOrder = 0;
    for (const item of items) {
      let processId = null;
      if (createProcesses && item.requires_process) {
        processId = await createLinkedProcess(client, tenantId, userId, sale, item, serviceOrder);
        processesCreated += 1;
      }
      await client.query(
        `INSERT INTO service_order_items
           (tenant_id, service_order_id, sale_item_id, process_id, description, quantity,
            supplier_id, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, serviceOrder.id, item.id, processId, item.description, item.quantity,
         item.supplier_id, sortOrder++]
      );
    }

    await client.query(
      `UPDATE sales SET status = 'em_execucao', row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'confirmada'`,
      [saleId, tenantId]);

    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrder.id,
      action: 'criada', to_status: 'rascunho',
      details: { number, sale_number: sale.number, items: items.length, processes: processesCreated },
      user_id: userId,
    });
    return { ...serviceOrder, processes_created: processesCreated };
  });
}

/**
 * Cria o processo operacional (fines) vinculado ao item, reutilizando o modulo
 * existente: o SISV nao ganha uma segunda tabela de processos.
 */
async function createLinkedProcess(client, tenantId, userId, sale, item, serviceOrder) {
  const { rows: typeRows } = item.tenant_service_type_id
    ? await client.query(
      'SELECT * FROM tenant_service_types WHERE id = $1 AND tenant_id = $2',
      [item.tenant_service_type_id, tenantId])
    : { rows: [] };
  const serviceType = typeRows[0] || null;

  const dueDate = serviceOrder.due_date
    || (serviceType && serviceType.default_due_days
      ? new Date(Date.now() + serviceType.default_due_days * 86400000).toISOString().slice(0, 10)
      : null);

  const { rows } = await client.query(
    `INSERT INTO fines
       (tenant_id, client_id, seller_id, tenant_service_type_id, department_id,
        fine_number, stage, status, value, cost, due_date, notes, last_moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     RETURNING id`,
    [tenantId, sale.client_id, serviceOrder.owner_id, item.tenant_service_type_id,
     serviceOrder.department_id || (serviceType ? serviceType.initial_department_id : null),
     `${serviceOrder.number}/${item.sort_order + 1}`,
     (serviceType && serviceType.initial_stage) || 'ENTRADA',
     (serviceType && serviceType.initial_status) || 'PENDENTE',
     item.total, Number(item.unit_cost || 0) * Number(item.quantity), dueDate,
     `Gerado pela ordem de servico ${serviceOrder.number} (venda ${sale.number}).`]
  );
  return rows[0].id;
}

async function listServiceOrders(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['so.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, SO_STATUSES, null);
  if (status) filters.push(`so.status = ${push(status)}`);
  const ownerId = uuidOrNull(query.owner_id);
  if (ownerId) filters.push(`so.owner_id = ${push(ownerId)}`);
  const departmentId = uuidOrNull(query.department_id);
  if (departmentId) filters.push(`so.department_id = ${push(departmentId)}`);
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`so.client_id = ${push(clientId)}`);
  const priority = oneOf(query.priority, PRIORITIES, null);
  if (priority) filters.push(`so.priority = ${push(priority)}`);
  if (query.overdue === 'true') {
    filters.push("so.due_date < CURRENT_DATE AND so.status NOT IN ('concluida','cancelada','arquivada')");
  }
  if (query.unassigned === 'true') filters.push('so.owner_id IS NULL');
  if (query.open === 'true') filters.push("so.status NOT IN ('concluida','cancelada','arquivada')");
  const term = clean(query.q, 120);
  if (term) {
    const like = push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(so.number) LIKE ${like} OR LOWER(c.name) LIKE ${like})`);
  }
  const where = filters.join(' AND ');
  // Contagem de processos e soma de custos entram como subconsultas AGREGADAS e
  // nao correlacionadas — a versao correlacionada nao roda no Postgres em
  // memoria usado pelo servidor de demonstracao (e o E2E depende dele).
  const from = `
      FROM service_orders so
      JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
      LEFT JOIN sales s ON s.id = so.sale_id AND s.tenant_id = so.tenant_id
      LEFT JOIN users u ON u.id = so.owner_id
      LEFT JOIN departments d ON d.id = so.department_id
      LEFT JOIN (
        SELECT service_order_id, COUNT(*)::int AS process_count
          FROM service_order_items
         WHERE tenant_id = $1 AND process_id IS NOT NULL
         GROUP BY service_order_id
      ) pc ON pc.service_order_id = so.id
      LEFT JOIN (
        SELECT service_order_id,
               COALESCE(SUM(COALESCE(actual_cost, planned_cost)), 0)::float AS cost_total
          FROM execution_costs
         WHERE tenant_id = $1 AND status <> 'cancelado'
         GROUP BY service_order_id
      ) ec ON ec.service_order_id = so.id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT so.*, c.name AS client_name, s.number AS sale_number, s.net_amount AS sale_amount,
            u.name AS owner_name, d.name AS department_name,
            COALESCE(pc.process_count, 0) AS process_count,
            COALESCE(ec.cost_total, 0) AS cost_total
       ${from} ORDER BY so.due_date NULLS LAST, so.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function getServiceOrder(tenantId, id) {
  const serviceOrderId = uuidOrNull(id);
  if (!serviceOrderId) return null;
  const { rows } = await pool.query(
    `SELECT so.*, c.name AS client_name, c.cpf AS client_cpf, c.phone AS client_phone,
            s.number AS sale_number, s.net_amount AS sale_amount, s.estimated_cost,
            o.number AS order_number, u.name AS owner_name, d.name AS department_name
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
       LEFT JOIN sales s ON s.id = so.sale_id AND s.tenant_id = so.tenant_id
       LEFT JOIN orders o ON o.id = so.order_id AND o.tenant_id = so.tenant_id
       LEFT JOIN users u ON u.id = so.owner_id
       LEFT JOIN departments d ON d.id = so.department_id
      WHERE so.id = $1 AND so.tenant_id = $2`,
    [serviceOrderId, tenantId]
  );
  if (!rows[0]) return null;

  const [items, costs, payables, fiscal, finalization, documents] = await Promise.all([
    pool.query(
      `SELECT i.*, f.fine_number AS process_number, f.stage AS process_stage,
              f.status AS process_status, sup.legal_name AS supplier_name
         FROM service_order_items i
         LEFT JOIN fines f ON f.id = i.process_id AND f.tenant_id = i.tenant_id
         LEFT JOIN suppliers sup ON sup.id = i.supplier_id
        WHERE i.tenant_id = $1 AND i.service_order_id = $2 ORDER BY i.sort_order ASC`,
      [tenantId, serviceOrderId]),
    pool.query(
      `SELECT e.*, s.legal_name AS supplier_name FROM execution_costs e
         LEFT JOIN suppliers s ON s.id = e.supplier_id
        WHERE e.tenant_id = $1 AND e.service_order_id = $2 ORDER BY e.created_at DESC`,
      [tenantId, serviceOrderId]),
    pool.query(
      `SELECT * FROM payables WHERE tenant_id = $1 AND service_order_id = $2 ORDER BY due_date NULLS LAST`,
      [tenantId, serviceOrderId]),
    pool.query('SELECT * FROM fiscal_documents WHERE tenant_id = $1 AND service_order_id = $2',
      [tenantId, serviceOrderId]),
    pool.query('SELECT * FROM finalization_records WHERE tenant_id = $1 AND service_order_id = $2',
      [tenantId, serviceOrderId]),
    pool.query(
      `SELECT id, doc_type, title, status, stage, created_at FROM generated_documents
        WHERE tenant_id = $1 AND entity_type = 'service_order' AND entity_id = $2
          AND status <> 'cancelado' ORDER BY created_at DESC`,
      [tenantId, serviceOrderId]),
  ]);

  return {
    ...rows[0],
    items: items.rows,
    costs: costs.rows,
    payables: payables.rows,
    fiscal_document: fiscal.rows[0] || null,
    finalization: finalization.rows[0] || null,
    documents: documents.rows,
  };
}

/** Transicoes da execucao (§25). Cancelamento e pausa exigem justificativa. */
async function changeServiceOrderStatus(tenantId, userId, id, targetStatus, reason, expectedVersion) {
  const serviceOrderId = uuidOrNull(id);
  if (!serviceOrderId) throw new BusinessError('Ordem de servico nao encontrada.', 404);
  const target = oneOf(targetStatus, SO_STATUSES, null);
  if (!target) throw new BusinessError('Situacao invalida.');
  const justification = cleanOrNull(reason, 2000);
  if (['cancelada', 'pausada', 'aguardando_terceiro'].includes(target) && !justification) {
    throw new BusinessError('Informe o motivo desta mudanca de situacao.');
  }

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, serviceOrderId, expectedVersion);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    if (serviceOrder.status === target) return serviceOrder;
    if (!SO_TRANSITIONS[serviceOrder.status].includes(target)) {
      throw new BusinessError(`Nao e possivel mudar de "${serviceOrder.status}" para "${target}".`);
    }
    if (target === 'em_execucao' && !serviceOrder.owner_id) {
      throw new BusinessError('Atribua um responsavel antes de iniciar a execucao.');
    }

    const { rows } = await client.query(
      `UPDATE service_orders
          SET status = $3,
              started_at = CASE WHEN $3 = 'em_execucao' AND started_at IS NULL THEN NOW() ELSE started_at END,
              finished_at = CASE WHEN $3 = 'concluida' THEN NOW() ELSE finished_at END,
              cancel_reason = CASE WHEN $3 = 'cancelada' THEN $4 ELSE cancel_reason END,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [serviceOrderId, tenantId, target, justification]
    );
    if (target === 'concluida') {
      await client.query(
        `UPDATE sales SET status = 'concluida', row_version = row_version + 1, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND status = 'em_execucao'`,
        [serviceOrder.sale_id, tenantId]);
    }
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrderId,
      action: 'situacao_alterada', from_status: serviceOrder.status, to_status: target,
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

/** Atribui/redistribui responsavel e setor — sempre com registro no historico. */
async function assignServiceOrder(tenantId, userId, id, input) {
  const serviceOrderId = uuidOrNull(id);
  if (!serviceOrderId) throw new BusinessError('Ordem de servico nao encontrada.', 404);

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, serviceOrderId, input.row_version);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);

    const ownerId = uuidOrNull(input.owner_id);
    const departmentId = uuidOrNull(input.department_id);
    if (ownerId) {
      const { rows } = await client.query(
        'SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [ownerId, tenantId]);
      if (!rows[0]) throw new BusinessError('Responsavel nao encontrado neste tenant.');
    }
    const { rows } = await client.query(
      `UPDATE service_orders SET owner_id = $3, department_id = COALESCE($4, department_id),
              priority = COALESCE($5, priority), due_date = COALESCE($6, due_date),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [serviceOrderId, tenantId, ownerId, departmentId,
       oneOf(input.priority, PRIORITIES, null), dateOrNull(input.due_date)]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrderId,
      action: serviceOrder.owner_id ? 'redistribuida' : 'atribuida',
      details: { from_owner: serviceOrder.owner_id, to_owner: ownerId }, user_id: userId,
    });
    return rows[0];
  });
}

/** Andamento livre da execucao: vira historico, nao muda situacao. */
async function addProgress(tenantId, userId, id, note) {
  const serviceOrderId = uuidOrNull(id);
  const text = cleanOrNull(note, 4000);
  if (!serviceOrderId) throw new BusinessError('Ordem de servico nao encontrada.', 404);
  if (!text) throw new BusinessError('Informe o andamento.');
  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, serviceOrderId);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrderId,
      action: 'andamento_registrado', reason: text, user_id: userId,
    });
    return { ok: true };
  });
}

/** Vincula um item da ordem a um processo ja existente (§24). */
async function linkItemProcess(tenantId, userId, id, itemId, processId) {
  const serviceOrderId = uuidOrNull(id);
  const targetItem = uuidOrNull(itemId);
  const targetProcess = uuidOrNull(processId);
  if (!serviceOrderId || !targetItem) throw new BusinessError('Item nao encontrado.', 404);

  return withTransaction(async (client) => {
    if (targetProcess) {
      const { rows } = await client.query(
        'SELECT id FROM fines WHERE id = $1 AND tenant_id = $2', [targetProcess, tenantId]);
      if (!rows[0]) throw new BusinessError('Processo nao encontrado neste tenant.', 404);
    }
    const { rows } = await client.query(
      `UPDATE service_order_items SET process_id = $4, updated_at = NOW()
        WHERE id = $1 AND service_order_id = $2 AND tenant_id = $3 RETURNING *`,
      [targetItem, serviceOrderId, tenantId, targetProcess]
    );
    if (!rows[0]) throw new BusinessError('Item nao encontrado.', 404);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrderId,
      action: targetProcess ? 'processo_vinculado' : 'processo_desvinculado',
      details: { item_id: targetItem, process_id: targetProcess }, user_id: userId,
    });
    return rows[0];
  });
}

// ── Custos da execucao ───────────────────────────────────────────────────────

async function addExecutionCost(tenantId, userId, id, input) {
  const serviceOrderId = uuidOrNull(id);
  const supplierId = uuidOrNull(input.supplier_id);
  const description = clean(input.description, 255);
  if (!serviceOrderId) throw new BusinessError('Ordem de servico nao encontrada.', 404);
  if (!supplierId) throw new BusinessError('Selecione o fornecedor ou prestador.');
  if (!description) throw new BusinessError('Descreva o servico prestado.');
  const planned = money(input.planned_cost) ?? 0;
  const actual = money(input.actual_cost);

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, serviceOrderId);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    const { rows: supplierRows } = await client.query(
      'SELECT id, legal_name FROM suppliers WHERE id = $1 AND tenant_id = $2', [supplierId, tenantId]);
    if (!supplierRows[0]) throw new BusinessError('Fornecedor nao encontrado neste tenant.', 404);

    const { rows } = await client.query(
      `INSERT INTO execution_costs
         (tenant_id, service_order_id, service_order_item_id, sale_id, supplier_id, description,
          planned_cost, actual_cost, incurred_on, document_ref, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [tenantId, serviceOrderId, uuidOrNull(input.service_order_item_id), serviceOrder.sale_id,
       supplierId, description, planned, actual, dateOrNull(input.incurred_on),
       cleanOrNull(input.document_ref, 120),
       // Custo com valor real informado ja nasce confirmado; sem valor, e previsao.
       actual === null ? 'previsto' : oneOf(input.status, COST_STATUSES, 'confirmado'),
       cleanOrNull(input.notes, 2000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: serviceOrderId,
      action: 'custo_registrado',
      details: { supplier: supplierRows[0].legal_name, planned, actual }, user_id: userId,
    });
    return rows[0];
  });
}

/** Atualiza o custo — permite informar o custo real depois (§26). */
async function updateExecutionCost(tenantId, userId, costId, input) {
  const id = uuidOrNull(costId);
  if (!id) throw new BusinessError('Custo nao encontrado.', 404);

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'execution_costs', tenantId, id, input.row_version);
    if (!current) throw new BusinessError('Custo nao encontrado.', 404);

    const planned = Object.prototype.hasOwnProperty.call(input, 'planned_cost')
      ? (money(input.planned_cost) ?? 0) : Number(current.planned_cost);
    const actual = Object.prototype.hasOwnProperty.call(input, 'actual_cost')
      ? money(input.actual_cost) : current.actual_cost;
    const status = oneOf(input.status, COST_STATUSES, null)
      || (actual === null ? current.status : 'confirmado');

    const { rows } = await client.query(
      `UPDATE execution_costs
          SET planned_cost = $3, actual_cost = $4, status = $5,
              incurred_on = COALESCE($6, incurred_on),
              document_ref = COALESCE($7, document_ref), notes = COALESCE($8, notes),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, planned, actual, status, dateOrNull(input.incurred_on),
       cleanOrNull(input.document_ref, 120), cleanOrNull(input.notes, 2000)]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: current.service_order_id,
      action: 'custo_atualizado',
      details: { cost_id: id, planned, actual, status }, user_id: userId,
    });
    return rows[0];
  });
}

// ── Obrigacoes: acao guiada "Preparar pagamentos" (§28) ──────────────────────

/**
 * CALCULA a previa das obrigacoes da venda/ordem. NAO persiste nada.
 * O usuario ajusta, remove, adiciona e so entao chama confirmObligations().
 */
async function prepareObligations(tenantId, saleId) {
  const id = uuidOrNull(saleId);
  if (!id) return null;
  const { rows: saleRows } = await pool.query(
    `SELECT s.*, c.name AS client_name FROM sales s
       JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [id, tenantId]);
  const sale = saleRows[0];
  if (!sale) return null;

  const [itemsResult, soResult, costsResult, existingPayables, existingCommissions] = await Promise.all([
    pool.query(
      `SELECT i.*, sup.legal_name AS supplier_name, sup.commission_type AS supplier_commission_type,
              sup.commission_value AS supplier_commission_value, sup.payment_terms
         FROM sale_items i LEFT JOIN suppliers sup ON sup.id = i.supplier_id
        WHERE i.tenant_id = $1 AND i.sale_id = $2 ORDER BY i.sort_order`,
      [tenantId, id]),
    pool.query('SELECT id, number, due_date FROM service_orders WHERE tenant_id = $1 AND sale_id = $2',
      [tenantId, id]),
    pool.query(
      `SELECT e.*, s.legal_name AS supplier_name FROM execution_costs e
         LEFT JOIN suppliers s ON s.id = e.supplier_id
        WHERE e.tenant_id = $1 AND e.sale_id = $2 AND e.status <> 'cancelado'`,
      [tenantId, id]),
    pool.query(
      `SELECT execution_cost_id, commission_id FROM payables
        WHERE tenant_id = $1 AND sale_id = $2 AND status <> 'cancelado'`,
      [tenantId, id]),
    pool.query(
      `SELECT sale_item_id, beneficiary_supplier_id FROM commissions
        WHERE tenant_id = $1 AND sale_id = $2 AND status <> 'cancelada'`,
      [tenantId, id]),
  ]);

  const serviceOrder = soResult.rows[0] || null;
  const payableCostIds = new Set(existingPayables.rows.map((row) => row.execution_cost_id).filter(Boolean));
  const commissionKeys = new Set(existingCommissions.rows
    .map((row) => `${row.sale_item_id || ''}|${row.beneficiary_supplier_id || ''}`));
  const suggestedDue = serviceOrder && serviceOrder.due_date
    ? serviceOrder.due_date
    : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  // Custos ja registrados na execucao que ainda nao viraram obrigacao.
  const costObligations = costsResult.rows
    .filter((cost) => !payableCostIds.has(cost.id))
    .map((cost) => ({
      kind: 'fornecedor',
      execution_cost_id: cost.id,
      payee_supplier_id: cost.supplier_id,
      payee_name: cost.supplier_name || 'Fornecedor',
      description: cost.description,
      amount: Math.round(Number(cost.actual_cost ?? cost.planned_cost) * 100) / 100,
      due_date: suggestedDue,
      source: cost.actual_cost === null ? 'custo previsto' : 'custo realizado',
    }))
    .filter((entry) => entry.amount > 0);

  // Comissoes sugeridas pela regra do item ou do parceiro; nada e gravado aqui.
  const commissionObligations = itemsResult.rows
    .map((item) => {
      const rule = item.commission_type
        ? { commission_type: item.commission_type, commission_value: item.commission_value }
        : { commission_type: item.supplier_commission_type, commission_value: item.supplier_commission_value };
      const amount = suggestedCommission(rule, Number(item.total));
      if (!amount || !item.supplier_id) return null;
      if (commissionKeys.has(`${item.id}|${item.supplier_id}`)) return null;
      return {
        kind: 'comissao',
        sale_item_id: item.id,
        beneficiary_supplier_id: item.supplier_id,
        payee_name: item.supplier_name,
        description: `Comissao — ${item.description}`,
        base_amount: Number(item.total),
        rate_type: rule.commission_type,
        rate_value: Number(rule.commission_value),
        amount,
        due_date: suggestedDue,
        source: item.commission_type ? 'regra do item' : 'regra do parceiro',
      };
    })
    .filter(Boolean);

  return {
    sale: {
      id: sale.id, number: sale.number, client_name: sale.client_name,
      net_amount: Number(sale.net_amount), estimated_cost: Number(sale.estimated_cost),
    },
    service_order: serviceOrder,
    custos: costObligations,
    comissoes: commissionObligations,
    total_sugerido: Math.round(
      [...costObligations, ...commissionObligations].reduce((sum, entry) => sum + entry.amount, 0) * 100
    ) / 100,
    aviso: 'Previa calculada. Nada e registrado ate a confirmacao explicita.',
  };
}

/**
 * Persiste as obrigacoes APROVADAS pelo usuario (§28). Recebe a lista ja
 * revisada — o servidor nao reusa a previa, justamente para respeitar ajustes,
 * remocoes e inclusoes feitas na tela.
 */
async function confirmObligations(tenantId, userId, saleId, input = {}) {
  const id = uuidOrNull(saleId);
  if (!id) throw new BusinessError('Venda nao encontrada.', 404);
  const entries = Array.isArray(input.obligations) ? input.obligations : [];
  if (!entries.length) throw new BusinessError('Nenhuma obrigacao para confirmar.');

  return withTransaction(async (client) => {
    const sale = await lockRow(client, 'sales', tenantId, id);
    if (!sale) throw new BusinessError('Venda nao encontrada.', 404);
    const { rows: soRows } = await client.query(
      'SELECT id FROM service_orders WHERE tenant_id = $1 AND sale_id = $2', [tenantId, id]);
    const serviceOrderId = soRows[0] ? soRows[0].id : null;

    const created = { payables: [], commissions: [] };
    for (const entry of entries) {
      const kind = oneOf(entry.kind, PAYABLE_KINDS, null);
      const amount = money(entry.amount);
      const description = clean(entry.description, 255);
      if (!kind) throw new BusinessError('Tipo de obrigacao invalido.');
      if (amount === null || amount <= 0) throw new BusinessError(`Valor invalido em "${description}".`);
      if (!description) throw new BusinessError('Informe a descricao da obrigacao.');

      const supplierId = uuidOrNull(entry.payee_supplier_id || entry.beneficiary_supplier_id);
      const beneficiaryUserId = uuidOrNull(entry.payee_user_id || entry.beneficiary_user_id);
      if (!supplierId && !beneficiaryUserId) {
        throw new BusinessError(`Informe o favorecido de "${description}".`);
      }
      if (supplierId) {
        const { rows } = await client.query(
          'SELECT id, legal_name FROM suppliers WHERE id = $1 AND tenant_id = $2', [supplierId, tenantId]);
        if (!rows[0]) throw new BusinessError('Favorecido nao encontrado neste tenant.');
        entry.payee_name = entry.payee_name || rows[0].legal_name;
      }

      let commissionId = null;
      if (kind === 'comissao') {
        const saleItemId = uuidOrNull(entry.sale_item_id);
        const { rows: dup } = await client.query(
          `SELECT id FROM commissions
            WHERE tenant_id = $1 AND sale_id = $2 AND status <> 'cancelada'
              AND COALESCE(sale_item_id::text,'') = COALESCE($3::text,'')
              AND COALESCE(beneficiary_supplier_id::text,'') = COALESCE($4::text,'')
              AND COALESCE(beneficiary_user_id::text,'') = COALESCE($5::text,'')`,
          [tenantId, id, saleItemId, supplierId, beneficiaryUserId]);
        if (dup[0]) throw new BusinessError(`Comissao ja registrada para "${description}".`, 409);

        const { rows: commissionRows } = await client.query(
          `INSERT INTO commissions
             (tenant_id, sale_id, sale_item_id, beneficiary_supplier_id, beneficiary_user_id,
              beneficiary_name, base_amount, rate_type, rate_value, amount, status,
              expected_date, notes, confirmed_by, confirmed_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmada',$11,$12,$13,NOW(),$13)
           RETURNING *`,
          [tenantId, id, saleItemId, supplierId, beneficiaryUserId,
           clean(entry.payee_name || entry.beneficiary_name, 200) || 'Beneficiario',
           money(entry.base_amount) ?? 0, oneOf(entry.rate_type, ['percentual', 'fixo'], 'fixo'),
           money(entry.rate_value) ?? 0, amount, dateOrNull(entry.due_date),
           cleanOrNull(entry.notes, 2000), userId]
        );
        commissionId = commissionRows[0].id;
        created.commissions.push(commissionRows[0]);
        await recordHistory(client, {
          tenant_id: tenantId, entity_type: 'commission', entity_id: commissionId,
          action: 'comissao_confirmada', to_status: 'confirmada',
          details: { sale_number: sale.number, amount }, user_id: userId,
        });
      }

      const executionCostId = uuidOrNull(entry.execution_cost_id);
      if (executionCostId) {
        const { rows: dup } = await client.query(
          `SELECT id FROM payables
            WHERE tenant_id = $1 AND execution_cost_id = $2 AND status <> 'cancelado'`,
          [tenantId, executionCostId]);
        if (dup[0]) throw new BusinessError(`Ja existe obrigacao para o custo de "${description}".`, 409);
      }

      const { rows: payableRows } = await client.query(
        `INSERT INTO payables
           (tenant_id, kind, payee_supplier_id, payee_user_id, payee_name, order_id, sale_id,
            service_order_id, execution_cost_id, commission_id, description, amount, due_date,
            payment_method, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'previsto',$15,$16)
         RETURNING *`,
        [tenantId, kind, supplierId, beneficiaryUserId,
         clean(entry.payee_name, 200) || 'Favorecido', sale.order_id, id, serviceOrderId,
         executionCostId, commissionId, description, amount, dateOrNull(entry.due_date),
         cleanOrNull(entry.payment_method, 30), cleanOrNull(entry.notes, 2000), userId]
      );
      created.payables.push(payableRows[0]);
      if (commissionId) {
        await client.query('UPDATE commissions SET payable_id = $3 WHERE id = $1 AND tenant_id = $2',
          [commissionId, tenantId, payableRows[0].id]);
      }
      await recordHistory(client, {
        tenant_id: tenantId, entity_type: 'payable', entity_id: payableRows[0].id,
        action: 'obrigacao_criada', to_status: 'previsto',
        details: { kind, amount, sale_number: sale.number }, user_id: userId,
      });
    }
    return created;
  });
}

// ── Contas a pagar ───────────────────────────────────────────────────────────

async function listPayables(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['p.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, PAYABLE_STATUSES, null);
  if (status) filters.push(`p.status = ${push(status)}`);
  const kind = oneOf(query.kind, PAYABLE_KINDS, null);
  if (kind) filters.push(`p.kind = ${push(kind)}`);
  const supplierId = uuidOrNull(query.supplier_id);
  if (supplierId) filters.push(`p.payee_supplier_id = ${push(supplierId)}`);
  const saleId = uuidOrNull(query.sale_id);
  if (saleId) filters.push(`p.sale_id = ${push(saleId)}`);
  const serviceOrderId = uuidOrNull(query.service_order_id);
  if (serviceOrderId) filters.push(`p.service_order_id = ${push(serviceOrderId)}`);
  if (query.overdue === 'true') {
    filters.push("p.due_date < CURRENT_DATE AND p.status IN ('previsto','aprovado','agendado')");
  }
  if (query.open === 'true') filters.push("p.status IN ('previsto','aprovado','agendado','vencido')");
  const where = filters.join(' AND ');
  const from = `
      FROM payables p
      LEFT JOIN suppliers s ON s.id = p.payee_supplier_id
      LEFT JOIN sales sa ON sa.id = p.sale_id AND sa.tenant_id = p.tenant_id
      LEFT JOIN service_orders so ON so.id = p.service_order_id AND so.tenant_id = p.tenant_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT p.*, s.legal_name AS supplier_name, sa.number AS sale_number, so.number AS service_order_number
       ${from} ORDER BY p.due_date NULLS LAST, p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

/**
 * Muda a situacao da obrigacao. Marcar como paga NAO integra com banco (§27):
 * apenas registra data, comprovante e responsavel.
 */
async function decidePayable(tenantId, userId, id, input) {
  const payableId = uuidOrNull(id);
  if (!payableId) throw new BusinessError('Obrigacao nao encontrada.', 404);
  const target = oneOf(input.status, PAYABLE_STATUSES, null);
  if (!target) throw new BusinessError('Situacao invalida.');
  const justification = cleanOrNull(input.reason, 2000);
  if (['cancelado', 'estornado'].includes(target) && !justification) {
    throw new BusinessError('Cancelamento e estorno exigem justificativa.');
  }

  return withTransaction(async (client) => {
    const payable = await lockRow(client, 'payables', tenantId, payableId, input.row_version);
    if (!payable) throw new BusinessError('Obrigacao nao encontrada.', 404);
    if (payable.status === 'pago' && target === 'pago') {
      throw new BusinessError('Obrigacao ja esta paga.', 409);
    }
    if (target === 'pago' && !['previsto', 'aprovado', 'agendado', 'vencido'].includes(payable.status)) {
      throw new BusinessError(`Obrigacao em "${payable.status}" nao pode ser paga.`);
    }

    const { rows } = await client.query(
      `UPDATE payables
          SET status = $3,
              approved_by = CASE WHEN $3 = 'aprovado' THEN $4 ELSE approved_by END,
              approved_at = CASE WHEN $3 = 'aprovado' THEN NOW() ELSE approved_at END,
              paid_by = CASE WHEN $3 = 'pago' THEN $4 ELSE paid_by END,
              paid_at = CASE WHEN $3 = 'pago' THEN COALESCE($5::date, CURRENT_DATE) ELSE paid_at END,
              proof_url = COALESCE($6, proof_url),
              payment_method = COALESCE($7, payment_method),
              notes = COALESCE($8, notes),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [payableId, tenantId, target, userId, dateOrNull(input.paid_at),
       cleanOrNull(input.proof_url, 2000), cleanOrNull(input.payment_method, 30),
       cleanOrNull(input.notes, 2000)]
    );

    // Comissao acompanha a obrigacao correspondente.
    if (payable.commission_id) {
      const commissionStatus = { pago: 'paga', cancelado: 'cancelada', estornado: 'estornada' }[target];
      if (commissionStatus) {
        await client.query(
          `UPDATE commissions SET status = $3, paid_at = CASE WHEN $3 = 'paga' THEN COALESCE($4::date, CURRENT_DATE) ELSE paid_at END,
                  proof_url = COALESCE($5, proof_url), row_version = row_version + 1, updated_at = NOW()
            WHERE id = $1 AND tenant_id = $2`,
          [payable.commission_id, tenantId, commissionStatus, dateOrNull(input.paid_at),
           cleanOrNull(input.proof_url, 2000)]);
      }
    }

    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'payable', entity_id: payableId,
      action: target === 'pago' ? 'pagamento_registrado' : 'situacao_alterada',
      from_status: payable.status, to_status: target, reason: justification,
      details: { amount: Number(payable.amount) }, user_id: userId,
    });
    return rows[0];
  });
}

/** Obrigacao avulsa (despesa, adiantamento) fora da previa da venda. */
async function createPayable(tenantId, userId, input) {
  const kind = oneOf(input.kind, PAYABLE_KINDS, null);
  const amount = money(input.amount);
  const description = clean(input.description, 255);
  if (!kind) throw new BusinessError('Selecione o tipo da obrigacao.');
  if (amount === null || amount <= 0) throw new BusinessError('Informe um valor maior que zero.');
  if (!description) throw new BusinessError('Informe a descricao.');
  const supplierId = uuidOrNull(input.payee_supplier_id);
  const beneficiaryUserId = uuidOrNull(input.payee_user_id);
  if (!supplierId && !beneficiaryUserId) throw new BusinessError('Informe o favorecido.');

  return withTransaction(async (client) => {
    let payeeName = clean(input.payee_name, 200);
    if (supplierId) {
      const { rows } = await client.query(
        'SELECT legal_name FROM suppliers WHERE id = $1 AND tenant_id = $2', [supplierId, tenantId]);
      if (!rows[0]) throw new BusinessError('Favorecido nao encontrado neste tenant.', 404);
      payeeName = payeeName || rows[0].legal_name;
    }
    const { rows } = await client.query(
      `INSERT INTO payables
         (tenant_id, kind, payee_supplier_id, payee_user_id, payee_name, order_id, sale_id,
          service_order_id, process_id, description, amount, due_date, payment_method,
          status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'previsto',$14,$15) RETURNING *`,
      [tenantId, kind, supplierId, beneficiaryUserId, payeeName || 'Favorecido',
       uuidOrNull(input.order_id), uuidOrNull(input.sale_id), uuidOrNull(input.service_order_id),
       uuidOrNull(input.process_id), description, amount, dateOrNull(input.due_date),
       cleanOrNull(input.payment_method, 30), cleanOrNull(input.notes, 2000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'payable', entity_id: rows[0].id,
      action: 'obrigacao_criada', to_status: 'previsto',
      details: { kind, amount }, user_id: userId,
    });
    return rows[0];
  });
}

// ── Comissoes ────────────────────────────────────────────────────────────────

async function listCommissions(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['c.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const status = oneOf(query.status, COMMISSION_STATUSES, null);
  if (status) filters.push(`c.status = ${push(status)}`);
  const saleId = uuidOrNull(query.sale_id);
  if (saleId) filters.push(`c.sale_id = ${push(saleId)}`);
  const supplierId = uuidOrNull(query.beneficiary_supplier_id);
  if (supplierId) filters.push(`c.beneficiary_supplier_id = ${push(supplierId)}`);
  if (query.open === 'true') filters.push("c.status IN ('prevista','confirmada')");
  const where = filters.join(' AND ');
  const from = `
      FROM commissions c
      LEFT JOIN sales s ON s.id = c.sale_id AND s.tenant_id = c.tenant_id
      LEFT JOIN suppliers sup ON sup.id = c.beneficiary_supplier_id
      LEFT JOIN users u ON u.id = c.beneficiary_user_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT c.*, s.number AS sale_number, s.net_amount AS sale_amount,
            COALESCE(sup.legal_name, u.name, c.beneficiary_name) AS beneficiary_display
       ${from} ORDER BY c.expected_date NULLS LAST, c.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function changeCommissionStatus(tenantId, userId, id, targetStatus, reason, expectedVersion) {
  const commissionId = uuidOrNull(id);
  if (!commissionId) throw new BusinessError('Comissao nao encontrada.', 404);
  const target = oneOf(targetStatus, COMMISSION_STATUSES, null);
  if (!target) throw new BusinessError('Situacao invalida.');
  const justification = cleanOrNull(reason, 2000);
  if (['cancelada', 'estornada'].includes(target) && !justification) {
    throw new BusinessError('Cancelamento e estorno exigem justificativa.');
  }

  return withTransaction(async (client) => {
    const commission = await lockRow(client, 'commissions', tenantId, commissionId, expectedVersion);
    if (!commission) throw new BusinessError('Comissao nao encontrada.', 404);
    const { rows } = await client.query(
      `UPDATE commissions SET status = $3,
              confirmed_by = CASE WHEN $3 = 'confirmada' THEN $4 ELSE confirmed_by END,
              confirmed_at = CASE WHEN $3 = 'confirmada' THEN NOW() ELSE confirmed_at END,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [commissionId, tenantId, target, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'commission', entity_id: commissionId,
      action: 'situacao_alterada', from_status: commission.status, to_status: target,
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

module.exports = {
  SO_STATUSES,
  SO_TRANSITIONS,
  PRIORITIES,
  COST_STATUSES,
  PAYABLE_STATUSES,
  PAYABLE_KINDS,
  COMMISSION_STATUSES,
  createServiceOrder,
  listServiceOrders,
  getServiceOrder,
  changeServiceOrderStatus,
  assignServiceOrder,
  addProgress,
  linkItemProcess,
  addExecutionCost,
  updateExecutionCost,
  prepareObligations,
  confirmObligations,
  listPayables,
  createPayable,
  decidePayable,
  listCommissions,
  changeCommissionStatus,
};
