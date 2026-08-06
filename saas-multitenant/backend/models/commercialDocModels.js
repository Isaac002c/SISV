'use strict';

// =============================================================================
// commercialDocModels.js — templates, documentos gerados (§13), contratos (§14),
// recibos operacionais (§15), nota fiscal como REGISTRO (§32), finalizacao (§30)
// e arquivamento (§33).
//
// Sobre nota fiscal: NAO ha integracao com SEFAZ, prefeitura, NFS-e ou NF-e.
// O sistema apenas registra numero, serie, chave, datas e arquivos informados
// manualmente pelo usuario. Nenhum documento fiscal e emitido pelo SISV.
//
// Recibo operacional NAO e nota fiscal — o texto padrao e a interface deixam
// essa distincao explicita (§15).
// =============================================================================

const pool = require('../config/db');
const templates = require('../services/templateService');
const {
  clean, cleanOrNull, money, bool, uuidOrNull, oneOf, dateOrNull, paging,
  nextNumber, recordHistory, lockRow, withTransaction, BusinessError,
} = require('../services/commercialCommon');

const DOC_TYPES = Object.freeze(['ordem_servico', 'recibo', 'contrato', 'formulario', 'termo', 'protocolo', 'personalizado']);
const TEMPLATE_STATUSES = Object.freeze(['rascunho', 'publicado', 'inativo']);
const DOC_STAGES = Object.freeze(['atendimento', 'pedido', 'pagamento', 'venda', 'execucao', 'finalizacao']);
const DOC_STATUSES = Object.freeze(['gerado', 'anexado', 'cancelado', 'substituido']);
const CONTRACT_STATUSES = Object.freeze(['rascunho', 'gerado', 'enviado', 'assinado', 'recusado', 'cancelado', 'substituido']);
const ENTITY_TYPES = Object.freeze(['order', 'sale', 'service_order', 'client', 'customer_payment']);
const FISCAL_STATUSES = Object.freeze(['nao_aplicavel', 'pendente', 'solicitada', 'emitida', 'cancelada', 'substituida']);

const RECEIPT_DISCLAIMER =
  'Recibo operacional de servico. Este documento NAO substitui nota fiscal.';

/** Arquivos comerciais precisam ter sido recebidos pela rota de upload do tenant. */
function internalUploadUrl(tenantId, value, { required = false } = {}) {
  const fileUrl = cleanOrNull(value, 2000);
  if (!fileUrl && required) throw new BusinessError('Selecione um arquivo para enviar pela plataforma.');
  if (fileUrl && !fileUrl.includes(`/uploads/${tenantId}/`)) {
    throw new BusinessError('Envie o arquivo pela plataforma. Links externos nao sao permitidos.');
  }
  return fileUrl;
}

// ── Templates ────────────────────────────────────────────────────────────────

async function listTemplates(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['t.tenant_id = $1'];
  const params = [tenantId];
  const docType = oneOf(query.doc_type, DOC_TYPES, null);
  if (docType) { params.push(docType); filters.push(`t.doc_type = $${params.length}`); }
  const status = oneOf(query.status, TEMPLATE_STATUSES, null);
  if (status) { params.push(status); filters.push(`t.status = $${params.length}`); }
  else filters.push("t.status <> 'inativo'");
  const where = filters.join(' AND ');

  const { rows } = await pool.query(
    `SELECT t.*, u.name AS created_by_name FROM document_templates t
       LEFT JOIN users u ON u.id = t.created_by
      WHERE ${where} ORDER BY t.doc_type ASC, t.name ASC, t.version DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM document_templates t WHERE ${where}`, params);
  return { rows, total: countRows[0].total, page, limit, available_fields: templates.ALLOWED_FIELDS };
}

async function getTemplate(tenantId, id) {
  const templateId = uuidOrNull(id);
  if (!templateId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM document_templates WHERE id = $1 AND tenant_id = $2', [templateId, tenantId]);
  return rows[0] || null;
}

async function createTemplate(tenantId, userId, input) {
  const name = clean(input.name, 160);
  const docType = oneOf(input.doc_type, DOC_TYPES, null);
  if (!name) throw new BusinessError('Informe o nome do template.');
  if (!docType) throw new BusinessError('Selecione o tipo do documento.');

  const safety = templates.assertSafeBody(input.body);
  if (!safety.ok) throw new BusinessError(safety.error);

  return withTransaction(async (client) => {
    // Mesmo nome cria uma NOVA VERSAO; a anterior permanece intacta (§13).
    const { rows: versionRows } = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS version FROM document_templates WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
      [tenantId, name]);
    const version = Number(versionRows[0].version) + 1;

    const { rows } = await client.query(
      `INSERT INTO document_templates
         (tenant_id, name, doc_type, body, available_fields, version, status, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'rascunho',$7) RETURNING *`,
      [tenantId, name, docType, String(input.body), JSON.stringify(safety.fields), version, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'document_template', entity_id: rows[0].id,
      action: 'criado', to_status: 'rascunho', details: { name, doc_type: docType, version },
      user_id: userId,
    });
    return rows[0];
  });
}

