'use strict';

const pool = require('../config/db');
const {
  clean, cleanOrNull, bool, uuidOrNull, withTransaction, recordHistory, BusinessError,
} = require('../services/commercialCommon');

const FIELD_TYPES = Object.freeze([
  'text', 'textarea', 'email', 'phone', 'date', 'number', 'boolean', 'document',
]);
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,59}$/;
const SYSTEM_FIELDS = new Set(['cpf', 'birth_date', 'cnh', 'first_cnh', 'phone', 'email', 'address']);

function safeRules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const rules = {};
  if (Number.isFinite(Number(value.min_length))) rules.min_length = Math.max(0, Number(value.min_length));
  if (Number.isFinite(Number(value.max_length))) rules.max_length = Math.min(10000, Math.max(1, Number(value.max_length)));
  if (Number.isFinite(Number(value.min))) rules.min = Number(value.min);
  if (Number.isFinite(Number(value.max))) rules.max = Number(value.max);
  if (typeof value.pattern === 'string' && value.pattern.length <= 200) rules.pattern = value.pattern;
  if (typeof value.hint === 'string') rules.hint = clean(value.hint, 240);
  return rules;
}

function parseDefinition(input = {}, { partial = false } = {}) {
  const data = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const set = (key, value) => { if (!partial || has(key)) data[key] = value; };
  if (!partial || has('field_key')) {
    const fieldKey = clean(input.field_key, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!FIELD_KEY_RE.test(fieldKey)) {
      throw new BusinessError('A chave do campo deve usar letras minusculas, numeros e sublinhado.');
    }
    if (SYSTEM_FIELDS.has(fieldKey)) throw new BusinessError('Este campo pertence ao cadastro padrao e nao pode ser recriado.');
    data.field_key = fieldKey;
  }
  set('label', clean(input.label, 120));
  set('field_type', FIELD_TYPES.includes(clean(input.field_type, 20)) ? clean(input.field_type, 20) : 'text');
  set('validation_rules', safeRules(input.validation_rules));
  set('sort_order', Number.isFinite(Number(input.sort_order)) ? Math.trunc(Number(input.sort_order)) : 0);
  if (has('active')) data.active = bool(input.active);
  if ((!partial || data.label !== undefined) && !data.label) throw new BusinessError('Informe o nome apresentado do campo.');
  return data;
}

async function listDefinitions(tenantId, { includeInactive = false } = {}) {
  const [{ rows }, { rows: counts }] = await Promise.all([
    pool.query(
      `SELECT d.* FROM client_field_definitions d
      WHERE d.tenant_id = $1 ${includeInactive ? '' : 'AND d.active = TRUE'}
      ORDER BY d.sort_order ASC, d.label ASC`,
      [tenantId]
    ),
    pool.query(
      `SELECT field_definition_id, COUNT(*)::int AS service_count
         FROM service_client_field_requirements
        WHERE tenant_id = $1 AND active = TRUE AND required = TRUE
        GROUP BY field_definition_id`,
      [tenantId]
    ),
  ]);
  const countByField = new Map(counts.map((row) => [row.field_definition_id, row.service_count]));
  return rows.map((row) => ({ ...row, service_count: countByField.get(row.id) || 0 }));
}

