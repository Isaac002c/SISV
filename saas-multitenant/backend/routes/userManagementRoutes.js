'use strict';

const express = require('express');
const router = express.Router();
const permissionModel = require('../models/permissionModels');
const { checkPermission, requireAdmin, getAllRoles } = require('../middlewares/checkPermission');
const saasModel = require('../models/saasModels');
const pool = require('../config/db');
const {
  USER_MODULES,
  ACCESS_PROFILES,
  normalizeModules,
  getProfile,
} = require('../config/accessControl');

const USER_LIMIT_ERROR = 'USER_LIMIT_REACHED';
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

const isUserLimitError = (err) => [err?.message, err?.detail]
  .some((value) => String(value || '').includes(USER_LIMIT_ERROR));

const capacityError = (capacity) => ({
  success: false,
  code: USER_LIMIT_ERROR,
  error: `O limite de ${capacity.limit} usuários ativos foi atingido. Desative um usuário antes de criar ou reativar outro.`,
  capacity,
});

const fail = (res, err) => {
  console.error('[users-management]', err?.message || err);
  if (isUserLimitError(err)) {
    return res.status(409).json({
      success: false,
      code: USER_LIMIT_ERROR,
      error: 'O limite de usuários ativos foi atingido. Desative um usuário antes de criar ou reativar outro.',
    });
  }
  return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
};

const validateDepartment = async (tenantId, departmentId) => {
  if (!departmentId) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM departments WHERE id=$1 AND tenant_id=$2 AND active=TRUE',
    [departmentId, tenantId]
  );
  return Boolean(rows[0]);
};

const resolveAccess = ({ access_profile, module_access, backoffice_level }, { required = false } = {}) => {
  if (!access_profile && !required) return null;

  const profile = getProfile(access_profile || 'sales');
  if (!profile) {
    const error = new Error('Perfil de acesso inválido.');
    error.status = 400;
    throw error;
  }

  if (profile.key !== 'custom') {
    return {
      role: profile.role,
      access_profile: profile.key,
      module_access: [...profile.modules],
      backoffice_level: profile.backofficeLevel,
    };
  }

  const modules = normalizeModules(module_access);
  if (!modules || modules.length === 0) {
    const error = new Error('Selecione ao menos um módulo para o perfil personalizado.');
    error.status = 400;
    throw error;
  }

  let level = Number(backoffice_level || 0);
  if (!Number.isInteger(level) || level < 0 || level > 2) {
    const error = new Error('Nível de Back Office inválido.');
    error.status = 400;
    throw error;
  }
  if (!modules.includes('backoffice')) level = 0;

  return {
    role: 'operator',
    access_profile: 'custom',
    module_access: modules,
    backoffice_level: level,
  };
};

