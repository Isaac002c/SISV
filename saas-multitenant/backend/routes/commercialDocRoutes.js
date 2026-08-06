'use strict';

// =============================================================================
// commercialDocRoutes.js — documentos comerciais e encerramento:
//   /api/doc-templates      templates com variaveis autorizadas (§13)
//   /api/commercial-docs    documentos gerados/anexados e recibos (§13, §15, §31)
//   /api/contracts-op       contratos operacionais (§14)
//   /api/fiscal-documents   REGISTRO MANUAL de nota fiscal (§32)
//   /api/closure            finalizacao, arquivamento e reabertura (§30, §33)
//
// A rota de nota fiscal apenas GRAVA o que o usuario informou. Nao existe
// comunicacao com SEFAZ, prefeitura, NFS-e, NF-e ou provedor fiscal.
// =============================================================================

const express = require('express');
const router = express.Router();

const docs = require('../models/commercialDocModels');
const templateService = require('../services/templateService');
const { listHistory } = require('../services/commercialCommon');
const { checkPermission } = require('../middlewares/checkPermission');
const { handle, audit, sendCsv } = require('./helpers/commercialRouteUtils');

const scope = 'commercial-docs';

const DOCUMENT_ENTITY_PERMISSIONS = Object.freeze({
  order: 'orders:read',
  sale: 'sales:read',
  service_order: 'service_orders:read',
  client: 'clients:read',
  customer_payment: 'payments:register',
});

// O acesso ao módulo de documentos não concede acesso indireto a qualquer
// entidade relacionada. O vínculo escolhido também precisa estar autorizado.
const requireDocumentEntityAccess = (req, res, next) => {
  const permission = DOCUMENT_ENTITY_PERMISSIONS[req.body && req.body.entity_type];
  if (!permission) {
    return res.status(400).json({ success: false, error: 'Tipo de vínculo inválido.' });
  }
  return checkPermission(permission)(req, res, next);
};

// ── Templates ────────────────────────────────────────────────────────────────

const templates = express.Router();

templates.get('/fields', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: {
      available_fields: templateService.ALLOWED_FIELDS,
      doc_types: docs.DOC_TYPES,
      statuses: docs.TEMPLATE_STATUSES,
    },
  });
}));

templates.get('/', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  res.json({ success: true, ...(await docs.listTemplates(req.tenantId, req.query)) });
}));

templates.get('/:id', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  const template = await docs.getTemplate(req.tenantId, req.params.id);
  if (!template) return res.status(404).json({ success: false, error: 'Template nao encontrado.' });
  res.json({ success: true, data: template });
}));

templates.post('/', checkPermission('commercial_docs:templates'), handle(scope, async (req, res) => {
  const template = await docs.createTemplate(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'document_template_created', entity_type: 'template', entity_id: template.id,
    entity_name: template.name, description: 'Template de documento criado',
    metadata: { doc_type: template.doc_type, version: template.version },
  });
  res.status(201).json({ success: true, data: template });
}));

templates.put('/:id', checkPermission('commercial_docs:templates'), handle(scope, async (req, res) => {
  const template = await docs.updateTemplate(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'document_template_updated', entity_type: 'template', entity_id: template.id,
    entity_name: template.name, description: 'Template de documento atualizado',
    metadata: { status: template.status },
  });
  res.json({ success: true, data: template });
}));

templates.delete('/:id', checkPermission('commercial_docs:templates'), handle(scope, async (req, res) => {
  const template = await docs.deleteTemplate(
    req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'document_template_deleted', entity_type: 'template', entity_id: template.id,
    entity_name: template.name, description: 'Template excluido',
    metadata: { reason: req.body && req.body.reason },
  });
  res.json({ success: true, data: template });
}));

// ── Documentos gerados / anexados ────────────────────────────────────────────

const documents = express.Router();

documents.get('/', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  res.json({ success: true, ...(await docs.listDocuments(req.tenantId, req.query)) });
}));

documents.get('/:id', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  const document = await docs.getDocument(req.tenantId, req.params.id);
  if (!document) return res.status(404).json({ success: false, error: 'Documento nao encontrado.' });
  res.json({ success: true, data: document });
}));

