'use strict';

const pool = require('../config/db');

const DEFAULT_SETTINGS = Object.freeze({
  stale_after_days: 7,
  due_soon_days: 7,
  aging_bands: [2, 5, 10],
  department_required: false,
});

const VIEW_TYPES = Object.freeze(['processos', 'pendencias']);
const PROCESS_FILTERS = new Set([
  'q', 'stage', 'status', 'seller_id', 'department_id', 'tenant_service_type_id',
  'client_id', 'pending', 'finalized', 'stale_days', 'aging', 'overdue',
  'due_today', 'due_soon', 'missing_documents', 'due_from', 'due_to', 'date_from', 'date_to',
]);
const TASK_FILTERS = new Set([
  'q', 'fine_id', 'assignee_id', 'department_id', 'task_type_id', 'status',
  'priority', 'open', 'overdue', 'due_today', 'due_from', 'due_to',
]);
const SORT_FIELDS = new Set([
  'created_at', 'updated_at', 'last_moved_at', 'client_name', 'stage', 'status',
  'due_date', 'due_at', 'priority',
]);

const clean = (value, max = 200) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const bool = (value) => value === true || value === 'true' || value === '1';

async function getSettings(tenantId) {
  const { rows } = await pool.query(
    `SELECT stale_after_days, due_soon_days, aging_bands, department_required, updated_at
     FROM tenant_operation_settings WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!rows[0]) return { ...DEFAULT_SETTINGS };
  const bands = Array.isArray(rows[0].aging_bands) ? rows[0].aging_bands.map(Number) : DEFAULT_SETTINGS.aging_bands;
  return { ...rows[0], aging_bands: bands };
}

function validateBands(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const values = value.map(Number);
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 365)) return null;
  if (!(values[0] < values[1] && values[1] < values[2])) return null;
  return values;
}

async function updateSettings(tenantId, userId, input) {
  const bands = input.aging_bands === undefined ? undefined : validateBands(input.aging_bands);
  if (input.aging_bands !== undefined && !bands) {
    return { ok: false, error: 'Faixas de aging devem ter tres limites crescentes entre 1 e 365.' };
  }
  const stale = input.stale_after_days === undefined ? null : Number(input.stale_after_days);
  const soon = input.due_soon_days === undefined ? null : Number(input.due_soon_days);
  if (stale !== null && (!Number.isInteger(stale) || stale < 1 || stale > 365)) {
    return { ok: false, error: 'Periodo sem movimentacao invalido.' };
  }
  if (soon !== null && (!Number.isInteger(soon) || soon < 1 || soon > 90)) {
    return { ok: false, error: 'Periodo de prazo proximo invalido.' };
  }
  const { rows } = await pool.query(
    `INSERT INTO tenant_operation_settings (
       tenant_id, stale_after_days, due_soon_days, aging_bands,
       department_required, updated_by, updated_at
     ) VALUES (
       $1, COALESCE($2, 7), COALESCE($3, 7), COALESCE($4::jsonb, '[2,5,10]'::jsonb),
       COALESCE($5, FALSE), $6, NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       stale_after_days = COALESCE($2, tenant_operation_settings.stale_after_days),
       due_soon_days = COALESCE($3, tenant_operation_settings.due_soon_days),
       aging_bands = COALESCE($4::jsonb, tenant_operation_settings.aging_bands),
       department_required = COALESCE($5, tenant_operation_settings.department_required),
       updated_by = $6,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      stale,
      soon,
      bands ? JSON.stringify(bands) : null,
      input.department_required === undefined ? null : Boolean(input.department_required),
      userId || null,
    ]
  );
  return { ok: true, settings: { ...rows[0], aging_bands: rows[0].aging_bands.map(Number) } };
}

function scopeClause(role, userId, processAlias = 'f', taskAlias = 't') {
  const manager = role === 'admin' || role === 'manager';
  return {
    manager,
    process: manager ? { sql: '', params: [] } : { sql: ` AND ${processAlias}.seller_id = $2`, params: [userId] },
    task: manager ? { sql: '', params: [] } : { sql: ` AND ${taskAlias}.assignee_id = $2`, params: [userId] },
  };
}