async function updateTemplate(tenantId, userId, id, input, expectedVersion) {
  const templateId = uuidOrNull(id);
  if (!templateId) throw new BusinessError('Template nao encontrado.', 404);

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'document_templates', tenantId, templateId, expectedVersion);
    if (!current) throw new BusinessError('Template nao encontrado.', 404);
    // Template publicado nao muda de corpo: crie uma nova versao.
    if (current.status === 'publicado' && input.body !== undefined) {
      throw new BusinessError('Template publicado nao pode ter o corpo alterado. Crie uma nova versao.');
    }

    let fields = current.available_fields;
    if (input.body !== undefined) {
      const safety = templates.assertSafeBody(input.body);
      if (!safety.ok) throw new BusinessError(safety.error);
      fields = safety.fields;
    }
    const status = oneOf(input.status, TEMPLATE_STATUSES, null);

    const { rows } = await client.query(
      `UPDATE document_templates
          SET name = COALESCE($3, name), body = COALESCE($4, body),
              available_fields = $5::jsonb, status = COALESCE($6, status),
              published_at = CASE WHEN $6 = 'publicado' AND published_at IS NULL THEN NOW() ELSE published_at END,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [templateId, tenantId, cleanOrNull(input.name, 160),
       input.body === undefined ? null : String(input.body),
       JSON.stringify(fields), status]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'document_template', entity_id: templateId,
      action: status && status !== current.status ? 'situacao_alterada' : 'atualizado',
      from_status: current.status, to_status: rows[0].status, user_id: userId,
    });
    return rows[0];
  });
}

async function deleteTemplate(tenantId, userId, id, reason) {
  const templateId = uuidOrNull(id);
  const justification = cleanOrNull(reason, 2000);
  if (!templateId) throw new BusinessError('Template nao encontrado.', 404);
  if (!justification) throw new BusinessError('Informe o motivo da exclusao.');
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'document_templates', tenantId, templateId);
    if (!current || current.status === 'inativo') {
      throw new BusinessError('Template nao encontrado ou ja excluido.', 404);
    }
    const { rows } = await client.query(
      `UPDATE document_templates SET status = 'inativo', row_version = row_version + 1,
              updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [templateId, tenantId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'document_template', entity_id: templateId,
      action: 'excluido', from_status: current.status, to_status: 'inativo',
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

// ── Contexto de renderizacao ─────────────────────────────────────────────────

/** Carrega o que o template pode precisar, conforme a entidade de origem. */
async function loadContext(tenantId, entityType, entityId) {
  const context = { tenant: null, client: null, order: null, items: [], sale: null, serviceOrder: null, payment: null, owner: null };
  const { rows: tenantRows } = await pool.query(
    'SELECT name, developer, tagline FROM tenants WHERE id = $1', [tenantId]);
  context.tenant = tenantRows[0] || null;

  if (entityType === 'order') {
    const { rows } = await pool.query(
      `SELECT o.*, u.name AS owner_name FROM orders o
         LEFT JOIN users u ON u.id = o.owner_id
        WHERE o.id = $1 AND o.tenant_id = $2`, [entityId, tenantId]);
    if (!rows[0]) return null;
    context.order = rows[0];
    context.owner = rows[0].owner_id ? { name: rows[0].owner_name } : null;
    const { rows: items } = await pool.query(
      `SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND status = 'ativo'
        ORDER BY sort_order`, [tenantId, entityId]);
    context.items = items;
    const { rows: receivables } = await pool.query(
      `SELECT COALESCE(SUM(received_amount),0) AS received FROM receivables
        WHERE tenant_id = $1 AND order_id = $2 AND status <> 'cancelado'`, [tenantId, entityId]);
    context.order.received_amount = Number(receivables[0].received);
    const { rows: clients } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [rows[0].client_id, tenantId]);
    context.client = clients[0] || null;
  } else if (entityType === 'sale') {
    const { rows } = await pool.query(
      `SELECT s.*, u.name AS owner_name FROM sales s
         LEFT JOIN users u ON u.id = s.owner_id
        WHERE s.id = $1 AND s.tenant_id = $2`, [entityId, tenantId]);
    if (!rows[0]) return null;
    context.sale = rows[0];
    context.owner = rows[0].owner_id ? { name: rows[0].owner_name } : null;
    const { rows: items } = await pool.query(
      'SELECT * FROM sale_items WHERE tenant_id = $1 AND sale_id = $2 ORDER BY sort_order',
      [tenantId, entityId]);
    context.items = items;
    const { rows: clients } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [rows[0].client_id, tenantId]);
    context.client = clients[0] || null;
    if (rows[0].order_id) {
      const { rows: orders } = await pool.query(
        'SELECT * FROM orders WHERE id = $1 AND tenant_id = $2', [rows[0].order_id, tenantId]);
      context.order = orders[0] || null;
    }
  } else if (entityType === 'service_order') {
    const { rows } = await pool.query(
      `SELECT so.*, u.name AS owner_name FROM service_orders so
         LEFT JOIN users u ON u.id = so.owner_id
        WHERE so.id = $1 AND so.tenant_id = $2`, [entityId, tenantId]);
    if (!rows[0]) return null;
    context.serviceOrder = rows[0];
    context.owner = rows[0].owner_id ? { name: rows[0].owner_name } : null;
    const { rows: clients } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [rows[0].client_id, tenantId]);
    context.client = clients[0] || null;
    const { rows: items } = await pool.query(
      'SELECT * FROM service_order_items WHERE tenant_id = $1 AND service_order_id = $2 ORDER BY sort_order',
      [tenantId, entityId]);
    context.items = items.map((item) => ({ ...item, total: 0, unit: 'un' }));
    if (rows[0].sale_id) {
      const { rows: sales } = await pool.query(
        'SELECT * FROM sales WHERE id = $1 AND tenant_id = $2', [rows[0].sale_id, tenantId]);
      context.sale = sales[0] || null;
    }
  } else if (entityType === 'customer_payment') {
    const { rows } = await pool.query(
      'SELECT * FROM customer_payments WHERE id = $1 AND tenant_id = $2', [entityId, tenantId]);
    if (!rows[0]) return null;
    context.payment = rows[0];
    const { rows: clients } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [rows[0].client_id, tenantId]);
    context.client = clients[0] || null;
    if (rows[0].order_id) {
      const { rows: orders } = await pool.query(
        'SELECT * FROM orders WHERE id = $1 AND tenant_id = $2', [rows[0].order_id, tenantId]);
      context.order = orders[0] || null;
      const { rows: items } = await pool.query(
        `SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND status = 'ativo'`,
        [tenantId, rows[0].order_id]);
      context.items = items;
    }
  } else if (entityType === 'client') {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [entityId, tenantId]);
    if (!rows[0]) return null;
    context.client = rows[0];
  }
  return context;
}

