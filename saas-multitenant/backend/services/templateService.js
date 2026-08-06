'use strict';

// =============================================================================
// templateService.js — renderizacao SEGURA de documentos comerciais (§13).
//
// O corpo do template e TEXTO PURO com marcadores {{variavel}}. Nunca aceitamos
// HTML, script, expressao ou codigo: §13 exige "nao permitir HTML ou codigo
// arbitrario inseguro" e "utilizar variaveis autorizadas".
//
// Por isso:
//   * ALLOWED_FIELDS e uma lista fechada; {{qualquer.outra.coisa}} e rejeitada
//     na validacao do template, nao silenciosamente ignorada na renderizacao;
//   * o corpo passa por assertSafeBody(), que barra tags, entidades e protocolos
//     perigosos antes de gravar;
//   * o valor substituido tambem e limpo, para o caso de um dado cadastral ter
//     sido preenchido com marcacao.
// =============================================================================

const crypto = require('crypto');

/**
 * Variaveis autorizadas, agrupadas por contexto (§13).
 * A chave e o marcador; o valor descreve o campo para a interface de edicao.
 */
const ALLOWED_FIELDS = Object.freeze({
  'cliente.nome': 'Nome do cliente',
  'cliente.cpf': 'CPF/CNPJ do cliente',
  'cliente.telefone': 'Telefone do cliente',
  'cliente.email': 'E-mail do cliente',
  'cliente.endereco': 'Endereco do cliente',
  'pedido.numero': 'Numero do pedido',
  'pedido.data': 'Data do pedido',
  'pedido.observacoes': 'Observacoes do pedido',
  'itens.lista': 'Lista de itens (uma linha por item)',
  'itens.quantidade': 'Quantidade de itens',
  'valores.subtotal': 'Subtotal',
  'valores.desconto': 'Desconto',
  'valores.acrescimo': 'Acrescimo',
  'valores.total': 'Total',
  'valores.total_extenso': 'Total por extenso (numerico formatado)',
  'valores.recebido': 'Valor recebido',
  'valores.pendente': 'Valor pendente',
  'responsavel.nome': 'Responsavel pelo atendimento',
  'datas.hoje': 'Data de emissao',
  'empresa.nome': 'Nome da empresa (tenant)',
  'empresa.marca': 'Assinatura institucional',
  'servico.descricao': 'Descricao do servico',
  'venda.numero': 'Numero da venda',
  'ordem.numero': 'Numero da ordem de servico',
  'pagamento.valor': 'Valor do pagamento',
  'pagamento.data': 'Data do pagamento',
  'pagamento.forma': 'Forma de pagamento',
});

const FIELD_KEYS = Object.freeze(Object.keys(ALLOWED_FIELDS));

// Marcacao e protocolos que nao podem existir no corpo de um template.
const UNSAFE_PATTERNS = Object.freeze([
  { re: /<[a-z!/?]/i, message: 'tags HTML' },
  { re: /&#|&[a-z]+;/i, message: 'entidades HTML' },
  { re: /javascript:|data:|vbscript:/i, message: 'protocolos de script' },
  { re: /\$\{/, message: 'interpolacao de template literal' },
]);

// Nome de variavel valido: dois segmentos minusculos separados por ponto.
// Qualquer marcador que fuja disso (parenteses, operadores, chamada de funcao)
// nao casa e cai na checagem de "variavel nao autorizada" abaixo.
const VARIABLE_NAME_RE = /^[a-z_]+\.[a-z_]+$/;
const MARKER_RE = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi;

/**
 * Valida o corpo do template. Retorna { ok, error, fields } — `fields` lista os
 * marcadores efetivamente usados, para exibir na tela de edicao.
 */
function assertSafeBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return { ok: false, error: 'O corpo do template nao pode ficar vazio.' };
  if (text.length > 50000) return { ok: false, error: 'Template muito longo (maximo 50.000 caracteres).' };

  for (const { re, message } of UNSAFE_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, error: `Conteudo nao permitido no template: ${message}. Use apenas texto e variaveis {{autorizadas}}.` };
    }
  }

  // Qualquer marcador fora da lista autorizada reprova o template — inclusive
  // um que pareca uma expressao, porque nao casa com VARIABLE_NAME_RE.
  const used = new Set();
  const unknown = new Set();
  for (const match of text.matchAll(/\{\{([^}]*)\}\}/g)) {
    const raw = match[1].trim();
    const key = raw.toLowerCase();
    if (VARIABLE_NAME_RE.test(key) && FIELD_KEYS.includes(key)) used.add(key);
    else unknown.add(raw);
  }
  if (unknown.size) {
    return {
      ok: false,
      error: `Variavel nao autorizada: ${[...unknown].slice(0, 5).join(', ')}. Consulte a lista de campos disponiveis.`,
    };
  }
  return { ok: true, fields: [...used] };
}