documents.put('/:id', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const document = await docs.updateDocument(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'document_updated', entity_type: 'documento', entity_id: document.id,
    entity_name: document.title, description: 'Documento comercial atualizado',
  });
  res.json({ success: true, data: document });
}));

documents.post('/generate', checkPermission('commercial_docs:manage'), requireDocumentEntityAccess, handle(scope, async (req, res) => {
  const document = await docs.generateDocument(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'document_generated', entity_type: 'documento', entity_id: document.id,
    entity_name: document.title, description: 'Documento comercial gerado',
    // Guardamos o prefixo do checksum, nunca o conteudo do documento (§39).
    metadata: {
      doc_type: document.doc_type, template_version: document.template_version,
      checksum: String(document.checksum).slice(0, 12),
    },
  });
  res.status(201).json({ success: true, data: document });
}));

documents.post('/attach', checkPermission('commercial_docs:manage'), requireDocumentEntityAccess, handle(scope, async (req, res) => {
  const document = await docs.attachDocument(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'document_attached', entity_type: 'documento', entity_id: document.id,
    entity_name: document.title, description: 'Documento externo anexado',
    metadata: { doc_type: document.doc_type, stage: document.stage },
  });
  res.status(201).json({ success: true, data: document });
}));

documents.post('/:id/cancel', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const document = await docs.cancelDocument(
    req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'document_cancelled', entity_type: 'documento', entity_id: document.id,
    entity_name: document.title, description: 'Documento cancelado',
    metadata: { reason: req.body.reason },
  });
  res.json({ success: true, data: document });
}));

documents.delete('/:id', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const document = await docs.cancelDocument(
    req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'document_deleted', entity_type: 'documento', entity_id: document.id,
    entity_name: document.title, description: 'Documento excluido',
    metadata: { reason: req.body && req.body.reason },
  });
  res.json({ success: true, data: document });
}));

/** Recibo operacional de um pagamento aprovado — nao equivale a nota fiscal. */
documents.post('/receipts/:paymentId', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const receipt = await docs.issueReceipt(req.tenantId, req.userId, req.params.paymentId, req.body || {});
  await audit(req, {
    action: 'receipt_issued', entity_type: 'recibo', entity_id: receipt.id,
    entity_name: receipt.title, description: 'Recibo operacional emitido',
    metadata: { payment_id: req.params.paymentId },
  });
  res.status(201).json({ success: true, data: { ...receipt, disclaimer: docs.RECEIPT_DISCLAIMER } });
}));

// ── Contratos ────────────────────────────────────────────────────────────────

const contracts = express.Router();

contracts.get('/meta', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: { statuses: docs.CONTRACT_STATUSES } });
}));

contracts.get('/', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  const result = await docs.listContracts(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-contratos.csv');
  res.json({ success: true, ...result });
}));

contracts.post('/', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const contract = await docs.createContract(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'contract_created', entity_type: 'contrato', entity_id: contract.id,
    entity_name: contract.number, description: 'Contrato criado',
  });
  res.status(201).json({ success: true, data: contract });
}));

contracts.put('/:id', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const contract = await docs.updateContract(
    req.tenantId, req.userId, req.params.id, req.body || {}, req.body && req.body.row_version);
  await audit(req, {
    action: 'contract_updated', entity_type: 'contrato', entity_id: contract.id,
    entity_name: contract.number, description: `Contrato em ${contract.status}`,
    metadata: { status: contract.status },
  });
  res.json({ success: true, data: contract });
}));

contracts.post('/:id/replace', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const contract = await docs.replaceContract(req.tenantId, req.userId, req.params.id, req.body || {});
  await audit(req, {
    action: 'contract_replaced', entity_type: 'contrato', entity_id: contract.id,
    entity_name: contract.number, description: 'Contrato substituido',
    metadata: { previous_id: req.params.id },
  });
  res.status(201).json({ success: true, data: contract });
}));

contracts.delete('/:id', checkPermission('commercial_docs:manage'), handle(scope, async (req, res) => {
  const contract = await docs.deleteContract(
    req.tenantId, req.userId, req.params.id, req.body && req.body.reason);
  await audit(req, {
    action: 'contract_deleted', entity_type: 'contrato', entity_id: contract.id,
    entity_name: contract.number, description: 'Contrato excluido',
    metadata: { reason: req.body && req.body.reason },
  });
  res.json({ success: true, data: contract });
}));