// ── Documentos gerados ───────────────────────────────────────────────────────

/** Gera o documento a partir de um template PUBLICADO e guarda o checksum. */
async function generateDocument(tenantId, userId, input) {
  const templateId = uuidOrNull(input.template_id);
  const entityType = oneOf(input.entity_type, ENTITY_TYPES, null);
  const entityId = uuidOrNull(input.entity_id);
  if (!templateId) throw new BusinessError('Selecione o template.');
  if (!entityType || !entityId) throw new BusinessError('Informe a entidade de origem do documento.');

  const template = await getTemplate(tenantId, templateId);
  if (!template) throw new BusinessError('Template nao encontrado.', 404);
  if (template.status !== 'publicado') {
    throw new BusinessError('Somente templates publicados podem gerar documentos.');
  }

  const context = await loadContext(tenantId, entityType, entityId);
  if (!context) throw new BusinessError('Registro de origem nao encontrado neste tenant.', 404);

  const values = templates.buildContext(context);
  const content = templates.render(template.body, values);
  const stage = oneOf(input.stage, DOC_STAGES, defaultStage(entityType));

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO generated_documents
         (tenant_id, template_id, template_version, doc_type, title, entity_type, entity_id,
          client_id, order_id, sale_id, payment_id, content, checksum, stage, status, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'gerado',$15) RETURNING *`,
      [tenantId, templateId, template.version, template.doc_type,
       clean(input.title, 200) || `${template.name} — ${new Date().toLocaleDateString('pt-BR')}`,
       entityType, entityId,
       context.client ? context.client.id : null,
       context.order ? context.order.id : null,
       context.sale ? context.sale.id : null,
       context.payment ? context.payment.id : null,
       content, templates.checksum(content), stage, userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      action: 'documento_gerado',
      details: { doc_type: template.doc_type, template: template.name, version: template.version,
        checksum: rows[0].checksum.slice(0, 12) },
      user_id: userId,
    });
    return rows[0];
  });
}

const defaultStage = (entityType) => ({
  order: 'pedido', sale: 'venda', service_order: 'execucao',
  customer_payment: 'pagamento', client: 'atendimento',
}[entityType] || 'pedido');

/** Registra um documento EXTERNO (upload/anexo), sem template. */
async function attachDocument(tenantId, userId, input) {
  const entityType = oneOf(input.entity_type, ENTITY_TYPES, null);
  const entityId = uuidOrNull(input.entity_id);
  const title = clean(input.title, 200);
  if (!entityType || !entityId) throw new BusinessError('Informe a entidade de origem do documento.');
  if (!title) throw new BusinessError('Informe o titulo do documento.');
  const fileUrl = internalUploadUrl(tenantId, input.file_url, { required: true });

  const context = await loadContext(tenantId, entityType, entityId);
  if (!context) throw new BusinessError('Registro de origem nao encontrado neste tenant.', 404);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO generated_documents
         (tenant_id, doc_type, title, entity_type, entity_id, client_id, order_id, sale_id,
          file_url, stage, status, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'anexado',$11) RETURNING *`,
      [tenantId, oneOf(input.doc_type, DOC_TYPES, 'personalizado'), title, entityType, entityId,
       context.client ? context.client.id : null,
       context.order ? context.order.id : null,
       context.sale ? context.sale.id : null,
       fileUrl,
       oneOf(input.stage, DOC_STAGES, defaultStage(entityType)), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: entityType, entity_id: entityId,
      action: 'documento_anexado', details: { title, doc_type: rows[0].doc_type }, user_id: userId,
    });
    return rows[0];
  });
}

