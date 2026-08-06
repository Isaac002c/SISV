'use strict';

// =============================================================================
// supplierModels.js — fornecedores, prestadores, parceiros, indicadores e
// correspondentes (§5 e §6 do SISV 2.0).
//
// Estrutura unica classificada por `kind`: parceiro e prestador NAO tem tabela
// propria — o que muda entre eles e a classificacao e a regra de comissao.
//
// Nunca ha exclusao fisica: um fornecedor com historico e apenas inativado, e
// continua visivel em vendas, pagamentos e auditoria anteriores.
// =============================================================================

const pool = require('../config/db');
const {
  clean, cleanOrNull, money, bool, uuidOrNull, oneOf, paging,
  recordHistory, lockRow, withTransaction, BusinessError,
} = require('../services/commercialCommon');

const KINDS = Object.freeze(['fornecedor', 'prestador', 'parceiro', 'indicador', 'correspondente', 'outro']);
const PERSON_TYPES = Object.freeze(['pf', 'pj']);
const COMMISSION_TYPES = Object.freeze(['percentual', 'fixo']);
const SORTABLE = Object.freeze(['legal_name', 'created_at', 'updated_at', 'kind']);

/** Mantem apenas digitos do CPF/CNPJ; string vazia vira null. */
const onlyDigits = (value) => {
  const digits = clean(value, 30).replace(/\D/g, '');
  return digits === '' ? null : digits.slice(0, 20);
};

function parseInput(input = {}, { partial = false } = {}) {
  const data = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const set = (key, value) => { if (!partial || has(key)) data[key] = value; };

  set('kind', oneOf(input.kind, KINDS, 'fornecedor'));
  set('person_type', oneOf(input.person_type, PERSON_TYPES, 'pj'));
  set('legal_name', clean(input.legal_name, 200));
  set('trade_name', cleanOrNull(input.trade_name, 200));
  set('document', onlyDigits(input.document));
  set('state_registration', cleanOrNull(input.state_registration, 40));
  set('contact_name', cleanOrNull(input.contact_name, 160));
  set('phone', cleanOrNull(input.phone, 30));
  set('whatsapp', cleanOrNull(input.whatsapp, 30));
  set('email', cleanOrNull(input.email, 200));
  set('address', cleanOrNull(input.address, 2000));
  set('bank_details', cleanOrNull(input.bank_details, 1000));
  set('pix_key', cleanOrNull(input.pix_key, 200));
  set('services_provided', cleanOrNull(input.services_provided, 2000));
  set('commission_type', input.commission_type ? oneOf(input.commission_type, COMMISSION_TYPES, null) : null);
  set('commission_value', money(input.commission_value));
  set('payment_terms', cleanOrNull(input.payment_terms, 160));
  set('default_price_table_id', uuidOrNull(input.default_price_table_id));
  set('discount_type', input.discount_type ? oneOf(input.discount_type, COMMISSION_TYPES, null) : null);
  set('discount_value', money(input.discount_value));
  set('payment_method', cleanOrNull(input.payment_method, 40));
  set('commercial_notes', cleanOrNull(input.commercial_notes, 2000));
  set('notes', cleanOrNull(input.notes, 4000));
  if (has('active')) data.active = bool(input.active);
  return data;
}

function validate(data, { partial = false } = {}) {
  if ((!partial || data.legal_name !== undefined) && !clean(data.legal_name, 200)) {
    return 'Informe o nome ou razao social do fornecedor.';
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return 'E-mail invalido.';
  }
  // Percentual acima de 100 quase sempre e erro de digitacao (ex.: 1500 no lugar de 15).
  if (data.commission_type === 'percentual' && data.commission_value !== null
      && data.commission_value !== undefined && data.commission_value > 100) {
    return 'Comissao percentual nao pode ultrapassar 100%.';
  }
  if (data.commission_value !== null && data.commission_value !== undefined
      && data.commission_value > 0 && !data.commission_type) {
    return 'Informe o tipo da comissao (percentual ou valor fixo).';
  }
  if (data.discount_type === 'percentual' && data.discount_value !== null
      && data.discount_value !== undefined && data.discount_value > 100) {
    return 'Desconto percentual nao pode ultrapassar 100%.';
  }
  if (data.discount_value !== null && data.discount_value !== undefined
      && data.discount_value > 0 && !data.discount_type) {
    return 'Informe o tipo do desconto comercial (percentual ou valor fixo).';
  }
  return null;
}

