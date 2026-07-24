'use strict';
// =============================================================================
// SISV — Módulo documental: categorias por tenant, metadados, soft-delete e
// ISOLAMENTO entre tenants (documentos do processo e do cliente).
// =============================================================================
process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let cfg, fineDocs, clientDocs, pool;
const A = 'tenant-A';
const B = 'tenant-B';
let fineA, catA, cliA;

before(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });

  db.public.none(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT);
    CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT);
    CREATE TABLE fines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, client_id UUID, fine_number TEXT);
    CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE);
    CREATE TABLE process_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_final BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE);
    CREATE TABLE process_statuses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_pending BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE);
    CREATE TABLE tenant_service_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE);
    CREATE TABLE document_categories (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, description TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE fine_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, name TEXT, file_url TEXT, file_type TEXT, file_size BIGINT, category TEXT, category_id UUID, notes TEXT, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, contract_id UUID, client_id UUID, company_id UUID, vehicle_id UUID, file_url TEXT, file_name TEXT, file_type TEXT, file_size BIGINT, category TEXT, description TEXT, category_id UUID, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now());
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();
  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId); stub.filename = dbId; stub.loaded = true; stub.exports = pool;
  require.cache[dbId] = stub;

  cfg = require('../models/tenantConfigModels');
  fineDocs = require('../models/fineDocumentModels');
  clientDocs = require('../models/documentModels');

  await pool.query(`INSERT INTO tenants (id,name) VALUES ($1,'A'),($2,'B')`, [A, B]);
  cliA = (await pool.query(`INSERT INTO clients (tenant_id,name) VALUES ($1,'Cliente A') RETURNING id`, [A])).rows[0].id;
  fineA = (await pool.query(`INSERT INTO fines (tenant_id,client_id,fine_number) VALUES ($1,$2,'A-1') RETURNING id`, [A, cliA])).rows[0].id;
  catA = (await cfg.createDocumentCategory({ tenant_id: A, name: 'CNH', color: '#16a34a' })).id;
});

test('categorias de documento: criação e isolamento', async () => {
  await cfg.createDocumentCategory({ tenant_id: B, name: 'Procuração' });
  const listA = await cfg.listDocumentCategories(A);
  assert.ok(listA.some((c) => c.name === 'CNH'));
  assert.ok(!listA.some((c) => c.name === 'Procuração'), 'A não vê categoria de B');
  const full = await cfg.getFullConfig(A);
  assert.ok(Array.isArray(full.documentCategories));
});

test('documento do processo: cria com categoria e metadados', async () => {
  const doc = await fineDocs.createFineDocument({
    tenant_id: A, fine_id: fineA, name: 'cnh.pdf', file_url: 'http://x/uploads/tenant-A/uuid.pdf',
    file_type: 'application/pdf', file_size: 1000, category_id: catA, notes: 'frente e verso',
    stored_name: 'uuid.pdf', original_name: 'cnh.pdf', uploaded_by: null,
  });
  assert.equal(doc.category_id, catA);
  assert.equal(doc.status, 'ativo');
  const list = await fineDocs.getDocumentsByFine(fineA, A);
  assert.equal(list[0].category_name, 'CNH', 'JOIN traz o nome da categoria');
});

test('documento do processo: arquivar, restaurar e remover (soft)', async () => {
  const d = await fineDocs.createFineDocument({ tenant_id: A, fine_id: fineA, name: 'temp.pdf', file_url: 'u', uploaded_by: null });
  await fineDocs.archiveFineDocument(d.id, A);
  let one = await fineDocs.getDocumentById(d.id, A);
  assert.equal(one.status, 'arquivado');
  // arquivado ainda aparece na lista (só removido some)
  assert.ok((await fineDocs.getDocumentsByFine(fineA, A)).some((x) => x.id === d.id));
  await fineDocs.restoreFineDocument(d.id, A);
  assert.equal((await fineDocs.getDocumentById(d.id, A)).status, 'ativo');
  // soft-remove: some da lista padrão, preserva a linha
  await fineDocs.softRemoveFineDocument(d.id, A, null);
  assert.ok(!(await fineDocs.getDocumentsByFine(fineA, A)).some((x) => x.id === d.id), 'removido não aparece por padrão');
  assert.ok((await fineDocs.getDocumentsByFine(fineA, A, { includeRemoved: true })).some((x) => x.id === d.id), 'aparece com includeRemoved');
  const still = await fineDocs.getDocumentById(d.id, A);
  assert.equal(still.status, 'removido', 'linha preservada (não apagada fisicamente)');
});

test('documento do processo: isolamento entre tenants', async () => {
  const d = await fineDocs.createFineDocument({ tenant_id: A, fine_id: fineA, name: 'a.pdf', file_url: 'u', uploaded_by: null });
  assert.equal(await fineDocs.getDocumentById(d.id, B), undefined, 'B não lê doc de A');
  assert.equal(await fineDocs.archiveFineDocument(d.id, B), undefined, 'B não arquiva doc de A');
  assert.equal(await fineDocs.softRemoveFineDocument(d.id, B, null), undefined, 'B não remove doc de A');
  assert.equal((await fineDocs.getDocumentById(d.id, A)).status, 'ativo', 'doc de A intacto');
});

test('documento do cliente: cria com categoria e soft-delete isolado', async () => {
  const doc = await clientDocs.createDocument({
    tenant_id: A, client_id: cliA, file_url: 'http://x/uploads/tenant-A/u.pdf', file_name: 'rg.pdf',
    file_type: 'application/pdf', file_size: 500, category: 'outros', category_id: catA, stored_name: 'u.pdf', original_name: 'rg.pdf', uploaded_by: null,
  });
  const listA = await clientDocs.getDocumentsByClient(cliA, A);
  assert.equal(listA[0].category_name, 'CNH');
  // B não remove
  assert.equal(await clientDocs.softRemoveDocument(doc.id, B, null), undefined);
  // A remove (soft) → some da listagem padrão
  await clientDocs.softRemoveDocument(doc.id, A, null);
  assert.equal((await clientDocs.getDocumentsByClient(cliA, A)).length, 0);
  assert.equal((await clientDocs.getDocumentsByClient(cliA, A, { includeRemoved: true })).length, 1);
});