router.get('/', checkPermission('users:read'), async (req, res) => {
  try {
    const users = await permissionModel.getUsersWithRoles(req.tenantId);
    res.json({ success: true, data: users });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/stats', checkPermission('users:read'), async (req, res) => {
  try {
    const [stats, capacity] = await Promise.all([
      permissionModel.getUsersStats(req.tenantId),
      permissionModel.getTenantUserCapacity(req.tenantId),
    ]);
    res.json({ success: true, data: { stats, ...capacity } });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/access-options', checkPermission('users:read'), (_req, res) => {
  res.json({
    success: true,
    data: {
      modules: USER_MODULES.map(({ permissionPrefixes, ...module }) => module),
      profiles: ACCESS_PROFILES,
      max_backoffice_level: 2,
    },
  });
});

// Rota legada mantida para clientes antigos.
router.get('/roles', checkPermission('users:read'), (_req, res) => {
  const descriptions = {
    admin: 'Acesso total ao sistema',
    manager: 'Gestão da operação, distribuição e produtividade',
    operator: 'Operação de processos, documentos e pendências',
    seller: 'Operação de processos e sua fila de trabalho',
    viewer: 'Apenas visualização',
    front_office: 'Vendas e atendimento comercial',
    back_office: 'Conferência e operação de Back Office',
    sales_backoffice: 'Vendas e Back Office de primeiro nível',
    finance: 'Rotinas financeiras e pagamentos',
    operations: 'Execução operacional',
  };
  res.json({
    success: true,
    data: getAllRoles().map((name) => ({ name, description: descriptions[name] || '' })),
  });
});

router.get('/:id', checkPermission('users:read'), async (req, res) => {
  try {
    const user = await permissionModel.getUserById(req.params.id, req.tenantId);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    return res.json({ success: true, data: user });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name, username, phone = null, password, department_id = null,
      access_profile = 'sales', module_access, backoffice_level,
    } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ success: false, error: 'Nome, usuário de acesso e senha são obrigatórios.' });
    }
    if (!USERNAME_PATTERN.test(String(username).trim())) {
      return res.status(400).json({ success: false, error: 'O usuário deve usar apenas letras, números, ponto, hífen ou sublinhado.' });
    }
    if (password.length < 10) {
      return res.status(400).json({ success: false, error: 'A senha deve ter ao menos 10 caracteres.' });
    }
    if (phone && String(phone).trim().length > 30) {
      return res.status(400).json({ success: false, error: 'Telefone inválido.' });
    }
    if (!(await validateDepartment(req.tenantId, department_id))) {
      return res.status(400).json({ success: false, error: 'Setor inválido.' });
    }

    const capacity = await permissionModel.getTenantUserCapacity(req.tenantId);
    if (capacity.limit !== null && capacity.active >= capacity.limit) {
      return res.status(409).json(capacityError(capacity));
    }
    const access = resolveAccess({ access_profile, module_access, backoffice_level }, { required: true });

    if (await permissionModel.checkUsernameExists(username, req.tenantId)) {
      return res.status(409).json({ success: false, error: 'Usuário de acesso já está em uso.' });
    }
    const resolvedEmail = `${String(username).trim().toLowerCase()}@login.sisv.local`;

    const user = await permissionModel.createUser({
      tenant_id: req.tenantId,
      name: String(name).trim(),
      username: String(username).trim(),
      email: resolvedEmail,
      phone: phone ? String(phone).trim() : null,
      password,
      ...access,
      department_id: department_id || null,
    });

    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'create',
      entity_type: 'user',
      entity_id: user.id,
      description: `Usuário ${user.name} (${access.access_profile}) criado`,
      metadata: {
        username: user.username,
        access_profile: access.access_profile,
        modules: access.module_access,
      },
    });

    return res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    return fail(res, err);
  }
});

