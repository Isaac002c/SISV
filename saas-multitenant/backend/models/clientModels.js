const pool = require('../config/db');
const { nextNumber, withTransaction } = require('../services/commercialCommon');

// ============================================
// CLIENTS MODEL - Clientes/Proprietários
// ============================================

// Helper - converte string vazia para null (evita erro de tipo date no PostgreSQL)
const toDateOrNull = (value) => (value === '' || value === undefined ? null : value);
const toStrOrNull = (value) => (value === '' || value === undefined ? null : value);

// CREATE - Criar novo cliente
const createClient = async ({
  tenant_id, name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status,
  additional_data, client_code, client_type, category, rg, cnh_category, whatsapp,
  contact_preference, origin, responsible_name, additional_info, portal_access,
}) => {
  if (!tenant_id) {
    throw new Error('tenant_id é obrigatório para criar um cliente');
  }

  return withTransaction(async (client) => {
    const code = toStrOrNull(client_code) || await nextNumber(client, tenant_id, 'client');
    const result = await client.query(
      `INSERT INTO clients(
         tenant_id, name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status,
         additional_data, client_code, client_type, category, rg, cnh_category, whatsapp,
         contact_preference, origin, responsible_name, additional_info, portal_access)
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23::jsonb) RETURNING *`,
      [
        tenant_id, name, toDateOrNull(birth_date), toStrOrNull(cpf), toStrOrNull(cnh),
        toDateOrNull(first_cnh), toStrOrNull(phone), toStrOrNull(email),
        toStrOrNull(address), toStrOrNull(notes), status || 'negociacao',
        JSON.stringify(additional_data || {}), code, toStrOrNull(client_type),
        toStrOrNull(category), toStrOrNull(rg), toStrOrNull(cnh_category),
        toStrOrNull(whatsapp), toStrOrNull(contact_preference), toStrOrNull(origin),
        toStrOrNull(responsible_name), toStrOrNull(additional_info),
        JSON.stringify(portal_access || {}),
      ]
    );
    return result.rows[0];
  });
};

