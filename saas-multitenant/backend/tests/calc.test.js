'use strict';
// Testes das regras financeiras puras — rodam com `node --test` (sem banco).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../services/finance/calc');

// ── Dinheiro ──────────────────────────────────────────────────────────────
test('toCents converte number, string en e pt-BR', () => {
  assert.equal(calc.toCents(10.5), 1050);
  assert.equal(calc.toCents('10.50'), 1050);
  assert.equal(calc.toCents('1.234,56'), 123456);
  assert.equal(calc.toCents('1,234.56'), 123456);
  assert.equal(calc.toCents('R$ 1.000,00'), 100000);
  assert.equal(calc.toCents(''), 0);
  assert.equal(calc.toCents(null), 0);
  assert.equal(calc.toCents('0,01'), 1);
});

test('toCents não sofre erro de ponto flutuante', () => {
  assert.equal(calc.toCents(0.1) + calc.toCents(0.2), 30); // 0.1+0.2 problem
  assert.equal(calc.toCents('35.35'), 3535);
});

test('fromCents e roundMoney', () => {
  assert.equal(calc.fromCents(1050), 10.5);
  assert.equal(calc.roundMoney('10.999'), 11);
  assert.equal(calc.roundMoney(10.005), 10.01);
});

test('formatBRL formata no padrão brasileiro', () => {
  assert.equal(calc.formatBRL(1234.5), 'R$ 1.234,50');
  assert.equal(calc.formatBRL(0), 'R$ 0,00');
  assert.equal(calc.formatBRL(1000000), 'R$ 1.000.000,00');
  assert.equal(calc.formatBRL('99,9'), 'R$ 99,90');
});

// ── Faturamento ───────────────────────────────────────────────────────────
test('computeBilling: final = original - desconto + acréscimo', () => {
  const r = calc.computeBilling({ original: 1000, discount: 100, surcharge: 50 });
  assert.equal(r.finalAmount, 950);
  assert.equal(r.balance, 950);
});

test('computeBilling: saldo = final - pago', () => {
  const r = calc.computeBilling({ original: 1000, discount: 0, surcharge: 0, paid: 300 });
  assert.equal(r.finalAmount, 1000);
  assert.equal(r.balance, 700);
});

test('computeBilling rejeita valor final negativo', () => {
  assert.throws(() => calc.computeBilling({ original: 100, discount: 200 }), /negativo/);
});

test('computeBilling rejeita pago > final sem allowOverpay', () => {
  assert.throws(() => calc.computeBilling({ original: 100, paid: 150 }), /maior que o valor final/);
});

test('computeBilling permite overpay explícito', () => {
  const r = calc.computeBilling({ original: 100, paid: 150, allowOverpay: true });
  assert.equal(r.balance, -50);
});

// ── Status do faturamento ─────────────────────────────────────────────────
test('deriveBillingStatus cobre todos os casos', () => {
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 0, canceled: true }), 'cancelado');
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 100 }), 'pago');
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 40 }), 'parcialmente_pago');
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 0 }), 'faturado');
  // vencido (dueDate no passado, não quitado)
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 0, dueDate: '2020-01-01', referenceDate: '2020-02-01' }), 'vencido');
  // pago vence 'vencido'
  assert.equal(calc.deriveBillingStatus({ finalAmount: 100, paidAmount: 100, dueDate: '2020-01-01', referenceDate: '2020-02-01' }), 'pago');
});

// ── Semana ────────────────────────────────────────────────────────────────
test('getWeekRange retorna segunda→domingo (ISO)', () => {
  // 2026-07-10 é uma sexta-feira
  const r = calc.getWeekRange('2026-07-10');
  assert.equal(r.start, '2026-07-06'); // segunda
  assert.equal(r.end, '2026-07-12');   // domingo
});

test('getWeekRange em um domingo pertence à semana que começou na segunda anterior', () => {
  const r = calc.getWeekRange('2026-07-12'); // domingo
  assert.equal(r.start, '2026-07-06');
  assert.equal(r.end, '2026-07-12');
});

