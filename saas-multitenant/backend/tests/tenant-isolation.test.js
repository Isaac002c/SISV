'use strict';
// =============================================================================
// ISOLAMENTO MULTI-TENANT (spec §5/§23) — comprova, exercitando os MODELS REAIS,
// que um usuário de um tenant NÃO consegue, sobre registros de OUTRO tenant:
//   • listar   • ler por ID   • alterar   • excluir
// Roda contra um Postgres em memória (pg-mem) injetado no lugar de config/db.
// Sem banco externo. Cobre as entidades operacionais centrais: clientes e processos.
// =============================================================================
process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let clientModels, fineModels, pool;
const A = 'tenant-A';
const B = 'tenant-B';
let cliA, cliB, fineA, fineB;

before(async () => {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid', returns: DataType.uuid, impure: true,
    implementation: () => randomUUID(),
  });

  // Esquema mínimo compatível com as queries reais dos models (colunas + JOINs).
  db.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT, name TEXT
    );
    CREATE TABLE clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, name TEXT, birth_date DATE, cpf TEXT, cnh TEXT,
      first_cnh DATE, phone TEXT, email TEXT, address TEXT, notes TEXT,
      status TEXT DEFAULT 'negociacao', lead_id TEXT, additional_data JSONB DEFAULT '{}'::jsonb,
      deleted_at TIMESTAMPTZ, deleted_by UUID, delete_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE fines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, client_id UUID, fine_number TEXT, plate TEXT, organ TEXT,
      infraction_type TEXT, vehicle_model TEXT, infraction_date DATE, due_date DATE,
      defense_date DATE, stage TEXT DEFAULT 'cadastro', status TEXT DEFAULT 'pendente',
      value NUMERIC(15,2) DEFAULT 0, cost NUMERIC(15,2) DEFAULT 0, paid_value NUMERIC(15,2) DEFAULT 0,
      seller_id UUID, notes TEXT,
      -- colunas adicionadas por sisv_01_tenant_config.sql
      service_type_id INT, protocol_number TEXT,
      department_id UUID, tenant_service_type_id UUID,
      finalized_at TIMESTAMPTZ, reopened_at TIMESTAMPTZ, last_moved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();

  // Injeta o pool pg-mem no lugar de config/db ANTES de carregar os models
  // (config/db é singleton; ao pré-popular o cache, o require dos models o usa).
  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId);
  stub.filename = dbId;
  stub.loaded = true;
  stub.exports = pool;
  require.cache[dbId] = stub;

  clientModels = require('../models/clientModels');
  fineModels = require('../models/fineModels');

  // Seed: 1 cliente + 1 processo por tenant.
  cliA = await clientModels.createClient({ tenant_id: A, name: 'Cliente A', cpf: '11111111111', phone: '1111', status: 'ativo' });
  cliB = await clientModels.createClient({ tenant_id: B, name: 'Cliente B', cpf: '22222222222', phone: '2222', status: 'ativo' });
  fineA = await fineModels.createFine({ tenant_id: A, client_id: cliA.id, organ: 'DETRAN', fine_number: 'A-1', status: 'pendente' });
  fineB = await fineModels.createFine({ tenant_id: B, client_id: cliB.id, organ: 'DETRAN', fine_number: 'B-1', status: 'pendente' });
});

// ───────────────────────────── CLIENTES ─────────────────────────────
test('clientes: listar retorna somente registros do próprio tenant', async () => {
  const listA = await clientModels.getAllClients(A);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].id, cliA.id);
  assert.ok(!listA.some((c) => c.id === cliB.id), 'não pode conter cliente de outro tenant');
});

test('clientes: ler por ID de outro tenant → não encontra', async () => {
  assert.equal(await clientModels.getClientById(cliB.id, A), undefined);
  assert.ok(await clientModels.getClientById(cliA.id, A), 'sanidade: encontra o próprio');
});

test('clientes: atualizar de outro tenant → 0 linhas e dado preservado', async () => {
  const upd = await clientModels.updateClient(cliB.id, { name: 'INVASOR', status: 'ativo' }, A);
  assert.equal(upd, undefined);
  const still = await clientModels.getClientById(cliB.id, B);
  assert.equal(still.name, 'Cliente B');
});

test('clientes: excluir de outro tenant → 0 linhas e registro preservado', async () => {
  const del = await clientModels.deleteClient(cliB.id, A);
  assert.equal(del, undefined);
  assert.ok(await clientModels.getClientById(cliB.id, B), 'registro do outro tenant deve continuar existindo');
});

test('clientes: busca não vaza registros de outro tenant', async () => {
  const found = await clientModels.searchClients(A, 'Cliente B');
  assert.equal(found.length, 0);
});

test('clientes: contagem é isolada por tenant', async () => {
  assert.equal(Number(await clientModels.countClients(A)), 1);
  assert.equal(Number(await clientModels.countClients(B)), 1);
});

test('clientes: exclusão lógica preserva pedido vinculado e permite restauração', async () => {
  const client = await clientModels.createClient({
    tenant_id: A, name: 'Cliente com pedido', cpf: '33333333333', status: 'fechado',
  });
  const order = (await pool.query(
    'INSERT INTO orders (tenant_id, client_id) VALUES ($1, $2) RETURNING *',
    [A, client.id]
  )).rows[0];

  const archived = await clientModels.deleteClient(client.id, A, null, 'Cadastro duplicado');
  assert.ok(archived.deleted_at, 'cliente deve ser marcado como excluído');
  assert.equal(await clientModels.getClientById(client.id, A), undefined, 'cliente excluído não aparece como ativo');
  assert.ok((await clientModels.getAllClients(A, { archived: true })).some((item) => item.id === client.id));
  assert.ok((await pool.query('SELECT id FROM orders WHERE id = $1', [order.id])).rows[0], 'pedido deve continuar existindo');

  const restored = await clientModels.restoreClient(client.id, A);
  assert.equal(restored.deleted_at, null);
  assert.ok(await clientModels.getClientById(client.id, A));

  await pool.query('DELETE FROM orders WHERE id = $1', [order.id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [client.id]);
});

// ─────────────────────────── PROCESSOS (fines) ───────────────────────────
test('processos: listar retorna somente do próprio tenant', async () => {
  const listA = await fineModels.getAllFines(A);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].id, fineA.id);
});

test('processos: ler por ID de outro tenant → não encontra', async () => {
  assert.equal(await fineModels.getFineById(fineB.id, A), undefined);
  assert.ok(await fineModels.getFineById(fineA.id, A), 'sanidade: encontra o próprio');
});

test('processos: alterar status de outro tenant → 0 linhas e status preservado', async () => {
  const upd = await fineModels.updateFineStatus(fineB.id, 'deferido', A);
  assert.equal(upd, undefined);
  const still = await fineModels.getFineById(fineB.id, B);
  assert.equal(still.status, 'pendente');
});

test('processos: excluir de outro tenant → 0 linhas e registro preservado', async () => {
  const del = await fineModels.deleteFine(fineB.id, A);
  assert.equal(del, undefined);
  assert.ok(await fineModels.getFineById(fineB.id, B), 'processo do outro tenant deve continuar existindo');
});