// READ - Listar todos os clientes do tenant
// LIMIT 500: proteção de performance; se ultrapassar esse volume, implementar paginação real
const getAllClients = async (tenant_id, { archived = false } = {}) => {
  const result = await pool.query(
    `SELECT id, tenant_id, name, cpf, cnh, first_cnh, birth_date, phone, email, address, notes, additional_data,
            client_code, client_type, category, rg, cnh_category, whatsapp,
            contact_preference, origin, responsible_name, additional_info, portal_access,
            status, created_at, updated_at, deleted_at, deleted_by, delete_reason
     FROM clients
     WHERE tenant_id = $1
       AND ${archived ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'}
     ORDER BY ${archived ? 'deleted_at DESC, name ASC' : 'name ASC'}
     LIMIT 500`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Buscar cliente por ID
const getClientById = async (id, tenant_id, { includeDeleted = false } = {}) => {
  const result = await pool.query(
    `SELECT * FROM clients
     WHERE id = $1 AND tenant_id = $2
       ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// READ - Buscar cliente por CPF
const getClientByCPF = async (cpf, tenant_id) => {
  const result = await pool.query(
    'SELECT * FROM clients WHERE cpf = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [cpf, tenant_id]
  );
  return result.rows[0];
};

// READ - Pesquisar clientes
const searchClients = async (tenant_id, searchTerm) => {
  const result = await pool.query(
    `SELECT id, tenant_id, name, cpf, cnh, first_cnh, birth_date, phone, email, address, notes,
            additional_data, client_code, client_type, category, rg, cnh_category, whatsapp,
            contact_preference, origin, responsible_name, additional_info, portal_access,
            status, created_at
     FROM clients
     WHERE tenant_id = $1
       AND deleted_at IS NULL
       AND (name ILIKE $2 OR cpf ILIKE $2 OR cnh ILIKE $2 OR phone ILIKE $2
            OR client_code ILIKE $2 OR rg ILIKE $2 OR whatsapp ILIKE $2 OR email ILIKE $2)
     ORDER BY name ASC
     LIMIT 50`,
    [tenant_id, `%${searchTerm}%`]
  );
  return result.rows;
};

// READ - Contar clientes
const countClients = async (tenant_id) => {
  const result = await pool.query(
    'SELECT COUNT(*) as total FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL',
    [tenant_id]
  );
  return result.rows[0].total;
};

// UPDATE - Atualizar cliente
const updateClient = async (id, {
  name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status, additional_data,
  client_code, client_type, category, rg, cnh_category, whatsapp, contact_preference,
  origin, responsible_name, additional_info, portal_access,
}, tenant_id) => {
  const hasAdditionalData = additional_data !== undefined;
  const hasPortalAccess = portal_access !== undefined;
  return withTransaction(async (client) => {
    const code = toStrOrNull(client_code) || await nextNumber(client, tenant_id, 'client');
    const values = [
      name, toDateOrNull(birth_date), toStrOrNull(cpf), toStrOrNull(cnh),
      toDateOrNull(first_cnh), toStrOrNull(phone), toStrOrNull(email),
      toStrOrNull(address), toStrOrNull(notes), status || 'negociacao', code,
      toStrOrNull(client_type), toStrOrNull(category), toStrOrNull(rg),
      toStrOrNull(cnh_category), toStrOrNull(whatsapp), toStrOrNull(contact_preference),
      toStrOrNull(origin), toStrOrNull(responsible_name), toStrOrNull(additional_info),
    ];
    const extraAssignments = [];
    if (hasAdditionalData) {
      values.push(JSON.stringify(additional_data || {}));
      extraAssignments.push(`additional_data = COALESCE(additional_data, '{}'::jsonb) || $${values.length}::jsonb`);
    }
    if (hasPortalAccess) {
      values.push(JSON.stringify(portal_access || {}));
      extraAssignments.push(`portal_access = $${values.length}::jsonb`);
    }
    values.push(id, tenant_id);
    const result = await client.query(
      `UPDATE clients
          SET name = $1, birth_date = $2, cpf = $3, cnh = $4, first_cnh = $5,
              phone = $6, email = $7, address = $8, notes = $9, status = $10,
              client_code = $11, client_type = $12, category = $13, rg = $14,
              cnh_category = $15, whatsapp = $16, contact_preference = $17,
              origin = $18, responsible_name = $19, additional_info = $20,
              ${extraAssignments.length ? `${extraAssignments.join(', ')},` : ''}
              updated_at = NOW()
        WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
          AND deleted_at IS NULL RETURNING *`,
      values
    );
    return result.rows[0];
  });
};

// DELETE lógico - preserva pedidos, documentos e histórico ligados ao cliente.
const deleteClient = async (id, tenant_id, deleted_by = null, reason = null) => {
  const result = await pool.query(
    `UPDATE clients
     SET deleted_at = NOW(), deleted_by = $3, delete_reason = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [id, tenant_id, deleted_by || null, toStrOrNull(reason)]
  );
  return result.rows[0];
};

// RESTORE - Reativa um cliente arquivado sem alterar seus vínculos históricos.
const restoreClient = async (id, tenant_id) => {
  const result = await pool.query(
    `UPDATE clients
     SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL
     RETURNING *`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// ============================================
// Cria (uma única vez) o cliente correspondente a um lead "fechado".
// Idempotente e sem duplicar dados:
//   1) já existe cliente vinculado a este lead (lead_id)?  -> não cria
//   2) já existe cliente com o mesmo CPF neste tenant?     -> vincula o existente, não cria
//   3) senão, cria o cliente herdando os dados do lead.
// Respeita o tenant (todas as queries filtram por tenant_id). Requer a coluna
// clients.lead_id (migration add_client_lead_link.sql).
// ============================================
const ensureClientFromLead = async (lead, tenant_id) => {
  if (!tenant_id) throw new Error('tenant_id é obrigatório');
  if (!lead || !lead.id) throw new Error('lead inválido');

  return withTransaction(async (client) => {
    // 1) idempotência por vínculo direto
    const byLead = await client.query(
      'SELECT id FROM clients WHERE lead_id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [lead.id, tenant_id]
    );
    if (byLead.rows[0]) return { created: false, reason: 'already_linked', id: byLead.rows[0].id };

    // 2) dedupe por CPF (mesma pessoa já cadastrada) — compara só dígitos
    const cpf = String(lead.cpf || '').replace(/\D/g, '') || null;
    if (cpf) {
      const byCpf = await client.query(
        `SELECT id FROM clients
           WHERE tenant_id = $1
             AND deleted_at IS NULL
             AND regexp_replace(COALESCE(cpf, ''), '\\D', '', 'g') = $2
           LIMIT 1`,
        [tenant_id, cpf]
      );
      if (byCpf.rows[0]) {
        // vincula o cliente já existente a este lead sem sobrescrever outro vínculo
        await client.query(
          "UPDATE clients SET lead_id = $1, status = 'fechado' WHERE id = $2 AND tenant_id = $3 AND lead_id IS NULL",
          [lead.id, byCpf.rows[0].id, tenant_id]
        );
        return { created: false, reason: 'existing_cpf', id: byCpf.rows[0].id };
      }
    }

    // 3) cria o cliente herdando os dados disponíveis do lead
    const notesParts = [];
    if (lead.source) notesParts.push(`Origem: ${lead.source}`);
    if (lead.created_by_name) notesParts.push(`Consultor: ${lead.created_by_name}`);
    if (lead.notes) notesParts.push(String(lead.notes));
    const notes = notesParts.join('\n') || null;

    const code = await nextNumber(client, tenant_id, 'client');
    const result = await client.query(
      `INSERT INTO clients
         (tenant_id, name, cpf, cnh, first_cnh, birth_date, phone, notes, status, lead_id, client_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [tenant_id, lead.name, cpf, toStrOrNull(lead.cnh),
       toDateOrNull(lead.first_license_date), toDateOrNull(lead.birth_date),
       toStrOrNull(lead.phone), notes, 'fechado', lead.id, code]
    );
    return { created: true, id: result.rows[0].id };
  });
};

module.exports = {
  createClient,
  getAllClients,
  getClientById,
  getClientByCPF,
  searchClients,
  countClients,
  updateClient,
  deleteClient,
  restoreClient,
  ensureClientFromLead,
};