async function getMyWork(tenantId, userId, role) {
  const settings = await getSettings(tenantId);
  const scope = scopeClause(role, userId);
  const processParams = [tenantId, ...scope.process.params];
  const taskParams = [tenantId, ...scope.task.params];
  const staleCutoff = new Date(Date.now() - settings.stale_after_days * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const next7 = new Date(Date.now() + 7 * 86400000).toISOString();

  const processSelect = `
    SELECT f.id, f.fine_number, f.protocol_number, f.stage, f.status, f.due_date,
           f.seller_id, f.department_id, f.tenant_service_type_id,
           f.last_moved_at, f.updated_at, c.name AS client_name,
           u.name AS seller_name, d.name AS department_name
    FROM fines f
    LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
    LEFT JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
    LEFT JOIN departments d ON d.id = f.department_id AND d.tenant_id = f.tenant_id`;
  const taskSelect = `
    SELECT t.id, t.fine_id, t.title, t.priority, t.status, t.due_at, t.completed_at,
           t.task_type_id, t.assignee_id, t.department_id,
           f.fine_number, f.protocol_number, f.stage AS process_stage,
           f.status AS process_status, c.name AS client_name,
           tt.label AS task_type_label, u.name AS assignee_name,
           d.name AS department_name
    FROM process_tasks t
    JOIN fines f ON f.id = t.fine_id AND f.tenant_id = t.tenant_id
    LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
    LEFT JOIN task_types tt ON tt.id = t.task_type_id AND tt.tenant_id = t.tenant_id
    LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
    LEFT JOIN departments d ON d.id = t.department_id AND d.tenant_id = t.tenant_id`;
  const taskOpen = `t.deleted_at IS NULL AND t.status IN ('aberta','em_andamento','aguardando_terceiro')`;

  const [
    processes,
    openTasks,
    overdueTasks,
    todayTasks,
    nextTasks,
    staleProcesses,
    waitingDocument,
    recentlyCompleted,
  ] = await Promise.all([
    pool.query(
      `${processSelect}
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL${scope.process.sql}
       ORDER BY f.due_date ASC NULLS LAST, COALESCE(f.last_moved_at, f.updated_at) ASC
       LIMIT 20`,
      processParams
    ),
    pool.query(
      `${taskSelect}
       WHERE t.tenant_id = $1 AND ${taskOpen}${scope.task.sql}
       ORDER BY CASE t.priority WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                t.due_at ASC NULLS LAST LIMIT 20`,
      taskParams
    ),
    pool.query(
      `${taskSelect}
       WHERE t.tenant_id = $1 AND ${taskOpen} AND t.due_at < NOW()${scope.task.sql}
       ORDER BY t.due_at ASC LIMIT 20`,
      taskParams
    ),
    pool.query(
      `${taskSelect}
       WHERE t.tenant_id = $1 AND ${taskOpen}
         AND CAST(t.due_at AS DATE) = '${today}'${scope.task.sql}
       ORDER BY t.due_at ASC LIMIT 20`,
      taskParams
    ),
    pool.query(
      `${taskSelect}
       WHERE t.tenant_id = $1 AND ${taskOpen}
         AND t.due_at > NOW() AND t.due_at <= '${next7}'${scope.task.sql}
       ORDER BY t.due_at ASC LIMIT 20`,
      taskParams
    ),
    pool.query(
      `${processSelect}
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
         AND COALESCE(f.last_moved_at, f.updated_at) < '${staleCutoff}'${scope.process.sql}
       ORDER BY COALESCE(f.last_moved_at, f.updated_at) ASC LIMIT 20`,
      processParams
    ),
    pool.query(
      `${processSelect}
       LEFT JOIN process_statuses ps ON ps.tenant_id = f.tenant_id AND ps.code = f.status
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
         AND (UPPER(f.status) LIKE '%DOCUMENT%' OR ps.is_pending = TRUE)${scope.process.sql}
       ORDER BY COALESCE(f.last_moved_at, f.updated_at) ASC LIMIT 20`,
      processParams
    ),
    pool.query(
      `${taskSelect}
       WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.status = 'concluida'${scope.task.sql}
       ORDER BY t.completed_at DESC NULLS LAST LIMIT 20`,
      taskParams
    ),
  ]);

  const sections = {
    processes: processes.rows,
    openTasks: openTasks.rows,
    overdueTasks: overdueTasks.rows,
    todayTasks: todayTasks.rows,
    nextTasks: nextTasks.rows,
    staleProcesses: staleProcesses.rows,
    waitingDocument: waitingDocument.rows,
    recentlyCompleted: recentlyCompleted.rows,
  };
  return {
    scope: scope.manager ? 'tenant' : 'user',
    settings,
    counts: Object.fromEntries(Object.entries(sections).map(([key, rows]) => [key, rows.length])),
    ...sections,
  };
}

async function missingDocumentCount(tenantId) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT f.id)::int AS count
     FROM fines f
     JOIN service_type_documents std
       ON std.tenant_id = f.tenant_id
      AND std.tenant_service_type_id = f.tenant_service_type_id
      AND std.required = TRUE
     LEFT JOIN fine_documents fd
       ON fd.tenant_id = f.tenant_id
      AND fd.fine_id = f.id
      AND fd.category_id = std.category_id
      AND COALESCE(fd.status, 'ativo') = 'ativo'
      AND fd.removed_at IS NULL
     WHERE f.tenant_id = $1 AND f.finalized_at IS NULL AND fd.id IS NULL`,
    [tenantId]
  );
  return rows[0]?.count || 0;
}

async function getQualityIssues(tenantId, { limit = 100 } = {}) {
  const settings = await getSettings(tenantId);
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const checks = [
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'sem_responsavel' AS issue,
              'Processo sem responsavel' AS message, f.fine_number AS reference
       FROM fines f WHERE f.tenant_id = $1 AND f.finalized_at IS NULL AND f.seller_id IS NULL LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'sem_etapa' AS issue,
              'Processo sem etapa' AS message, f.fine_number AS reference
       FROM fines f WHERE f.tenant_id = $1 AND (f.stage IS NULL OR f.stage = '') LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'sem_status' AS issue,
              'Processo sem status' AS message, f.fine_number AS reference
       FROM fines f WHERE f.tenant_id = $1 AND (f.status IS NULL OR f.status = '') LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'sem_servico' AS issue,
              'Processo sem tipo de servico' AS message, f.fine_number AS reference
       FROM fines f WHERE f.tenant_id = $1 AND f.tenant_service_type_id IS NULL LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'prazo_anterior_abertura' AS issue,
              'Prazo anterior a abertura' AS message, f.fine_number AS reference
       FROM fines f
       WHERE f.tenant_id = $1 AND f.due_date IS NOT NULL
         AND f.due_date < CAST(f.created_at AS DATE) LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT c.id AS entity_id, 'cliente' AS entity_type, 'cliente_sem_documento_principal' AS issue,
              'Cliente sem CPF/CNPJ ou CNH' AS message, c.name AS reference
       FROM clients c
       JOIN fines cf ON cf.tenant_id = c.tenant_id AND cf.client_id = c.id
       WHERE c.tenant_id = $1
         AND TRIM(COALESCE(c.cpf, '')) = ''
         AND TRIM(COALESCE(c.cnh, '')) = ''
       GROUP BY c.id, c.name
       LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'finalizado_sem_data' AS issue,
              'Processo marcado como finalizado sem data de finalizacao' AS message,
              f.fine_number AS reference
       FROM fines f
       LEFT JOIN process_stages ps ON ps.tenant_id = f.tenant_id AND ps.code = f.stage
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
         AND (COALESCE(ps.is_final, FALSE) = TRUE
              OR UPPER(COALESCE(f.status, '')) IN ('FINALIZADO','CONCLUIDO'))
       LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT fd.id AS entity_id, f.id AS related_process_id,
              'documento' AS entity_type, 'documento_tenant_incorreto' AS issue,
              'Documento associado a processo de outro tenant' AS message,
              COALESCE(fd.name, fd.original_name, fd.id::text) AS reference
       FROM fine_documents fd
       JOIN fines f ON f.id = fd.fine_id
       WHERE fd.tenant_id = $1 AND f.tenant_id <> fd.tenant_id
       LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'responsavel_inativo' AS issue,
              'Responsavel inativo atribuido' AS message, f.fine_number AS reference
       FROM fines f JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND COALESCE(u.is_active, TRUE) = FALSE
         AND f.finalized_at IS NULL LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT t.id AS entity_id, t.fine_id AS related_process_id,
              'pendencia' AS entity_type, 'conclusao_sem_data' AS issue,
              'Pendencia concluida sem data de conclusao' AS message, t.title AS reference
       FROM process_tasks t
       WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
         AND t.status = 'concluida' AND t.completed_at IS NULL LIMIT $2`,
      [tenantId, max]
    ),
    pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'possivel_duplicidade' AS issue,
              'Possivel processo duplicado para o cliente e servico' AS message,
              f.fine_number AS reference
       FROM fines f
       JOIN fines x ON x.tenant_id = f.tenant_id
                   AND x.client_id = f.client_id
                   AND x.tenant_service_type_id = f.tenant_service_type_id
                   AND x.id <> f.id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL AND x.finalized_at IS NULL
       LIMIT $2`,
      [tenantId, max]
    ),
  ];
  if (settings.department_required) {
    checks.push(pool.query(
      `SELECT f.id AS entity_id, 'processo' AS entity_type, 'sem_setor' AS issue,
              'Processo sem setor obrigatorio' AS message, f.fine_number AS reference
       FROM fines f
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL AND f.department_id IS NULL LIMIT $2`,
      [tenantId, max]
    ));
  }
  const results = await Promise.all(checks);
  const seen = new Set();
  const issues = [];
  for (const result of results) {
    for (const row of result.rows) {
      const key = `${row.entity_id}:${row.issue}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push(row);
      }
    }
  }
  return {
    total: issues.length,
    byType: issues.reduce((acc, item) => {
      acc[item.issue] = (acc[item.issue] || 0) + 1;
      return acc;
    }, {}),
    rows: issues.slice(0, max),
  };
}