async function updateDocument(tenantId, userId, id, input) {
  const documentId = uuidOrNull(id);
  if (!documentId) throw new BusinessError('Documento nao encontrado.', 404);
  const title = clean(input.title, 200);
  if (!title) throw new BusinessError('Informe o titulo do documento.');
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'generated_documents', tenantId, documentId);
    if (!current || current.status === 'cancelado') {
      throw new BusinessError('Documento nao encontrado ou ja excluido.', 404);
    }
    const { rows } = await client.query(
      `UPDATE generated_documents
          SET title = $3, doc_type = $4, stage = $5, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [documentId, tenantId, title,
       oneOf(input.doc_type, DOC_TYPES, current.doc_type),
       oneOf(input.stage, DOC_STAGES, current.stage)]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: current.entity_type, entity_id: current.entity_id,
      action: 'documento_atualizado', details: { document_id: documentId, title }, user_id: userId,
    });
    return rows[0];
  });
}

async function listDocuments(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['g.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };

  const entityType = oneOf(query.entity_type, ENTITY_TYPES, null);
  if (entityType) filters.push(`g.entity_type = ${push(entityType)}`);
  const entityId = uuidOrNull(query.entity_id);
  if (entityId) filters.push(`g.entity_id = ${push(entityId)}`);
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`g.client_id = ${push(clientId)}`);
  const docType = oneOf(query.doc_type, DOC_TYPES, null);
  if (docType) filters.push(`g.doc_type = ${push(docType)}`);
  const stage = oneOf(query.stage, DOC_STAGES, null);
  if (stage) filters.push(`g.stage = ${push(stage)}`);
  if (query.status !== 'all') filters.push("g.status <> 'cancelado'");
  const where = filters.join(' AND ');

  const { rows } = await pool.query(
    `SELECT g.id, g.doc_type, g.title, g.entity_type, g.entity_id, g.client_id, g.order_id,
            g.sale_id, g.stage, g.status, g.checksum, g.file_url, g.template_version,
            g.created_at, u.name AS generated_by_name, t.name AS template_name
       FROM generated_documents g
       LEFT JOIN users u ON u.id = g.generated_by
       LEFT JOIN document_templates t ON t.id = g.template_id
      WHERE ${where} ORDER BY g.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM generated_documents g WHERE ${where}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function getDocument(tenantId, id) {
  const documentId = uuidOrNull(id);
  if (!documentId) return null;
  const { rows } = await pool.query(
    `SELECT g.*, u.name AS generated_by_name, t.name AS template_name
       FROM generated_documents g
       LEFT JOIN users u ON u.id = g.generated_by
       LEFT JOIN document_templates t ON t.id = g.template_id
      WHERE g.id = $1 AND g.tenant_id = $2`, [documentId, tenantId]);
  return rows[0] || null;
}

async function cancelDocument(tenantId, userId, id, reason) {
  const documentId = uuidOrNull(id);
  const justification = cleanOrNull(reason, 2000);
  if (!documentId) throw new BusinessError('Documento nao encontrado.', 404);
  if (!justification) throw new BusinessError('Cancelamento exige justificativa.');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE generated_documents SET status = 'cancelado', cancel_reason = $3,
              cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status <> 'cancelado' RETURNING *`,
      [documentId, tenantId, justification]);
    if (!rows[0]) throw new BusinessError('Documento nao encontrado ou ja cancelado.', 404);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: rows[0].entity_type, entity_id: rows[0].entity_id,
      action: 'documento_cancelado', reason: justification,
      details: { document_id: documentId, title: rows[0].title }, user_id: userId,
    });
    return rows[0];
  });
}

// ── Recibos operacionais (§15) ───────────────────────────────────────────────

/**
 * Emite o recibo de um pagamento APROVADO. O indice UNIQUE parcial impede um
 * segundo recibo vivo para o mesmo pagamento.
 */
async function issueReceipt(tenantId, userId, paymentId, input = {}) {
  const id = uuidOrNull(paymentId);
  if (!id) throw new BusinessError('Pagamento nao encontrado.', 404);

  return withTransaction(async (client) => {
    const payment = await lockRow(client, 'customer_payments', tenantId, id);
    if (!payment) throw new BusinessError('Pagamento nao encontrado.', 404);
    if (payment.status !== 'aprovado') {
      throw new BusinessError('Somente pagamentos aprovados geram recibo.');
    }
    const { rows: existing } = await client.query(
      `SELECT id FROM generated_documents
        WHERE tenant_id = $1 AND payment_id = $2 AND doc_type = 'recibo' AND status <> 'cancelado'`,
      [tenantId, id]);
    if (existing[0]) throw new BusinessError('Este pagamento ja possui recibo emitido.', 409);

    const context = await loadContext(tenantId, 'customer_payment', id);
    const values = templates.buildContext(context);

    // Com template publicado, usa o texto do tenant; sem, usa o corpo padrao.
    const templateId = uuidOrNull(input.template_id);
    let content;
    let usedTemplate = null;
    if (templateId) {
      const template = await getTemplate(tenantId, templateId);
      if (!template || template.status !== 'publicado') {
        throw new BusinessError('Template de recibo invalido ou nao publicado.');
      }
      usedTemplate = template;
      content = templates.render(template.body, values);
    } else {
      content = templates.render(
        [
          'RECIBO',
          '',
          'Recebemos de {{cliente.nome}} (CPF/CNPJ {{cliente.cpf}})',
          'a importancia de {{pagamento.valor}}, em {{pagamento.data}}, via {{pagamento.forma}},',
          'referente ao pedido {{pedido.numero}}.',
          '',
          'Itens:',
          '{{itens.lista}}',
          '',
          'Total do pedido: {{valores.total}}',
          'Valor recebido: {{valores.recebido}}',
          'Valor pendente: {{valores.pendente}}',
          '',
          '{{empresa.nome}} — {{datas.hoje}}',
          `${RECEIPT_DISCLAIMER}`,
        ].join('\n'),
        values
      );
    }

    const { rows } = await client.query(
      `INSERT INTO generated_documents
         (tenant_id, template_id, template_version, doc_type, title, entity_type, entity_id,
          client_id, order_id, sale_id, payment_id, content, checksum, stage, status, generated_by)
       VALUES ($1,$2,$3,'recibo',$4,'customer_payment',$5,$6,$7,$8,$5,$9,$10,'pagamento','gerado',$11)
       RETURNING *`,
      [tenantId, usedTemplate ? usedTemplate.id : null, usedTemplate ? usedTemplate.version : null,
       clean(input.title, 200) || `Recibo — ${payment.reference || payment.id.slice(0, 8)}`,
       id, payment.client_id, payment.order_id, payment.sale_id,
       content, templates.checksum(content), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'customer_payment', entity_id: id,
      action: 'recibo_emitido',
      details: { amount: Number(payment.amount), document_id: rows[0].id }, user_id: userId,
    });
    return rows[0];
  });
}

// ── Contratos (§14) ──────────────────────────────────────────────────────────

async function createContract(tenantId, userId, input) {
  const clientId = uuidOrNull(input.client_id);
  const title = clean(input.title, 200);
  if (!clientId) throw new BusinessError('Selecione o cliente do contrato.');
  if (!title) throw new BusinessError('Informe o titulo do contrato.');

  return withTransaction(async (client) => {
    const { rows: clientRows } = await client.query(
      'SELECT id FROM clients WHERE id = $1 AND tenant_id = $2', [clientId, tenantId]);
    if (!clientRows[0]) throw new BusinessError('Cliente nao encontrado neste tenant.', 404);

    const number = await nextNumber(client, tenantId, 'contract');
    const { rows } = await client.query(
      `INSERT INTO commercial_contracts
         (tenant_id, number, client_id, order_id, sale_id, title, generated_document_id,
          status, responsible_id, witnesses, file_url, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING *`,
      [tenantId, number, clientId, uuidOrNull(input.order_id), uuidOrNull(input.sale_id), title,
       uuidOrNull(input.generated_document_id),
       oneOf(input.status, CONTRACT_STATUSES, 'rascunho'),
       uuidOrNull(input.responsible_id) || userId,
       JSON.stringify(parseWitnesses(input.witnesses)),
       internalUploadUrl(tenantId, input.file_url), cleanOrNull(input.notes, 2000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'contract', entity_id: rows[0].id,
      action: 'criado', to_status: rows[0].status, details: { number, title }, user_id: userId,
    });
    return rows[0];
  });
}

const parseWitnesses = (value) => (Array.isArray(value) ? value : [])
  .map((entry) => ({ name: clean(entry && entry.name, 160), document: clean(entry && entry.document, 30) }))
  .filter((entry) => entry.name)
  .slice(0, 5);

async function updateContract(tenantId, userId, id, input, expectedVersion) {
  const contractId = uuidOrNull(id);
  if (!contractId) throw new BusinessError('Contrato nao encontrado.', 404);
  const status = oneOf(input.status, CONTRACT_STATUSES, null);
  if (['cancelado', 'recusado'].includes(status) && !cleanOrNull(input.notes, 2000)) {
    throw new BusinessError('Cancelamento e recusa exigem observacao com o motivo.');
  }

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'commercial_contracts', tenantId, contractId, expectedVersion);
    if (!current) throw new BusinessError('Contrato nao encontrado.', 404);
    if (status === 'assinado' && !dateOrNull(input.signed_at) && !current.signed_at) {
      throw new BusinessError('Informe a data da assinatura.');
    }

    const { rows } = await client.query(
      `UPDATE commercial_contracts
          SET title = COALESCE($3, title), status = COALESCE($4, status),
              signed_at = COALESCE($5, signed_at), signed_by_name = COALESCE($6, signed_by_name),
              responsible_id = COALESCE($7, responsible_id),
              witnesses = COALESCE($8::jsonb, witnesses), file_url = COALESCE($9, file_url),
              notes = COALESCE($10, notes),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [contractId, tenantId, cleanOrNull(input.title, 200), status, dateOrNull(input.signed_at),
       cleanOrNull(input.signed_by_name, 200), uuidOrNull(input.responsible_id),
       input.witnesses === undefined ? null : JSON.stringify(parseWitnesses(input.witnesses)),
       input.file_url === undefined ? null : internalUploadUrl(tenantId, input.file_url),
       cleanOrNull(input.notes, 2000)]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'contract', entity_id: contractId,
      action: status && status !== current.status ? 'situacao_alterada' : 'atualizado',
      from_status: current.status, to_status: rows[0].status,
      reason: cleanOrNull(input.notes, 2000), user_id: userId,
    });
    return rows[0];
  });
}

