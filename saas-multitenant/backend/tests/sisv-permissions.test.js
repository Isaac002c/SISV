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
const {
  checkPermission,
  requireAdmin,
  requireAdminOrManager,
  getPermissionsByRole,
} = require('../middlewares/checkPermission');

// Executa um middleware com uma role e retorna { allowed, status }.
function run(mw, role, extra = {}) {
  return new Promise((resolve) => {
    const req = { userRole: role, tenantId: 't', userId: 'u', ...extra };
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

test('matriz operacional: gestor administra operação; operacional não acessa governança', () => {
  const manager = getPermissionsByRole('manager');
  assert.ok(manager.includes('tasks:reopen'));
  assert.ok(manager.includes('operations:manage'));
  assert.ok(manager.includes('audit:read'));
  assert.ok(manager.includes('users:read'));
  assert.ok(!manager.includes('users:create'));
  assert.ok(!manager.includes('users:update'));

  for (const role of ['operator', 'seller']) {
    const permissions = getPermissionsByRole(role);
    assert.ok(permissions.includes('tasks:update'));
    assert.ok(permissions.includes('operations:read'));
    assert.ok(!permissions.includes('operations:manage'));
    assert.ok(!permissions.includes('audit:read'));
    assert.ok(!permissions.includes('users:update'));
  }
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

test('requireAdminOrManager protege lote, reabertura, auditoria e qualidade', async () => {
  for (const role of ['admin', 'manager']) {
    assert.equal((await run(requireAdminOrManager, role)).allowed, true);
  }
  for (const role of ['operator', 'seller', 'viewer']) {
    const result = await run(requireAdminOrManager, role);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
  }
});

test('módulos individuais bloqueiam áreas fora do perfil', async () => {
  const sales = { userModules: ['sales'], backofficeLevel: 0, accessProfile: 'sales' };
  assert.equal((await run(checkPermission('orders:create'), 'front_office', sales)).allowed, true);
  assert.equal((await run(checkPermission('backoffice:read'), 'front_office', sales)).allowed, false);

  const mixed = { userModules: ['sales', 'backoffice'], backofficeLevel: 1, accessProfile: 'sales_backoffice_l1' };
  assert.equal((await run(checkPermission('orders:create'), 'sales_backoffice', mixed)).allowed, true);
  assert.equal((await run(checkPermission('backoffice:read'), 'sales_backoffice', mixed)).allowed, true);
  assert.equal((await run(checkPermission('payments:read'), 'sales_backoffice', mixed)).allowed, false);

  assert.equal((await run(checkPermission('service_orders:read'), 'front_office', sales)).allowed, false,
    'Vendas não acessa ordens de serviço');
  assert.equal((await run(checkPermission('service_orders:read'), 'sales_backoffice', mixed)).allowed, false,
    'Back Office sem módulo Operação não acessa ordens de serviço');

  const operation = { userModules: ['operations'], backofficeLevel: 0, accessProfile: 'custom' };
  assert.equal((await run(checkPermission('service_orders:read'), 'operations', operation)).allowed, true);
  assert.equal((await run(checkPermission('orders:read'), 'operations', operation)).allowed, false,
    'Operação não ganha acesso indireto a Pedidos');

  const backoffice = { userModules: ['backoffice'], backofficeLevel: 1, accessProfile: 'backoffice_l1' };
  assert.equal((await run(checkPermission('commercial_docs:read'), 'back_office', backoffice)).allowed, true,
    'Back Office pode conferir documentos sem receber acesso à Operação');
});

test('aprovação crítica do Back Office exige nível 2', async () => {
  const levelOne = { userModules: ['backoffice'], backofficeLevel: 1, accessProfile: 'backoffice_l1' };
  const levelTwo = { userModules: ['backoffice'], backofficeLevel: 2, accessProfile: 'custom' };
  assert.equal((await run(checkPermission('backoffice:validate'), 'back_office', levelOne)).allowed, false);
  assert.equal((await run(checkPermission('backoffice:validate'), 'back_office', levelTwo)).allowed, true);
  assert.equal((await run(checkPermission('backoffice:validate'), 'admin', levelOne)).allowed, true);
});

test('clientes por servico e parceiros respeitam as fronteiras comerciais', async () => {
  assert.equal((await run(checkPermission('catalog:manage'), 'admin')).allowed, true,
    'admin configura campos e requisitos do servico');
  assert.equal((await run(checkPermission('catalog:manage'), 'manager')).allowed, false,
    'gestor operacional nao altera cadastro mestre');

  for (const permission of ['clients:read', 'suppliers:read', 'pricing:read', 'orders:create']) {
    assert.equal((await run(checkPermission(permission), 'front_office')).allowed, true,
      `front office possui ${permission}`);
  }
  assert.equal((await run(checkPermission('suppliers:manage'), 'front_office')).allowed, false);
  assert.equal((await run(checkPermission('catalog:manage'), 'front_office')).allowed, false);
  assert.equal((await run(checkPermission('pricing:read'), 'operations')).allowed, false,
    'operacao nao recebe condicoes comerciais do seletor de parceiros');
});
