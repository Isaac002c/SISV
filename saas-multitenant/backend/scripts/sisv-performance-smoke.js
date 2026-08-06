'use strict';

// Smoke de performance local e reproduzível. Usa somente dados sintéticos em
// pg-mem; serve para comparar regressões de formato de consulta, paginação e
// cardinalidade. Não substitui benchmark no PostgreSQL da infraestrutura alvo.
const { performance } = require('node:perf_hooks');
const { newDb } = require('pg-mem');

const TENANT = 'perf-tenant';
const CLIENTS = 1_000;
const PROCESSES = 5_000;
const MOVEMENTS = 10_000;
const DOCUMENTS = 2_500;
const TASKS = 5_000;
const USERS = 20;
const DEPARTMENTS = 5;

const db = newDb();
db.public.none(`
  CREATE TABLE departments (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE users (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, department_id INT
  );
  CREATE TABLE clients (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    cpf TEXT, cnh TEXT, created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE tenant_service_types (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL
  );
  CREATE TABLE fines (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id INT NOT NULL,
    seller_id INT, department_id INT, tenant_service_type_id INT,
    fine_number TEXT, protocol_number TEXT, stage TEXT, status TEXT,
    due_date DATE, last_moved_at TIMESTAMPTZ, finalized_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE fine_logs (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, fine_id INT NOT NULL,
    action TEXT, user_id INT, created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE fine_documents (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, fine_id INT NOT NULL,
    name TEXT, category TEXT, file_size INT, status TEXT,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE process_tasks (
    id INT PRIMARY KEY, tenant_id TEXT NOT NULL, fine_id INT NOT NULL,
    title TEXT, priority TEXT, assignee_id INT, department_id INT,
    status TEXT, due_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE INDEX perf_fines_queue
    ON fines (tenant_id, archived_at, updated_at);
  CREATE INDEX perf_fines_stage_status
    ON fines (tenant_id, stage, status);
  CREATE INDEX perf_fines_assignment
    ON fines (tenant_id, seller_id, department_id);
  CREATE INDEX perf_fines_due
    ON fines (tenant_id, due_date);
  CREATE INDEX perf_fines_last_moved
    ON fines (tenant_id, last_moved_at);
  CREATE INDEX perf_clients_search
    ON clients (tenant_id, name);
  CREATE INDEX perf_logs_history
    ON fine_logs (tenant_id, fine_id, created_at);
  CREATE INDEX perf_documents_process
    ON fine_documents (tenant_id, fine_id);
  CREATE INDEX perf_tasks_attention
    ON process_tasks (tenant_id, status, due_at);
`);

const pg = db.adapters.createPg();
const pool = new pg.Pool();