async function list(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['s.tenant_id = $1'];
  const params = [tenantId];

  const term = clean(query.q, 120);
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(s.legal_name) LIKE $${params.length}
                  OR LOWER(COALESCE(s.trade_name,'')) LIKE $${params.length}
                  OR COALESCE(s.document,'') LIKE $${params.length}
                  OR LOWER(COALESCE(s.email,'')) LIKE $${params.length})`);
  }
  const kind = oneOf(query.kind, KINDS, null);
  if (kind) { params.push(kind); filters.push(`s.kind = $${params.length}`); }
  // Sem filtro explicito, a listagem mostra apenas ativos (o historico continua
  // acessivel por id e pelos vinculos em vendas/pagamentos).
  if (query.active !== 'all') {
    params.push(query.active === undefined ? true : bool(query.active));
    filters.push(`s.active = $${params.length}`);
  }

  const sortField = SORTABLE.includes(clean(query.sort, 40)) ? clean(query.sort, 40) : 'legal_name';
  const sortDir = clean(query.dir, 4).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const where = filters.join(' AND ');

  const { rows } = await pool.query(
    `SELECT s.*, u.name AS created_by_name
       FROM suppliers s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE ${where}
      ORDER BY s.${sortField} ${sortDir}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM suppliers s WHERE ${where}`, params
  );
  return { rows, total: countRows[0].total, page, limit };
}

async function getById(tenantId, id) {
  const supplierId = uuidOrNull(id);
  if (!supplierId) return null;
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS created_by_name, u.name AS updated_by_name
       FROM suppliers s
       LEFT JOIN users c ON c.id = s.created_by
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [supplierId, tenantId]
  );
  return rows[0] || null;
}

/** Dados estritamente necessarios para escolher um parceiro como contratante. */
async function listActivePartners(tenantId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.legal_name, s.trade_name, s.document, s.email, s.phone,
            s.default_price_table_id, p.name AS default_price_table_name,
            s.discount_type, s.discount_value, s.payment_terms, s.payment_method,
            s.commission_type, s.commission_value, s.commercial_notes
       FROM suppliers s
       LEFT JOIN price_tables p ON p.id = s.default_price_table_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.kind = 'parceiro' AND s.active = TRUE
      ORDER BY s.legal_name ASC`,
    [tenantId]
  );
  return rows;
}

async function assertPriceTable(client, tenantId, priceTableId) {
  if (!priceTableId) return;
  const { rows } = await client.query(
    'SELECT id FROM price_tables WHERE id = $1 AND tenant_id = $2',
    [priceTableId, tenantId]
  );
  if (!rows[0]) throw new BusinessError('Tabela de precos do parceiro nao pertence a este tenant.');
}

async function create(tenantId, userId, input) {
  const data = parseInput(input);
  const error = validate(data);
  if (error) throw new BusinessError(error);

  return withTransaction(async (client) => {
    await assertPriceTable(client, tenantId, data.default_price_table_id);
    if (data.document) {
      const { rows } = await client.query(
        'SELECT id, legal_name FROM suppliers WHERE tenant_id = $1 AND document = $2',
        [tenantId, data.document]
      );
      if (rows[0]) throw new BusinessError(`Ja existe cadastro com este CPF/CNPJ: ${rows[0].legal_name}.`);
    }
    const columns = Object.keys(data);
    const placeholders = columns.map((_, index) => `$${index + 3}`);
    const { rows } = await client.query(
      `INSERT INTO suppliers (tenant_id, created_by, ${columns.join(', ')})
       VALUES ($1, $2, ${placeholders.join(', ')})
       RETURNING *`,
      [tenantId, userId, ...columns.map((column) => data[column])]
    );
    const supplier = rows[0];
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'supplier', entity_id: supplier.id,
      action: 'criado', to_status: supplier.active ? 'ativo' : 'inativo',
      details: { kind: supplier.kind, legal_name: supplier.legal_name }, user_id: userId,
    });
    return supplier;
  });
}