async function listForServices(tenantId, serviceIds = [], clientId = null) {
  const definitions = await listDefinitions(tenantId);
  const ids = [...new Set(serviceIds.map(uuidOrNull).filter(Boolean))];
  let requirements = [];
  if (ids.length) {
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS service_name
         FROM service_client_field_requirements r
         JOIN catalog_items c ON c.id = r.catalog_item_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.catalog_item_id IN (${placeholders})
          AND r.active = TRUE AND r.required = TRUE`,
      [tenantId, ...ids]
    );
    requirements = rows;
  }

  let client = null;
  const normalizedClientId = uuidOrNull(clientId);
  if (normalizedClientId) {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
      [normalizedClientId, tenantId]
    );
    client = rows[0] || null;
  }

  return definitions.map((definition) => {
    const matched = requirements.filter((row) => row.field_definition_id === definition.id);
    const value = client
      ? (definition.storage_kind === 'system'
        ? client[definition.system_column]
        : (client.additional_data || {})[definition.field_key])
      : undefined;
    return {
      ...definition,
      required: matched.length > 0,
      required_by: matched.map((row) => ({ id: row.catalog_item_id, name: row.service_name })),
      requirement_rules: matched.reduce((merged, row) => ({ ...merged, ...(row.validation_rules || {}) }), {}),
      value,
    };
  });
}

async function createDefinition(tenantId, userId, input) {
  const data = parseDefinition(input);
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id FROM client_field_definitions WHERE tenant_id = $1 AND LOWER(field_key) = LOWER($2)',
      [tenantId, data.field_key]
    );
    if (existing[0]) throw new BusinessError('Ja existe um campo com esta chave.');
    const { rows } = await client.query(
      `INSERT INTO client_field_definitions
         (tenant_id, field_key, label, field_type, storage_kind, validation_rules,
          active, sort_order, created_by, updated_by)
       VALUES ($1,$2,$3,$4,'custom',$5::jsonb,TRUE,$6,$7,$7) RETURNING *`,
      [tenantId, data.field_key, data.label, data.field_type,
       JSON.stringify(data.validation_rules), data.sort_order, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'client_field', entity_id: rows[0].id,
      action: 'criado', details: { field_key: data.field_key, label: data.label }, user_id: userId,
    });
    return rows[0];
  });
}

async function updateDefinition(tenantId, userId, id, input) {
  const fieldId = uuidOrNull(id);
  if (!fieldId) throw new BusinessError('Campo nao encontrado.', 404);
  const data = parseDefinition(input, { partial: true });
  delete data.field_key;
  if (!Object.keys(data).length) throw new BusinessError('Nenhum campo para atualizar.');
  return withTransaction(async (client) => {
    const { rows: currentRows } = await client.query(
      'SELECT * FROM client_field_definitions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [fieldId, tenantId]
    );
    const current = currentRows[0];
    if (!current) throw new BusinessError('Campo nao encontrado.', 404);
    if (current.storage_kind === 'system') {
      delete data.field_type;
      delete data.active;
    }
    const columns = Object.keys(data);
    if (!columns.length) throw new BusinessError('Campos nativos permitem alterar apenas nome, ordem e validacoes.');
    const assignments = columns.map((column, index) => `${column} = $${index + 4}`);
    const values = columns.map((column) => column === 'validation_rules'
      ? JSON.stringify(data[column]) : data[column]);
    const { rows } = await client.query(
      `UPDATE client_field_definitions
          SET ${assignments.join(', ')}, updated_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [fieldId, tenantId, userId, ...values]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'client_field', entity_id: fieldId,
      action: 'atualizado', details: { fields: columns }, user_id: userId,
    });
    return rows[0];
  });
}

async function getServiceRequirements(tenantId, serviceId) {
  const catalogId = uuidOrNull(serviceId);
  if (!catalogId) throw new BusinessError('Servico nao encontrado.', 404);
  const { rows: services } = await pool.query(
    `SELECT id, name, item_type FROM catalog_items WHERE id = $1 AND tenant_id = $2`,
    [catalogId, tenantId]
  );
  if (!services[0] || services[0].item_type !== 'servico') {
    throw new BusinessError('Servico nao encontrado.', 404);
  }
  return {
    service: services[0],
    fields: await listForServices(tenantId, [catalogId]),
  };
}