router.put('/:id', checkPermission('users:update'), async (req, res) => {
  try {
    const {
      name, username, phone, role, is_active, department_id,
      access_profile, module_access, backoffice_level,
    } = req.body;
    const currentUserRole = req.userRole;

    if (currentUserRole !== 'admin' && currentUserRole !== 'manager' && req.userId !== req.params.id) {
      return res.status(403).json({ success: false, error: 'Você só pode atualizar seu próprio perfil.' });
    }

    const existingUser = await permissionModel.getUserById(req.params.id, req.tenantId);
    if (!existingUser) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

    if (role !== undefined && (!getAllRoles().includes(role) || role === 'super_admin')) {
      return res.status(400).json({ success: false, error: 'Perfil inválido.' });
    }
    if (username !== undefined && !USERNAME_PATTERN.test(String(username).trim())) {
      return res.status(400).json({ success: false, error: 'O usuário deve usar apenas letras, números, ponto, hífen ou sublinhado.' });
    }
    if (phone && String(phone).trim().length > 30) {
      return res.status(400).json({ success: false, error: 'Telefone inválido.' });
    }
    if (currentUserRole === 'manager') {
      if (existingUser.role === 'admin') {
        return res.status(403).json({ success: false, error: 'Gestores não podem editar administradores.' });
      }
      if (role && role !== existingUser.role && (role === 'admin' || role === 'manager' || req.userId === req.params.id)) {
        return res.status(403).json({ success: false, error: 'Gestores não podem atribuir esse perfil ou alterar o próprio perfil.' });
      }
    }
    if (!(await validateDepartment(req.tenantId, department_id))) {
      return res.status(400).json({ success: false, error: 'Setor inválido.' });
    }
    if (username && username.toLowerCase() !== String(existingUser.username || '').toLowerCase()
        && await permissionModel.checkUsernameExists(username, req.tenantId, req.params.id)) {
      return res.status(409).json({ success: false, error: 'Usuário de acesso já está em uso.' });
    }
    if (is_active === false && existingUser.is_active !== false) {
      return res.status(400).json({ success: false, error: 'Use a ação de desativação para validar a carga de trabalho.' });
    }
    if (is_active === true && existingUser.is_active === false && currentUserRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Somente administrador pode reativar usuários.' });
    }
    if (is_active === true && existingUser.is_active === false) {
      const capacity = await permissionModel.getTenantUserCapacity(req.tenantId);
      if (capacity.limit !== null && capacity.active >= capacity.limit) {
        return res.status(409).json(capacityError(capacity));
      }
    }

    const access = resolveAccess(
      { access_profile, module_access, backoffice_level },
      { required: false }
    );
    const user = await permissionModel.updateUser(req.params.id, {
      name,
      username: username === undefined ? undefined : String(username).trim(),
      email: username === undefined
        ? undefined
        : `${String(username).trim().toLowerCase()}@login.sisv.local`,
      phone: phone === undefined ? undefined : (phone ? String(phone).trim() : null),
      role: access?.role ?? role,
      is_active,
      department_id,
      access_profile: access?.access_profile,
      module_access: access?.module_access,
      backoffice_level: access?.backoffice_level,
    }, req.tenantId);

    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'update',
      entity_type: 'user',
      entity_id: req.params.id,
      description: `Usuário ${user?.name || existingUser.name} atualizado`,
      metadata: {
        changes: {
          name, username, phone, role: access?.role ?? role, is_active, department_id,
          access_profile: access?.access_profile,
          module_access: access?.module_access,
          backoffice_level: access?.backoffice_level,
        },
      },
    });

    return res.json({ success: true, data: user });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    return fail(res, err);
  }
});

router.patch('/:id/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 10) {
      return res.status(400).json({ success: false, error: 'A senha deve ter ao menos 10 caracteres.' });
    }
    if (req.userRole !== 'admin' && req.userId !== req.params.id) {
      return res.status(403).json({ success: false, error: 'Você só pode alterar sua própria senha.' });
    }
    await permissionModel.updateUserPassword(req.params.id, password, req.tenantId);
    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'update_password',
      entity_type: 'user',
      entity_id: req.params.id,
      description: 'Senha atualizada',
    });
    return res.json({ success: true, message: 'Senha atualizada com sucesso.' });
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/:id/workload', checkPermission('users:read'), async (req, res) => {
  try {
    const user = await permissionModel.getUserById(req.params.id, req.tenantId);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
    return res.json({ success: true, data: await permissionModel.getUserWorkload(req.params.id, req.tenantId) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    if (req.userId === req.params.id) {
      return res.status(400).json({ success: false, error: 'Você não pode desativar seu próprio usuário.' });
    }
    const result = await permissionModel.deactivateUser(req.params.id, req.tenantId, {
      redistribute_to: req.body?.redistribute_to || null,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, error: result.error, workload: result.workload });
    }
    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'user_deactivated',
      entity_type: 'usuario',
      entity_id: req.params.id,
      entity_name: result.user.name,
      description: 'Usuário desativado',
      metadata: { workload: result.workload, redistributed_to: result.redistributed_to },
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return fail(res, err);
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (req.userId === req.params.id) {
      return res.status(400).json({ success: false, error: 'Você não pode excluir seu próprio usuário.' });
    }
    const result = await permissionModel.softDeleteUser(req.params.id, req.tenantId);
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, error: result.error });
    }
    await saasModel.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'user_deleted',
      entity_type: 'usuario',
      entity_id: req.params.id,
      entity_name: result.user.name,
      description: 'Usuário excluído',
      metadata: {
        preserved_history: true,
        username: result.original.username,
      },
    });
    return res.json({ success: true, message: 'Usuário excluído com sucesso.', data: result.user });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