async function update(tenantId, userId, id, input, expectedVersion) {
  const supplierId = uuidOrNull(id);
  if (!supplierId) throw new BusinessError('Fornecedor nao encontrado.', 404);
  const data = parseInput(input, { partial: true });
  if (!Object.keys(data).length) throw new BusinessError('Nenhum campo para atualizar.');

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'suppliers', tenantId, supplierId, expectedVersion);
    if (!current) throw new BusinessError('Fornecedor nao encontrado.', 404);
    // Edicoes parciais herdam o tipo atual de desconto/comissao. Validar o
    // registro resultante evita obrigar a interface a reenviar campos intactos.
    const error = validate({ ...current, ...data });
    if (error) throw new BusinessError(error);

    if (Object.prototype.hasOwnProperty.call(data, 'default_price_table_id')) {
      await assertPriceTable(client, tenantId, data.default_price_table_id);
    }

    if (data.document && data.document !== current.document) {
      const { rows } = await client.query(
        'SELECT id FROM suppliers WHERE tenant_id = $1 AND document = $2 AND id <> $3',
        [tenantId, data.document, supplierId]
      );
      if (rows[0]) throw new BusinessError('Ja existe outro cadastro com este CPF/CNPJ.');
    }

    const columns = Object.keys(data);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const { rows } = await client.query(
      `UPDATE suppliers
          SET ${assignments.join(', ')}, updated_by = $3, row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [supplierId, tenantId, userId, ...columns.map((column) => data[column])]
    );
    const supplier = rows[0];
    const changed = columns.filter((column) => String(current[column] ?? '') !== String(supplier[column] ?? ''));
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'supplier', entity_id: supplierId,
      action: 'atualizado', details: { fields: changed }, user_id: userId,
    });
    return supplier;
  });
}

/**
 * Inativa (ou reativa) o fornecedor. Nunca apaga: §5 exige que o fornecedor com
 * historico permaneca consultavel em vendas, pagamentos e auditoria.
 */
async function setActive(tenantId, userId, id, active, reason) {
  const supplierId = uuidOrNull(id);
  if (!supplierId) throw new BusinessError('Fornecedor nao encontrado.', 404);
  const target = bool(active);
  if (!target && !cleanOrNull(reason, 500)) {
    throw new BusinessError('Informe o motivo da inativacao.');
  }
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'suppliers', tenantId, supplierId);
    if (!current) throw new BusinessError('Fornecedor nao encontrado.', 404);
    const { rows } = await client.query(
      `UPDATE suppliers SET active = $3, updated_by = $4,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [supplierId, tenantId, target, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'supplier', entity_id: supplierId,
      action: target ? 'reativado' : 'inativado',
      from_status: current.active ? 'ativo' : 'inativo',
      to_status: target ? 'ativo' : 'inativo',
      reason: cleanOrNull(reason, 500), user_id: userId,
    });
    return rows[0];
  });
}

/** Vinculos do fornecedor — usado na tela de detalhe e antes de inativar. */
async function getUsage(tenantId, id) {
  const supplierId = uuidOrNull(id);
  if (!supplierId) return null;
  const [costs, payablesRows, commissionsRows, orderItems, contractedOrders] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(COALESCE(actual_cost, planned_cost)),0)::float AS amount
         FROM execution_costs WHERE tenant_id = $1 AND supplier_id = $2 AND status <> 'cancelado'`,
      [tenantId, supplierId]),
    pool.query(
      `SELECT status, COUNT(*)::int AS total, COALESCE(SUM(amount),0)::float AS amount
         FROM payables WHERE tenant_id = $1 AND payee_supplier_id = $2
        GROUP BY status`,
      [tenantId, supplierId]),
    pool.query(
      `SELECT status, COUNT(*)::int AS total, COALESCE(SUM(amount),0)::float AS amount
         FROM commissions WHERE tenant_id = $1 AND beneficiary_supplier_id = $2
        GROUP BY status`,
      [tenantId, supplierId]),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM order_items
        WHERE tenant_id = $1 AND supplier_id = $2 AND status = 'ativo'`,
      [tenantId, supplierId]),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM orders
        WHERE tenant_id = $1 AND contractor_partner_id = $2`,
      [tenantId, supplierId]),
  ]);
  return {
    execution_costs: costs.rows[0],
    payables: payablesRows.rows,
    commissions: commissionsRows.rows,
    order_items: orderItems.rows[0].total,
    contracted_orders: contractedOrders.rows[0].total,
  };
}

module.exports = {
  KINDS,
  PERSON_TYPES,
  COMMISSION_TYPES,
  list,
  getById,
  create,
  update,
  setActive,
  getUsage,
  listActivePartners,
};
