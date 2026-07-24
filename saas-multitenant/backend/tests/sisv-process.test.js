'use strict';
// =============================================================================
// SISV — Fluxo operacional dos processos (models reais sobre pg-mem).
// Cobre: criação, movimentação de etapa/status, redistribuição, troca de setor,
// finalização, reabertura, filtros da fila, dashboard e HISTÓRICO automático.
// Isolamento por tenant verificado nos filtros/consultas.
// =============================================================================
process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let fineModels, fineLogModels, cfg, pool;
const T = 'tenant-sisv';
const OTHER = 'tenant-outro';
let cliId, cliOther, uAdmin, uOp, deptJur, deptAtd, svc;

before(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });

  db.public.none(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT, modules JSONB);
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT, email TEXT, role TEXT);
    CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, cpf TEXT, cnh TEXT, phone TEXT, email TEXT, address TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE process_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_final BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE process_statuses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_pending BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tenant_service_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE fines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, client_id UUID,
      company_id UUID, vehicle_id UUID, service_type_id INT, seller_id UUID,
      fine_number TEXT, plate TEXT, organ TEXT, infraction_type TEXT, vehicle_model TEXT,
      infraction_date DATE, due_date DATE, defense_date DATE,
      stage TEXT DEFAULT 'cadastro', status TEXT DEFAULT 'pendente',
      value NUMERIC(15,2) DEFAULT 0, cost NUMERIC(15,2) DEFAULT 0, paid_value NUMERIC(15,2) DEFAULT 0,
      notes TEXT, protocol_number TEXT,
      department_id UUID, tenant_service_type_id UUID,
      finalized_at TIMESTAMPTZ, reopened_at TIMESTAMPTZ, last_moved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE fine_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, name TEXT, file_url TEXT, file_type TEXT, file_size BIGINT, category TEXT, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE fine_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, action TEXT, field_name TEXT, old_value TEXT, new_value TEXT, user_id UUID, created_at TIMESTAMPTZ DEFAULT NOW());
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();

  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId);
  stub.filename = dbId; stub.loaded = true; stub.exports = pool;
  require.cache[dbId] = stub;

  fineModels = require('../models/fineModels');
  fineLogModels = require('../models/fineLogModels');
  cfg = require('../models/tenantConfigModels');

  // Seed base para os dois tenants.
  await pool.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,'SISV','sisv'),($2,'Outro','outro')`, [T, OTHER]);
  uAdmin = (await pool.query(`INSERT INTO users (tenant_id,name,email,role) VALUES ($1,'Gestor','g@sisv','admin') RETURNING id`, [T])).rows[0].id;
  uOp = (await pool.query(`INSERT INTO users (tenant_id,name,email,role) VALUES ($1,'Operador','o@sisv','operator') RETURNING id`, [T])).rows[0].id;
  cliId = (await pool.query(`INSERT INTO clients (tenant_id,name,cpf,status) VALUES ($1,'Maria CNH','11122233344','fechado') RETURNING id`, [T])).rows[0].id;
  cliOther = (await pool.query(`INSERT INTO clients (tenant_id,name,cpf,status) VALUES ($1,'Cliente Outro','999','fechado') RETURNING id`, [OTHER])).rows[0].id;

  deptAtd = (await cfg.createDepartment({ tenant_id: T, name: 'Atendimento', sort_order: 1 })).id;
  deptJur = (await cfg.createDepartment({ tenant_id: T, name: 'Jurídico', sort_order: 2 })).id;
  await cfg.createStage({ tenant_id: T, code: 'ENTRADA', label: 'Entrada', sort_order: 1 });
  await cfg.createStage({ tenant_id: T, code: 'DEFESA', label: 'Defesa', sort_order: 3 });
  await cfg.createStage({ tenant_id: T, code: 'FINALIZADO', label: 'Finalizado', sort_order: 5, is_final: true });
  await cfg.createStatus({ tenant_id: T, code: 'PENDENTE', label: 'Pendente', sort_order: 1, is_pending: true });
  await cfg.createStatus({ tenant_id: T, code: 'EM_ANALISE', label: 'Em análise', sort_order: 2 });
  await cfg.createStatus({ tenant_id: T, code: 'FINALIZADO', label: 'Finalizado', sort_order: 8 });
  svc = (await cfg.createServiceType({ tenant_id: T, code: 'REABILITACAO', label: 'Reabilitação de CNH' })).id;
});

let procId;

test('cria processo com setor, tipo de serviço e responsável', async () => {
  const p = await fineModels.createFine({
    tenant_id: T, client_id: cliId, fine_number: 'SV-0001', seller_id: uOp,
    department_id: deptAtd, tenant_service_type_id: svc, stage: 'ENTRADA', status: 'PENDENTE',
  });
  procId = p.id;
  await fineLogModels.logProcessCreated(T, p.id, 'Processo SV-0001', uOp);
  assert.equal(p.stage, 'ENTRADA');
  assert.equal(p.department_id, deptAtd);
  assert.ok(p.last_moved_at, 'last_moved_at deve ser preenchido na criação');
});

test('detalhe traz rótulos de setor / tipo de serviço / responsável', async () => {
  const d = await fineModels.getProcessById(procId, T);
  assert.equal(d.department_name, 'Atendimento');
  assert.equal(d.service_type_label, 'Reabilitação de CNH');
  assert.equal(d.seller_name, 'Operador');
  assert.equal(d.client_name, 'Maria CNH');
});

test('detalhe de outro tenant não é acessível (isolamento)', async () => {
  assert.equal(await fineModels.getProcessById(procId, OTHER), undefined);
});

test('movimenta etapa e status; histórico registra ambos', async () => {
  const before = await fineModels.getProcessById(procId, T);
  await fineModels.moveProcessStage(procId, 'DEFESA', T);
  await fineLogModels.logStageChange(T, procId, before.stage, 'DEFESA', uOp);
  await fineModels.moveProcessStatus(procId, 'EM_ANALISE', T);
  await fineLogModels.logStatusChange(T, procId, before.status, 'EM_ANALISE', uOp);

  const after = await fineModels.getProcessById(procId, T);
  assert.equal(after.stage, 'DEFESA');
  assert.equal(after.status, 'EM_ANALISE');

  const logs = await fineLogModels.getLogsByFine(procId, T);
  const actions = logs.map(l => l.action);
  assert.ok(actions.includes('stage_changed'));
  assert.ok(actions.includes('status_changed'));
});

test('redistribui responsável e troca setor com histórico', async () => {
  const before = await fineModels.getProcessById(procId, T);
  await fineModels.changeProcessSeller(procId, uAdmin, T);
  await fineLogModels.logSellerChange(T, procId, before.seller_name, 'Gestor', uAdmin);
  await fineModels.changeProcessDepartment(procId, deptJur, T);
  await fineLogModels.logDepartmentChange(T, procId, before.department_name, 'Jurídico', uAdmin);

  const after = await fineModels.getProcessById(procId, T);
  assert.equal(after.seller_id, uAdmin);
  assert.equal(after.department_name, 'Jurídico');

  const logs = await fineLogModels.getLogsByFine(procId, T);
  const seller = logs.find(l => l.action === 'seller_changed');
  assert.equal(seller.new_value, 'Gestor');
  assert.ok(logs.some(l => l.action === 'department_changed'));
});

test('finaliza e reabre, refletindo finalized_at e histórico', async () => {
  await fineModels.finalizeProcess(procId, { stage: 'FINALIZADO', status: 'FINALIZADO' }, T);
  await fineLogModels.logFinalized(T, procId, uAdmin);
  let d = await fineModels.getProcessById(procId, T);
  assert.ok(d.finalized_at, 'finalized_at deve ser setado');

  await fineModels.reopenProcess(procId, { stage: 'DEFESA', status: 'EM_ANALISE' }, T);
  await fineLogModels.logReopened(T, procId, uAdmin);
  d = await fineModels.getProcessById(procId, T);
  assert.equal(d.finalized_at, null, 'finalized_at deve limpar na reabertura');
  assert.ok(d.reopened_at, 'reopened_at deve ser setado');

  const logs = await fineLogModels.getLogsByFine(procId, T);
  assert.ok(logs.some(l => l.action === 'finalized'));
  assert.ok(logs.some(l => l.action === 'reopened'));
});

test('fila: filtro por responsável e "sem responsável"', async () => {
  // cria um processo sem responsável
  await fineModels.createFine({ tenant_id: T, client_id: cliId, fine_number: 'SV-0002', seller_id: null, stage: 'ENTRADA', status: 'PENDENTE' });

  const mine = await fineModels.listProcesses(T, { seller_id: uAdmin });
  assert.ok(mine.rows.every(r => r.seller_id === uAdmin));

  const none = await fineModels.listProcesses(T, { seller_id: 'none' });
  assert.ok(none.total >= 1);
  assert.ok(none.rows.every(r => r.seller_id === null));
});

test('fila: busca textual por cliente/número e paginação/total', async () => {
  const byNumber = await fineModels.listProcesses(T, { q: 'SV-0002' });
  assert.equal(byNumber.total, 1);
  const byClient = await fineModels.listProcesses(T, { q: 'Maria' });
  assert.ok(byClient.total >= 2);
  // isolamento: busca não vaza outro tenant
  const otherView = await fineModels.listProcesses(OTHER, { q: 'Maria' });
  assert.equal(otherView.total, 0);
});

test('fila: filtro finalizado e pendente', async () => {
  const finalized = await fineModels.listProcesses(T, { finalized: 'true' });
  // reabrimos o SV-0001, então não deve haver finalizados agora
  assert.equal(finalized.rows.every(r => r.finalized_at), true);

  const pend = await fineModels.listProcesses(T, { pending: 'true' });
  assert.ok(pend.rows.length >= 1, 'deve listar processos com status pendente');
});

test('prazos: filtro de vencidos e contagem no dashboard', async () => {
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await fineModels.createFine({ tenant_id: T, client_id: cliId, fine_number: 'SV-VENC', due_date: past, stage: 'ENTRADA', status: 'PENDENTE' });
  await fineModels.createFine({ tenant_id: T, client_id: cliId, fine_number: 'SV-PROX', due_date: future, stage: 'ENTRADA', status: 'PENDENTE' });

  const overdue = await fineModels.listProcesses(T, { overdue: 'true' });
  assert.ok(overdue.rows.some((r) => r.fine_number === 'SV-VENC'), 'vencido deve aparecer no filtro overdue');
  assert.ok(!overdue.rows.some((r) => r.fine_number === 'SV-PROX'), 'prazo futuro não é vencido');

  const dueSoon = await fineModels.listProcesses(T, { due_soon: 'true' });
  assert.ok(dueSoon.rows.some((r) => r.fine_number === 'SV-PROX'), 'prazo em 3 dias deve estar em due_soon');

  const dash = await fineModels.getProcessDashboard(T);
  assert.ok(Number(dash.totals.overdue) >= 1, 'dashboard deve contar vencidos');
  assert.ok(Number(dash.totals.due_soon) >= 1, 'dashboard deve contar vencendo');
});

test('prazos: processo FINALIZADO com prazo vencido NÃO entra em vencidos', async () => {
  const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const p = await fineModels.createFine({ tenant_id: T, client_id: cliId, fine_number: 'SV-FIN-VENC', due_date: past, stage: 'ENTRADA', status: 'PENDENTE' });
  await fineModels.finalizeProcess(p.id, { stage: 'FINALIZADO', status: 'FINALIZADO' }, T);
  const overdue = await fineModels.listProcesses(T, { overdue: 'true' });
  assert.ok(!overdue.rows.some((r) => r.fine_number === 'SV-FIN-VENC'), 'finalizado não é vencido');
  // reaberto volta a contar
  await fineModels.reopenProcess(p.id, {}, T);
  const overdue2 = await fineModels.listProcesses(T, { overdue: 'true' });
  assert.ok(overdue2.rows.some((r) => r.fine_number === 'SV-FIN-VENC'), 'reaberto volta a ser vencido');
});

test('dashboard operacional agrega totais e catálogos', async () => {
  const dash = await fineModels.getProcessDashboard(T);
  assert.ok(Number(dash.totals.total) >= 2);
  assert.ok(Array.isArray(dash.byStage));
  assert.ok(Array.isArray(dash.byStatus));
  assert.ok(Array.isArray(dash.bySeller));
  assert.ok(Array.isArray(dash.byDepartment));
  assert.ok(Number(dash.totals.unassigned) >= 1, 'deve contar processos sem responsável');
});