const money = (value) => Number(value || 0).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL',
});
const date = (value) => (value ? new Date(value).toLocaleDateString('pt-BR') : '');

/** Remove marcacao de um valor vindo do cadastro antes de injetar no documento. */
const sanitizeValue = (value) => String(value ?? '')
  .replace(/[<>]/g, '')
  .replace(/\{\{|\}\}/g, '')
  .slice(0, 4000);

/**
 * Monta o dicionario de valores a partir do contexto carregado pelo model.
 * Campos ausentes viram string vazia — nunca "undefined" no documento.
 */
function buildContext({ tenant, client, order, items = [], sale, serviceOrder, payment, owner }) {
  const totals = order || sale || {};
  const received = order && order.received_amount !== undefined ? order.received_amount : 0;
  const total = Number(totals.total ?? totals.net_amount ?? 0);

  return {
    'cliente.nome': client ? client.name : '',
    'cliente.cpf': client ? client.cpf : '',
    'cliente.telefone': client ? client.phone : '',
    'cliente.email': client ? client.email : '',
    'cliente.endereco': client ? client.address : '',
    'pedido.numero': order ? order.number : '',
    'pedido.data': order ? date(order.created_at) : '',
    'pedido.observacoes': order ? order.notes : '',
    'itens.lista': items
      .map((item) => `- ${item.description} (${Number(item.quantity)} ${item.unit || 'un'}) — ${money(item.total)}`)
      .join('\n'),
    'itens.quantidade': String(items.length),
    'valores.subtotal': money(totals.subtotal ?? totals.gross_amount ?? 0),
    'valores.desconto': money(totals.discount ?? totals.discount_amount ?? 0),
    'valores.acrescimo': money(totals.surcharge ?? 0),
    'valores.total': money(total),
    'valores.total_extenso': `${money(total)} (${Number(total).toFixed(2).replace('.', ',')})`,
    'valores.recebido': money(received),
    'valores.pendente': money(Math.max(0, total - Number(received))),
    'responsavel.nome': owner ? owner.name : '',
    'datas.hoje': date(new Date()),
    'empresa.nome': tenant ? tenant.name : '',
    'empresa.marca': tenant && tenant.developer ? `${tenant.name} · Uma solucao ${tenant.developer}` : (tenant ? tenant.name : ''),
    'servico.descricao': items.length ? items[0].description : '',
    'venda.numero': sale ? sale.number : '',
    'ordem.numero': serviceOrder ? serviceOrder.number : '',
    'pagamento.valor': payment ? money(payment.amount) : '',
    'pagamento.data': payment ? date(payment.paid_at) : '',
    'pagamento.forma': payment ? payment.payment_method : '',
  };
}

/** Substitui os marcadores autorizados. Marcador desconhecido vira string vazia. */
function render(body, context) {
  return String(body ?? '').replace(MARKER_RE, (_match, key) => {
    const value = context[String(key).toLowerCase()];
    return sanitizeValue(value);
  });
}

/** Checksum do conteudo gerado, para provar que o documento nao foi alterado. */
const checksum = (content) => crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');

module.exports = {
  ALLOWED_FIELDS,
  FIELD_KEYS,
  assertSafeBody,
  buildContext,
  render,
  checksum,
};
