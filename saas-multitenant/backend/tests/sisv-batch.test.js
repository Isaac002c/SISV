'use strict';
// =============================================================================
// SISV — Distribuição em LOTE (fineModels.batchAssign). Cobre os cenários do
// escopo: lote válido, só responsável, só setor, ambos, lista vazia, acima do
// limite, alvo inválido, alvo de outro tenant, processo de outro tenant,
// processo inexistente, histórico gerado, sem histórico quando não muda, e
// isolamento entre tenants. Rollback: a validação de alvo ocorre ANTES de
// qualquer escrita (nenhuma atualização parcial).
// =============================================================================
process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let fineModels, pool;
const A = 'tenant-A';
const B = 'tenant-B';
let uA, uB, deptA, deptB, cliA, p1, p2, pB;

before(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  db.public.none(`
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT);
    CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE);
    CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT);
    CREATE TABLE fines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, client_id UUID, fine_number TEXT, seller_id UUID, department_id UUID, stage TEXT DEFAULT 'ENTRADA', status TEXT DEFAULT 'PENDENTE', last_moved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  const pg = db.adapters.createPg(); pool = new pg.Pool();
  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId); stub.filename = dbId; stub.loaded = true; stub.exports = pool;
  require.cache[dbId] = stub;
  fineModels = require('../models/fineModels');

  uA = (await pool.query(`INSERT INTO users (tenant_id,name) VALUES ($1,'Op A') RETURNING id`, [A])).rows[0].id;
  uB = (await pool.query(`INSERT INTO users (tenant_id,name) VALUES ($1,'Op B') RETURNING id`, [B])).rows[0].id;
  deptA = (await pool.query(`INSERT INTO departments (tenant_id,name) VALUES ($1,'Jurídico A') RETURNING id`, [A])).rows[0].id;
  deptB = (await pool.query(`INSERT INTO departments (tenant_id,name) VALUES ($1,'Jurídico B') RETURNING id`, [B])).rows[0].id;
  cliA = (await pool.query(`INSERT INTO clients (tenant_id,name) VALUES ($1,'Cli A') RETURNING id`, [A])).rows[0].id;
  p1 = (await pool.query(`INSERT INTO fines (tenant_id,client_id,fine_number) VALUES ($1,$2,'A-1') RETURNING id`, [A, cliA])).rows[0].id;
  p2 = (await pool.query(`INSERT INTO fines (tenant_id,client_id,fine_number) VALUES ($1,$2,'A-2') RETURNING id`, [A, cliA])).rows[0].id;
  pB = (await pool.query(`INSERT INTO fines (tenant_id,fine_number) VALUES ($1,'B-1') RETURNING id`, [B])).rows[0].id;
});

test('lote válido: responsável + setor nos dois processos', async () => {
  const r = await fineModels.batchAssign(A, [p1, p2], { changeSeller: true, seller_id: uA, changeDept: true, department_id: deptA });
  assert.equal(r.ok, true);
  assert.equal(r.updated, 2);
  assert.equal(r.changes.length, 2);
  assert.ok(r.changes[0].seller && r.changes[0].department);
});

test('só responsável / só setor', async () => {
  const r1 = await fineModels.batchAssign(A, [p1], { changeSeller: true, seller_id: null });
  assert.equal(r1.ok, true);
  assert.ok(r1.changes[0].seller && !r1.changes[0].department, 'só mexe no responsável');
  const r2 = await fineModels.batchAssign(A, [p1], { changeDept: true, department_id: null });
  assert.equal(r2.ok, true);
  assert.ok(r2.changes[0].department && !r2.changes[0].seller, 'só mexe no setor');
});

test('lista vazia → erro', async () => {
  const r = await fineModels.batchAssign(A, [], { changeSeller: true, seller_id: uA });
  assert.equal(r.ok, false);
});

test('acima do limite (200) → erro', async () => {
  const many = Array.from({ length: 201 }, () => randomUUID());
  const r = await fineModels.batchAssign(A, many, { changeSeller: true, seller_id: uA });
  assert.equal(r.ok, false);
  assert.match(r.error, /limite/i);
});

test('nada a alterar → erro', async () => {
  const r = await fineModels.batchAssign(A, [p1], {});
  assert.equal(r.ok, false);
});

test('responsável inválido / de outro tenant → erro, sem escrita', async () => {
  const r1 = await fineModels.batchAssign(A, [p1], { changeSeller: true, seller_id: randomUUID() });
  assert.equal(r1.ok, false);
  const r2 = await fineModels.batchAssign(A, [p1], { changeSeller: true, seller_id: uB }); // usuário do tenant B
  assert.equal(r2.ok, false, 'responsável de outro tenant é rejeitado');
});

test('setor inválido / de outro tenant → erro', async () => {
  const r1 = await fineModels.batchAssign(A, [p1], { changeDept: true, department_id: randomUUID() });
  assert.equal(r1.ok, false);
  const r2 = await fineModels.batchAssign(A, [p1], { changeDept: true, department_id: deptB });
  assert.equal(r2.ok, false, 'setor de outro tenant é rejeitado');
});

test('processo de outro tenant e inexistente → skipped (isolamento)', async () => {
  const r = await fineModels.batchAssign(A, [pB, randomUUID()], { changeSeller: true, seller_id: uA });
  assert.equal(r.ok, true);
  assert.equal(r.updated, 0, 'nenhum atualizado');
  assert.equal(r.skipped.length, 2, 'ambos ignorados');
  // processo de B intacto
  const pbRow = await pool.query('SELECT seller_id FROM fines WHERE id = $1', [pB]);
  assert.equal(pbRow.rows[0].seller_id, null);
});

test('sem histórico quando o valor não muda', async () => {
  await fineModels.batchAssign(A, [p2], { changeSeller: true, seller_id: uA }); // define
  const again = await fineModels.batchAssign(A, [p2], { changeSeller: true, seller_id: uA }); // mesmo valor
  assert.equal(again.ok, true);
  assert.equal(again.changes.length, 0, 'nenhuma mudança → nenhum log');
  assert.equal(again.updated, 1, 'processado, mas sem alteração');
});

test('B não altera processos de A (isolamento na escrita)', async () => {
  await fineModels.batchAssign(A, [p1], { changeSeller: true, seller_id: uA });
  const r = await fineModels.batchAssign(B, [p1], { changeSeller: true, seller_id: uB });
  assert.equal(r.updated, 0);
  assert.equal(r.skipped.length, 1);
  const row = await pool.query('SELECT seller_id FROM fines WHERE id = $1', [p1]);
  assert.equal(row.rows[0].seller_id, uA, 'responsável de A preservado');
});