/** Substitui o contrato por um novo, preservando a via anterior (§14). */
async function replaceContract(tenantId, userId, id, input) {
  const contractId = uuidOrNull(id);
  if (!contractId) throw new BusinessError('Contrato nao encontrado.', 404);

  return withTransaction(async (client) => {
    const current = await lockRow(client, 'commercial_contracts', tenantId, contractId);
    if (!current) throw new BusinessError('Contrato nao encontrado.', 404);
    if (current.status === 'substituido') throw new BusinessError('Contrato ja foi substituido.');

    const number = await nextNumber(client, tenantId, 'contract');
    const { rows } = await client.query(
      `INSERT INTO commercial_contracts
         (tenant_id, number, client_id, order_id, sale_id, title, status, responsible_id,
          witnesses, file_url, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'rascunho',$7,$8::jsonb,$9,$10,$11) RETURNING *`,
      [tenantId, number, current.client_id, current.order_id, current.sale_id,
       clean(input.title, 200) || current.title, uuidOrNull(input.responsible_id) || userId,
       JSON.stringify(current.witnesses || []), internalUploadUrl(tenantId, input.file_url),
       cleanOrNull(input.notes, 2000), userId]
    );
    await client.query(
      `UPDATE commercial_contracts SET status = 'substituido', replaced_by = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [contractId, tenantId, rows[0].id]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'contract', entity_id: contractId,
      action: 'substituido', from_status: current.status, to_status: 'substituido',
      details: { replaced_by: rows[0].number }, user_id: userId,
    });
    return rows[0];
  });
}

async function listContracts(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['ct.tenant_id = $1'];
  const params = [tenantId];
  const push = (value) => { params.push(value); return `$${params.length}`; };
  const status = oneOf(query.status, CONTRACT_STATUSES, null);
  if (status) filters.push(`ct.status = ${push(status)}`);
  else filters.push("ct.status <> 'cancelado'");
  const clientId = uuidOrNull(query.client_id);
  if (clientId) filters.push(`ct.client_id = ${push(clientId)}`);
  const orderId = uuidOrNull(query.order_id);
  if (orderId) filters.push(`ct.order_id = ${push(orderId)}`);
  const term = clean(query.q, 120);
  if (term) {
    const like = push(`%${term.toLowerCase()}%`);
    filters.push(`(LOWER(ct.number) LIKE ${like} OR LOWER(ct.title) LIKE ${like} OR LOWER(c.name) LIKE ${like})`);
  }
  const where = filters.join(' AND ');
  const from = `
      FROM commercial_contracts ct
      JOIN clients c ON c.id = ct.client_id AND c.tenant_id = ct.tenant_id
      LEFT JOIN orders o ON o.id = ct.order_id AND o.tenant_id = ct.tenant_id
      LEFT JOIN users u ON u.id = ct.responsible_id
     WHERE ${where}`;

  const { rows } = await pool.query(
    `SELECT ct.*, c.name AS client_name, o.number AS order_number, u.name AS responsible_name
       ${from} ORDER BY ct.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]);
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

async function deleteContract(tenantId, userId, id, reason) {
  const contractId = uuidOrNull(id);
  const justification = cleanOrNull(reason, 2000);
  if (!contractId) throw new BusinessError('Contrato nao encontrado.', 404);
  if (!justification) throw new BusinessError('Informe o motivo da exclusao.');
  return withTransaction(async (client) => {
    const current = await lockRow(client, 'commercial_contracts', tenantId, contractId);
    if (!current || ['cancelado', 'substituido'].includes(current.status)) {
      throw new BusinessError('Contrato nao encontrado ou nao pode ser excluido.', 404);
    }
    const { rows } = await client.query(
      `UPDATE commercial_contracts SET status = 'cancelado', notes = $3,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [contractId, tenantId, justification]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'contract', entity_id: contractId,
      action: 'excluido', from_status: current.status, to_status: 'cancelado',
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

// ── Nota fiscal: REGISTRO MANUAL (§32) ───────────────────────────────────────

/**
 * Registra/atualiza os dados da nota fiscal informados pelo usuario.
 * O SISV NAO emite nota e NAO se comunica com SEFAZ, prefeitura, NFS-e ou NF-e.
 */
async function upsertFiscalDocument(tenantId, userId, input) {
  const saleId = uuidOrNull(input.sale_id);
  if (!saleId) throw new BusinessError('Selecione a venda da nota fiscal.');
  const status = oneOf(input.status, FISCAL_STATUSES, 'pendente');
  if (status === 'emitida') {
    if (!clean(input.number, 40)) throw new BusinessError('Informe o numero da nota emitida.');
    if (!dateOrNull(input.issued_at)) throw new BusinessError('Informe a data de emissao.');
  }

  return withTransaction(async (client) => {
    const sale = await lockRow(client, 'sales', tenantId, saleId);
    if (!sale) throw new BusinessError('Venda nao encontrada.', 404);
    const { rows: soRows } = await client.query(
      'SELECT id FROM service_orders WHERE tenant_id = $1 AND sale_id = $2', [tenantId, saleId]);

    const { rows: existing } = await client.query(
      'SELECT * FROM fiscal_documents WHERE tenant_id = $1 AND sale_id = $2 FOR UPDATE',
      [tenantId, saleId]);

    const fields = [
      bool(input.required === undefined ? true : input.required), status,
      cleanOrNull(input.number, 40), cleanOrNull(input.series, 20),
      cleanOrNull(input.access_key, 60), dateOrNull(input.issued_at),
      money(input.amount) ?? Number(sale.net_amount),
      cleanOrNull(input.pdf_url, 2000), cleanOrNull(input.xml_url, 2000),
      cleanOrNull(input.issuer, 200), cleanOrNull(input.notes, 2000),
    ];

    let row;
    if (existing[0]) {
      const { rows } = await client.query(
        `UPDATE fiscal_documents
            SET required = $3, status = $4, number = $5, series = $6, access_key = $7,
                issued_at = $8, amount = $9, pdf_url = $10, xml_url = $11, issuer = $12,
                notes = $13, updated_by = $14, row_version = row_version + 1, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [existing[0].id, tenantId, ...fields, userId]);
      row = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO fiscal_documents
           (tenant_id, sale_id, service_order_id, order_id, client_id, required, status, number,
            series, access_key, issued_at, amount, pdf_url, xml_url, issuer, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,
        [tenantId, saleId, soRows[0] ? soRows[0].id : null, sale.order_id, sale.client_id,
         ...fields, userId]);
      row = rows[0];
    }
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'fiscal_document', entity_id: row.id,
      action: existing[0] ? 'nota_atualizada' : 'nota_registrada',
      from_status: existing[0] ? existing[0].status : null, to_status: status,
      details: { sale_number: sale.number, number: row.number }, user_id: userId,
    });
    return row;
  });
}