async function getAttention(tenantId) {
  const settings = await getSettings(tenantId);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + settings.due_soon_days * 86400000).toISOString().slice(0, 10);
  const stale = new Date(Date.now() - settings.stale_after_days * 86400000).toISOString();
  const [counts, taskCounts, missingDocuments, quality, agingSeller, agingDepartment] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(CASE WHEN f.finalized_at IS NULL AND f.due_date < $2 THEN 1 END)::int AS process_overdue,
         COUNT(CASE WHEN f.finalized_at IS NULL AND f.due_date = $2 THEN 1 END)::int AS process_due_today,
         COUNT(CASE WHEN f.finalized_at IS NULL AND f.due_date > $2 AND f.due_date <= $3 THEN 1 END)::int AS process_due_soon,
         COUNT(CASE WHEN f.finalized_at IS NULL AND f.seller_id IS NULL THEN 1 END)::int AS unassigned,
         COUNT(CASE WHEN f.finalized_at IS NULL AND f.department_id IS NULL THEN 1 END)::int AS no_department,
         COUNT(CASE WHEN f.finalized_at IS NULL AND COALESCE(f.last_moved_at, f.updated_at) < $4 THEN 1 END)::int AS stale,
         COUNT(CASE WHEN f.client_id IS NULL OR f.tenant_service_type_id IS NULL
                         OR f.stage IS NULL OR f.status IS NULL THEN 1 END)::int AS incomplete
       FROM fines f WHERE f.tenant_id = $1`,
      [tenantId, today, soon, stale]
    ),
    pool.query(
      `SELECT
         COUNT(CASE WHEN t.status IN ('aberta','em_andamento','aguardando_terceiro')
                         AND t.due_at < NOW() THEN 1 END)::int AS task_overdue,
         COUNT(CASE WHEN t.status IN ('aberta','em_andamento','aguardando_terceiro')
                         AND t.priority = 'critica' THEN 1 END)::int AS task_critical
       FROM process_tasks t WHERE t.tenant_id = $1 AND t.deleted_at IS NULL`,
      [tenantId]
    ),
    missingDocumentCount(tenantId),
    getQualityIssues(tenantId, { limit: 500 }),
    pool.query(
      `SELECT f.seller_id, COALESCE(u.name, 'Sem responsavel') AS label, COUNT(*)::int AS count
       FROM fines f LEFT JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
         AND COALESCE(f.last_moved_at, f.updated_at) < $2
       GROUP BY f.seller_id, u.name ORDER BY count DESC`,
      [tenantId, stale]
    ),
    pool.query(
      `SELECT f.department_id, COALESCE(d.name, 'Sem setor') AS label, COUNT(*)::int AS count
       FROM fines f LEFT JOIN departments d ON d.id = f.department_id AND d.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
         AND COALESCE(f.last_moved_at, f.updated_at) < $2
       GROUP BY f.department_id, d.name ORDER BY count DESC`,
      [tenantId, stale]
    ),
  ]);
  const c = { ...counts.rows[0], ...taskCounts.rows[0], missing_documents: missingDocuments, quality: quality.total };
  const cards = [
    ['process_overdue', 'Processos com prazo vencido', 'processos', { overdue: 'true' }],
    ['process_due_today', 'Processos vencendo hoje', 'processos', { due_today: 'true' }],
    ['process_due_soon', `Processos vencendo em ${settings.due_soon_days} dias`, 'processos', { due_soon: String(settings.due_soon_days) }],
    ['unassigned', 'Processos sem responsavel', 'processos', { seller_id: 'none' }],
    ['no_department', 'Processos sem setor', 'processos', { department_id: 'none' }],
    ['stale', 'Processos sem movimentacao', 'processos', { stale_days: String(settings.stale_after_days) }],
    ['missing_documents', 'Documentos obrigatorios faltantes', 'processos', { missing_documents: 'true' }],
    ['task_overdue', 'Pendencias vencidas', 'pendencias', { overdue: 'true' }],
    ['task_critical', 'Pendencias criticas', 'pendencias', { priority: 'critica', open: 'true' }],
    ['incomplete', 'Processos com dados incompletos', 'qualidade', { incomplete: 'true' }],
    ['quality', 'Inconsistencias identificadas', 'qualidade', {}],
  ].map(([key, label, target, filters]) => ({
    key,
    label,
    count: Number(c[key]) || 0,
    target,
    filters,
    href: target === 'processos'
      ? `/dashboard?module=multas&tab=processos&${new URLSearchParams(filters)}`
      : target === 'pendencias'
        ? `/dashboard?module=multas&tab=meu-trabalho&view=tasks&${new URLSearchParams(filters)}`
        : '/dashboard?module=multas&tab=qualidade',
  }));
  return {
    settings,
    cards,
    staleBySeller: agingSeller.rows,
    staleByDepartment: agingDepartment.rows,
    quality: { total: quality.total, byType: quality.byType },
  };
}

function agingLabel(days, bands) {
  if (days <= bands[0]) return `ate_${bands[0]}`;
  if (days <= bands[1]) return `${bands[0] + 1}_a_${bands[1]}`;
  if (days <= bands[2]) return `${bands[1] + 1}_a_${bands[2]}`;
  return `acima_${bands[2]}`;
}

async function getDashboardV2(tenantId, filters = {}) {
  const settings = await getSettings(tenantId);
  const dateFrom = filters.date_from || new Date(Date.now() - 30 * 86400000).toISOString();
  const dateTo = filters.date_to || new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + settings.due_soon_days * 86400000).toISOString().slice(0, 10);
  const stale = new Date(Date.now() - settings.stale_after_days * 86400000).toISOString();
  const [overview, byStage, byStatus, byDepartment, bySeller, byService, movements, finalizedUsers, taskUsers, durations, workload, agingRows, missingDocuments] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(CASE WHEN finalized_at IS NULL THEN 1 END)::int AS in_progress,
         COUNT(CASE WHEN finalized_at BETWEEN $2 AND $3 THEN 1 END)::int AS finalized_period,
         COUNT(CASE WHEN finalized_at IS NULL AND due_date < $4 THEN 1 END)::int AS overdue,
         COUNT(CASE WHEN finalized_at IS NULL AND due_date >= $4 AND due_date <= $5 THEN 1 END)::int AS due_soon,
         COUNT(CASE WHEN finalized_at IS NULL AND seller_id IS NULL THEN 1 END)::int AS unassigned,
         COUNT(CASE WHEN finalized_at IS NULL AND COALESCE(last_moved_at, updated_at) < $6 THEN 1 END)::int AS stale
       FROM fines WHERE tenant_id = $1`,
      [tenantId, dateFrom, dateTo, today, soon, stale]
    ),
    pool.query(
      `SELECT f.stage AS code, COALESCE(s.label, f.stage) AS label, s.color, COUNT(*)::int AS count
       FROM fines f LEFT JOIN process_stages s ON s.tenant_id = f.tenant_id AND s.code = f.stage
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.stage, s.label, s.color ORDER BY count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT f.status AS code, COALESCE(s.label, f.status) AS label, s.color, COUNT(*)::int AS count
       FROM fines f LEFT JOIN process_statuses s ON s.tenant_id = f.tenant_id AND s.code = f.status
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.status, s.label, s.color ORDER BY count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT f.department_id AS id, COALESCE(d.name, 'Sem setor') AS label, d.color, COUNT(*)::int AS count
       FROM fines f LEFT JOIN departments d ON d.id = f.department_id AND d.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.department_id, d.name, d.color ORDER BY count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT f.seller_id AS id, COALESCE(u.name, 'Sem responsavel') AS label, COUNT(*)::int AS count
       FROM fines f LEFT JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.seller_id, u.name ORDER BY count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT f.tenant_service_type_id AS id, COALESCE(s.label, 'Sem tipo') AS label, s.color, COUNT(*)::int AS count
       FROM fines f LEFT JOIN tenant_service_types s ON s.id = f.tenant_service_type_id AND s.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at IS NULL
       GROUP BY f.tenant_service_type_id, s.label, s.color ORDER BY count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM fine_logs
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3`,
      [tenantId, dateFrom, dateTo]
    ),
    pool.query(
      `SELECT f.seller_id AS user_id, COALESCE(u.name, 'Sem responsavel') AS label, COUNT(*)::int AS count
       FROM fines f LEFT JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND f.finalized_at BETWEEN $2 AND $3
       GROUP BY f.seller_id, u.name ORDER BY count DESC`,
      [tenantId, dateFrom, dateTo]
    ),
    pool.query(
      `SELECT t.completed_by AS user_id, COALESCE(u.name, 'Usuario inativo') AS label, COUNT(*)::int AS count
       FROM process_tasks t LEFT JOIN users u ON u.id = t.completed_by AND u.tenant_id = t.tenant_id
       WHERE t.tenant_id = $1 AND t.status = 'concluida' AND t.completed_at BETWEEN $2 AND $3
       GROUP BY t.completed_by, u.name ORDER BY count DESC`,
      [tenantId, dateFrom, dateTo]
    ),
    pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (finalized_at - created_at)) / 86400.0) AS avg_completion_days
       FROM fines WHERE tenant_id = $1 AND finalized_at BETWEEN $2 AND $3`,
      [tenantId, dateFrom, dateTo]
    ),
    pool.query(
      `SELECT u.id AS user_id, u.name AS label,
              COALESCE(f.process_count, 0)::int AS process_count,
              COALESCE(t.task_count, 0)::int AS task_count
       FROM users u
       LEFT JOIN (
         SELECT tenant_id, seller_id, COUNT(*)::int AS process_count
         FROM fines
         WHERE finalized_at IS NULL
         GROUP BY tenant_id, seller_id
       ) f ON f.tenant_id = u.tenant_id AND f.seller_id = u.id
       LEFT JOIN (
         SELECT tenant_id, assignee_id, COUNT(*)::int AS task_count
         FROM process_tasks
         WHERE deleted_at IS NULL
           AND status IN ('aberta','em_andamento','aguardando_terceiro')
         GROUP BY tenant_id, assignee_id
       ) t ON t.tenant_id = u.tenant_id AND t.assignee_id = u.id
       WHERE u.tenant_id = $1 AND COALESCE(u.is_active, TRUE) = TRUE
       ORDER BY process_count DESC, task_count DESC`,
      [tenantId]
    ),
    pool.query(
      `SELECT f.id, COALESCE(f.last_moved_at, f.updated_at) AS moved_at
       FROM fines f WHERE f.tenant_id = $1 AND f.finalized_at IS NULL`,
      [tenantId]
    ),
    missingDocumentCount(tenantId),
  ]);
  const agingCounts = {};
  for (const row of agingRows.rows) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(row.moved_at).getTime()) / 86400000));
    const key = agingLabel(days, settings.aging_bands);
    agingCounts[key] = (agingCounts[key] || 0) + 1;
  }
  const taskOverview = await pool.query(
    `SELECT
       COUNT(CASE WHEN status IN ('aberta','em_andamento','aguardando_terceiro') THEN 1 END)::int AS task_open,
       COUNT(CASE WHEN status IN ('aberta','em_andamento','aguardando_terceiro') AND due_at < NOW() THEN 1 END)::int AS task_overdue,
       COUNT(CASE WHEN status IN ('aberta','em_andamento','aguardando_terceiro') AND priority = 'critica' THEN 1 END)::int AS task_critical
     FROM process_tasks WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );
  return {
    period: { date_from: dateFrom, date_to: dateTo },
    settings,
    overview: { ...overview.rows[0], ...taskOverview.rows[0], missing_documents: missingDocuments },
    operation: {
      byStage: byStage.rows,
      byStatus: byStatus.rows,
      byDepartment: byDepartment.rows,
      bySeller: bySeller.rows,
      byService: byService.rows,
      aging: agingCounts,
    },
    productivity: {
      movements: movements.rows[0]?.count || 0,
      finalizedByUser: finalizedUsers.rows,
      tasksCompletedByUser: taskUsers.rows,
      averageCompletionDays: Number(durations.rows[0]?.avg_completion_days || 0),
      workload: workload.rows,
    },
    attention: {
      unassigned: overview.rows[0]?.unassigned || 0,
      stale: overview.rows[0]?.stale || 0,
      overdue: overview.rows[0]?.overdue || 0,
      taskCritical: taskOverview.rows[0]?.task_critical || 0,
      missingDocuments,
    },
  };
}

