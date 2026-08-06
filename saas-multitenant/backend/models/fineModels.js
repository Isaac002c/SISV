const pool = require('../config/db');

// ============================================
// FINES MODEL - Multas V2
// ============================================

// CREATE - Criar novo processo (fines é a entidade "processo")
// `organ` é opcional: obrigatório apenas na operação de multas (validado na rota
// /api/fines). Em processos de CNH (SISV) não se aplica. Campos novos
// (department_id, tenant_service_type_id) são opcionais e retrocompatíveis.
const createFine = async ({
  tenant_id, client_id, fine_number, plate, organ, infraction_type,
  vehicle_model, infraction_date, due_date, defense_date, stage, status,
  value, cost, paid_value, seller_id, notes,
  department_id, tenant_service_type_id, service_type_id, protocol_number,
  custom_data
}, db = pool) => {
  if (!tenant_id) {
    throw new Error('tenant_id é obrigatório para criar um processo');
  }
  if (!client_id) {
    throw new Error('client_id é obrigatório para criar um processo');
  }

  const result = await db.query(
    `INSERT INTO fines(
      tenant_id, client_id, fine_number, plate, organ, infraction_type,
      vehicle_model, infraction_date, due_date, defense_date, stage, status,
      value, cost, paid_value, seller_id, notes,
      department_id, tenant_service_type_id, service_type_id, protocol_number, last_moved_at
    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, NOW()) RETURNING *`,
    [
      tenant_id, client_id, fine_number, plate, organ || null, infraction_type,
      vehicle_model, infraction_date, due_date, defense_date,
      stage || 'cadastro', status || 'pendente',
      value || 0, cost || 0, paid_value || 0, seller_id, notes,
      department_id || null, tenant_service_type_id || null, service_type_id || null,
      protocol_number || null
    ]
  );

  const created = result.rows[0];
  if (custom_data !== undefined) {
    const custom = await db.query(
      `UPDATE fines SET custom_data = $1::jsonb
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [JSON.stringify(custom_data || {}), created.id, tenant_id]
    );
    return custom.rows[0];
  }
  return created;
};

// READ - Listar todas as multas do tenant
const getAllFines = async (tenant_id) => {
  const result = await pool.query(
    `SELECT f.*, 
            c.name as client_name, c.cpf as client_cpf, c.phone as client_phone, c.email as client_email,
            u.name as seller_name
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     LEFT JOIN users u ON f.seller_id = u.id
     WHERE f.tenant_id = $1
     ORDER BY f.created_at DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Listar multas com filtros
const getFinesByFilter = async (tenant_id, filters = {}) => {
  let query = `
    SELECT f.*, 
           c.name as client_name, c.cpf as client_cpf, c.phone as client_phone,
           u.name as seller_name
    FROM fines f
    LEFT JOIN clients c ON f.client_id = c.id
    LEFT JOIN users u ON f.seller_id = u.id
    WHERE f.tenant_id = $1
  `;
  
  const params = [tenant_id];
  let paramIndex = 2;
  
  if (filters.client_id) {
    query += ` AND f.client_id = $${paramIndex}`;
    params.push(filters.client_id);
    paramIndex++;
  }
  
  if (filters.status) {
    query += ` AND f.status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }
  
  if (filters.stage) {
    query += ` AND f.stage = $${paramIndex}`;
    params.push(filters.stage);
    paramIndex++;
  }
  
  if (filters.organ) {
    query += ` AND f.organ ILIKE $${paramIndex}`;
    params.push(`%${filters.organ}%`);
    paramIndex++;
  }
  
  if (filters.plate) {
    query += ` AND f.plate ILIKE $${paramIndex}`;
    params.push(`%${filters.plate}%`);
    paramIndex++;
  }
  
  if (filters.seller_id) {
    query += ` AND f.seller_id = $${paramIndex}`;
    params.push(filters.seller_id);
    paramIndex++;
  }
  
  // Filtros de data
  if (filters.due_date_from) {
    query += ` AND f.due_date >= $${paramIndex}`;
    params.push(filters.due_date_from);
    paramIndex++;
  }
  
  if (filters.due_date_to) {
    query += ` AND f.due_date <= $${paramIndex}`;
    params.push(filters.due_date_to);
    paramIndex++;
  }
  
  query += ' ORDER BY f.created_at DESC';
  
  const result = await pool.query(query, params);
  return result.rows;
};

// READ - Buscar multa por ID
const getFineById = async (id, tenant_id) => {
  const result = await pool.query(
    `SELECT f.*, 
            c.name as client_name, c.cpf as client_cpf, c.phone as client_phone, c.email as client_email,
            c.cnh as client_cnh, c.address as client_address,
            u.name as seller_name
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     LEFT JOIN users u ON f.seller_id = u.id
     WHERE f.id = $1 AND f.tenant_id = $2`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// READ - Buscar multas por cliente
const getFinesByClient = async (client_id, tenant_id) => {
  const result = await pool.query(
    `SELECT * FROM fines 
     WHERE client_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC`,
    [client_id, tenant_id]
  );
  return result.rows;
};

// READ - Buscar multas por vendedor
const getFinesBySeller = async (seller_id, tenant_id) => {
  const result = await pool.query(
    `SELECT * FROM fines 
     WHERE seller_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC`,
    [seller_id, tenant_id]
  );
  return result.rows;
};

// READ - Contar multas
const countFines = async (tenant_id) => {
  const result = await pool.query(
    'SELECT COUNT(*) as total FROM fines WHERE tenant_id = $1',
    [tenant_id]
  );
  return result.rows[0].total;
};

// READ - Dashboard stats - Estatísticas completas
const getDashboardStats = async (tenant_id) => {
  const result = await pool.query(
    `SELECT 
      -- Total de multas
      COUNT(*) as total_fines,
      
      -- Por status
      COUNT(CASE WHEN status = 'pendente' THEN 1 END) as pending_fines,
      COUNT(CASE WHEN status = 'aguardando_documento' THEN 1 END) as waiting_doc_fines,
      COUNT(CASE WHEN status = 'protocolado' THEN 1 END) as filed_fines,
      COUNT(CASE WHEN status = 'deferido' THEN 1 END) as granted_fines,
      COUNT(CASE WHEN status = 'indeferido' THEN 1 END) as denied_fines,
      COUNT(CASE WHEN status = 'cancelado' THEN 1 END) as canceled_fines,
      
      -- Por estágio
      COUNT(CASE WHEN stage = 'cadastro' THEN 1 END) as stage_cadastro,
      COUNT(CASE WHEN stage = 'defesa_previa' THEN 1 END) as stage_defesa_previa,
      COUNT(CASE WHEN stage = 'recurso_1' THEN 1 END) as stage_recurso_1,
      COUNT(CASE WHEN stage = 'recurso_2' THEN 1 END) as stage_recurso_2,
      COUNT(CASE WHEN stage = 'finalizado' THEN 1 END) as stage_finalizado,
      
      -- Valores
      SUM(COALESCE(value, 0)) as total_value,
      SUM(COALESCE(cost, 0)) as total_cost,
      SUM(COALESCE(paid_value, 0)) as total_paid,
      
      -- Valor por status
      SUM(CASE WHEN status = 'deferido' THEN COALESCE(paid_value, 0) END) as granted_value,
      SUM(CASE WHEN status = 'pendente' THEN COALESCE(value, 0) END) as pending_value
    FROM fines
    WHERE tenant_id = $1`,
    [tenant_id]
  );
  return result.rows[0];
};

// READ - Urgência - Multas com prazo curto
const getUrgentFines = async (tenant_id, days = 5) => {
  const result = await pool.query(
    `SELECT f.*, c.name as client_name, c.phone as client_phone
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE f.tenant_id = $1 
       AND f.stage != 'finalizado'
       AND f.due_date IS NOT NULL
       AND f.due_date <= NOW() + INTERVAL '1 day' * $2
       AND f.due_date >= NOW()
     ORDER BY f.due_date ASC`,
    [tenant_id, days]
  );
  return result.rows;
};

// READ - Multas aguardando documento
const getFinesWaitingDocument = async (tenant_id) => {
  const result = await pool.query(
    `SELECT f.*, c.name as client_name, c.phone as client_phone
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE f.tenant_id = $1 
       AND f.status = 'aguardando_documento'
     ORDER BY f.updated_at DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Multas aguardando protocolo
const getFinesWaitingProtocol = async (tenant_id) => {
  const result = await pool.query(
    `SELECT f.*, c.name as client_name
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE f.tenant_id = $1 
       AND f.status = 'protocolado'
       AND f.stage IN ('defesa_previa', 'recurso_1', 'recurso_2')
     ORDER BY f.updated_at DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Multas vencidas
const getOverdueFines = async (tenant_id) => {
  const result = await pool.query(
    `SELECT f.*, c.name as client_name, c.phone as client_phone
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id
     WHERE f.tenant_id = $1 
       AND f.stage != 'finalizado'
       AND f.due_date IS NOT NULL
       AND f.due_date < NOW()
     ORDER BY f.due_date ASC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Multas por órgão (para gráficos)
const getFinesGroupedByOrgan = async (tenant_id) => {
  const result = await pool.query(
    `SELECT 
      organ, 
      COUNT(*) as count, 
      SUM(COALESCE(value, 0)) as total_value,
      COUNT(CASE WHEN status = 'deferido' THEN 1 END) as granted_count
    FROM fines
    WHERE tenant_id = $1
    GROUP BY organ
    ORDER BY count DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Multas por vendedor
const getFinesGroupedBySeller = async (tenant_id) => {
  const result = await pool.query(
    `SELECT 
      u.name as seller_name,
      f.seller_id,
      COUNT(*) as count, 
      SUM(COALESCE(value, 0)) as total_value,
      SUM(COALESCE(paid_value, 0)) as total_paid,
      COUNT(CASE WHEN status = 'deferido' THEN 1 END) as granted_count
    FROM fines f
    LEFT JOIN users u ON f.seller_id = u.id
    WHERE f.tenant_id = $1
    GROUP BY f.seller_id, u.name
    ORDER BY count DESC`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Taxa de deferimento
const getDefermentRate = async (tenant_id) => {
  const result = await pool.query(
    `SELECT 
      COUNT(CASE WHEN status = 'deferido' THEN 1 END) as granted,
      COUNT(CASE WHEN status IN ('deferido', 'indeferido') THEN 1 END) as total_decided,
      ROUND(
        COUNT(CASE WHEN status = 'deferido' THEN 1 END)::numeric / 
        NULLIF(COUNT(CASE WHEN status IN ('deferido', 'indeferido') THEN 1 END), 0) * 100, 2
      ) as rate
    FROM fines
    WHERE tenant_id = $1`,
    [tenant_id]
  );
  return result.rows[0];
};

// READ - Alertas
const getAlerts = async (tenant_id) => {
  const alerts = [];
  
  // Multas com prazo curto (< 5 dias)
  const urgent = await pool.query(
    `SELECT COUNT(*) as count FROM fines
     WHERE tenant_id = $1 
       AND stage != 'finalizado'
       AND due_date IS NOT NULL
       AND due_date <= NOW() + INTERVAL '5 days'
       AND due_date >= NOW()`,
    [tenant_id]
  );
  
  if (parseInt(urgent.rows[0].count) > 0) {
    alerts.push({
      type: 'danger',
      title: 'Multas com prazo curto',
      message: `${urgent.rows[0].count} multa(s) vencem em menos de 5 dias`,
      count: parseInt(urgent.rows[0].count)
    });
  }
  
  // Multas aguardando documento
  const waitingDoc = await pool.query(
    `SELECT COUNT(*) as count FROM fines
     WHERE tenant_id = $1 AND status = 'aguardando_documento'`,
    [tenant_id]
  );
  
  if (parseInt(waitingDoc.rows[0].count) > 0) {
    alerts.push({
      type: 'warning',
      title: 'Aguardando documento',
      message: `${waitingDoc.rows[0].count} multa(s) aguardando documento`,
      count: parseInt(waitingDoc.rows[0].count)
    });
  }
  
  // Multas vencidas
  const overdue = await pool.query(
    `SELECT COUNT(*) as count FROM fines
     WHERE tenant_id = $1 
       AND stage != 'finalizado'
       AND due_date IS NOT NULL
       AND due_date < NOW()`,
    [tenant_id]
  );
  
  if (parseInt(overdue.rows[0].count) > 0) {
    alerts.push({
      type: 'danger',
      title: 'Multas vencidas',
      message: `${overdue.rows[0].count} multa(s) com prazo vencido`,
      count: parseInt(overdue.rows[0].count)
    });
  }
  
  return alerts;
};

// READ - Fines por status
const getFinesByStatus = async (tenant_id) => {
  const result = await pool.query(
    `SELECT status, COUNT(*) as count, SUM(COALESCE(value, 0)) as total_value
     FROM fines
     WHERE tenant_id = $1
     GROUP BY status`,
    [tenant_id]
  );
  return result.rows;
};

// UPDATE - Atualizar multa
const updateFine = async (id, { 
  fine_number, plate, organ, infraction_type, vehicle_model,
  infraction_date, due_date, defense_date, stage, status,
  value, cost, paid_value, seller_id, notes
}, tenant_id) => {
  const result = await pool.query(
    `UPDATE fines 
     SET fine_number = $1, plate = $2, organ = $3, infraction_type = $4,
         vehicle_model = $5, infraction_date = $6, due_date = $7, defense_date = $8,
         stage = $9, status = $10, value = $11, cost = $12, paid_value = $13,
         seller_id = $14, notes = $15, updated_at = NOW()
     WHERE id = $16 AND tenant_id = $17 RETURNING *`,
    [
      fine_number, plate, organ, infraction_type, vehicle_model,
      infraction_date, due_date, defense_date, stage, status,
      value, cost, paid_value, seller_id, notes,
      id, tenant_id
    ]
  );
  return result.rows[0];
};

// UPDATE - Atualizar status da multa
const updateFineStatus = async (id, status, tenant_id) => {
  const result = await pool.query(
    `UPDATE fines 
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [status, id, tenant_id]
  );
  return result.rows[0];
};

// UPDATE - Atualizar estágio da multa
const updateFineStage = async (id, stage, tenant_id) => {
  const result = await pool.query(
    `UPDATE fines 
     SET stage = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [stage, id, tenant_id]
  );
  return result.rows[0];
};

// ============================================
// PROCESSOS (SISV) — operação sobre a mesma tabela `fines`.
// Consultas ricas com filtros combináveis, paginação e agregados operacionais.
// Toda query é escopada por tenant_id.
// ============================================

// READ - Detalhe do processo com rótulos de setor/tipo de serviço/responsável.
const getProcessById = async (id, tenant_id) => {
  const result = await pool.query(
    `SELECT f.*,
            c.name as client_name, c.cpf as client_cpf, c.phone as client_phone,
            c.email as client_email, c.cnh as client_cnh, c.address as client_address,
            u.name as seller_name,
            d.name as department_name, d.color as department_color,
            st.label as service_type_label, st.code as service_type_code
     FROM fines f
     LEFT JOIN clients c ON f.client_id = c.id AND c.tenant_id = f.tenant_id
     LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
     LEFT JOIN departments d ON f.department_id = d.id AND d.tenant_id = f.tenant_id
     LEFT JOIN tenant_service_types st ON f.tenant_service_type_id = st.id AND st.tenant_id = f.tenant_id
     WHERE f.id = $1 AND f.tenant_id = $2`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// Monta o WHERE compartilhado por listProcesses e countProcesses.
const buildProcessWhere = (tenant_id, filters = {}) => {
  const clauses = ['f.tenant_id = $1'];
  const params = [tenant_id];
  let i = 2;
  const add = (sql, val) => { clauses.push(sql.replace('$$', `$${i}`)); params.push(val); i++; };

  if (filters.stage)                 add('f.stage = $$', filters.stage);
  if (filters.status)                add('f.status = $$', filters.status);
  if (filters.department_id === 'none') clauses.push('f.department_id IS NULL');
  else if (filters.department_id)     add('f.department_id = $$', filters.department_id);
  if (filters.tenant_service_type_id) add('f.tenant_service_type_id = $$', filters.tenant_service_type_id);
  if (filters.client_id)             add('f.client_id = $$', filters.client_id);

  if (filters.seller_id === 'none')  clauses.push('f.seller_id IS NULL');
  else if (filters.seller_id)        add('f.seller_id = $$', filters.seller_id);

  if (filters.finalized === true || filters.finalized === 'true')   clauses.push('f.finalized_at IS NOT NULL');
  if (filters.finalized === false || filters.finalized === 'false') clauses.push('f.finalized_at IS NULL');

  // Pendência: usa o flag is_pending do catálogo de status (JOIN em listProcesses).
  if (filters.pending === true || filters.pending === 'true') {
    clauses.push('ps.is_pending = TRUE');
  }

  // Sem movimentação há N dias (usa last_moved_at, com fallback para updated_at).
  // Cutoff calculado em JS para portabilidade (evita cast dinâmico de intervalo).
  if (filters.stale_days) {
    const days = Math.min(Math.max(Number(filters.stale_days) || 0, 1), 3650);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    add('COALESCE(f.last_moved_at, f.updated_at) < $$', cutoff);
  }

  // Faixas padrao de aging. Os limites configuraveis sao expostos pela Central;
  // a fila tambem aceita min/max explicitos vindos desses cards.
  const defaultAgingRanges = {
    ate_2: [0, 2],
    '3_a_5': [3, 5],
    '6_a_10': [6, 10],
    acima_10: [11, null],
  };
  let agingRange = defaultAgingRanges[filters.aging];
  if (!agingRange && typeof filters.aging === 'string') {
    const until = /^ate_(\d{1,3})$/.exec(filters.aging);
    const between = /^(\d{1,3})_a_(\d{1,3})$/.exec(filters.aging);
    const above = /^acima_(\d{1,3})$/.exec(filters.aging);
    if (until && Number(until[1]) >= 1) agingRange = [0, Number(until[1])];
    if (between && Number(between[1]) >= 1 && Number(between[1]) <= Number(between[2])) {
      agingRange = [Number(between[1]), Number(between[2])];
    }
    if (above && Number(above[1]) >= 1) agingRange = [Number(above[1]) + 1, null];
  }
  if (agingRange) {
    const [min, max] = agingRange;
    if (max !== null) {
      add('COALESCE(f.last_moved_at, f.updated_at) >= $$', new Date(Date.now() - (max + 1) * 86400000).toISOString());
    }
    if (min > 0) {
      add('COALESCE(f.last_moved_at, f.updated_at) < $$', new Date(Date.now() - min * 86400000).toISOString());
    }
  }

  // Prazos (due_date): vencidos e vencendo em N dias — só processos em aberto.
  const todayISO = new Date().toISOString().slice(0, 10);
  if (filters.overdue === true || filters.overdue === 'true') {
    clauses.push('f.finalized_at IS NULL AND f.due_date IS NOT NULL');
    add('f.due_date < $$', todayISO);
  }
  if (filters.due_soon && filters.due_soon !== 'false') {
    const requestedDays = filters.due_soon === true || filters.due_soon === 'true'
      ? 7
      : Number(filters.due_soon);
    const dueSoonDays = Math.min(Math.max(Number.isInteger(requestedDays) ? requestedDays : 7, 1), 90);
    const soonISO = new Date(Date.now() + dueSoonDays * 86400000).toISOString().slice(0, 10);
    clauses.push('f.finalized_at IS NULL AND f.due_date IS NOT NULL');
    add('f.due_date >= $$', todayISO);
    add('f.due_date <= $$', soonISO);
  }
  if (filters.due_today === true || filters.due_today === 'true') {
    clauses.push('f.finalized_at IS NULL AND f.due_date IS NOT NULL');
    add('f.due_date = $$', todayISO);
  }
  if (filters.missing_documents === true || filters.missing_documents === 'true') {
    clauses.push(`EXISTS (
      SELECT 1 FROM service_type_documents std
      LEFT JOIN fine_documents mfd
        ON mfd.tenant_id = f.tenant_id AND mfd.fine_id = f.id
       AND mfd.category_id = std.category_id
       AND COALESCE(mfd.status, 'ativo') = 'ativo' AND mfd.removed_at IS NULL
      WHERE std.tenant_id = f.tenant_id
        AND std.tenant_service_type_id = f.tenant_service_type_id
        AND std.required = TRUE AND mfd.id IS NULL
    )`);
  }
  if (filters.due_from) add('f.due_date >= $$', filters.due_from);
  if (filters.due_to)   add('f.due_date <= $$', filters.due_to);
  if (filters.date_from) add('f.created_at >= $$', filters.date_from);
  if (filters.date_to)   add('f.created_at <= $$', filters.date_to);

  // Busca textual combinável: cliente, CPF/CNPJ, número, protocolo, placa.
  if (filters.q) {
    clauses.push(`(
      c.name ILIKE $${i} OR c.cpf ILIKE $${i} OR c.cnh ILIKE $${i}
      OR f.fine_number ILIKE $${i} OR f.protocol_number ILIKE $${i} OR f.plate ILIKE $${i}
      OR st.label ILIKE $${i} OR u.name ILIKE $${i}
    )`);
    params.push(`%${filters.q}%`);
    i++;
  }

  return { where: clauses.join(' AND '), params, nextIndex: i };
};

const SORT_COLUMNS = {
  created_at: 'f.created_at',
  updated_at: 'f.updated_at',
  last_moved_at: 'COALESCE(f.last_moved_at, f.updated_at)',
  client_name: 'c.name',
  stage: 'f.stage',
  status: 'f.status',
  due_date: 'f.due_date',
};

// READ - Lista paginada de processos com filtros combináveis.
const listProcesses = async (tenant_id, filters = {}) => {
  const { where, params, nextIndex } = buildProcessWhere(tenant_id, filters);
  const sortCol = SORT_COLUMNS[filters.sort_by] || 'COALESCE(f.last_moved_at, f.updated_at)';
  const sortDir = String(filters.sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  // JOINs em derived tables/catálogos (portável; sem subqueries correlacionadas).
  const joins = `
    LEFT JOIN clients c ON f.client_id = c.id AND c.tenant_id = f.tenant_id
    LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
    LEFT JOIN departments d ON f.department_id = d.id AND d.tenant_id = f.tenant_id
    LEFT JOIN tenant_service_types st ON f.tenant_service_type_id = st.id AND st.tenant_id = f.tenant_id
    LEFT JOIN process_statuses ps ON ps.tenant_id = f.tenant_id AND ps.code = f.status
    LEFT JOIN (SELECT fine_id, COUNT(*) AS c FROM fine_documents GROUP BY fine_id) dc ON dc.fine_id = f.id`;

  const rowsQuery = `
    SELECT f.id, f.client_id, f.fine_number, f.protocol_number, f.plate, f.stage, f.status,
           f.seller_id, f.department_id, f.tenant_service_type_id,
           f.created_at, f.updated_at, f.last_moved_at, f.finalized_at, f.due_date, f.notes,
           c.name as client_name, c.cpf as client_cpf, c.phone as client_phone,
           u.name as seller_name,
           d.name as department_name, d.color as department_color,
           st.label as service_type_label,
           COALESCE(dc.c, 0) AS document_count
    FROM fines f${joins}
    WHERE ${where}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM fines f
    LEFT JOIN clients c ON f.client_id = c.id AND c.tenant_id = f.tenant_id
    LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
    LEFT JOIN tenant_service_types st ON f.tenant_service_type_id = st.id AND st.tenant_id = f.tenant_id
    LEFT JOIN process_statuses ps ON ps.tenant_id = f.tenant_id AND ps.code = f.status
    WHERE ${where}`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsQuery, [...params, limit, offset]),
    pool.query(countQuery, params),
  ]);

  const now = Date.now();
  const rows = rowsRes.rows.map((row) => {
    const moved = new Date(row.last_moved_at || row.updated_at).getTime();
    const agingDays = Number.isFinite(moved) ? Math.max(0, Math.floor((now - moved) / 86400000)) : 0;
    const agingBucket = agingDays <= 2 ? 'ate_2' : agingDays <= 5 ? '3_a_5' : agingDays <= 10 ? '6_a_10' : 'acima_10';
    return { ...row, aging_days: agingDays, aging_bucket: agingBucket };
  });
  return { rows, total: countRes.rows[0].total, limit, offset };
};

// UPDATE - Movimenta etapa marcando a última movimentação.
const moveProcessStage = async (id, stage, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET stage = $1, last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [stage, id, tenant_id]
  );
  return rows[0];
};

// UPDATE - Muda status marcando a última movimentação.
const moveProcessStatus = async (id, status, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET status = $1, last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [status, id, tenant_id]
  );
  return rows[0];
};

// UPDATE - Redistribui para outro responsável.
const changeProcessSeller = async (id, seller_id, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET seller_id = $1, last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [seller_id || null, id, tenant_id]
  );
  return rows[0];
};

// UPDATE - Troca de setor/departamento.
const changeProcessDepartment = async (id, department_id, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET department_id = $1, last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [department_id || null, id, tenant_id]
  );
  return rows[0];
};

// UPDATE - Finaliza o processo (registra finalized_at; opcionalmente muda etapa/status).
const finalizeProcess = async (id, { stage, status }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET
       finalized_at = NOW(), reopened_at = NULL,
       stage = COALESCE($1, stage), status = COALESCE($2, status),
       last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [stage || null, status || null, id, tenant_id]
  );
  return rows[0];
};

// UPDATE - Reabre um processo finalizado.
const reopenProcess = async (id, { stage, status }, tenant_id) => {
  const { rows } = await pool.query(
    `UPDATE fines SET
       finalized_at = NULL, reopened_at = NOW(),
       stage = COALESCE($1, stage), status = COALESCE($2, status),
       last_moved_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 RETURNING *`,
    [stage || null, status || null, id, tenant_id]
  );
  return rows[0];
};

// READ - Dashboard operacional do SISV (agregados por catálogo do tenant).
const getProcessDashboard = async (tenant_id) => {
  // Cutoffs calculados em JS (portável Postgres/pg-mem).
  const staleCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const todayISO = new Date().toISOString().slice(0, 10);
  const soonISO = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const [totals, byStage, byStatus, bySeller, byDepartment, recent] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN f.finalized_at IS NOT NULL THEN 1 END)::int AS finalized,
        COUNT(CASE WHEN f.finalized_at IS NULL THEN 1 END)::int AS in_progress,
        COUNT(CASE WHEN f.seller_id IS NULL AND f.finalized_at IS NULL THEN 1 END)::int AS unassigned,
        COUNT(CASE WHEN COALESCE(f.last_moved_at, f.updated_at) < $2
                    AND f.finalized_at IS NULL THEN 1 END)::int AS stale,
        COUNT(CASE WHEN f.finalized_at IS NULL AND ps.is_pending = TRUE THEN 1 END)::int AS pending,
        COUNT(CASE WHEN f.finalized_at IS NULL AND f.due_date IS NOT NULL
                    AND f.due_date < $3 THEN 1 END)::int AS overdue,
        COUNT(CASE WHEN f.finalized_at IS NULL AND f.due_date IS NOT NULL
                    AND f.due_date >= $3 AND f.due_date <= $4 THEN 1 END)::int AS due_soon
       FROM fines f
       LEFT JOIN process_statuses ps ON ps.tenant_id = f.tenant_id AND ps.code = f.status
       WHERE f.tenant_id = $1`,
      [tenant_id, staleCutoff, todayISO, soonISO]
    ),
    pool.query(
      `SELECT COALESCE(s.label, f.stage) AS label, f.stage AS code, s.color,
              COUNT(*)::int AS count
       FROM fines f
       LEFT JOIN process_stages s ON s.tenant_id = f.tenant_id AND s.code = f.stage
       WHERE f.tenant_id = $1 GROUP BY f.stage, s.label, s.color, s.sort_order
       ORDER BY MIN(COALESCE(s.sort_order, 9999)), count DESC`,
      [tenant_id]
    ),
    pool.query(
      `SELECT COALESCE(s.label, f.status) AS label, f.status AS code, s.color,
              COUNT(*)::int AS count
       FROM fines f
       LEFT JOIN process_statuses s ON s.tenant_id = f.tenant_id AND s.code = f.status
       WHERE f.tenant_id = $1 GROUP BY f.status, s.label, s.color, s.sort_order
       ORDER BY MIN(COALESCE(s.sort_order, 9999)), count DESC`,
      [tenant_id]
    ),
    pool.query(
      `SELECT u.name AS seller_name, f.seller_id, COUNT(*)::int AS count
       FROM fines f LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.seller_id, u.name ORDER BY count DESC`,
      [tenant_id]
    ),
    pool.query(
      `SELECT d.name AS department_name, f.department_id, d.color, COUNT(*)::int AS count
       FROM fines f LEFT JOIN departments d ON f.department_id = d.id AND d.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.department_id, d.name, d.color ORDER BY count DESC`,
      [tenant_id]
    ),
    pool.query(
      `SELECT f.id, f.fine_number, f.stage, f.status, f.last_moved_at, f.updated_at,
              c.name AS client_name, u.name AS seller_name
       FROM fines f
       LEFT JOIN clients c ON f.client_id = c.id AND c.tenant_id = f.tenant_id
       LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1
       ORDER BY COALESCE(f.last_moved_at, f.updated_at) DESC LIMIT 8`,
      [tenant_id]
    ),
  ]);

  return {
    totals: totals.rows[0],
    byStage: byStage.rows,
    byStatus: byStatus.rows,
    bySeller: bySeller.rows,
    byDepartment: byDepartment.rows,
    recent: recent.rows,
  };
};

// UPDATE - Distribuição em LOTE (transacional): aplica responsável e/ou setor a
// vários processos do tenant. Semântica clara: valida os alvos ANTES; processos
// que não são do tenant entram em `skipped` (isolamento); tudo dentro de uma
// transação (all-or-nothing em caso de erro no meio). Retorna dados para o
// histórico (nomes anteriores) sem gravar o log aqui.
const batchAssign = async (tenant_id, ids, { changeSeller, seller_id, changeDept, department_id }) => {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'Nenhum processo selecionado.' };
  if (ids.length > 200) return { ok: false, error: 'Limite de 200 processos por lote.' };
  if (!changeSeller && !changeDept) return { ok: false, error: 'Informe responsável e/ou setor.' };

  const client = await pool.connect();
  try {
    // Validação de alvos (pertencem ao tenant). Fora da transação de escrita.
    let newSellerName = null, newDeptName = null;
    if (changeSeller && seller_id) {
      const r = await client.query('SELECT name FROM users WHERE id = $1 AND tenant_id = $2', [seller_id, tenant_id]);
      if (!r.rows[0]) return { ok: false, error: 'Responsável inválido.' };
      newSellerName = r.rows[0].name;
    }
    if (changeDept && department_id) {
      const r = await client.query('SELECT name FROM departments WHERE id = $1 AND tenant_id = $2', [department_id, tenant_id]);
      if (!r.rows[0]) return { ok: false, error: 'Setor inválido.' };
      newDeptName = r.rows[0].name;
    }

    await client.query('BEGIN');
    const changes = [];
    const skipped = [];
    let updated = 0;
    for (const id of ids) {
      const cur = await client.query(
        `SELECT f.id, f.seller_id, f.department_id, u.name AS seller_name, d.name AS department_name
         FROM fines f
         LEFT JOIN users u ON f.seller_id = u.id AND u.tenant_id = f.tenant_id
         LEFT JOIN departments d ON f.department_id = d.id AND d.tenant_id = f.tenant_id
         WHERE f.id = $1 AND f.tenant_id = $2`, [id, tenant_id]);
      const row = cur.rows[0];
      if (!row) { skipped.push(id); continue; } // isolamento: id de outro tenant / inexistente
      const rec = { fine_id: id };
      let touched = false;
      if (changeSeller && (row.seller_id || null) !== (seller_id || null)) {
        await client.query('UPDATE fines SET seller_id = $1, last_moved_at = NOW(), updated_at = NOW() WHERE id = $2 AND tenant_id = $3', [seller_id || null, id, tenant_id]);
        rec.seller = { old: row.seller_name, new: newSellerName, id: seller_id || null }; touched = true;
      }
      if (changeDept && (row.department_id || null) !== (department_id || null)) {
        await client.query('UPDATE fines SET department_id = $1, last_moved_at = NOW(), updated_at = NOW() WHERE id = $2 AND tenant_id = $3', [department_id || null, id, tenant_id]);
        rec.department = { old: row.department_name, new: newDeptName }; touched = true;
      }
      if (touched) changes.push(rec);
      updated++;
    }
    await client.query('COMMIT');
    return { ok: true, updated, skipped, changes };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
};

// DELETE - Deletar multa
const deleteFine = async (id, tenant_id) => {
  const result = await pool.query(
    'DELETE FROM fines WHERE id = $1 AND tenant_id = $2 RETURNING *',
    [id, tenant_id]
  );
  return result.rows[0];
};

module.exports = {
  createFine,
  getAllFines,
  getFinesByFilter,
  getFineById,
  getFinesByClient,
  getFinesBySeller,
  countFines,
  getDashboardStats,
  getUrgentFines,
  getFinesWaitingDocument,
  getFinesWaitingProtocol,
  getOverdueFines,
  getFinesGroupedByOrgan,
  getFinesGroupedBySeller,
  getDefermentRate,
  getAlerts,
  getFinesByStatus,
  updateFine,
  updateFineStatus,
  updateFineStage,
  deleteFine,
  // SISV — processos
  getProcessById,
  listProcesses,
  moveProcessStage,
  moveProcessStatus,
  changeProcessSeller,
  changeProcessDepartment,
  finalizeProcess,
  reopenProcess,
  getProcessDashboard,
  batchAssign
};

