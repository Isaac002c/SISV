'use strict';

// =============================================================================
// commercialCommon.js — utilitarios compartilhados pelos dominios comerciais do
// SISV 2.0 (pedidos, vendas, ordens, recebimentos, obrigacoes, finalizacao).
//
// Nao contem regra de negocio: apenas saneamento de entrada, numeracao
// transacional, controle de concorrencia (row_version) e historico por entidade.
// Nenhuma funcao aqui dispara acao automatica — quem decide e sempre a rota,
// a partir de uma acao explicita do usuario.
// =============================================================================

const pool = require('../config/db');

// ── Saneamento ───────────────────────────────────────────────────────────────

/** Texto sem NUL, aparado e truncado. Retorna '' para null/undefined. */
const clean = (value, max = 255) =>
  String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

/** Texto opcional: '' vira null (para colunas nullable). */
const cleanOrNull = (value, max = 255) => {
  const text = clean(value, max);
  return text === '' ? null : text;
};

/** Numero decimal >= 0. Retorna null quando ausente/invalido. */
const money = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
};

/** Quantidade > 0 com 3 casas. */
const qty = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 1000) / 1000;
};

const bool = (value) => value === true || value === 'true' || value === '1' || value === 1;

/** UUID valido ou null — evita erro de sintaxe do Postgres em filtros opcionais. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value) => {
  const text = clean(value, 40);
  return UUID_RE.test(text) ? text : null;
};

/** Data ISO (YYYY-MM-DD) ou null. */
const dateOrNull = (value) => {
  const text = clean(value, 30);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return text.slice(0, 10);
};

/** Valor pertencente a uma lista fechada; caso contrario, o padrao. */
const oneOf = (value, allowed, fallback = null) => {
  const text = clean(value, 40);
  return allowed.includes(text) ? text : fallback;
};

/** Paginacao segura (limite maximo defensivo). */
const paging = (query = {}) => {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
};

// ── Numeracao por tenant ─────────────────────────────────────────────────────

const NUMBER_PREFIX = Object.freeze({
  order: 'PED',
  sale: 'VEN',
  service_order: 'OS',
  contract: 'CTR',
  client: 'CLI',
});

/**
 * Reserva o proximo numero do tipo de documento DENTRO da transacao recebida.
 * Usa UPSERT + RETURNING: a linha do contador fica travada ate o COMMIT, entao
 * duas requisicoes simultaneas nunca recebem o mesmo numero.
 * Exige um client de transacao (nao aceita o pool) para nao vazar numeracao.
 */
async function nextNumber(client, tenantId, docType) {
  const prefix = NUMBER_PREFIX[docType] || 'DOC';
  const { rows } = await client.query(
    `INSERT INTO commercial_counters (tenant_id, doc_type, current_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, doc_type)
     DO UPDATE SET current_number = commercial_counters.current_number + 1, updated_at = NOW()
     RETURNING current_number`,
    [tenantId, docType]
  );
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(rows[0].current_number).padStart(5, '0')}`;
}

// ── Historico por entidade ───────────────────────────────────────────────────

/**
 * Registra um evento na linha do tempo do dominio comercial.
 * `details` nunca deve conter segredo, token ou conteudo integral de documento
 * (§39): guarde identificadores e valores, nao o payload cru.
 */
async function recordHistory(executor, {
  tenant_id, entity_type, entity_id, action,
  from_status = null, to_status = null, reason = null, details = {}, user_id = null,
}) {
  await executor.query(
    `INSERT INTO commercial_history
       (tenant_id, entity_type, entity_id, action, from_status, to_status, reason, details, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [tenant_id, entity_type, entity_id, clean(action, 60), from_status, to_status,
     cleanOrNull(reason, 1000), JSON.stringify(details || {}), user_id]
  );
}

async function listHistory(tenantId, entityType, entityId, query = {}) {
  const { limit, offset } = paging(query);
  const { rows } = await pool.query(
    `SELECT h.*, u.name AS user_name
       FROM commercial_history h
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.tenant_id = $1 AND h.entity_type = $2 AND h.entity_id = $3
      ORDER BY h.created_at DESC
      LIMIT $4 OFFSET $5`,
    [tenantId, entityType, entityId, limit, offset]
  );
  return rows;
}

// ── Concorrencia ─────────────────────────────────────────────────────────────

/** Erro de conflito de edicao; a rota traduz para HTTP 409. */
class ConflictError extends Error {
  constructor(message = 'Registro alterado por outro usuario. Recarregue e tente novamente.') {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

/** Erro de regra de negocio; a rota traduz para HTTP 400 (ou o status dado). */
class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BusinessError';
    this.status = status;
  }
}

/**
 * Carrega e TRAVA uma linha da entidade para atualizacao dentro da transacao.
 * Quando `expectedVersion` e informado e diverge, levanta ConflictError (409).
 */
async function lockRow(client, table, tenantId, id, expectedVersion = null) {
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== '') {
    const expected = Number(expectedVersion);
    if (Number.isFinite(expected) && Number(row.row_version) !== expected) {
      throw new ConflictError();
    }
  }
  return row;
}

/** Executa `fn` dentro de uma transacao, com ROLLBACK garantido em erro. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

// ── Calculo de totais (puro, sem persistencia) ───────────────────────────────

/**
 * Total do item = qtd * preco unitario - desconto + acrescimo (nunca negativo).
 * Arredondamento em duas casas em cada etapa, para bater com NUMERIC(15,2).
 */
function itemTotal({ quantity = 1, unit_price = 0, discount = 0, surcharge = 0 }) {
  const gross = Math.round(Number(quantity) * Number(unit_price) * 100) / 100;
  const total = gross - Number(discount || 0) + Number(surcharge || 0);
  return Math.max(0, Math.round(total * 100) / 100);
}

/** Soma os itens ativos e devolve subtotal/desconto/acrescimo/total do pedido. */
function orderTotals(items = []) {
  const active = items.filter((item) => item.status !== 'removido');
  const round = (value) => Math.round(value * 100) / 100;
  const subtotal = round(active.reduce(
    (sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0));
  const discount = round(active.reduce((sum, item) => sum + Number(item.discount || 0), 0));
  const surcharge = round(active.reduce((sum, item) => sum + Number(item.surcharge || 0), 0));
  const total = Math.max(0, round(subtotal - discount + surcharge));
  return { subtotal, discount, surcharge, total };
}

/** Custo estimado total (itens sem custo definido contam como zero). */
function estimatedCost(items = []) {
  const active = items.filter((item) => item.status !== 'removido');
  return Math.round(active.reduce(
    (sum, item) => sum + Number(item.quantity) * Number(item.unit_cost || 0), 0) * 100) / 100;
}

/**
 * Comissao SUGERIDA de um item — apenas calculo para exibicao ao usuario.
 * Nada e persistido aqui: a comissao so existe apos confirmacao explicita (§29).
 */
function suggestedCommission({ commission_type, commission_value }, baseAmount) {
  if (!commission_type || commission_value === null || commission_value === undefined) return 0;
  const value = Number(commission_value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (commission_type === 'fixo') return Math.round(value * 100) / 100;
  return Math.round((Number(baseAmount) * value) / 100 * 100) / 100;
}

module.exports = {
  clean,
  cleanOrNull,
  money,
  qty,
  bool,
  uuidOrNull,
  dateOrNull,
  oneOf,
  paging,
  nextNumber,
  recordHistory,
  listHistory,
  ConflictError,
  BusinessError,
  lockRow,
  withTransaction,
  itemTotal,
  orderTotals,
  estimatedCost,
  suggestedCommission,
};