async function setServiceRequirements(tenantId, userId, serviceId, input = []) {
  const catalogId = uuidOrNull(serviceId);
  if (!catalogId) throw new BusinessError('Servico nao encontrado.', 404);
  const requested = Array.isArray(input) ? input : [];
  return withTransaction(async (client) => {
    const { rows: services } = await client.query(
      `SELECT id, name, item_type FROM catalog_items
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [catalogId, tenantId]
    );
    if (!services[0] || services[0].item_type !== 'servico') {
      throw new BusinessError('Somente itens do tipo servico aceitam campos obrigatorios.', 404);
    }

    const ids = [...new Set(requested.map((row) => uuidOrNull(row.field_definition_id)).filter(Boolean))];
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
      const { rows: definitions } = await client.query(
        `SELECT id FROM client_field_definitions
          WHERE tenant_id = $1 AND id IN (${placeholders}) AND active = TRUE`,
        [tenantId, ...ids]
      );
      if (definitions.length !== ids.length) throw new BusinessError('Um ou mais campos nao pertencem a este tenant.');
    }

    await client.query(
      `UPDATE service_client_field_requirements
          SET active = FALSE, updated_by = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND catalog_item_id = $2`,
      [tenantId, catalogId, userId]
    );
    let displayOrder = 0;
    for (const row of requested) {
      const fieldId = uuidOrNull(row.field_definition_id);
      if (!fieldId) continue;
      await client.query(
        `INSERT INTO service_client_field_requirements
           (tenant_id, catalog_item_id, field_definition_id, required, active,
            display_order, label_override, validation_rules, created_by, updated_by)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7::jsonb,$8,$8)
         ON CONFLICT (catalog_item_id, field_definition_id) DO UPDATE SET
           required = EXCLUDED.required, active = TRUE,
           display_order = EXCLUDED.display_order, label_override = EXCLUDED.label_override,
           validation_rules = EXCLUDED.validation_rules, updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [tenantId, catalogId, fieldId, row.required !== false, displayOrder++,
         cleanOrNull(row.label_override, 120), JSON.stringify(safeRules(row.validation_rules)), userId]
      );
    }
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'catalog_item', entity_id: catalogId,
      action: 'campos_cliente_configurados',
      details: { required_fields: ids.length }, user_id: userId,
    });
    return { service: services[0], fields: ids };
  });
}

function isEmpty(value) {
  return value === null || value === undefined || value === ''
    || (typeof value === 'string' && value.trim() === '');
}

function validationMessage(value, definition, extraRules = {}) {
  if (isEmpty(value)) return null;
  const rules = { ...(definition.validation_rules || {}), ...(extraRules || {}) };
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (definition.field_type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'formato de e-mail invalido';
  if (definition.field_type === 'date' && Number.isNaN(new Date(value).getTime())) return 'data invalida';
  if (definition.field_type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return 'numero invalido';
    if (rules.min !== undefined && number < rules.min) return `valor minimo: ${rules.min}`;
    if (rules.max !== undefined && number > rules.max) return `valor maximo: ${rules.max}`;
  }
  if (rules.min_length !== undefined && text.length < rules.min_length) return `minimo de ${rules.min_length} caracteres`;
  if (rules.max_length !== undefined && text.length > rules.max_length) return `maximo de ${rules.max_length} caracteres`;
  if (rules.pattern) {
    try { if (!(new RegExp(rules.pattern)).test(text)) return 'formato invalido'; } catch { return 'regra de formato invalida'; }
  }
  return null;
}

async function normalizeAdditionalData(tenantId, input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BusinessError('Dados adicionais do cliente devem ser um objeto.');
  }
  const { rows: definitions } = await pool.query(
    `SELECT * FROM client_field_definitions
      WHERE tenant_id = $1 AND storage_kind = 'custom'`,
    [tenantId]
  );
  const byKey = new Map(definitions.map((row) => [row.field_key, row]));
  const normalized = {};
  for (const [key, raw] of Object.entries(input)) {
    const definition = byKey.get(key);
    if (!definition) throw new BusinessError(`Campo adicional desconhecido: ${clean(key, 60)}.`);
    if (isEmpty(raw)) { normalized[key] = null; continue; }
    let value = raw;
    if (definition.field_type === 'boolean') value = bool(raw);
    else if (definition.field_type === 'number') value = Number(raw);
    else value = clean(raw, Number(definition.validation_rules?.max_length) || 4000);
    const error = validationMessage(value, definition);
    if (error) throw new BusinessError(`${definition.label}: ${error}.`);
    normalized[key] = value;
  }
  return normalized;
}

