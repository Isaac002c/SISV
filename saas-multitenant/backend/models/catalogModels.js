'use strict';

// =============================================================================
// catalogModels.js — catalogo comercial de servicos e produtos (§7) e tabelas de
// preco (§8) do SISV 2.0.
//
// Preco de VENDA e CUSTO sao campos separados e independentes; um item pode
// existir sem custo definido.
//
// Uma tabela de preco ja utilizada NUNCA e apagada — apenas inativada. Pedidos
// antigos nao sao recalculados: o preco praticado vive no item do pedido
// (order_items.unit_price), nao na tabela. Ver resolvePrice().
// =============================================================================

const pool = require('../config/db');
const {
  clean, cleanOrNull, money, bool, uuidOrNull, oneOf, dateOrNull, paging,
  recordHistory, lockRow, withTransaction, BusinessError,
} = require('../services/commercialCommon');

const ITEM_TYPES = Object.freeze(['servico', 'produto']);
const TABLE_STATUSES = Object.freeze(['rascunho', 'ativa', 'inativa']);

// ── Catalogo ─────────────────────────────────────────────────────────────────

function parseItemInput(input = {}, { partial = false } = {}) {
  const data = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const set = (key, value) => { if (!partial || has(key)) data[key] = value; };

  set('code', clean(input.code, 40).toUpperCase());
  set('name', clean(input.name, 200));
  set('description', cleanOrNull(input.description, 4000));
  set('item_type', oneOf(input.item_type, ITEM_TYPES, 'servico'));
  set('category', cleanOrNull(input.category, 120));
  set('unit', clean(input.unit, 20) || 'un');
  set('default_price', money(input.default_price) ?? 0);
  // null e um valor legitimo: "custo ainda nao conhecido".
  set('default_cost', money(input.default_cost));
  set('tenant_service_type_id', uuidOrNull(input.tenant_service_type_id));
  if (has('estimated_duration_days')) {
    const days = parseInt(input.estimated_duration_days, 10);
    data.estimated_duration_days = Number.isInteger(days) && days >= 0 ? days : null;
  }
  if (has('document_checklist')) data.document_checklist = JSON.stringify(parseChecklist(input.document_checklist));
  if (has('requires_process')) data.requires_process = bool(input.requires_process);
  if (has('requires_invoice')) data.requires_invoice = bool(input.requires_invoice);
  if (has('active')) data.active = bool(input.active);
  return data;
}

/** Checklist documental: lista fechada de {name, required}. Sem HTML ou codigo. */
function parseChecklist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      name: clean(entry && entry.name, 160),
      required: bool(entry && entry.required),
    }))
    .filter((entry) => entry.name)
    .slice(0, 40);
}

function validateItem(data, { partial = false } = {}) {
  if ((!partial || data.name !== undefined) && !clean(data.name, 200)) return 'Informe o nome do item.';
  if ((!partial || data.code !== undefined) && !clean(data.code, 40)) return 'Informe o codigo do item.';
  if (data.default_price === null) return 'Preco padrao invalido.';
  return null;
}

/**
 * Margem estimada em % sobre o preco. Nao e persistida: derivar evita que preco
 * e custo mudem e a margem gravada fique mentindo.
 */
function itemMargin(row) {
  const price = Number(row.default_price || 0);
  const cost = row.default_cost === null || row.default_cost === undefined ? null : Number(row.default_cost);
  if (cost === null || price <= 0) return null;
  return Math.round(((price - cost) / price) * 10000) / 100;
}

const withMargin = (row) => (row ? { ...row, estimated_margin_percent: itemMargin(row) } : row);

