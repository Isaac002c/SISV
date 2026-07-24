'use strict';
// =============================================================================
// SISV — Validação de configuração no startup (config/env.js).
// Regra crítica: em produção o servidor não pode subir com segredo padrão,
// segredo curto, CORS aberto/curinga, modo demo ou seed automático.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../config/env');

// Executa validateEnv com um env isolado e restaura o original ao final.
function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const STRONG = 'a'.repeat(48);
const PROD_OK = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.local:5432/sisv?sslmode=require',
  JWT_SECRET: STRONG,
  FRONTEND_URL: 'https://app.exemplo.test',
  BASE_URL: 'https://api.exemplo.test',
};

test('produção: configuração completa é válida', () => {
  const r = withEnv(PROD_OK, validateEnv);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.isProd, true);
});

test('produção: falta DATABASE_URL ou JWT_SECRET → inválido', () => {
  const semDb = withEnv({ ...PROD_OK, DATABASE_URL: '' }, validateEnv);
  assert.equal(semDb.ok, false);
  assert.ok(semDb.errors.some((e) => /DATABASE_URL/.test(e)));

  const semJwt = withEnv({ ...PROD_OK, JWT_SECRET: '' }, validateEnv);
  assert.equal(semJwt.ok, false);
  assert.ok(semJwt.errors.some((e) => /JWT_SECRET/.test(e)));
});

test('produção: segredo padrão/conhecido é rejeitado', () => {
  for (const weak of ['TROQUE_ISSO_POR_UMA_CHAVE_SEGURA_DE_64_BYTES', 'sisv-demo-secret', 'changeme']) {
    const r = withEnv({ ...PROD_OK, JWT_SECRET: weak }, validateEnv);
    assert.equal(r.ok, false, `segredo "${weak}" deveria ser rejeitado`);
    assert.ok(r.errors.some((e) => /padrão|conhecido/i.test(e)));
  }
});

test('produção: segredo curto é rejeitado', () => {
  const r = withEnv({ ...PROD_OK, JWT_SECRET: 'curto123' }, validateEnv);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /curto/i.test(e)));
});

test('produção: CORS ausente ou com curinga é rejeitado', () => {
  const semOrigem = withEnv({ ...PROD_OK, FRONTEND_URL: '' }, validateEnv);
  assert.equal(semOrigem.ok, false);
  assert.ok(semOrigem.errors.some((e) => /CORS/i.test(e)));

  const curinga = withEnv({ ...PROD_OK, FRONTEND_URL: '*' }, validateEnv);
  assert.equal(curinga.ok, false);
  assert.ok(curinga.errors.some((e) => /curinga/i.test(e)));
});

test('produção: modo demo e seed automático são bloqueados', () => {
  const demo = withEnv({ ...PROD_OK, SISV_DEMO: '1' }, validateEnv);
  assert.equal(demo.ok, false);
  assert.ok(demo.errors.some((e) => /demonstração/i.test(e)));

  const seed = withEnv({ ...PROD_OK, SEED_ON_START: '1' }, validateEnv);
  assert.equal(seed.ok, false);
  assert.ok(seed.errors.some((e) => /[Ss]eed/.test(e)));
});

test('desenvolvimento: segredo fraco apenas avisa (não bloqueia)', () => {
  const r = withEnv({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://u:p@localhost:5432/sisv?sslmode=disable',
    JWT_SECRET: 'sisv-demo-secret',
  }, validateEnv);
  assert.equal(r.ok, true, 'dev não deve bloquear');
  assert.ok(r.warnings.length > 0, 'mas deve avisar');
});
