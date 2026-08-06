// middlewares/checkPermission.js
// Middleware para verificar permissões do usuário
//
// SISV 2.0 (§38): além dos perfis originais (admin, manager, operator, seller,
// viewer), existem quatro perfis operacionais — front_office, back_office,
// finance e operations. O enforcement é SEMPRE no backend: o menu do frontend
// esconde o que a role não pode ver, mas quem recusa a escrita é esta camada.
//
// Permissões do domínio comercial (prefixos):
//   suppliers:*      cadastro de fornecedores/prestadores/parceiros
//   catalog:*        catálogo de serviços e produtos
//   pricing:*        tabelas de preço
//   orders:*         pedidos e itens
//   backoffice:*     filas e decisão de validação do pedido
//   receivables:*    contas a receber operacionais
//   payments:*       pagamentos do cliente (registrar / validar)
//   sales:*          vendas (confirmar / cancelar)
//   service_orders:* ordens de serviço e execução
//   payables:*       contas a pagar operacionais
//   commissions:*    comissões
//   fiscal:*         registro manual de nota fiscal
//   closure:*        finalização, arquivamento e reabertura
//   commercial_docs:* templates, documentos gerados, contratos e recibos

// Definição de permissões por role
const {
  ELEVATED_LEVEL_2_PERMISSIONS,
  hasModuleForPermission,
} = require('../config/accessControl');