contracts.get('/:id/history', checkPermission('commercial_docs:read'), handle(scope, async (req, res) => {
  res.json({ success: true, data: await listHistory(req.tenantId, 'contract', req.params.id, req.query) });
}));

// ── Nota fiscal: REGISTRO MANUAL (§32) ───────────────────────────────────────

const fiscal = express.Router();

fiscal.get('/meta', checkPermission('fiscal:read'), handle(scope, async (req, res) => {
  res.json({
    success: true,
    data: {
      statuses: docs.FISCAL_STATUSES,
      // Deixa explicito para a interface: aqui nao ha emissao, so registro.
      integration: 'nenhuma — registro manual, sem SEFAZ/prefeitura/NFS-e/NF-e',
    },
  });
}));

fiscal.get('/', checkPermission('fiscal:read'), handle(scope, async (req, res) => {
  const result = await docs.listFiscalDocuments(req.tenantId, req.query);
  if (req.query.format === 'csv') return sendCsv(res, result.rows, 'sisv-notas-fiscais.csv');
  res.json({ success: true, ...result });
}));

fiscal.post('/', checkPermission('fiscal:manage'), handle(scope, async (req, res) => {
  const document = await docs.upsertFiscalDocument(req.tenantId, req.userId, req.body || {});
  await audit(req, {
    action: 'fiscal_document_recorded', entity_type: 'nota_fiscal', entity_id: document.id,
    entity_name: document.number || 'sem numero',
    description: 'Nota fiscal registrada manualmente',
    metadata: { status: document.status, sale_id: document.sale_id },
  });
  res.json({ success: true, data: document });
}));

// ── Finalizacao e arquivamento ───────────────────────────────────────────────

const closure = express.Router();

closure.get('/checklist/:serviceOrderId', checkPermission('service_orders:read'), handle(scope, async (req, res) => {
  const checklist = await docs.finalizationChecklist(req.tenantId, req.params.serviceOrderId);
  if (!checklist) return res.status(404).json({ success: false, error: 'Ordem de servico nao encontrada.' });
  res.json({ success: true, data: checklist });
}));

closure.post('/finalize/:serviceOrderId', checkPermission('closure:finalize'), handle(scope, async (req, res) => {
  const record = await docs.finalize(req.tenantId, req.userId, req.params.serviceOrderId, req.body || {});
  await audit(req, {
    action: 'service_order_finalized', entity_type: 'ordem_servico',
    entity_id: req.params.serviceOrderId, description: 'Atendimento finalizado',
    metadata: { finalization_id: record.id },
  });
  res.status(201).json({ success: true, data: record });
}));

closure.post('/archive/:serviceOrderId', checkPermission('closure:archive'), handle(scope, async (req, res) => {
  const serviceOrder = await docs.archive(req.tenantId, req.userId, req.params.serviceOrderId);
  await audit(req, {
    action: 'service_order_archived', entity_type: 'ordem_servico', entity_id: serviceOrder.id,
    entity_name: serviceOrder.number, description: 'Atendimento arquivado',
  });
  res.json({ success: true, data: serviceOrder });
}));

// Reabertura: perfil autorizado (admin) + justificativa obrigatoria (§33).
closure.post('/reopen/:serviceOrderId', checkPermission('closure:reopen'), handle(scope, async (req, res) => {
  const serviceOrder = await docs.reopen(
    req.tenantId, req.userId, req.params.serviceOrderId, req.body && req.body.reason);
  await audit(req, {
    action: 'service_order_reopened', entity_type: 'ordem_servico', entity_id: serviceOrder.id,
    entity_name: serviceOrder.number, description: 'Atendimento reaberto',
    metadata: { reason: req.body.reason },
  });
  res.json({ success: true, data: serviceOrder });
}));

router.use('/doc-templates', templates);
router.use('/commercial-docs', documents);
router.use('/contracts-op', contracts);
router.use('/fiscal-documents', fiscal);
router.use('/closure', closure);

module.exports = router;
