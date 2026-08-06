'use strict';

// =============================================================================
// commercialRouteUtils.js — utilitarios compartilhados pelas rotas comerciais.
//
// Traduz os erros de dominio para HTTP:
//   BusinessError  -> o status que ele carrega (400 por padrao, 404, 409)
//   ConflictError  -> 409, conforme §51 (conflito de edicao por row_version)
//   qualquer outro -> 500 com mensagem generica (nunca vaza SQL nem stack)
// =============================================================================

const saas = require('../../models/saasModels');
const { toCsv } = require('../../services/csvService');

/**
 * Responde um erro sem vazar detalhe interno.
 * Erros de dominio tem `status`; o resto vira 500 com mensagem neutra.
 */
function fail(res, error, scope = 'commercial') {
  const status = Number(error && error.status) || 500;
  if (status >= 500) {
    console.error(`[${scope}]`, error && error.message ? error.message : error);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
  return res.status(status).json({
    success: false,
    error: (error && error.message) || 'Nao foi possivel concluir a acao.',
    ...(error && error.code ? { code: error.code } : {}),
    ...(error && error.details ? { details: error.details } : {}),
  });
}

/** Envolve o handler e encaminha qualquer excecao para `fail`. */
const handle = (scope, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    fail(res, error, scope);
  }
};

/**
 * Registro na auditoria global (activity_logs).
 * Nunca recebe segredo nem conteudo integral de documento (§39): apenas
 * identificadores, valores e a decisao tomada.
 */
async function audit(req, { action, entity_type, entity_id, entity_name, description, metadata }) {
  try {
    await saas.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action,
      entity_type,
      entity_id,
      entity_name,
      description,
      metadata: metadata || {},
      ip_address: req.ip,
    });
  } catch (error) {
    // Falha de auditoria nao pode derrubar a operacao ja efetivada; fica no log.
    console.error('[commercial][audit]', error.message);
  }
}

/** Exporta linhas como CSV usando o servico seguro (protege contra CSV injection). */
function sendCsv(res, rows, filename) {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const columns = keys.map((key) => ({ label: key, value: key }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(toCsv(rows, columns));
}

module.exports = { fail, handle, audit, sendCsv };