function validateViewPayload(input, role) {
  const name = clean(input.name, 120);
  const type = VIEW_TYPES.includes(input.view_type) ? input.view_type : 'processos';
  if (!name) return { ok: false, error: 'Nome e obrigatorio.' };
  if (!input.filters || typeof input.filters !== 'object' || Array.isArray(input.filters)) {
    return { ok: false, error: 'Filtros invalidos.' };
  }
  const allowed = type === 'processos' ? PROCESS_FILTERS : TASK_FILTERS;
  const filters = {};
  for (const [key, value] of Object.entries(input.filters)) {
    if (!allowed.has(key)) return { ok: false, error: `Filtro nao permitido: ${key}.` };
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
      return { ok: false, error: `Valor invalido para ${key}.` };
    }
    filters[key] = typeof value === 'string' ? clean(value, 200) : value;
  }
  const sort = {};
  if (input.sort_config && typeof input.sort_config === 'object' && !Array.isArray(input.sort_config)) {
    if (input.sort_config.by && !SORT_FIELDS.has(input.sort_config.by)) {
      return { ok: false, error: 'Ordenacao nao permitida.' };
    }
    if (input.sort_config.by) sort.by = input.sort_config.by;
    if (input.sort_config.dir) sort.dir = input.sort_config.dir === 'asc' ? 'asc' : 'desc';
  }
  const shared = Boolean(input.shared_tenant);
  if (shared && role !== 'admin' && role !== 'manager') {
    return { ok: false, status: 403, error: 'Sem permissao para compartilhar com o tenant.' };
  }
  return {
    ok: true,
    value: {
      name,
      view_type: type,
      filters,
      sort_config: sort,
      is_default: Boolean(input.is_default),
      is_favorite: Boolean(input.is_favorite),
      shared_tenant: shared,
    },
  };
}

