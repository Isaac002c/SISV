'use strict';
// =============================================================================
// SISV — Autorização no BACKEND dos recursos recentes (§13). Verifica o mapa de
// permissões por role e o comportamento dos middlewares checkPermission /
// requireAdmin para os endpoints críticos: distribuição em lote, documentos
// (arquivar/remover), reabertura, configurações e exportação.
// =============================================================================
process.env.JWT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkPermission, requireAdmin, getPermissionsByRole } = require('../middlewares/checkPermission');

// Executa um middleware com uma role e retorna { allowed, status }.
function run(mw, role) {
  return new Promise((resolve) => {
    const req = { userRole: role, tenantId: 't', userId: 'u' };
    const res = { status(s) { this._s = s; return this; }, json() { resolve({ allowed: false, status: this._s }); } };
    mw(req, res, () => resolve({ allowed: true, status: 200 }));
  });
}

test('mapa de permissões: operator opera processos mas NÃO exclui', () => {
  const op = getPermissionsByRole('operator');
  assert.ok(op.includes('fines:update'), 'operator move/redistribui/arquiva doc (fines:update)');
  assert.ok(op.includes('fines:create'), 'operator cria processo');
  assert.ok(!op.includes('fines:delete'), 'operator NÃO remove processo/doc (fines:delete)');
  assert.ok(!op.includes('users:create'), 'operator não cria usuários');
});

test('viewer é somente leitura', () => {
  const v = getPermissionsByRole('viewer');
  assert.ok(v.includes('fines:read'));
  assert.ok(!v.includes('fines:update'), 'viewer não altera nada');
});

test('checkPermission(fines:update): admin/manager/operator ok; viewer bloqueado', async () => {
  for (const role of ['admin', 'manager', 'operator', 'seller']) {
    assert.equal((await run(checkPermission('fines:update'), role)).allowed, true, `${role} pode fines:update`);
  }
  const blocked = await run(checkPermission('fines:update'), 'viewer');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, 403);
});

test('checkPermission(fines:delete): admin ok; operator/seller/viewer bloqueados', async () => {
  assert.equal((await run(checkPermission('fines:delete'), 'admin')).allowed, true);
  for (const role of ['operator', 'seller', 'viewer']) {
    assert.equal((await run(checkPermission('fines:delete'), role)).allowed, false,
      `${role} não remove documento/processo`);
  }
});

test('requireAdmin: só admin passa; operator/seller/viewer/manager bloqueados', async () => {
  assert.equal((await run(requireAdmin, 'admin')).allowed, true);
  // requireAdmin é estrito (só 'admin'); no SISV o gestor é 'admin'. Backend mais
  // restritivo que o frontend = direção segura.
  for (const role of ['operator', 'seller', 'viewer', 'manager']) {
    const r = await run(requireAdmin, role);
    assert.equal(r.allowed, false, `${role} bloqueado em rota admin (reabertura, config, remoção de doc do cliente)`);
    assert.equal(r.status, 403);
  }
});
