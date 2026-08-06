'use strict';
// =============================================================================
// SISV — Catálogos por tenant (isolamento + CRUD) e gating de módulos por tenant.
// =============================================================================
process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let cfg, requireModuleMod, pool;
const A = 'tenant-A';
const B = 'tenant-B';
const LEGACY = 'tenant-legacy';

before(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });

  db.public.none(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT, modules JSONB);
    CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE process_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_final BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE process_statuses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_pending BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tenant_service_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL,
      code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0,
      description TEXT, initial_stage TEXT, initial_status TEXT,
      default_due_days INT, initial_department_id UUID,
      suggested_tasks JSONB DEFAULT '[]'::jsonb,
      custom_fields JSONB DEFAULT '[]'::jsonb,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE document_categories (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, description TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();
  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId);
  stub.filename = dbId; stub.loaded = true; stub.exports = pool;
  require.cache[dbId] = stub;

  cfg = require('../models/tenantConfigModels');
  requireModuleMod = require('../middlewares/requireModule');

  // Tenants + módulos: A restrito a processos/clientes; LEGACY sem restrição.
  await pool.query(`INSERT INTO tenants (id,name,slug,modules) VALUES ($1,'A','a',$2::jsonb)`, [A, JSON.stringify(['processos', 'clientes'])]);
  await pool.query(`INSERT INTO tenants (id,name,slug,modules) VALUES ($1,'B','b',$2::jsonb)`, [B, JSON.stringify(['processos'])]);
  await pool.query(`INSERT INTO tenants (id,name,slug,modules) VALUES ($1,'Legacy','legacy',NULL)`, [LEGACY]);
});

// ───────────────────────── Catálogos: isolamento + CRUD ─────────────────────
test('setores: criação e isolamento por tenant', async () => {
  const d = await cfg.createDepartment({ tenant_id: A, name: 'Jurídico' });
  await cfg.createDepartment({ tenant_id: B, name: 'Protocolo' });
  const listA = await cfg.listDepartments(A);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].name, 'Jurídico');
  const listB = await cfg.listDepartments(B);
  assert.ok(!listB.some(x => x.id === d.id), 'B não enxerga setor de A');
});

test('setores: update/delete cross-tenant não afetam o dono', async () => {
  const d = await cfg.createDepartment({ tenant_id: A, name: 'Atendimento' });
  const upd = await cfg.updateDepartment(d.id, { name: 'INVASOR' }, B);
  assert.equal(upd, undefined, 'update de outro tenant → 0 linhas');
  const del = await cfg.deleteDepartment(d.id, B);
  assert.equal(del, undefined, 'delete de outro tenant → 0 linhas');
  const still = await cfg.listDepartments(A);
  assert.ok(still.some(x => x.id === d.id && x.name === 'Atendimento'), 'registro preservado');
});

test('etapas/status/tipos: criam com code derivado e listam ativos', async () => {
  const st = await cfg.createStage({ tenant_id: A, label: 'Defesa Prévia' });
  assert.equal(st.code, 'DEFESA_PREVIA');
  await cfg.createStatus({ tenant_id: A, label: 'Em análise', is_pending: false });
  await cfg.createServiceType({ tenant_id: A, label: 'Reabilitação de CNH' });

  const full = await cfg.getFullConfig(A);
  assert.ok(full.stages.length >= 1);
  assert.ok(full.statuses.length >= 1);
  assert.ok(full.serviceTypes.length >= 1);
  // isolamento no agregado
  const fullB = await cfg.getFullConfig(B);
  assert.equal(fullB.stages.length, 0);
});

test('inativar (active=false) esconde da listagem padrão', async () => {
  const s = await cfg.createStatus({ tenant_id: A, label: 'Temporário' });
  await cfg.updateStatus(s.id, { active: false }, A);
  const activeOnly = await cfg.listStatuses(A);
  assert.ok(!activeOnly.some(x => x.id === s.id), 'inativo não aparece por padrão');
  const all = await cfg.listStatuses(A, { includeInactive: true });
  assert.ok(all.some(x => x.id === s.id), 'aparece com includeInactive');
});

// ───────────────────────── Gating de módulos por tenant ─────────────────────
function runMiddleware(mw, tenantId) {
  return new Promise((resolve) => {
    const req = { tenantId };
    let statusCode = 200;
    const res = {
      status(c) { statusCode = c; return this; },
      json(body) { resolve({ statusCode, body, nexted: false }); },
    };
    const next = () => resolve({ statusCode: 200, nexted: true });
    mw(req, res, next);
  });
}

test('módulo habilitado → next(); desabilitado → 403', async () => {
  const { requireModule, clearModuleCache } = requireModuleMod;
  clearModuleCache();

  const okRes = await runMiddleware(requireModule('processos'), A);
  assert.equal(okRes.nexted, true, 'A tem processos habilitado');

  const blocked = await runMiddleware(requireModule('financeiro'), A);
  assert.equal(blocked.nexted, false);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.module, 'financeiro');
});

test('tenant legado (modules=NULL) libera qualquer módulo', async () => {
  const { requireModule, clearModuleCache } = requireModuleMod;
  clearModuleCache();
  const r1 = await runMiddleware(requireModule('financeiro'), LEGACY);
  const r2 = await runMiddleware(requireModule('leads'), LEGACY);
  assert.equal(r1.nexted, true);
  assert.equal(r2.nexted, true);
});

test('B não acessa clientes (fora do seu conjunto de módulos)', async () => {
  const { requireModule, clearModuleCache } = requireModuleMod;
  clearModuleCache();
  const blocked = await runMiddleware(requireModule('clientes'), B);
  assert.equal(blocked.statusCode, 403);
});
