const pool = require('../config/db');

// ============================================
// CLIENTS MODEL - Clientes/Proprietários
// ============================================

// Helper - converte string vazia para null (evita erro de tipo date no PostgreSQL)
const toDateOrNull = (value) => (value === '' || value === undefined ? null : value);
const toStrOrNull = (value) => (value === '' || value === undefined ? null : value);

// CREATE - Criar novo cliente
const createClient = async ({
  tenant_id, name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status,
  additional_data
}) => {
  if (!tenant_id) {
    throw new Error('tenant_id é obrigatório para criar um cliente');
  }

  const result = await pool.query(
    `INSERT INTO clients(tenant_id, name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status, additional_data)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING *`,
    [
      tenant_id,
      name,
      toDateOrNull(birth_date),
      toStrOrNull(cpf),
      toStrOrNull(cnh),
      toDateOrNull(first_cnh),
      toStrOrNull(phone),
      toStrOrNull(email),
      toStrOrNull(address),
      toStrOrNull(notes),
      status || 'negociacao',
      JSON.stringify(additional_data || {}),
    ]
  );

  return result.rows[0];
};

// READ - Listar todos os clientes do tenant
// LIMIT 500: proteção de performance; se ultrapassar esse volume, implementar paginação real
const getAllClients = async (tenant_id, { archived = false } = {}) => {
  const result = await pool.query(
    `SELECT id, tenant_id, name, cpf, cnh, first_cnh, birth_date, phone, email, address, notes, additional_data,
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
            additional_data, status, created_at
     FROM clients
     WHERE tenant_id = $1
       AND deleted_at IS NULL
       AND (name ILIKE $2 OR cpf ILIKE $2 OR cnh ILIKE $2 OR phone ILIKE $2)
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
}, tenant_id) => {
  const hasAdditionalData = additional_data !== undefined;
  const baseValues = [
    name,
    toDateOrNull(birth_date),
    toStrOrNull(cpf),
    toStrOrNull(cnh),
    toDateOrNull(first_cnh),
    toStrOrNull(phone),
    toStrOrNull(email),
    toStrOrNull(address),
    toStrOrNull(notes),
    status || 'negociacao',
  ];
  const result = await pool.query(
    `UPDATE clients
     SET name = $1, birth_date = $2, cpf = $3, cnh = $4, first_cnh = $5,
         phone = $6, email = $7, address = $8, notes = $9, status = $10,
         ${hasAdditionalData
    ? "additional_data = COALESCE(additional_data, '{}'::jsonb) || $11::jsonb,"
    : ''}
         updated_at = NOW()
     WHERE id = $${hasAdditionalData ? 12 : 11}
       AND tenant_id = $${hasAdditionalData ? 13 : 12}
       AND deleted_at IS NULL RETURNING *`,
    hasAdditionalData
      ? [...baseValues, JSON.stringify(additional_data || {}), id, tenant_id]
      : [...baseValues, id, tenant_id]
  );
  return result.rows[0];
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

  // 1) idempotência por vínculo direto
  const byLead = await pool.query(
    'SELECT id FROM clients WHERE lead_id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
    [lead.id, tenant_id]
  );
  if (byLead.rows[0]) return { created: false, reason: 'already_linked', id: byLead.rows[0].id };

  // 2) dedupe por CPF (mesma pessoa já cadastrada) — compara só dígitos
  const cpf = String(lead.cpf || '').replace(/\D/g, '') || null;
  if (cpf) {
    const byCpf = await pool.query(
      `SELECT id FROM clients
         WHERE tenant_id = $1
           AND deleted_at IS NULL
           AND regexp_replace(COALESCE(cpf, ''), '\\D', '', 'g') = $2
         LIMIT 1`,
      [tenant_id, cpf]
    );
    if (byCpf.rows[0]) {
      // vincula o cliente já existente a este lead (sem sobrescrever outro vínculo)
      // e o promove a "fechado" (o lead foi fechado -> é a mesma pessoa/cliente fechado)
      await pool.query(
        "UPDATE clients SET lead_id = $1, status = 'fechado' WHERE id = $2 AND tenant_id = $3 AND lead_id IS NULL",
        [lead.id, byCpf.rows[0].id, tenant_id]
      );
      return { created: false, reason: 'existing_cpf', id: byCpf.rows[0].id };
    }
  }

  // 3) cria o cliente herdando os dados disponíveis do lead
  const notesParts = [];
  if (lead.source)          notesParts.push(`Origem: ${lead.source}`);
  if (lead.created_by_name) notesParts.push(`Consultor: ${lead.created_by_name}`);
  if (lead.notes)           notesParts.push(String(lead.notes));
  const notes = notesParts.join('\n') || null;

  const result = await pool.query(
    `INSERT INTO clients
       (tenant_id, name, cpf, cnh, first_cnh, birth_date, phone, notes, status, lead_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tenant_id,
      lead.name,
      cpf,
      toStrOrNull(lead.cnh),
      toDateOrNull(lead.first_license_date),
      toDateOrNull(lead.birth_date),
      toStrOrNull(lead.phone),
      notes,
      'fechado',
      lead.id,
    ]
  );
  return { created: true, id: result.rows[0].id };
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