const rolePermissions = {
  admin: [
    'users:create', 'users:read', 'users:update', 'users:delete',
    'clients:create', 'clients:read', 'clients:update', 'clients:delete',
    'companies:create', 'companies:read', 'companies:update', 'companies:delete',
    'contracts:create', 'contracts:read', 'contracts:update', 'contracts:delete',
    'documents:create', 'documents:read', 'documents:update', 'documents:delete',
    'fines:create', 'fines:read', 'fines:update', 'fines:delete',
    'reports:read', 'reports:export',
    'settings:read', 'settings:update',
    'billing:read', 'billing:update',
    'tasks:create', 'tasks:read', 'tasks:update', 'tasks:reopen',
    'operations:read', 'operations:manage',
    'audit:read', 'users:deactivate',
    'workflow:view', 'workflow:create', 'workflow:edit', 'workflow:publish',
    'workflow:disable', 'workflow:migrate', 'workflow:transition',
    'sla:view', 'sla:configure', 'sla:pause', 'sla:resume', 'sla:cancel', 'sla:dashboard',
    'automation:view', 'automation:create', 'automation:edit', 'automation:activate',
    'automation:disable', 'automation:reprocess',
    // Módulo Financeiro (enforcement real em middlewares/financeAccess.js).
    // Admin tem acesso completo; consultor/seller/super_admin não recebem estas permissões.
    'finance:read', 'finance:manage',
    // SISV 2.0 — domínio comercial completo.
    'suppliers:read', 'suppliers:manage',
    'catalog:read', 'catalog:manage',
    'pricing:read', 'pricing:manage',
    'orders:read', 'orders:create', 'orders:update', 'orders:cancel',
    'backoffice:read', 'backoffice:validate',
    'receivables:read', 'receivables:manage',
    'payments:register', 'payments:validate', 'payments:reverse',
    'sales:read', 'sales:confirm', 'sales:cancel',
    'service_orders:read', 'service_orders:manage', 'service_orders:execute',
    'payables:read', 'payables:manage', 'payables:pay',
    'commissions:read', 'commissions:confirm',
    'fiscal:read', 'fiscal:manage',
    'closure:finalize', 'closure:archive', 'closure:reopen',
    'commercial_docs:read', 'commercial_docs:manage', 'commercial_docs:templates'
  ],
  manager: [
    'clients:create', 'clients:read', 'clients:update',
    'companies:create', 'companies:read', 'companies:update',
    'contracts:create', 'contracts:read', 'contracts:update',
    'documents:create', 'documents:read', 'documents:update',
    'fines:create', 'fines:read', 'fines:update', 'fines:delete',
    'reports:read', 'reports:export',
    'tasks:create', 'tasks:read', 'tasks:update', 'tasks:reopen',
    'operations:read', 'operations:manage',
    'audit:read', 'users:read',
    'workflow:view', 'workflow:migrate', 'workflow:transition',
    'sla:view', 'sla:pause', 'sla:resume', 'sla:cancel', 'sla:dashboard',
    'automation:view',
    // Gestor (§38): acompanha todas as áreas, valida pedidos, confirma vendas,
    // distribui execução e aprova pagamentos. Não administra cadastros mestres
    // nem reabre atendimento arquivado — isso fica com o administrador.
    'suppliers:read', 'catalog:read', 'pricing:read',
    'orders:read', 'orders:create', 'orders:update', 'orders:cancel',
    'backoffice:read', 'backoffice:validate',
    'receivables:read', 'receivables:manage',
    'payments:register', 'payments:validate',
    'sales:read', 'sales:confirm', 'sales:cancel',
    'service_orders:read', 'service_orders:manage', 'service_orders:execute',
    'payables:read', 'payables:manage', 'payables:pay',
    'commissions:read', 'commissions:confirm',
    'fiscal:read', 'fiscal:manage',
    'closure:finalize', 'closure:archive',
    'commercial_docs:read', 'commercial_docs:manage'
  ],
  operator: [
    'clients:create', 'clients:read', 'clients:update',
    'companies:create', 'companies:read', 'companies:update',
    'contracts:create', 'contracts:read', 'contracts:update',
    'documents:create', 'documents:read',
    'fines:create', 'fines:read', 'fines:update',
    'tasks:create', 'tasks:read', 'tasks:update',
    'operations:read',
    'workflow:view', 'workflow:transition',
    'sla:view', 'sla:pause', 'sla:resume'
  ],
  seller: [
    'clients:create', 'clients:read', 'clients:update',
    'companies:create', 'companies:read', 'companies:update',
    'contracts:create', 'contracts:read', 'contracts:update',
    'documents:create', 'documents:read',
    'fines:create', 'fines:read', 'fines:update',
    'tasks:create', 'tasks:read', 'tasks:update',
    'operations:read',
    'workflow:view', 'workflow:transition',
    'sla:view', 'sla:pause', 'sla:resume'
  ],
  viewer: [
    'clients:read',
    'companies:read',
    'contracts:read',
    'documents:read',
    'fines:read',
    'reports:read',
    'tasks:read', 'operations:read',
    'workflow:view', 'sla:view',
    // Visualizador (§38): somente leitura dos módulos autorizados.
    'suppliers:read', 'catalog:read', 'pricing:read', 'orders:read',
    'receivables:read', 'sales:read', 'service_orders:read',
    'payables:read', 'commissions:read', 'fiscal:read', 'commercial_docs:read'
  ],

  // ── Perfis operacionais do SISV 2.0 (§38) ──────────────────────────────────

  // Atende o cliente: cadastra, monta pedido, gera documento, consulta andamento.
  // NÃO valida pedido, NÃO aprova pagamento e NÃO confirma venda.
  front_office: [
    'clients:create', 'clients:read', 'clients:update',
    'documents:create', 'documents:read',
    'fines:read', 'tasks:read', 'operations:read',
    'suppliers:read', 'catalog:read', 'pricing:read',
    'orders:read', 'orders:create', 'orders:update',
    'receivables:read', 'payments:register',
    'sales:read', 'service_orders:read',
    'commercial_docs:read', 'commercial_docs:manage',
    'workflow:view', 'sla:view'
  ],

  // Confere e decide: valida pedido, valida pagamento, confirma venda e abre a
  // ordem de serviço. NÃO administra catálogo, preços nem fornecedores.
  back_office: [
    'clients:read', 'documents:create', 'documents:read', 'documents:update',
    'fines:read', 'fines:update', 'tasks:create', 'tasks:read', 'tasks:update',
    'operations:read', 'reports:read',
    'suppliers:read', 'catalog:read', 'pricing:read',
    'orders:read', 'orders:update', 'orders:cancel',
    'backoffice:read', 'backoffice:validate',
    'receivables:read', 'receivables:manage',
    'payments:register', 'payments:validate',
    'sales:read', 'sales:confirm',
    'service_orders:read', 'service_orders:manage',
    'commercial_docs:read', 'commercial_docs:manage',
    'fiscal:read', 'workflow:view', 'sla:view'
  ],

  // Financeiro operacional: recebimentos, pagamentos, comissões e comprovantes.
  // NÃO confirma venda e NÃO executa ordem de serviço.
  finance: [
    'clients:read', 'documents:read', 'fines:read', 'operations:read',
    'reports:read', 'reports:export',
    'suppliers:read', 'suppliers:manage', 'catalog:read', 'pricing:read',
    'orders:read', 'backoffice:read',
    'receivables:read', 'receivables:manage',
    'payments:register', 'payments:validate', 'payments:reverse',
    'sales:read',
    'service_orders:read',
    'payables:read', 'payables:manage', 'payables:pay',
    'commissions:read', 'commissions:confirm',
    'fiscal:read', 'fiscal:manage',
    'commercial_docs:read'
  ],

  // Executa: ordens, processos, documentos, pendências e finalização.
  // NÃO valida pagamento, NÃO confirma venda e NÃO arquiva.
  operations: [
    'clients:read', 'clients:update',
    'documents:create', 'documents:read',
    'fines:create', 'fines:read', 'fines:update',
    'tasks:create', 'tasks:read', 'tasks:update',
    'operations:read',
    'suppliers:read', 'catalog:read',
    'orders:read', 'sales:read',
    'service_orders:read', 'service_orders:manage', 'service_orders:execute',
    'payables:read', 'fiscal:read', 'fiscal:manage',
    'closure:finalize',
    'commercial_docs:read', 'commercial_docs:manage',
    'workflow:view', 'workflow:transition', 'sla:view', 'sla:pause', 'sla:resume'
  ]
};