async function validateOrderClient(executor, tenantId, orderId) {
  const id = uuidOrNull(orderId);
  if (!id) throw new BusinessError('Pedido nao encontrado.', 404);
  const { rows: orderRows } = await executor.query(
    `SELECT o.id, o.client_id, o.contracting_model_version, c.*
       FROM orders o JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
      WHERE o.id = $1 AND o.tenant_id = $2`,
    [id, tenantId]
  );
  if (!orderRows[0]) throw new BusinessError('Pedido nao encontrado.', 404);
  const client = orderRows[0];
  const { rows: services } = await executor.query(
    `SELECT DISTINCT ci.id, COALESCE(ci.name, oi.description) AS name
       FROM order_items oi
       LEFT JOIN catalog_items ci ON ci.id = oi.catalog_item_id AND ci.tenant_id = oi.tenant_id
      WHERE oi.tenant_id = $1 AND oi.order_id = $2 AND oi.status = 'ativo'
        AND oi.item_type = 'servico'`,
    [tenantId, id]
  );
  const version = Number(client.contracting_model_version || 1);
  if (!services.length) {
    return { valid: version < 2, missing_service: version >= 2, missing_fields: [], invalid_fields: [], services: [] };
  }
  const catalogIds = services.map((service) => service.id).filter(Boolean);
  if (!catalogIds.length) return { valid: true, missing_service: false, missing_fields: [], invalid_fields: [], services };
  const placeholders = catalogIds.map((_, index) => `$${index + 2}`).join(', ');
  const { rows: requirements } = await executor.query(
    `SELECT r.*, d.field_key, d.label, d.field_type, d.storage_kind, d.system_column,
            d.validation_rules AS definition_rules, c.name AS service_name
       FROM service_client_field_requirements r
       JOIN client_field_definitions d ON d.id = r.field_definition_id AND d.tenant_id = r.tenant_id
       JOIN catalog_items c ON c.id = r.catalog_item_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.catalog_item_id IN (${placeholders})
        AND r.active = TRUE AND r.required = TRUE AND d.active = TRUE
      ORDER BY r.display_order, d.sort_order, d.label`,
    [tenantId, ...catalogIds]
  );
  const missing = [];
  const invalid = [];
  const seen = new Set();
  for (const requirement of requirements) {
    const value = requirement.storage_kind === 'system'
      ? client[requirement.system_column]
      : (client.additional_data || {})[requirement.field_key];
    const label = requirement.label_override || requirement.label;
    const key = `${requirement.field_key}:${requirement.catalog_item_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isEmpty(value)) {
      missing.push({ field_key: requirement.field_key, label, service_id: requirement.catalog_item_id, service_name: requirement.service_name });
      continue;
    }
    const error = validationMessage(value, { ...requirement, validation_rules: requirement.definition_rules }, requirement.validation_rules);
    if (error) invalid.push({ field_key: requirement.field_key, label, service_id: requirement.catalog_item_id, service_name: requirement.service_name, error });
  }
  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing_service: false,
    missing_fields: missing,
    invalid_fields: invalid,
    services,
  };
}

async function assertOrderClientReady(executor, tenantId, orderId) {
  const result = await validateOrderClient(executor, tenantId, orderId);
  if (result.missing_service) throw new BusinessError('Inclua ao menos um servico antes de continuar.');
  if (result.missing_fields.length) {
    const labels = [...new Set(result.missing_fields.map((field) => field.label))];
    const error = new BusinessError(`Complete os dados obrigatorios do cliente: ${labels.join(', ')}.`);
    error.code = 'CLIENT_REQUIRED_FIELDS_MISSING';
    error.details = result;
    throw error;
  }
  if (result.invalid_fields.length) {
    const labels = [...new Set(result.invalid_fields.map((field) => `${field.label} (${field.error})`))];
    throw new BusinessError(`Corrija os dados do cliente: ${labels.join(', ')}.`);
  }
  return result;
}

module.exports = {
  FIELD_TYPES,
  SYSTEM_FIELDS,
  listDefinitions,
  listForServices,
  createDefinition,
  updateDefinition,
  getServiceRequirements,
  setServiceRequirements,
  normalizeAdditionalData,
  validateOrderClient,
  assertOrderClientReady,
  validationMessage,
};