function isoDaysAgo(days, hour = 12) {
  const date = new Date(Date.UTC(2026, 6, 24, hour));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function dateDaysFromToday(days) {
  const date = new Date(Date.UTC(2026, 6, 24, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function insertRows(table, columns, rows, batchSize = 400) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const params = [];
    const values = batch.map((row, rowIndex) => {
      const offset = rowIndex * columns.length;
      params.push(...row);
      return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(',')})`;
    });
    await pool.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`,
      params
    );
  }
}

async function seed() {
  const started = performance.now();
  await insertRows('departments', ['id', 'tenant_id', 'name'],
    Array.from({ length: DEPARTMENTS }, (_, index) => [index + 1, TENANT, `Setor ${index + 1}`]));
  await insertRows('users', ['id', 'tenant_id', 'name', 'is_active', 'department_id'],
    Array.from({ length: USERS }, (_, index) => [index + 1, TENANT, `Responsável ${index + 1}`, true, (index % DEPARTMENTS) + 1]));
  await insertRows('tenant_service_types', ['id', 'tenant_id', 'label'],
    Array.from({ length: 6 }, (_, index) => [index + 1, TENANT, `Serviço ${index + 1}`]));
  await insertRows('clients', ['id', 'tenant_id', 'name', 'cpf', 'cnh', 'created_at'],
    Array.from({ length: CLIENTS }, (_, index) => [
      index + 1, TENANT, `Cliente Sintético ${String(index + 1).padStart(4, '0')}`,
      String(10000000000 + index), index % 7 ? `CNH${index + 1}` : null, isoDaysAgo(index % 365),
    ]));

  const stages = ['ENTRADA', 'ANALISE', 'DEFESA', 'PROTOCOLO', 'JULGAMENTO'];
  const statuses = ['PENDENTE', 'EM_ANALISE', 'AGUARDANDO_DOCUMENTO', 'AGUARDANDO_RETORNO'];
  await insertRows('fines', [
    'id', 'tenant_id', 'client_id', 'seller_id', 'department_id',
    'tenant_service_type_id', 'fine_number', 'protocol_number', 'stage',
    'status', 'due_date', 'last_moved_at', 'finalized_at', 'archived_at',
    'created_at', 'updated_at',
  ], Array.from({ length: PROCESSES }, (_, index) => {
    const id = index + 1;
    const isFinal = id % 11 === 0;
    const created = isoDaysAgo(30 + (id % 330));
    const updated = isoDaysAgo(id % 21);
    return [
      id, TENANT, (index % CLIENTS) + 1, id % 17 === 0 ? null : (index % USERS) + 1,
      id % 19 === 0 ? null : (index % DEPARTMENTS) + 1, (index % 6) + 1,
      `SV-PERF-${String(id).padStart(5, '0')}`, `PROTO-${String(id).padStart(5, '0')}`,
      isFinal ? 'FINALIZADO' : stages[index % stages.length],
      isFinal ? 'DEFERIDO' : statuses[index % statuses.length],
      dateDaysFromToday((id % 31) - 10), updated, isFinal ? updated : null,
      null, created, updated,
    ];
  }));

  await insertRows('fine_logs', ['id', 'tenant_id', 'fine_id', 'action', 'user_id', 'created_at'],
    Array.from({ length: MOVEMENTS }, (_, index) => [
      index + 1, TENANT, (index % PROCESSES) + 1,
      ['created', 'stage_changed', 'status_changed', 'seller_changed'][index % 4],
      (index % USERS) + 1, isoDaysAgo(index % 120, index % 24),
    ]));
  await insertRows('fine_documents', ['id', 'tenant_id', 'fine_id', 'name', 'category', 'file_size', 'status', 'created_at'],
    Array.from({ length: DOCUMENTS }, (_, index) => [
      index + 1, TENANT, (index % PROCESSES) + 1, `documento-${index + 1}.pdf`,
      ['CNH', 'PROCURAÇÃO', 'COMPROVANTE'][index % 3], 10_000 + index, 'ativo',
      isoDaysAgo(index % 90),
    ]));
  await insertRows('process_tasks', [
    'id', 'tenant_id', 'fine_id', 'title', 'priority', 'assignee_id',
    'department_id', 'status', 'due_at', 'completed_at', 'created_at',
  ], Array.from({ length: TASKS }, (_, index) => {
    const completed = index % 4 === 0;
    return [
      index + 1, TENANT, (index % PROCESSES) + 1, `Pendência sintética ${index + 1}`,
      ['normal', 'alta', 'critica'][index % 3], (index % USERS) + 1,
      (index % DEPARTMENTS) + 1, completed ? 'concluida' : 'aberta',
      isoDaysAgo((index % 15) - 5), completed ? isoDaysAgo(index % 30) : null,
      isoDaysAgo(30 + (index % 90)),
    ];
  }));
  return performance.now() - started;
}

const scenarios = [
  {
    name: 'fila paginada',
    sql: `SELECT f.id, f.fine_number, f.stage, f.status, f.due_date,
                 c.name AS client_name, u.name AS seller_name, d.name AS department_name
          FROM fines f
          JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
          LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
          LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND f.archived_at IS NULL
          ORDER BY f.updated_at DESC, f.id DESC LIMIT 50 OFFSET 100`,
    params: [TENANT],
  },
  {
    name: 'fila com filtros',
    sql: `SELECT f.id, f.fine_number, c.name
          FROM fines f JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND f.stage=$2 AND f.status=$3
            AND f.department_id=$4 AND f.seller_id=$5
            AND f.last_moved_at < $6 AND f.archived_at IS NULL
          ORDER BY f.updated_at DESC LIMIT 50`,
    params: [TENANT, 'ANALISE', 'EM_ANALISE', 2, 2, isoDaysAgo(5)],
  },
  {
    name: 'dashboard agregado',
    sql: `SELECT
            COUNT(*) FILTER (WHERE finalized_at IS NULL) AS active,
            COUNT(*) FILTER (WHERE finalized_at IS NOT NULL AND finalized_at >= $2) AS finalized,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND due_date < $3) AS overdue,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND seller_id IS NULL) AS unassigned,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND last_moved_at < $4) AS stale
          FROM fines WHERE tenant_id=$1 AND archived_at IS NULL`,
    params: [TENANT, isoDaysAgo(30), dateDaysFromToday(0), isoDaysAgo(7)],
  },
  {
    name: 'busca global limitada',
    sql: `SELECT f.id, f.fine_number, f.protocol_number, c.name, c.cpf, u.name AS seller_name
          FROM fines f
          JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
          LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND (
            c.name ILIKE $2 OR c.cpf ILIKE $2 OR f.fine_number ILIKE $2
            OR f.protocol_number ILIKE $2 OR u.name ILIKE $2
          ) ORDER BY f.updated_at DESC LIMIT 20`,
    params: [TENANT, '%0250%'],
  },
  {
    name: 'exportação 5 mil linhas',
    sql: `SELECT f.fine_number, c.name, c.cpf, f.stage, f.status, f.due_date,
                 u.name AS seller_name, d.name AS department_name, s.label AS service_type
          FROM fines f
          JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
          LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
          LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
          LEFT JOIN tenant_service_types s ON s.id=f.tenant_service_type_id AND s.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 ORDER BY f.id`,
    params: [TENANT],
    runs: 2,
  },
  {
    name: 'histórico de processo',
    sql: `SELECT l.id, l.action, l.created_at, u.name
          FROM fine_logs l
          LEFT JOIN users u ON u.id=l.user_id AND u.tenant_id=l.tenant_id
          WHERE l.tenant_id=$1 AND l.fine_id=$2
          ORDER BY l.created_at DESC LIMIT 100`,
    params: [TENANT, 2500],
  },
  {
    name: 'relatório por etapa/setor',
    sql: `SELECT f.stage, d.name AS department_name, COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE f.finalized_at IS NOT NULL) AS finalized
          FROM fines f
          LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND f.created_at BETWEEN $2 AND $3
          GROUP BY f.stage, d.name ORDER BY total DESC`,
    params: [TENANT, isoDaysAgo(400), isoDaysAgo(-1)],
  },
  {
    name: 'central de atenção',
    sql: `SELECT
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND due_date < $2) AS overdue,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND due_date = $2) AS due_today,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND seller_id IS NULL) AS unassigned,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND department_id IS NULL) AS no_department,
            COUNT(*) FILTER (WHERE finalized_at IS NULL AND last_moved_at < $3) AS stale
          FROM fines WHERE tenant_id=$1 AND archived_at IS NULL`,
    params: [TENANT, dateDaysFromToday(0), isoDaysAgo(7)],
  },
];

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function measure(scenario) {
  await pool.query(scenario.sql, scenario.params); // aquecimento
  const timings = [];
  let rowCount = 0;
  for (let index = 0; index < (scenario.runs || 5); index += 1) {
    const started = performance.now();
    const result = await pool.query(scenario.sql, scenario.params);
    timings.push(performance.now() - started);
    rowCount = result.rowCount;
  }
  timings.sort((left, right) => left - right);
  return {
    scenario: scenario.name,
    rows: rowCount,
    median_ms: Number(percentile(timings, 0.5).toFixed(1)),
    p95_ms: Number(percentile(timings, 0.95).toFixed(1)),
  };
}

async function main() {
  const seedMs = await seed();
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM clients WHERE tenant_id=$1', [TENANT]),
    pool.query('SELECT COUNT(*)::int AS count FROM fines WHERE tenant_id=$1', [TENANT]),
    pool.query('SELECT COUNT(*)::int AS count FROM fine_logs WHERE tenant_id=$1', [TENANT]),
  ]);
  const actual = counts.map((result) => result.rows[0].count);
  if (actual[0] !== CLIENTS || actual[1] !== PROCESSES || actual[2] !== MOVEMENTS) {
    throw new Error(`Massa incompleta: ${actual.join('/')}`);
  }

  const results = [];
  for (const scenario of scenarios) results.push(await measure(scenario));
  const summary = {
    environment: 'pg-mem local; dados totalmente sintéticos; sem rede',
    mass: {
      clients: CLIENTS,
      processes: PROCESSES,
      movements: MOVEMENTS,
      document_metadata: DOCUMENTS,
      tasks: TASKS,
      users: USERS,
      departments: DEPARTMENTS,
    },
    seed_ms: Number(seedMs.toFixed(1)),
    memory_mb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error('[sisv-performance-smoke]', error);
  process.exitCode = 1;
});
