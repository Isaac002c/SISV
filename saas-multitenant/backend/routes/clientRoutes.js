const express = require('express');
const router = express.Router();
const clientModel = require('../models/clientModels');
const clientFields = require('../models/clientFieldModels');
const {
  normalizeRegistration, normalizePortalAccess, canViewPortalSecrets,
  clientForViewer, clientForAudit,
} = require('../models/clientRegistration');
const { cleanOrNull } = require('../services/commercialCommon');
const { checkPermission } = require('../middlewares/checkPermission');
const activityLog = require('../services/activityLogService');

const presentClient = (req, client) =>
  clientForViewer(client, canViewPortalSecrets(req.userRole));
const presentClients = (req, clients) => clients.map((client) => presentClient(req, client));

const sendClientError = (res, err) => {
  if (err.code === '23505' && err.constraint === 'uq_clients_code') {
    return res.status(409).json({ success: false, error: 'Código do cliente já cadastrado.' });
  }
  return res.status(err.status || 500).json({ success: false, error: err.message });
};

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Apenas administradores podem consultar ou restaurar clientes excluídos' });
  }
  next();
};

// GET /api/clients - Listar todos os clientes
router.get('/', checkPermission('clients:read'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const archived = req.query.archived === '1';
    if (archived && req.userRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Apenas administradores podem consultar clientes excluídos' });
    }
    const clients = await clientModel.getAllClients(tenantId, { archived });
    res.json({ success: true, data: presentClients(req, clients) });
  } catch (err) {
    console.error('Erro ao buscar clientes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clients/search - Pesquisar clientes
router.get('/search', checkPermission('clients:read'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }
    
    const clients = await clientModel.searchClients(tenantId, q);
    res.json({ success: true, data: presentClients(req, clients) });
  } catch (err) {
    console.error('Erro ao pesquisar clientes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clients/stats - Estatísticas de clientes
router.get('/stats', checkPermission('clients:read'), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const total = await clientModel.countClients(tenantId);
    res.json({ success: true, data: { total } });
  } catch (err) {
    console.error('Erro ao buscar stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients/:id/restore - Restaurar cliente excluído (somente admin)
router.post('/:id/restore', checkPermission('clients:update'), requireAdmin, async (req, res) => {
  try {
    const client = await clientModel.restoreClient(req.params.id, req.tenantId);
    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente excluído não encontrado' });
    }

    activityLog.logActivity({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'restore',
      entity_type: 'client',
      entity_id: client.id,
      description: `Cliente restaurado: ${client.name}`,
      metadata: { restored_data: clientForAudit(client) },
    }).catch(() => {});

    res.json({ success: true, data: presentClient(req, client), message: 'Cliente restaurado com sucesso' });
  } catch (err) {
    console.error('Erro ao restaurar cliente:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/clients/:id - Buscar cliente por ID
router.get('/:id', checkPermission('clients:read'), async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    
    const client = await clientModel.getClientById(id, tenantId);
    
    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }
    
    res.json({ success: true, data: presentClient(req, client) });
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/clients - Criar novo cliente
router.post('/', checkPermission('clients:create'), async (req, res) => {
  try {
    const { name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status } = req.body;
    const tenantId = req.tenantId;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    }

    // Normaliza CPF removendo máscara antes de salvar
    const cpfNormalized = cpf ? cpf.replace(/\D/g, '') : null;
    if (cpfNormalized && cpfNormalized.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF deve ter 11 dígitos' });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'E-mail inválido' });
    }

    // Verificar se CPF já existe no tenant
    if (cpfNormalized) {
      const existingClient = await clientModel.getClientByCPF(cpfNormalized, tenantId);
      if (existingClient) {
        return res.status(400).json({ success: false, error: 'CPF já cadastrado' });
      }
    }

    const additionalData = await clientFields.normalizeAdditionalData(tenantId, req.body.additional_data);
    const registration = normalizeRegistration(req.body);
    const portalAccess = normalizePortalAccess(req.body.portal_access) || {};
    const client = await clientModel.createClient({
      tenant_id: tenantId,
      name: name.trim(), birth_date, cpf: cpfNormalized, cnh, first_cnh,
      phone, email, address, notes,
      status: status || 'negociacao',
      additional_data: additionalData,
      client_code: cleanOrNull(req.body.client_code, 40),
      ...registration,
      portal_access: portalAccess,
    });

    // Histórico (§11) — registrado pelo backend; não bloqueia a operação.
    activityLog.logCreate(tenantId, req.userId, 'client', client.id,
      `Cliente cadastrado: ${client.name}`,
      { name: client.name, cpf: client.cpf, status: client.status }).catch(() => {});

    res.status(201).json({ success: true, data: presentClient(req, client) });
  } catch (err) {
    console.error('Erro ao criar cliente:', err);
    sendClientError(res, err);
  }
});

// PUT /api/clients/:id - Atualizar cliente
router.put('/:id', checkPermission('clients:update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, birth_date, cpf, cnh, first_cnh, phone, email, address, notes, status } = req.body;
    const tenantId = req.tenantId;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'E-mail inválido' });
    }

    const existingClient = await clientModel.getClientById(id, tenantId);
    if (!existingClient) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }

    // Normaliza CPF removendo máscara antes de salvar
    const cpfNormalized = cpf ? cpf.replace(/\D/g, '') : null;
    if (cpfNormalized && cpfNormalized.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF deve ter 11 dígitos' });
    }

    // Verificar se CPF já existe em outro cliente
    if (cpfNormalized && cpfNormalized !== existingClient.cpf) {
      const existingCPF = await clientModel.getClientByCPF(cpfNormalized, tenantId);
      if (existingCPF) {
        return res.status(400).json({ success: false, error: 'CPF já cadastrado para outro cliente' });
      }
    }

    const additionalData = await clientFields.normalizeAdditionalData(tenantId, req.body.additional_data);
    const registrationChanges = normalizeRegistration(req.body, { partial: true });
    const registration = {
      client_type: existingClient.client_type,
      category: existingClient.category,
      rg: existingClient.rg,
      cnh_category: existingClient.cnh_category,
      whatsapp: existingClient.whatsapp,
      contact_preference: existingClient.contact_preference,
      origin: existingClient.origin,
      responsible_name: existingClient.responsible_name,
      additional_info: existingClient.additional_info,
      ...registrationChanges,
    };
    if (registration.client_type !== 'pj') registration.responsible_name = null;
    const portalAccess = normalizePortalAccess(req.body.portal_access);
    const client = await clientModel.updateClient(id, {
      name: name.trim(), birth_date, cpf: cpfNormalized, cnh, first_cnh,
      phone, email, address, notes,
      status: status || existingClient.status || 'negociacao',
      additional_data: additionalData,
      client_code: Object.prototype.hasOwnProperty.call(req.body, 'client_code')
        ? cleanOrNull(req.body.client_code, 40) : existingClient.client_code,
      ...registration,
      portal_access: portalAccess,
    }, tenantId);

    // Histórico (§11) — registra o que mudou (old → new). Não bloqueia a operação.
    activityLog.logUpdate(tenantId, req.userId, 'client', id,
      `Cliente atualizado: ${client.name}`,
      clientForAudit(existingClient), clientForAudit(client)).catch(() => {});

    res.json({ success: true, data: presentClient(req, client) });
  } catch (err) {
    console.error('Erro ao atualizar cliente:', err);
    sendClientError(res, err);
  }
});

// DELETE /api/clients/:id - Deletar cliente
router.delete('/:id', checkPermission('clients:delete'), async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    
    const reason = String(req.body?.reason || '').trim() || null;
    const client = await clientModel.deleteClient(id, tenantId, req.userId, reason);

    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
    }

    // Histórico (§11) — registra a remoção com snapshot do dado. Não bloqueia a operação.
    activityLog.logDelete(tenantId, req.userId, 'client', id,
      `Cliente arquivado: ${client.name}`, { ...clientForAudit(client), reason }).catch(() => {});

    res.json({ success: true, data: presentClient(req, client), message: 'Cliente excluído com sucesso. O histórico foi preservado.' });
  } catch (err) {
    console.error('Erro ao deletar cliente:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