async function listItems(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['c.tenant_id = $1'];
  const params = [tenantId];

  const term = clean(query.q, 120);
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(c.name) LIKE $${params.length} OR LOWER(c.code) LIKE $${params.length}
                  OR LOWER(COALESCE(c.category,'')) LIKE $${params.length})`);
  }
  const itemType = oneOf(query.item_type, ITEM_TYPES, null);
  if (itemType) { params.push(itemType); filters.push(`c.item_type = $${params.length}`); }
  const category = cleanOrNull(query.category, 120);
  if (category) { params.push(category); filters.push(`c.category = $${params.length}`); }
  if (query.active !== 'all') {
    params.push(query.active === undefined ? true : bool(query.active));
    filters.push(`c.active = $${params.length}`);
  }
  const where = filters.join(' AND ');

  const { rows } = await pool.query(
    `SELECT c.*, t.label AS service_type_label
       FROM catalog_items c
       LEFT JOIN tenant_service_types t ON t.id = c.tenant_service_type_id
      WHERE ${where}
      ORDER BY c.name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM catalog_items c WHERE ${where}`, params
  );
  return { rows: rows.map(withMargin), total: countRows[0].total, page, limit };
}

async function getItem(tenantId, id) {
  const itemId = uuidOrNull(id);
  if (!itemId) return null;
  const { rows } = await pool.query(
    `SELECT c.*, t.label AS service_type_label
       FROM catalog_items c
       LEFT JOIN tenant_service_types t ON t.id = c.tenant_service_type_id
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [itemId, tenantId]
  );
  return withMargin(rows[0] || null);
}

async function createItem(tenantId, userId, input) {
  const data = parseItemInput(input);
  const error = validateItem(data);
  if (error) throw new BusinessError(error);

  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND LOWER(code) = LOWER($2)',
      [tenantId, data.code]
    );
    if (existing[0]) throw new BusinessError('Ja existe um item com este codigo.');

    const columns = Object.keys(data);
    const placeholders = columns.map((_, index) => `$${index + 3}`);
    const { rows } = await client.query(
      `INSERT INTO catalog_items (tenant_id, created_by, ${columns.join(', ')})
       VALUES ($1, $2, ${placeholders.join(', ')}) RETURNING *`,
      [tenantId, userId, ...columns.map((column) => data[column])]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'catalog_item', entity_id: rows[0].id,
      action: 'criado', details: { code: rows[0].code, default_price: rows[0].default_price },
      user_id: userId,
    });
    return withMargin(rows[0]);
  });
}

async function updateItem(tenantId, userId, id, input, expectedVersion) {
  const itemId = uuidOrNull(id);
  if (!itemId) throw new BusinessError('Item nao encontrado.', 404);
  const data = parseItemInput(input, { partial: true });
  const error = validateItem(data, { partial: true });
  if (error) throw new BusinessError(error);
  if (!Object.keys(data).length) throw new BusinessError('Nenhum campo para atualizar.');

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'catalog_items', tenantId, itemId, expectedVersion);
    if (!current) throw new BusinessError('Item nao encontrado.', 404);
    if (data.code && data.code.toLowerCase() !== String(current.code).toLowerCase()) {
      const { rows } = await client.query(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND LOWER(code) = LOWER($2) AND id <> $3',
        [tenantId, data.code, itemId]
      );
      if (rows[0]) throw new BusinessError('Ja existe outro item com este codigo.');
    }

    const columns = Object.keys(data);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const { rows } = await client.query(
      `UPDATE catalog_items
          SET ${assignments.join(', ')}, updated_by = $3, row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [itemId, tenantId, userId, ...columns.map((column) => data[column])]
    );
    // Alteracao de preco e auditada com o valor anterior (§39).
    const priceChanged = data.default_price !== undefined
      && Number(current.default_price) !== Number(rows[0].default_price);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'catalog_item', entity_id: itemId,
      action: priceChanged ? 'preco_alterado' : 'atualizado',
      details: priceChanged
        ? { from: Number(current.default_price), to: Number(rows[0].default_price) }
        : { fields: columns },
      user_id: userId,
    });
    return withMargin(rows[0]);
  });
}

async function deleteItem(tenantId, userId, id, reason) {
  const itemId = uuidOrNull(id);
  const justification = cleanOrNull(reason, 2000);
  if (!itemId) throw new BusinessError('Item nao encontrado.', 404);
  if (!justification) throw new BusinessError('Informe o motivo da exclusao.');
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'catalog_items', tenantId, itemId);
    if (!current || !current.active) throw new BusinessError('Item nao encontrado ou ja excluido.', 404);
    const { rows } = await client.query(
      `UPDATE catalog_items SET active = FALSE, updated_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`, [itemId, tenantId, userId]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'catalog_item', entity_id: itemId,
      action: 'excluido', reason: justification, details: { code: current.code }, user_id: userId,
    });
    return withMargin(rows[0]);
  });
}

// ── Tabelas de preco ─────────────────────────────────────────────────────────

function parseTableInput(input = {}, { partial = false } = {}) {
  const data = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const set = (key, value) => { if (!partial || has(key)) data[key] = value; };

  set('name', clean(input.name, 160));
  set('description', cleanOrNull(input.description, 2000));
  set('audience', cleanOrNull(input.audience, 120));
  set('starts_on', dateOrNull(input.starts_on));
  set('ends_on', dateOrNull(input.ends_on));
  if (has('priority')) {
    const priority = parseInt(input.priority, 10);
    data.priority = Number.isInteger(priority) ? Math.max(0, Math.min(priority, 1000)) : 0;
  }
  if (has('status')) data.status = oneOf(input.status, TABLE_STATUSES, 'rascunho');
  return data;
}

async function listTables(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['p.tenant_id = $1'];
  const params = [tenantId];
  const status = oneOf(query.status, TABLE_STATUSES, null);
  if (status) { params.push(status); filters.push(`p.status = $${params.length}`); }
  else filters.push("p.status <> 'inativa'");
  const term = clean(query.q, 120);
  if (term) { params.push(`%${term.toLowerCase()}%`); filters.push(`LOWER(p.name) LIKE $${params.length}`); }
  const where = filters.join(' AND ');

  // Contagem de itens vem de uma subconsulta agregada (nao correlacionada), que
  // roda tanto no PostgreSQL quanto no banco em memoria do servidor de demo.
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS created_by_name, COALESCE(ic.item_count, 0) AS item_count
       FROM price_tables p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN (
         SELECT price_table_id, COUNT(*)::int AS item_count
           FROM price_table_items WHERE tenant_id = $1 GROUP BY price_table_id
       ) ic ON ic.price_table_id = p.id
      WHERE ${where}
      ORDER BY p.priority DESC, p.name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM price_tables p WHERE ${where}`, params
  );
  return { rows, total: countRows[0].total, page, limit };
}

