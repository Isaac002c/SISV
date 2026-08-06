'use strict';

const express = require('express');
const fields = require('../models/clientFieldModels');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, audit } = require('./helpers/commercialRouteUtils');

const router = express.Router();
const scope = 'client-fields';

const serviceIds = (value) => String(value || '').split(',').map((id) => id.trim()).filter(Boolean);

router.get('/', checkPermission('clients:read'), handle(scope, async (req, res) => {
  const data = await fields.listForServices(
    req.tenantId, serviceIds(req.query.service_ids), req.query.client_id
  );
  res.json({ success: true, data });
}));

router.post('/', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const field = await fields.createDefinition(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'client_field_created', entity_type: 'campo_cliente', entity_id: field.id,
    entity_name: field.label, description: 'Campo adicional de cliente criado',
    metadata: { field_key: field.field_key, field_type: field.field_type },
  });
  res.status(201).json({ success: true, data: field });
}));

router.put('/:id', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const field = await fields.updateDefinition(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'client_field_updated', entity_type: 'campo_cliente', entity_id: field.id,
    entity_name: field.label, description: 'Campo de cliente atualizado',
    metadata: { active: field.active, field_type: field.field_type },
  });
  res.json({ success: true, data: field });
}));

router.get('/services/:serviceId/requirements', checkPermission('catalog:read'), handle(scope, async (req, res) => {
  const data = await fields.getServiceRequirements(req.tenantId, req.params.serviceId);
  res.json({ success: true, data });
}));

router.put('/services/:serviceId/requirements', checkPermission('catalog:manage'), handle(scope, async (req, res) => {
  const data = await fields.setServiceRequirements(
    req.tenantId, req.userId, req.params.serviceId, req.body?.fields
  );
  await audit(req, {
    action: 'service_client_fields_updated', entity_type: 'servico', entity_id: req.params.serviceId,
    description: 'Campos obrigatorios do cliente atualizados',
    metadata: { field_count: data.fields.length },
  });
  res.json({ success: true, data });
}));

router.get('/orders/:orderId/validation', checkPermission('orders:read'), handle(scope, async (req, res) => {
  const data = await fields.validateOrderClient(require('../config/db'), req.tenantId, req.params.orderId);
  res.json({ success: true, data });
}));

module.exports = router;