// Perfil combinado usado por quem atua em vendas e na triagem de Back Office.
// As acoes criticas da segunda etapa continuam protegidas por
// backoffice_level no middleware abaixo.
rolePermissions.sales_backoffice = [
  ...new Set([...rolePermissions.front_office, ...rolePermissions.back_office]),
];

/**
 * Middleware para verificar se o usuário tem uma permissão específica
 * @param {string} permission - Permissão necessária (ex: 'contracts:create')
 */
const checkPermission = (permission) => {
  return (req, res, next) => {
    try {
      const userRole = req.userRole || 'viewer';
      
      // Admin tem acesso a tudo
      if (userRole === 'admin') {
        return next();
      }
      
      // Verificar se a role existe
      const permissions = rolePermissions[userRole] || [];
      
      // Verificar permissão específica
      if (!permissions.includes(permission)) {
        console.warn(`[Permission] Usuário role=${userRole} tentou acessar ${permission}`);
        return res.status(403).json({ 
          success: false, 
          error: 'Você não tem permissão para realizar esta ação' 
        });
      }
      
      // module_access == NULL preserva usuarios legados. Quando o administrador
      // configura explicitamente os modulos, a permissao precisa pertencer a ao
      // menos um deles.
      if (!hasModuleForPermission(req.userModules, permission)) {
        return res.status(403).json({
          success: false,
          error: 'Este modulo nao esta habilitado para o seu perfil.',
          code: 'USER_MODULE_FORBIDDEN',
        });
      }

      // Nivel 1 executa triagem e registro; nivel 2 aprova, confirma ou reverte.
      if (Array.isArray(req.userModules)
          && ELEVATED_LEVEL_2_PERMISSIONS.has(permission)
          && Number(req.backofficeLevel || 0) < 2) {
        return res.status(403).json({
          success: false,
          error: 'Esta acao exige Back Office nivel 2.',
          code: 'BACKOFFICE_LEVEL_REQUIRED',
        });
      }

      next();
    } catch (error) {
      console.error('[Permission] Erro ao verificar permissão:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Erro ao verificar permissão' 
      });
    }
  };
};

/**
 * Middleware para verificar se o usuário é admin ou manager
 */
const requireAdminOrManager = (req, res, next) => {
  const userRole = req.userRole || 'viewer';
  
  if (userRole === 'admin' || userRole === 'manager') {
    return next();
  }
  
  return res.status(403).json({ 
    success: false, 
    error: 'Acesso restrito a administradores e gerentes' 
  });
};

/**
 * Middleware para verificar se o usuário é admin
 */
const requireAdmin = (req, res, next) => {
  const userRole = req.userRole || 'viewer';
  
  if (userRole === 'admin') {
    return next();
  }
  
  return res.status(403).json({ 
    success: false, 
    error: 'Acesso restrito a administradores' 
  });
};

/**
 * Retorna as permissões de uma role
 */
const getPermissionsByRole = (role) => {
  return rolePermissions[role] || [];
};

/**
 * Retorna todas as roles disponíveis
 */
const getAllRoles = () => {
  return Object.keys(rolePermissions);
};

module.exports = {
  checkPermission,
  requireAdminOrManager,
  requireAdmin,
  getPermissionsByRole,
  getAllRoles,
  rolePermissions
};