async function listViews(tenantId, userId, type = 'processos') {
  const safeType = VIEW_TYPES.includes(type) ? type : 'processos';
  const { rows } = await pool.query(
    `SELECT sv.*, u.name AS owner_name, (sv.user_id = $2) AS owned
     FROM saved_views sv
     LEFT JOIN users u ON u.id = sv.user_id AND u.tenant_id = sv.tenant_id
     WHERE sv.tenant_id = $1 AND sv.view_type = $3
       AND (sv.user_id = $2 OR sv.shared_tenant = TRUE)
     ORDER BY (sv.user_id = $2) DESC, sv.is_default DESC, sv.is_favorite DESC, sv.name`,
    [tenantId, userId, safeType]
  );
  return rows;
}

async function createView(tenantId, userId, role, input) {
  const validation = validateViewPayload(input, role);
  if (!validation.ok) return validation;
  const v = validation.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (v.is_default) {
      await client.query(
        'UPDATE saved_views SET is_default = FALSE WHERE tenant_id = $1 AND user_id = $2 AND view_type = $3',
        [tenantId, userId, v.view_type]
      );
    }
    const { rows } = await client.query(
      `INSERT INTO saved_views (
         tenant_id, user_id, name, view_type, filters, sort_config,
         is_default, is_favorite, shared_tenant
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
       RETURNING *`,
      [tenantId, userId, v.name, v.view_type, JSON.stringify(v.filters), JSON.stringify(v.sort_config), v.is_default, v.is_favorite, v.shared_tenant]
    );
    await client.query('COMMIT');
    return { ok: true, view: rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    if (/duplicate|unique/i.test(error.message || '')) return { ok: false, status: 409, error: 'Ja existe uma visualizacao com esse nome.' };
    throw error;
  } finally {
    client.release();
  }
}