async function listFiscalDocuments(tenantId, query = {}) {
  const { limit, offset, page } = paging(query);
  const filters = ['f.tenant_id = $1'];
  const params = [tenantId];
  const status = oneOf(query.status, FISCAL_STATUSES, null);
  if (status) { params.push(status); filters.push(`f.status = $${params.length}`); }
  if (query.pending === 'true') filters.push("f.required = TRUE AND f.status IN ('pendente','solicitada')");
  const where = filters.join(' AND ');
  const from = `
      FROM fiscal_documents f
      LEFT JOIN sales s ON s.id = f.sale_id AND s.tenant_id = f.tenant_id
      LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
     WHERE ${where}`;
  const { rows } = await pool.query(
    `SELECT f.*, s.number AS sale_number, c.name AS client_name ${from}
      ORDER BY f.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]);
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  return { rows, total: countRows[0].total, page, limit };
}

// ── Finalizacao (§30) e arquivamento (§33) ───────────────────────────────────

const FINALIZATION_CHECKS = Object.freeze([
  'execucao_concluida', 'pendencias_criticas', 'documentos_obrigatorios',
  'documentos_finais', 'nota_fiscal', 'situacao_financeira', 'entrega_cliente',
]);

/**
 * Checklist de conclusao (§30). Apenas INFORMA a situacao de cada verificacao —
 * nao bloqueia por regra financeira sem definicao explicita do tenant.
 */
async function finalizationChecklist(tenantId, serviceOrderId) {
  const id = uuidOrNull(serviceOrderId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT so.*, s.number AS sale_number FROM service_orders so
       LEFT JOIN sales s ON s.id = so.sale_id AND s.tenant_id = so.tenant_id
      WHERE so.id = $1 AND so.tenant_id = $2`, [id, tenantId]);
  const serviceOrder = rows[0];
  if (!serviceOrder) return null;

  const [processes, fiscal, receivables, documents, existing] = await Promise.all([
    pool.query(
      `SELECT f.id, f.fine_number, f.stage, f.status, f.finalized_at,
              COUNT(t.id)::int AS open_tasks
         FROM service_order_items i
         JOIN fines f ON f.id = i.process_id AND f.tenant_id = i.tenant_id
         LEFT JOIN process_tasks t ON t.fine_id = f.id AND t.tenant_id = f.tenant_id
              AND t.status = 'aberta' AND t.deleted_at IS NULL
        WHERE i.tenant_id = $1 AND i.service_order_id = $2
        GROUP BY f.id, f.fine_number, f.stage, f.status, f.finalized_at`, [tenantId, id]),
    pool.query('SELECT * FROM fiscal_documents WHERE tenant_id = $1 AND service_order_id = $2', [tenantId, id]),
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::float AS total, COALESCE(SUM(received_amount),0)::float AS received
         FROM receivables WHERE tenant_id = $1 AND sale_id = $2 AND status <> 'cancelado'`,
      [tenantId, serviceOrder.sale_id]),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM generated_documents
        WHERE tenant_id = $1 AND entity_type = 'service_order' AND entity_id = $2
          AND status <> 'cancelado' AND stage = 'finalizacao'`, [tenantId, id]),
    pool.query('SELECT * FROM finalization_records WHERE tenant_id = $1 AND service_order_id = $2', [tenantId, id]),
  ]);

  const openTasks = processes.rows.reduce((sum, row) => sum + Number(row.open_tasks), 0);
  const fiscalDoc = fiscal.rows[0] || null;
  const financeiro = receivables.rows[0];
  const pending = Math.max(0, Number(financeiro.total) - Number(financeiro.received));

  const checks = [
    {
      key: 'execucao_concluida',
      label: 'Execucao concluida',
      ok: serviceOrder.status === 'concluida',
      detail: `Ordem em "${serviceOrder.status}".`,
      blocking: true,
    },
    {
      key: 'pendencias_criticas',
      label: 'Sem pendencias abertas nos processos',
      ok: openTasks === 0,
      detail: openTasks ? `${openTasks} pendencia(s) aberta(s).` : 'Nenhuma pendencia aberta.',
      blocking: false,
    },
    {
      key: 'documentos_finais',
      label: 'Documentos finais registrados',
      ok: documents.rows[0].total > 0,
      detail: `${documents.rows[0].total} documento(s) na etapa de finalizacao.`,
      blocking: false,
    },
    {
      key: 'nota_fiscal',
      label: 'Situacao da nota fiscal',
      ok: !fiscalDoc || !fiscalDoc.required || fiscalDoc.status === 'emitida' || fiscalDoc.status === 'nao_aplicavel',
      detail: fiscalDoc ? `Nota em "${fiscalDoc.status}".` : 'Nota fiscal ainda nao registrada.',
      blocking: false,
    },
    {
      key: 'situacao_financeira',
      label: 'Situacao financeira',
      ok: pending <= 0,
      detail: pending > 0
        ? `Valor pendente de ${pending.toFixed(2)}.`
        : 'Recebimentos quitados.',
      blocking: false,
    },
  ];

  return {
    service_order: {
      id: serviceOrder.id, number: serviceOrder.number, status: serviceOrder.status,
      sale_number: serviceOrder.sale_number,
    },
    processes: processes.rows,
    checks,
    // So a execucao concluida trava a finalizacao; o resto e alerta (§30).
    can_finalize: checks.filter((check) => check.blocking).every((check) => check.ok)
      && !existing.rows[0],
    blockers: checks.filter((check) => check.blocking && !check.ok).map((check) => check.detail),
    already_finalized: existing.rows[0] || null,
  };
}