async function getTable(tenantId, id) {
  const tableId = uuidOrNull(id);
  if (!tableId) return null;
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS created_by_name FROM price_tables p
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [tableId, tenantId]
  );
  if (!rows[0]) return null;
  const { rows: items } = await pool.query(
    `SELECT i.*, c.code, c.name, c.item_type, c.unit, c.default_price, c.active AS item_active
       FROM price_table_items i
       JOIN catalog_items c ON c.id = i.catalog_item_id
      WHERE i.price_table_id = $1 AND i.tenant_id = $2
      ORDER BY c.name ASC`,
    [tableId, tenantId]
  );
  return { ...rows[0], items };
}

async function createTable(tenantId, userId, input) {
  const data = parseTableInput(input);
  if (!clean(data.name, 160)) throw new BusinessError('Informe o nome da tabela de precos.');
  if (data.starts_on && data.ends_on && data.ends_on < data.starts_on) {
    throw new BusinessError('A data final da vigencia nao pode ser anterior a inicial.');
  }
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id FROM price_tables WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, data.name]
    );
    if (existing[0]) throw new BusinessError('Ja existe uma tabela com este nome.');
    const columns = Object.keys(data);
    const placeholders = columns.map((_, index) => `$${index + 3}`);
    const { rows } = await client.query(
      `INSERT INTO price_tables (tenant_id, created_by, ${columns.join(', ')})
       VALUES ($1, $2, ${placeholders.join(', ')}) RETURNING *`,
      [tenantId, userId, ...columns.map((column) => data[column])]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'price_table', entity_id: rows[0].id,
      action: 'criada', to_status: rows[0].status, details: { name: rows[0].name }, user_id: userId,
    });
    return rows[0];
  });
}