async function updateView(tenantId, userId, role, id, input) {
  const current = await pool.query(
    'SELECT * FROM saved_views WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
    [id, tenantId, userId]
  );
  if (!current.rows[0]) return { ok: false, status: 404, error: 'Visualizacao nao encontrada.' };
  const merged = {
    ...current.rows[0],
    ...input,
    filters: input.filters === undefined ? current.rows[0].filters : input.filters,
    sort_config: input.sort_config === undefined ? current.rows[0].sort_config : input.sort_config,
  };
  const validation = validateViewPayload(merged, role);
  if (!validation.ok) return validation;
  const v = validation.value;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (v.is_default) {
      await client.query(
        'UPDATE saved_views SET is_default = FALSE WHERE tenant_id = $1 AND user_id = $2 AND view_type = $3',
        [tenantId, userId, v.view_type]
      );
    }
    const { rows } = await client.query(
      `UPDATE saved_views SET
         name=$1, filters=$2::jsonb, sort_config=$3::jsonb,
         is_default=$4, is_favorite=$5, shared_tenant=$6, updated_at=NOW()
       WHERE id=$7 AND tenant_id=$8 AND user_id=$9 RETURNING *`,
      [v.name, JSON.stringify(v.filters), JSON.stringify(v.sort_config), v.is_default, v.is_favorite, v.shared_tenant, id, tenantId, userId]
    );
    await client.query('COMMIT');
    return { ok: true, view: rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function deleteView(tenantId, userId, id) {
  const { rows } = await pool.query(
    'DELETE FROM saved_views WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id',
    [id, tenantId, userId]
  );
  return rows[0];
}

async function globalSearch(tenantId, query, { limit = 20 } = {}) {
  const q = clean(query, 100);
  if (q.length < 2) return [];
  const each = Math.max(2, Math.min(Math.ceil((Number(limit) || 20) / 3), 10));
  const term = `%${q}%`;
  const [clients, processes, documents] = await Promise.all([
    pool.query(
      `SELECT id, 'cliente' AS type, name AS title,
              COALESCE(cpf, cnh, email, '') AS subtitle,
              '/dashboard?module=multas&tab=clients&client=' || id::text AS href
       FROM clients
       WHERE tenant_id = $1 AND (name ILIKE $2 OR cpf ILIKE $2 OR cnh ILIKE $2 OR email ILIKE $2)
       ORDER BY name LIMIT $3`,
      [tenantId, term, each]
    ),
    pool.query(
      `SELECT f.id, 'processo' AS type,
              COALESCE(f.fine_number, f.protocol_number, 'Processo') AS title,
              COALESCE(c.name, '') || CASE WHEN st.label IS NULL THEN '' ELSE ' - ' || st.label END AS subtitle,
              '/dashboard?module=multas&tab=processos&process=' || f.id::text AS href
       FROM fines f
       LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
       LEFT JOIN tenant_service_types st ON st.id = f.tenant_service_type_id AND st.tenant_id = f.tenant_id
       LEFT JOIN users u ON u.id = f.seller_id AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = $1 AND (
         f.fine_number ILIKE $2 OR f.protocol_number ILIKE $2 OR c.name ILIKE $2
         OR c.cpf ILIKE $2 OR c.cnh ILIKE $2 OR st.label ILIKE $2 OR u.name ILIKE $2
       )
       ORDER BY COALESCE(f.last_moved_at, f.updated_at) DESC LIMIT $3`,
      [tenantId, term, each]
    ),
    pool.query(
      `SELECT fd.id, 'documento' AS type, COALESCE(fd.name, fd.original_name, 'Documento') AS title,
              COALESCE(f.fine_number, c.name, '') AS subtitle,
              '/dashboard?module=multas&tab=processos&process=' || f.id::text AS href
       FROM fine_documents fd
       JOIN fines f ON f.id = fd.fine_id AND f.tenant_id = fd.tenant_id
       LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
       WHERE fd.tenant_id = $1 AND COALESCE(fd.status, 'ativo') <> 'removido'
         AND (fd.name ILIKE $2 OR fd.original_name ILIKE $2)
       ORDER BY fd.created_at DESC LIMIT $3`,
      [tenantId, term, each]
    ),
  ]);
  return [...clients.rows, ...processes.rows, ...documents.rows].slice(0, Math.min(Number(limit) || 20, 30));
}

async function listAudit(tenantId, filters = {}) {
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 50, 1), 200);
  const activityClauses = ['al.tenant_id = $1'];
  const fineClauses = ['fl.tenant_id = $1'];
  const aParams = [tenantId];
  const fParams = [tenantId];
  const add = (clauses, params, sql, value) => {
    params.push(value);
    clauses.push(sql.replace('$$', `$${params.length}`));
  };
  if (filters.user_id) {
    add(activityClauses, aParams, 'al.user_id = $$', filters.user_id);
    add(fineClauses, fParams, 'fl.user_id = $$', filters.user_id);
  }
  if (filters.action) {
    add(activityClauses, aParams, 'al.action = $$', clean(filters.action, 60));
    add(fineClauses, fParams, 'fl.action = $$', clean(filters.action, 60));
  }
  if (filters.entity) add(activityClauses, aParams, 'al.entity = $$', clean(filters.entity, 60));
  if (filters.process_id) {
    aParams.push(filters.process_id);
    activityClauses.push(`(al.entity_id = $${aParams.length} OR al.details->>'fine_id' = $${aParams.length}::text)`);
    add(fineClauses, fParams, 'fl.fine_id = $$', filters.process_id);
  }
  if (filters.client_id) {
    aParams.push(filters.client_id);
    activityClauses.push(`(
      al.entity_id = $${aParams.length}
      OR al.details->>'client_id' = $${aParams.length}::text
    )`);
    add(fineClauses, fParams, 'f.client_id = $$', filters.client_id);
  }
  if (filters.department_id) {
    aParams.push(filters.department_id);
    activityClauses.push(`al.details->>'department_id' = $${aParams.length}::text`);
    add(fineClauses, fParams, 'f.department_id = $$', filters.department_id);
  }
  if (filters.date_from) {
    add(activityClauses, aParams, 'al.created_at >= $$', filters.date_from);
    add(fineClauses, fParams, 'fl.created_at >= $$', filters.date_from);
  }
  if (filters.date_to) {
    add(activityClauses, aParams, 'al.created_at <= $$', filters.date_to);
    add(fineClauses, fParams, 'fl.created_at <= $$', filters.date_to);
  }
  const [activity, fine] = await Promise.all([
    pool.query(
      `SELECT al.id, al.user_id, u.name AS user_name, al.entity, al.entity_id,
              al.entity_name, al.action, al.details, al.created_at, 'global' AS source
       FROM activity_logs al
       LEFT JOIN users u ON u.id = al.user_id AND u.tenant_id = al.tenant_id
       WHERE ${activityClauses.join(' AND ')}
       ORDER BY al.created_at DESC LIMIT ${limit}`,
      aParams
    ),
    pool.query(
      `SELECT fl.id, fl.user_id, u.name AS user_name, 'processo' AS entity,
              fl.fine_id AS entity_id, COALESCE(f.fine_number, c.name) AS entity_name,
              fl.action, jsonb_build_object(
                'field', fl.field_name, 'old_value', fl.old_value, 'new_value', fl.new_value
              ) AS details, fl.created_at, 'processo' AS source
       FROM fine_logs fl
       JOIN fines f ON f.id = fl.fine_id AND f.tenant_id = fl.tenant_id
       LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
       LEFT JOIN users u ON u.id = fl.user_id AND u.tenant_id = fl.tenant_id
       WHERE ${fineClauses.join(' AND ')}
       ORDER BY fl.created_at DESC LIMIT ${limit}`,
      fParams
    ),
  ]);
  const dedupe = new Set();
  const rows = [...activity.rows, ...fine.rows]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .filter((item) => {
      const key = `${item.source}:${item.id}`;
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    })
    .slice(0, limit)
    .map((item) => ({ ...item, details: redactAuditDetails(item.details) }));
  return { rows, total: rows.length, limit };
}

