'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://u:p@localhost:5432/db?sslmode=disable';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRegistration, normalizePortalAccess, redactPortalAccess,
  canViewPortalSecrets, clientForAudit,
} = require('../models/clientRegistration');

test('cadastro de cliente normaliza listas fechadas e limita responsável a PJ', () => {
  const pj = normalizeRegistration({
    client_type: 'PJ', category: 'EMPRESARIAL', cnh_category: 'ab',
    contact_preference: 'WHATSAPP', origin: 'INDICACAO', responsible_name: '  Ana  ',
  });
  assert.equal(pj.client_type, 'pj');
  assert.equal(pj.category, 'empresarial');
  assert.equal(pj.cnh_category, 'AB');
  assert.equal(pj.responsible_name, 'Ana');

  const pf = normalizeRegistration({ client_type: 'PF', responsible_name: 'Não deve ficar' });
  assert.equal(pf.responsible_name, null);
});

test('atualização parcial não apaga campos ausentes', () => {
  const partial = normalizeRegistration({ whatsapp: ' (21) 99999-0000 ' }, { partial: true });
  assert.deepEqual(partial, { whatsapp: '(21) 99999-0000' });
});

test('cadastro rejeita opção fora das respostas permitidas', () => {
  assert.throws(
    () => normalizeRegistration({ category: 'vip' }),
    /Categoria do cliente invalido/,
  );
});

test('acessos são saneados e senhas são redigidas para perfis de leitura', () => {
  const access = normalizePortalAccess({
    detran: { login: '  usuario ', password: ' senha ' },
    gov: { login: '', password: '' },
    outros: { label: 'Portal municipal', login: 'cidadao', password: '123' },
  });
  assert.deepEqual(access, {
    detran: { login: 'usuario', password: 'senha' },
    outros: { login: 'cidadao', password: '123', label: 'Portal municipal' },
  });
  assert.deepEqual(redactPortalAccess(access).detran, { login: 'usuario', has_password: true });
  assert.equal(canViewPortalSecrets('operations'), true);
  assert.equal(canViewPortalSecrets('viewer'), false);

  const audit = clientForAudit({ id: '1', portal_access: access });
  assert.deepEqual(audit.portal_access, { detran: true, gov: false, outros: true });
  assert.equal(JSON.stringify(audit).includes('senha'), false);
});