async function finalize(tenantId, userId, serviceOrderId, input = {}) {
  const id = uuidOrNull(serviceOrderId);
  if (!id) throw new BusinessError('Ordem de servico nao encontrada.', 404);

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, id, input.row_version);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    if (serviceOrder.status !== 'concluida') {
      throw new BusinessError('Conclua a execucao antes de finalizar o atendimento.');
    }
    const { rows: existing } = await client.query(
      'SELECT id FROM finalization_records WHERE tenant_id = $1 AND service_order_id = $2', [tenantId, id]);
    if (existing[0]) throw new BusinessError('Este atendimento ja foi finalizado.', 409);

    const checklist = {};
    for (const key of FINALIZATION_CHECKS) {
      if (input.checklist && key in input.checklist) checklist[key] = bool(input.checklist[key]);
    }

    const { rows } = await client.query(
      `INSERT INTO finalization_records
         (tenant_id, service_order_id, sale_id, client_id, checklist, delivered_at,
          delivery_notes, final_notes, status, finalized_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'concluida',$9) RETURNING *`,
      [tenantId, id, serviceOrder.sale_id, serviceOrder.client_id, JSON.stringify(checklist),
       dateOrNull(input.delivered_at), cleanOrNull(input.delivery_notes, 2000),
       cleanOrNull(input.final_notes, 4000), userId]
    );
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: id,
      action: 'finalizado', to_status: 'concluida',
      details: { checklist, finalization_id: rows[0].id }, user_id: userId,
    });
    return rows[0];
  });
}

