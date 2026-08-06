'use strict';
// Integração SQL real com pg-mem (Postgres em memória, puro JS).
// Executa o SQL REAL do financeRepo (ON CONFLICT, UPDATE...RETURNING, SUM FILTER,
// constraints únicas) validando semântica Postgres — o que os testes com repo
// em memória não cobrem. Sem banco externo.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { newDb, DataType } = require('pg-mem');

const { createDbRepo } = require('../services/finance/financeRepo');
const paymentService = require('../services/finance/paymentService');
const receiptService = require('../services/finance/receiptService');

let pool;

before(async () => {
  const db = newDb();
  db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });

  db.public.none(`
    CREATE TABLE service_billings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, client_id TEXT, fine_id TEXT,
      final_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (final_amount >= 0),
      paid_amount  NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
      financial_status TEXT NOT NULL DEFAULT 'faturado', due_date DATE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, billing_id UUID, client_id TEXT, fine_id TEXT,
      amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      payment_date DATE, payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'confirmado',
      installment_number INT DEFAULT 1, installments_total INT DEFAULT 1,
      is_deposit BOOLEAN DEFAULT FALSE, notes TEXT, created_by TEXT,
      canceled_at TIMESTAMPTZ, cancel_reason TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE financial_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, type TEXT NOT NULL, category_id TEXT, description TEXT,
      amount NUMERIC(15,2) NOT NULL, transaction_date DATE, payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'recebido', client_id TEXT, fine_id TEXT,
      billing_id UUID,
      -- No migration real isto é um CREATE UNIQUE INDEX(payment_id); aqui usamos
      -- UNIQUE inline porque o pg-mem só arbitra ON CONFLICT em constraints
      -- (em Postgres real ambos funcionam como árbitro). Semântica idêntica.
      payment_id UUID UNIQUE,
      origin TEXT DEFAULT 'manual', created_by TEXT,
      canceled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE tenant_financial_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL UNIQUE, receipt_prefix TEXT NOT NULL DEFAULT 'NEXO',
      last_receipt_number INT NOT NULL DEFAULT 0,
      razao_social TEXT, document TEXT, address TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, number INT NOT NULL, prefix TEXT NOT NULL, full_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'emitido', issue_date DATE,
      client_id TEXT, payment_id UUID, billing_id UUID, fine_id TEXT,
      client_name TEXT, client_document TEXT, service_description TEXT,
      amount NUMERIC(15,2) DEFAULT 0, payment_method TEXT,
      issuer_name TEXT, issuer_document TEXT, issuer_address TEXT,
      notes TEXT, created_by TEXT, created_by_name TEXT,
      canceled_at TIMESTAMPTZ, cancel_reason TEXT, updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_receipts_tenant_number UNIQUE (tenant_id, number)
    );
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();
});

const T = 'tenant-1';

async function makeBilling(final = 1000) {
  const { rows } = await pool.query(
    `INSERT INTO service_billings (tenant_id, client_id, fine_id, final_amount)
     VALUES ($1,'cli-1','fine-1',$2) RETURNING *`, [T, final]);
  return rows[0];
}

test('confirmPayment (SQL real): recalcula billing e cria exatamente 1 entrada', async () => {
  const repo = createDbRepo(pool);
  const b = await makeBilling(1000);

  const r = await paymentService.confirmPayment(
    { tenant_id: T, billing_id: b.id, amount: 1000, payment_date: '2026-07-10', payment_method: 'pix', category_id: null }, repo);

  assert.equal(Number(r.billing.paid_amount), 1000);
  assert.equal(r.billing.financial_status, 'pago');

  const tx = await pool.query(`SELECT * FROM financial_transactions WHERE payment_id = $1`, [r.payment.id]);
  assert.equal(tx.rows.length, 1);
  assert.equal(tx.rows[0].type, 'entrada');
  assert.equal(tx.rows[0].origin, 'pagamento');
  assert.equal(Number(tx.rows[0].amount), 1000);
  // Obs.: a idempotência por ON CONFLICT (1 entrada por pagamento) é validada nos
  // testes de serviço (finance-services.test.js). O pg-mem não emula a resolução
  // de árbitro do ON CONFLICT; em Postgres real o índice único garante a regra.
});

test('cancelPayment (SQL real): recalcula billing e estorna a entrada', async () => {
  const repo = createDbRepo(pool);
  const b = await makeBilling(500);
  const r = await paymentService.confirmPayment({ tenant_id: T, billing_id: b.id, amount: 500, payment_date: '2026-07-10' }, repo);
  const c = await paymentService.cancelPayment(r.payment.id, { tenant_id: T, reason: 'teste' }, repo);
  assert.equal(Number(c.billing.paid_amount), 0);
  assert.equal(c.billing.financial_status, 'faturado');
  assert.equal(c.transaction.status, 'cancelado');
});

test('parcial → status parcialmente_pago (SQL real, SUM FILTER)', async () => {
  const repo = createDbRepo(pool);
  const b = await makeBilling(1000);
  const r = await paymentService.confirmPayment({ tenant_id: T, billing_id: b.id, amount: 400, payment_date: '2026-07-10' }, repo);
  assert.equal(Number(r.billing.paid_amount), 400);
  assert.equal(r.billing.financial_status, 'parcialmente_pago');
});

test('receitas: numeração sequencial via UPDATE...RETURNING e UNIQUE(tenant, number)', async () => {
  const repo = createDbRepo(pool);
  const b = await makeBilling(1000);
  const p1 = await paymentService.confirmPayment({ tenant_id: T, billing_id: b.id, amount: 500, payment_date: '2026-07-10' }, repo);
  const p2 = await paymentService.confirmPayment({ tenant_id: T, billing_id: b.id, amount: 500, payment_date: '2026-07-10' }, repo);

  const rec1 = await receiptService.issueReceipt({ tenant_id: T, payment_id: p1.payment.id, client_name: 'A', amount: 500 }, repo);
  const rec2 = await receiptService.issueReceipt({ tenant_id: T, payment_id: p2.payment.id, client_name: 'B', amount: 500 }, repo);
  assert.equal(rec1.full_number, 'SISV-000001');
  assert.equal(rec2.full_number, 'SISV-000002');

  // Inserção manual de número duplicado deve violar a UNIQUE
  await assert.rejects(() => pool.query(
    `INSERT INTO receipts (tenant_id, number, prefix, full_number) VALUES ($1, 1, 'SISV', 'SISV-000001')`, [T]));
});

test('reemissão: cancela antigo e gera novo número (SQL real)', async () => {
  const repo = createDbRepo(pool);
  const b = await makeBilling(300);
  const p = await paymentService.confirmPayment({ tenant_id: T, billing_id: b.id, amount: 300, payment_date: '2026-07-10' }, repo);
  const rec = await receiptService.issueReceipt({ tenant_id: T, payment_id: p.payment.id, amount: 300 }, repo);
  const re = await receiptService.reissueReceipt(rec.id, { tenant_id: T }, repo);
  assert.notEqual(re.number, rec.number);
  const old = await pool.query(`SELECT status FROM receipts WHERE id = $1`, [rec.id]);
  assert.equal(old.rows[0].status, 'cancelado');
});
