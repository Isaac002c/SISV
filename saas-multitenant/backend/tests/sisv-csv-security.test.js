'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCsvValue, csvCell, toCsv } = require('../services/csvService');

test('CSV: neutraliza formulas inclusive depois de espaços e tabulações', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-10+20', '@cmd', '  =HYPERLINK("x")', '\t+1']) {
    assert.equal(sanitizeCsvValue(value).startsWith("'"), true, value);
  }
  assert.equal(sanitizeCsvValue('valor normal'), 'valor normal');
});

test('CSV: remove nulos e quebras de linha e escapa aspas/separador', () => {
  assert.equal(sanitizeCsvValue('a\u0000b\r\nc'), 'ab c');
  assert.equal(csvCell('A;"B"'), '"A;""B"""');
  assert.equal(sanitizeCsvValue(null), '');
});

test('CSV: preserva UTF-8, inclui BOM e serializa somente colunas autorizadas', () => {
  const csv = toCsv(
    [{ cliente: 'João', observacao: '=2+2', segredo: 'não exportar' }],
    [
      { label: 'Cliente', value: 'cliente' },
      { label: 'Observação', value: (row) => row.observacao },
    ]
  );
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /João/);
  assert.match(csv, /'=2\+2/);
  assert.doesNotMatch(csv, /não exportar/);
});