/** Arquiva o atendimento. Nao apaga nada: apenas marca e preserva o historico. */
async function archive(tenantId, userId, serviceOrderId) {
  const id = uuidOrNull(serviceOrderId);
  if (!id) throw new BusinessError('Ordem de servico nao encontrada.', 404);

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, id);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    const { rows: finalizationRows } = await client.query(
      'SELECT * FROM finalization_records WHERE tenant_id = $1 AND service_order_id = $2 FOR UPDATE',
      [tenantId, id]);
    if (!finalizationRows[0]) throw new BusinessError('Finalize o atendimento antes de arquivar.');
    if (finalizationRows[0].status === 'arquivada') {
      throw new BusinessError('Atendimento ja arquivado.', 409);
    }

    await client.query(
      `UPDATE finalization_records SET status = 'arquivada', archived_by = $3, archived_at = NOW(),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [finalizationRows[0].id, tenantId, userId]);
    const { rows } = await client.query(
      `UPDATE service_orders SET status = 'arquivada', archived_by = $3, archived_at = NOW(),
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, userId]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: id,
      action: 'arquivado', from_status: serviceOrder.status, to_status: 'arquivada',
      user_id: userId,
    });
    return rows[0];
  });
}

/** Reabertura: exige justificativa; o perfil autorizado e checado na rota (§33). */
async function reopen(tenantId, userId, serviceOrderId, reason) {
  const id = uuidOrNull(serviceOrderId);
  const justification = cleanOrNull(reason, 2000);
  if (!id) throw new BusinessError('Ordem de servico nao encontrada.', 404);
  if (!justification) throw new BusinessError('Reabertura exige justificativa.');

  return withTransaction(async (client) => {
    const serviceOrder = await lockRow(client, 'service_orders', tenantId, id);
    if (!serviceOrder) throw new BusinessError('Ordem de servico nao encontrada.', 404);
    if (!['arquivada', 'concluida'].includes(serviceOrder.status)) {
      throw new BusinessError('Somente atendimentos concluidos ou arquivados podem ser reabertos.');
    }
    await client.query(
      `UPDATE finalization_records SET status = 'reaberta', reopened_by = $3, reopened_at = NOW(),
              reopen_reason = $4, row_version = row_version + 1, updated_at = NOW()
        WHERE tenant_id = $1 AND service_order_id = $2`,
      [tenantId, id, userId, justification]);
    const { rows } = await client.query(
      `UPDATE service_orders SET status = 'em_execucao', reopened_by = $3, reopened_at = NOW(),
              reopen_reason = $4, archived_at = NULL,
              row_version = row_version + 1, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, userId, justification]);
    await recordHistory(client, {
      tenant_id: tenantId, entity_type: 'service_order', entity_id: id,
      action: 'reaberto', from_status: serviceOrder.status, to_status: 'em_execucao',
      reason: justification, user_id: userId,
    });
    return rows[0];
  });
}

module.exports = {
  DOC_TYPES,
  TEMPLATE_STATUSES,
  DOC_STAGES,
  DOC_STATUSES,
  CONTRACT_STATUSES,
  ENTITY_TYPES,
  FISCAL_STATUSES,
  FINALIZATION_CHECKS,
  RECEIPT_DISCLAIMER,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  generateDocument,
  attachDocument,
  updateDocument,
  listDocuments,
  getDocument,
  cancelDocument,
  issueReceipt,
  createContract,
  updateContract,
  replaceContract,
  deleteContract,
  listContracts,
  upsertFiscalDocument,
  listFiscalDocuments,
  finalizationChecklist,
  finalize,
  archive,
  reopen,
};
