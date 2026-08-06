'use strict';

// Harness local e descartavel para PostgreSQL real.
// Nao usa o servico PostgreSQL compartilhado da maquina e nunca aceita uma
// DATABASE_URL externa. O cluster fica exclusivamente em backend/.postgres-test.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const backendDir = path.resolve(__dirname, '..');
const sandboxDir = path.resolve(backendDir, '.postgres-test');
const dataDir = path.resolve(sandboxDir, 'data');
const port = String(process.env.SISV_POSTGRES_TEST_PORT || '55432');
const user = 'sisv_test';
const db = 'sisv_governance_test';
const host = '127.0.0.1';

if (!dataDir.startsWith(`${backendDir}${path.sep}.postgres-test${path.sep}`)) {
  throw new Error('Diretorio PostgreSQL descartavel fora do workspace permitido.');
}

const candidates = [
  process.env.POSTGRES_BIN,
  'C:\\Program Files\\PostgreSQL\\18\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
].filter(Boolean);

const executable = (name) => process.platform === 'win32' ? `${name}.exe` : name;
const binDir = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, executable('pg_ctl')))
);

const commandPath = (name) => binDir ? path.join(binDir, executable(name)) : name;

function run(name, args, options = {}) {
  const result = spawnSync(commandPath(name), args, {
    cwd: backendDir,
    env: { ...process.env, PGHOST: host, PGPORT: port, PGUSER: user },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${name} falhou (${result.status}). ${details}`.trim());
  }
  return result;
}

function psql(database, args, options) {
  return run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database, ...args], options);
}

function migration(file) {
  psql(db, ['-f', path.join(backendDir, 'migrations', file)]);
}

function resetDatabase() {
  run('dropdb', ['--if-exists', '--force', db]);
  run('createdb', [db]);
}

function migrateAll() {
  [
    '000_nexos_schema.sql',
    'sisv_01_tenant_config.sql',
    'sisv_02_documents.sql',
    'sisv_03_operations.sql',
    'sisv_04_telun_identity.sql',
    'sisv_05_workflow_sla_automation.sql',
    'sisv_06_commercial_backoffice_execution.sql',
    'sisv_07_user_access_control.sql',
    'sisv_08_username_login.sql',
    'sisv_09_user_soft_delete.sql',
    'sisv_10_client_soft_delete.sql',
    'sisv_11_client_fields_partners_contractors.sql',
  ].forEach(migration);
}

let startedHere = false;
try {
  fs.mkdirSync(sandboxDir, { recursive: true });
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    run('initdb', [
      '-D', dataDir,
      '-U', user,
      '--auth-local=trust',
      '--auth-host=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]);
  }

  const ready = run('pg_isready', ['-h', host, '-p', port], { allowFailure: true, capture: true });
  if (ready.status !== 0) {
    run('pg_ctl', [
      '-D', dataDir,
      '-l', path.join(sandboxDir, 'postgres.log'),
      '-o', `-h ${host} -p ${port}`,
      '-w', 'start',
    ]);
    startedHere = true;
  }

  console.log(`\n[SISV PostgreSQL] cluster isolado pronto em ${host}:${port}`);
  resetDatabase();
  migrateAll();

  // Idempotencia declarada das migrations incrementais.
  migration('sisv_03_operations.sql');
  migration('sisv_04_telun_identity.sql');
  migration('sisv_05_workflow_sla_automation.sql');
  migration('sisv_06_commercial_backoffice_execution.sql');
  migration('sisv_07_user_access_control.sql');
  migration('sisv_08_username_login.sql');
  migration('sisv_09_user_soft_delete.sql');
  migration('sisv_10_client_soft_delete.sql');
  migration('sisv_11_client_fields_partners_contractors.sql');

  const databaseUrl = `postgresql://${user}@${host}:${port}/${db}?sslmode=disable`;
  const postgresTests = fs.readdirSync(path.join(backendDir, 'tests-postgres'))
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => path.join('tests-postgres', file));
  const tests = spawnSync(process.execPath, ['--test', ...postgresTests], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SISV_POSTGRES_TEST: '1',
    },
    stdio: 'inherit',
  });
  if (tests.status !== 0) throw new Error(`Testes PostgreSQL falharam (${tests.status}).`);

  // Prova o rollback da extensao 11 antes das estruturas comerciais que ela
  // referencia. Dados anteriores e tabelas da migration 06 devem sobreviver.
  migration('sisv_11_client_fields_partners_contractors_rollback.sql');
  const rollback11 = psql(db, [
    '-Atc',
    "SELECT to_regclass('public.client_field_definitions') IS NULL"
    + " AND to_regclass('public.service_client_field_requirements') IS NULL"
    + " AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='contractor_type')"
    + " AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='additional_data')"
    + " AND to_regclass('public.orders') IS NOT NULL AND to_regclass('public.clients') IS NOT NULL",
  ], { capture: true });
  if (String(rollback11.stdout).trim() !== 't') {
    throw new Error('Rollback 11 deixou estruturas novas ou removeu tabelas anteriores.');
  }

  // Prova o rollback das rodadas, na ordem inversa, depois recria do zero.
  migration('sisv_06_commercial_backoffice_execution_rollback.sql');
  const rollback06 = psql(db, [
    '-Atc',
    "SELECT to_regclass('public.orders') IS NULL AND to_regclass('public.sales') IS NULL"
    + " AND to_regclass('public.service_orders') IS NULL AND to_regclass('public.suppliers') IS NULL",
  ], { capture: true });
  if (String(rollback06.stdout).trim() !== 't') {
    throw new Error('Rollback 06 deixou estruturas comerciais no banco.');
  }
  // O rollback 06 nao pode levar junto o que veio antes (processos e workflows).
  const preserved = psql(db, [
    '-Atc',
    "SELECT to_regclass('public.fines') IS NOT NULL AND to_regclass('public.clients') IS NOT NULL"
    + " AND to_regclass('public.workflow_flows') IS NOT NULL",
  ], { capture: true });
  if (String(preserved.stdout).trim() !== 't') {
    throw new Error('Rollback 06 removeu estruturas de rodadas anteriores.');
  }

  migration('sisv_05_workflow_sla_automation_rollback.sql');
  const rollbackCheck = psql(db, [
    '-Atc',
    "SELECT to_regclass('public.workflow_flows') IS NULL AND to_regclass('public.internal_queue_jobs') IS NULL",
  ], { capture: true });
  if (String(rollbackCheck.stdout).trim() !== 't') {
    throw new Error('Rollback 05 deixou estruturas da rodada no banco.');
  }

  resetDatabase();
  migrateAll();
  const finalCheck = psql(db, [
    '-Atc',
    "SELECT to_regclass('public.workflow_flows') IS NOT NULL AND to_regclass('public.internal_queue_jobs') IS NOT NULL"
    + " AND to_regclass('public.orders') IS NOT NULL AND to_regclass('public.commissions') IS NOT NULL"
    + " AND to_regclass('public.client_field_definitions') IS NOT NULL"
    + " AND to_regclass('public.service_client_field_requirements') IS NOT NULL"
    + " AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='contractor_type')"
    + " AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='additional_data')",
  ], { capture: true });
  if (String(finalCheck.stdout).trim() !== 't') {
    throw new Error('Reaplicacao completa nao reconstruiu as estruturas da rodada.');
  }
  console.log('\n[SISV PostgreSQL] migrations, idempotencia, rollback e reaplicacao: OK');
} finally {
  if (startedHere) {
    run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { allowFailure: true });
  }
}