test('getWeekRange em uma segunda', () => {
  const r = calc.getWeekRange('2026-07-06');
  assert.equal(r.start, '2026-07-06');
  assert.equal(r.end, '2026-07-12');
});

test('getWeekRangeByOffset navega entre semanas', () => {
  const prev = calc.getWeekRangeByOffset(-1, '2026-07-10');
  assert.equal(prev.start, '2026-06-29');
  assert.equal(prev.end, '2026-07-05');
  const next = calc.getWeekRangeByOffset(1, '2026-07-10');
  assert.equal(next.start, '2026-07-13');
  assert.equal(next.end, '2026-07-19');
});

test('getMonthRange', () => {
  const r = calc.getMonthRange('2026-02-15');
  assert.equal(r.start, '2026-02-01');
  assert.equal(r.end, '2026-02-28');
});

test('formatDateBR', () => {
  assert.equal(calc.formatDateBR('2026-07-10'), '10/07/2026');
  assert.equal(calc.formatDateBR(''), '');
});

test('isOverdue', () => {
  assert.equal(calc.isOverdue('2020-01-01', '2020-02-01'), true);
  assert.equal(calc.isOverdue('2020-03-01', '2020-02-01'), false);
  assert.equal(calc.isOverdue(null), false);
});

// ── Parcelas ──────────────────────────────────────────────────────────────
test('splitInstallments soma exatamente o total', () => {
  const parts = calc.splitInstallments(100, 3);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts, [33.33, 33.33, 33.34]);
  const sum = parts.reduce((a, b) => calc.toCents(a) + b * 0 + calc.toCents(0) + Math.round(b * 100), 0);
  // soma em centavos deve ser 10000
  const totalCents = parts.reduce((a, b) => a + Math.round(b * 100), 0);
  assert.equal(totalCents, 10000);
});

test('splitInstallments com 1 parcela', () => {
  assert.deepEqual(calc.splitInstallments(250.75, 1), [250.75]);
});

test('splitInstallments rejeita n inválido', () => {
  assert.throws(() => calc.splitInstallments(100, 0), /parcelas inválido/);
});

// ── Recibo ────────────────────────────────────────────────────────────────
test('formatReceiptNumber', () => {
  assert.equal(calc.formatReceiptNumber('NEXO', 1), 'NEXO-000001');
  assert.equal(calc.formatReceiptNumber('CR', 123), 'CR-000123');
  assert.equal(calc.formatReceiptNumber('nexo', 999999), 'NEXO-999999');
  assert.equal(calc.formatReceiptNumber('', 5), 'SISV-000005');
  assert.equal(calc.formatReceiptNumber('n e x-o', 5), 'NEXO-000005');
});

// ── Valor por extenso ─────────────────────────────────────────────────────
test('valorPorExtenso casos básicos', () => {
  assert.equal(calc.valorPorExtenso(1), 'um real');
  assert.equal(calc.valorPorExtenso(2), 'dois reais');
  assert.equal(calc.valorPorExtenso(0), 'zero real');
  assert.equal(calc.valorPorExtenso(0.5), 'cinquenta centavos');
  assert.equal(calc.valorPorExtenso(0.01), 'um centavo');
  assert.equal(calc.valorPorExtenso(100), 'cem reais');
  assert.equal(calc.valorPorExtenso(101), 'cento e um reais');
});

test('valorPorExtenso com centavos', () => {
  assert.equal(calc.valorPorExtenso(1234.56),
    'mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
  assert.equal(calc.valorPorExtenso(1.99), 'um real e noventa e nove centavos');
});

test('valorPorExtenso milhares e milhões', () => {
  assert.equal(calc.valorPorExtenso(1000), 'mil reais');
  assert.equal(calc.valorPorExtenso(2000), 'dois mil reais');
  assert.equal(calc.valorPorExtenso(1000000), 'um milhão reais');
  assert.equal(calc.valorPorExtenso(2500), 'dois mil e quinhentos reais');
});
