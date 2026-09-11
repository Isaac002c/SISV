'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://u:p@localhost:5432/db?sslmode=disable';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRegistration, validateClientRequirements, normalizePortalAccess, redactPortalAccess,
  canViewPortalSecrets, clientForAudit,
} = require('../models/clientRegistration');

test('cadastro de cliente normaliza listas fechadas e fixa pessoa fisica', () => {
  const pf = normalizeRegistration({
    client_type: 'PJ', category: 'EMPRESARIAL', cnh_category: 'ab',
    contact_preference: 'WHATSAPP', origin: 'INDICACAO', responsible_name: '  Ana  ',
  });
  assert.equal(pf.client_type, 'pf');
  assert.equal(pf.category, 'empresarial');
  assert.equal(pf.cnh_category, 'AB');
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

test('categoria define origem obrigatoria, exceto para parceiro', () => {
  const regular = normalizeRegistration({ category: 'standard', origin: 'campanha' });
  assert.doesNotThrow(() => validateClientRequirements({ ...regular, cpf: '12345678901' }));
  assert.throws(
    () => validateClientRequirements({ category: 'standard', cpf: '12345678901' }),
    /Origem do cliente e obrigatoria/,
  );
  const partner = normalizeRegistration({ category: 'parceiro', origin: 'indicacao' });
  assert.equal(partner.origin, null);
  assert.doesNotThrow(() => validateClientRequirements({ ...partner, cpf: '12345678901' }));
});

test('acessos são saneados e senhas são redigidas para perfis de leitura', () => {
  const access = normalizePortalAccess({
    detran: { login: '  usuario ', password: ' senha ' },
    gov: { login: '', password: '' },
    outros: { label: 'Portal municipal', login: 'cidadao', password: '123' },
  }, { cpf: '123.456.789-01' });
  assert.deepEqual(access, {
    detran: { login: '12345678901', password: 'senha' },
    outros: { login: 'cidadao', password: '123', label: 'PORTAL MUNICIPAL' },
  });
  assert.deepEqual(redactPortalAccess(access).detran, { login: '12345678901', has_password: true });
  assert.equal(canViewPortalSecrets('operations'), true);
  assert.equal(canViewPortalSecrets('viewer'), false);

  const audit = clientForAudit({ id: '1', portal_access: access });
  assert.deepEqual(audit.portal_access, { detran: true, gov: false, outros: true });
  assert.equal(JSON.stringify(audit).includes('senha'), false);
});