function redactAuditDetails(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditDetails(item, depth + 1));
  if (typeof value !== 'object') return value;
  const blocked = /password|senha|token|secret|authorization|cookie|file_content|document_content|password_hash/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .map(([key, item]) => [key, redactAuditDetails(item, depth + 1)]));
}

async function reportData(tenantId, type, filters = {}) {
  const allowed = new Set([
    'processos-periodo', 'processos-etapa', 'processos-status', 'processos-responsavel',
    'processos-setor', 'processos-servico', 'prazos-vencidos', 'documentos-pendentes',
    'pendencias', 'produtividade', 'tempo-conclusao',
  ]);
  if (!allowed.has(type)) return { ok: false, error: 'Relatorio invalido.' };
  const dateFrom = filters.date_from || new Date(Date.now() - 30 * 86400000).toISOString();
  const dateTo = filters.date_to || new Date().toISOString();
  let result;
  if (type === 'processos-periodo') {
    result = await pool.query(
      `SELECT f.id, f.fine_number, c.name AS cliente, st.label AS servico, f.stage AS etapa,
              f.status, u.name AS responsavel, d.name AS setor, f.created_at AS abertura,
              f.due_date AS prazo, f.finalized_at AS conclusao
       FROM fines f
       LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       LEFT JOIN tenant_service_types st ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id
       LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
       LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
       WHERE f.tenant_id=$1 AND f.created_at BETWEEN $2 AND $3
       ORDER BY f.created_at DESC LIMIT 1000`,
      [tenantId, dateFrom, dateTo]
    );
  } else if (type.startsWith('processos-') && type !== 'processos-periodo') {
    const maps = {
      'processos-etapa': ['f.stage', 'COALESCE(ps.label, f.stage)', 'LEFT JOIN process_stages ps ON ps.tenant_id=f.tenant_id AND ps.code=f.stage'],
      'processos-status': ['f.status', 'COALESCE(ps.label, f.status)', 'LEFT JOIN process_statuses ps ON ps.tenant_id=f.tenant_id AND ps.code=f.status'],
      'processos-responsavel': ['f.seller_id', `COALESCE(u.name, 'Sem responsavel')`, 'LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id'],
      'processos-setor': ['f.department_id', `COALESCE(d.name, 'Sem setor')`, 'LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id'],
      'processos-servico': ['f.tenant_service_type_id', `COALESCE(st.label, 'Sem tipo')`, 'LEFT JOIN tenant_service_types st ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id'],
    };
    const [group, label, join] = maps[type];
    result = await pool.query(
      `SELECT ${group} AS id, ${label} AS grupo, COUNT(*)::int AS total,
              COUNT(CASE WHEN f.finalized_at IS NULL THEN 1 END)::int AS em_andamento,
              COUNT(CASE WHEN f.finalized_at BETWEEN $2 AND $3 THEN 1 END)::int AS finalizados
       FROM fines f ${join}
       WHERE f.tenant_id=$1 GROUP BY ${group}, ${label} ORDER BY total DESC`,
      [tenantId, dateFrom, dateTo]
    );
  } else if (type === 'prazos-vencidos') {
    result = await pool.query(
      `SELECT f.id, f.fine_number, c.name AS cliente, f.due_date AS prazo,
              u.name AS responsavel, d.name AS setor
       FROM fines f
       LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
       LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
       WHERE f.tenant_id=$1 AND f.finalized_at IS NULL AND f.due_date < CURRENT_DATE
       ORDER BY f.due_date LIMIT 1000`,
      [tenantId]
    );
  } else if (type === 'documentos-pendentes') {
    result = await pool.query(
      `SELECT f.id, f.fine_number, c.name AS cliente, dc.name AS documento
       FROM fines f
       JOIN service_type_documents std ON std.tenant_id=f.tenant_id
         AND std.tenant_service_type_id=f.tenant_service_type_id AND std.required=TRUE
       JOIN document_categories dc ON dc.id=std.category_id AND dc.tenant_id=std.tenant_id
       LEFT JOIN fine_documents fd ON fd.tenant_id=f.tenant_id AND fd.fine_id=f.id
         AND fd.category_id=std.category_id AND COALESCE(fd.status,'ativo')='ativo' AND fd.removed_at IS NULL
       LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       WHERE f.tenant_id=$1 AND f.finalized_at IS NULL AND fd.id IS NULL
       ORDER BY c.name, dc.name LIMIT 1000`,
      [tenantId]
    );
  } else if (type === 'pendencias') {
    result = await pool.query(
      `SELECT t.id, t.title AS pendencia, t.priority AS prioridade, t.status AS situacao,
              t.due_at AS prazo, f.fine_number AS processo, c.name AS cliente,
              u.name AS responsavel, t.completed_at AS conclusao
       FROM process_tasks t
       JOIN fines f ON f.id=t.fine_id AND f.tenant_id=t.tenant_id
       LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       LEFT JOIN users u ON u.id=t.assignee_id AND u.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.deleted_at IS NULL AND t.created_at BETWEEN $2 AND $3
       ORDER BY t.created_at DESC LIMIT 1000`,
      [tenantId, dateFrom, dateTo]
    );
  } else if (type === 'produtividade') {
    result = await pool.query(
      `SELECT u.id, u.name AS usuario,
              COUNT(DISTINCT CASE WHEN f.finalized_at BETWEEN $2 AND $3 THEN f.id END)::int AS processos_finalizados,
              COUNT(DISTINCT CASE WHEN t.completed_at BETWEEN $2 AND $3 THEN t.id END)::int AS pendencias_concluidas,
              COUNT(DISTINCT CASE WHEN fl.created_at BETWEEN $2 AND $3 THEN fl.id END)::int AS movimentacoes
       FROM users u
       LEFT JOIN fines f ON f.tenant_id=u.tenant_id AND f.seller_id=u.id
       LEFT JOIN process_tasks t ON t.tenant_id=u.tenant_id AND t.completed_by=u.id
       LEFT JOIN fine_logs fl ON fl.tenant_id=u.tenant_id AND fl.user_id=u.id
       WHERE u.tenant_id=$1 GROUP BY u.id,u.name ORDER BY processos_finalizados DESC, pendencias_concluidas DESC`,
      [tenantId, dateFrom, dateTo]
    );
  } else {
    result = await pool.query(
      `SELECT COUNT(*)::int AS processos_concluidos,
              AVG(EXTRACT(EPOCH FROM (finalized_at-created_at))/86400.0) AS media_dias
       FROM fines WHERE tenant_id=$1 AND finalized_at BETWEEN $2 AND $3`,
      [tenantId, dateFrom, dateTo]
    );
  }
  return { ok: true, type, period: { date_from: dateFrom, date_to: dateTo }, rows: result.rows };
}

module.exports = {
  DEFAULT_SETTINGS,
  VIEW_TYPES,
  PROCESS_FILTERS,
  TASK_FILTERS,
  SORT_FIELDS,
  clean,
  bool,
  getSettings,
  updateSettings,
  getMyWork,
  missingDocumentCount,
  getQualityIssues,
  getAttention,
  agingLabel,
  getDashboardV2,
  validateViewPayload,
  listViews,
  createView,
  updateView,
  deleteView,
  globalSearch,
  redactAuditDetails,
  listAudit,
  reportData,
};