async function updateTable(tenantId, userId, id, input, expectedVersion) {
  const tableId = uuidOrNull(id);
  if (!tableId) throw new BusinessError('Tabela nao encontrada.', 404);
  const data = parseTableInput(input, { partial: true });
  if (!Object.keys(data).length) throw new BusinessError('Nenhum campo para atualizar.');

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'price_tables', tenantId, tableId, expectedVersion);
    if (!current) throw new BusinessError('Tabela nao encontrada.', 404);
    const startsOn = data.starts_on !== undefined ? data.starts_on : current.starts_on;
    const endsOn = data.ends_on !== undefined ? data.ends_on : current.ends_on;
    if (startsOn && endsOn && new Date(endsOn) < new Date(startsOn)) {
      throw new BusinessError('A data final da vigencia nao pode ser anterior a inicial.');
    }
    const columns = Object.keys(data);
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const { rows } = await client.query(
      `UPDATE price_tables SET ${assignments.join(', ')}, updated_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [tableId, tenantId, userId, ...columns.map((column) => data[column])]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'price_table', entity_id: tableId,
      action: data.status && data.status !== current.status ? 'situacao_alterada' : 'atualizada',
      from_status: current.status, to_status: rows[0].status,
      details: { fields: columns }, user_id: userId,
    });
    return rows[0];
  });
}

async function deleteTable(tenantId, userId, id, reason) {
  const tableId = uuidOrNull(id);
  const justification = cleanOrNull(reason, 2000);
  if (!tableId) throw new BusinessError('Tabela nao encontrada.', 404);
  if (!justification) throw new BusinessError('Informe o motivo da exclusao.');
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'price_tables', tenantId, tableId);
    if (!current || current.status === 'inativa') {
      throw new BusinessError('Tabela nao encontrada ou ja excluida.', 404);
    }
    const { rows } = await client.query(
      `UPDATE price_tables SET status = 'inativa', updated_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`, [tableId, tenantId, userId]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'price_table', entity_id: tableId,
      action: 'excluida', from_status: current.status, to_status: 'inativa',
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

/** Substitui os itens da tabela em bloco (a tela envia a grade inteira). */
async function setTableItems(tenantId, userId, id, items) {
  const tableId = uuidOrNull(id);
  if (!tableId) throw new BusinessError('Tabela nao encontrada.', 404);
  if (!Array.isArray(items)) throw new BusinessError('Lista de itens invalida.');

  const parsed = items.map((entry) => ({
    catalog_item_id: uuidOrNull(entry.catalog_item_id),
    price: money(entry.price) ?? 0,
    cost: money(entry.cost),
    max_discount_percent: Math.max(0, Math.min(Number(entry.max_discount_percent) || 0, 100)),
    notes: cleanOrNull(entry.notes, 500),
  })).filter((entry) => entry.catalog_item_id);

  return withTransaction(async (client) => {
    const table = await lockRow(client, 'price_tables', tenantId, tableId);
    if (!table) throw new BusinessError('Tabela nao encontrada.', 404);

    // Todos os itens precisam pertencer ao tenant (barreira de isolamento).
    // Lista de placeholders em vez de ANY($n::uuid[]): mesma semantica, e
    // compativel com o Postgres em memoria usado pelo servidor de demonstracao.
    if (parsed.length) {
      const ids = [...new Set(parsed.map((entry) => entry.catalog_item_id))];
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
      const { rows: valid } = await client.query(
        `SELECT id FROM catalog_items WHERE tenant_id = $1 AND id IN (${placeholders})`,
        [tenantId, ...ids]
      );
      if (valid.length !== ids.length) {
        throw new BusinessError('Um ou mais itens do catalogo nao pertencem a este tenant.');
      }
    }

    await client.query('DELETE FROM price_table_items WHERE tenant_id = $1 AND price_table_id = $2',
      [tenantId, tableId]);
    for (const entry of parsed) {
      await client.query(
        `INSERT INTO price_table_items
           (tenant_id, price_table_id, catalog_item_id, price, cost, max_discount_percent, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, tableId, entry.catalog_item_id, entry.price, entry.cost,
         entry.max_discount_percent, entry.notes]
      );
    }
    await client.query(
      `UPDATE price_tables SET updated_by = $3, row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [tableId, tenantId, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'price_table', entity_id: tableId,
      action: 'itens_atualizados', details: { count: parsed.length }, user_id: userId,
    });
    return { count: parsed.length };
  });
}

/** Duplica a tabela e seus itens — a original nunca e alterada (§8). */
async function duplicateTable(tenantId, userId, id, name) {
  const tableId = uuidOrNull(id);
  if (!tableId) throw new BusinessError('Tabela nao encontrada.', 404);
  const newName = clean(name, 160);
  if (!newName) throw new BusinessError('Informe o nome da nova tabela.');

  return withTransaction(async (client) => {
    const source = await lockRow(client, 'price_tables', tenantId, tableId);
    if (!source) throw new BusinessError('Tabela nao encontrada.', 404);
    const { rows: existing } = await client.query(
      'SELECT id FROM price_tables WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, newName]
    );
    if (existing[0]) throw new BusinessError('Ja existe uma tabela com este nome.');

    const { rows } = await client.query(
      `INSERT INTO price_tables
         (tenant_id, name, description, audience, starts_on, ends_on, priority, status,
          source_table_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'rascunho',$8,$9) RETURNING *`,
      [tenantId, newName, source.description, source.audience, source.starts_on,
       source.ends_on, source.priority, tableId, userId]
    );
    const copy = rows[0];
    await client.query(
      `INSERT INTO price_table_items
         (tenant_id, price_table_id, catalog_item_id, price, cost, max_discount_percent, notes)
       SELECT tenant_id, $3, catalog_item_id, price, cost, max_discount_percent, notes
         FROM price_table_items WHERE tenant_id = $1 AND price_table_id = $2`,
      [tenantId, tableId, copy.id]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'price_table', entity_id: copy.id,
      action: 'duplicada', details: { source_id: tableId, source_name: source.name }, user_id: userId,
    });
    return copy;
  });
}

/**
 * Preco vigente de um item para a data de referencia.
 * Precedencia: tabela informada (se vigente e ativa) > tabela ativa de maior
 * prioridade > preco padrao do catalogo. Devolve tambem o desconto maximo
 * permitido, que o pedido usa para validar o desconto aplicado.
 */
async function resolvePrice(tenantId, catalogItemId, priceTableId = null, referenceDate = null) {
  const itemId = uuidOrNull(catalogItemId);
  if (!itemId) return null;
  const item = await getItem(tenantId, itemId);
  if (!item) return null;

  const today = dateOrNull(referenceDate) || new Date().toISOString().slice(0, 10);
  const params = [tenantId, itemId, today];
  let tableFilter = "p.status = 'ativa'";
  const tableId = uuidOrNull(priceTableId);
  if (tableId) {
    params.push(tableId);
    tableFilter = `p.id = $${params.length} AND p.status = 'ativa'`;
  }

  const { rows } = await pool.query(
    `SELECT i.price, i.cost, i.max_discount_percent, p.id AS price_table_id, p.name AS price_table_name
       FROM price_table_items i
       JOIN price_tables p ON p.id = i.price_table_id AND p.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.catalog_item_id = $2
        AND ${tableFilter}
        AND (p.starts_on IS NULL OR p.starts_on <= $3::date)
        AND (p.ends_on IS NULL OR p.ends_on >= $3::date)
      ORDER BY p.priority DESC, p.created_at DESC
      LIMIT 1`,
    params
  );

  if (rows[0]) {
    return {
      catalog_item_id: itemId,
      description: item.name,
      item_type: item.item_type,
      unit: item.unit,
      unit_price: Number(rows[0].price),
      unit_cost: rows[0].cost === null ? (item.default_cost === null ? null : Number(item.default_cost)) : Number(rows[0].cost),
      max_discount_percent: Number(rows[0].max_discount_percent),
      price_table_id: rows[0].price_table_id,
      price_table_name: rows[0].price_table_name,
      source: 'tabela',
      requires_process: item.requires_process,
      requires_invoice: item.requires_invoice,
      tenant_service_type_id: item.tenant_service_type_id,
      document_checklist: item.document_checklist,
    };
  }
  return {
    catalog_item_id: itemId,
    description: item.name,
    item_type: item.item_type,
    unit: item.unit,
    unit_price: Number(item.default_price),
    unit_cost: item.default_cost === null ? null : Number(item.default_cost),
    max_discount_percent: 100,
    price_table_id: null,
    price_table_name: null,
    source: 'catalogo',
    requires_process: item.requires_process,
    requires_invoice: item.requires_invoice,
    tenant_service_type_id: item.tenant_service_type_id,
    document_checklist: item.document_checklist,
  };
}

module.exports = {
  ITEM_TYPES,
  TABLE_STATUSES,
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  listTables,
  getTable,
  createTable,
  updateTable,
  deleteTable,
  setTableItems,
  duplicateTable,
  resolvePrice,
};
