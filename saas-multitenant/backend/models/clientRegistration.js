'use strict';

// =============================================================================
// clientRegistration.js — normalizacao e validacao dos campos de cadastro de
// cliente introduzidos na migration sisv_12 (identificacao, categoria, contato,
// origem, responsavel PJ) e das credenciais de acesso a portais (portal_access).
//
// Regras de dominio ficam AQUI (fora da rota e do modelo) para serem testaveis
// isoladamente e reaproveitadas por create/update. Nenhuma automacao: apenas
// saneia e valida o que o usuario enviou explicitamente.
// =============================================================================

const { clean, cleanOrNull, BusinessError } = require('../services/commercialCommon');

// Conjuntos fechados (espelham as CHECKs da migration). A aplicacao normaliza
// para minusculo, exceto a categoria da CNH, que segue a convencao maiuscula.
const ENUMS = Object.freeze({
  client_type: ['pf'],
  category: ['standard', 'fidelidade', 'empresarial', 'parceiro', 'agencia'],
  cnh_category: ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE', 'ACC'],
  contact_preference: ['whatsapp', 'telefone', 'email', 'sms'],
  // `carteira` permanece aceito somente para compatibilidade com cadastros
  // antigos; a interface oferece `campanha` em seu lugar.
  origin: ['carteira', 'indicacao', 'balcao', 'midia_online', 'campanha', 'outros'],
});

const ENUM_LABELS = Object.freeze({
  client_type: 'Tipo de cliente',
  category: 'Categoria do cliente',
  cnh_category: 'Categoria da CNH',
  contact_preference: 'Meio de contato preferencial',
  origin: 'Origem do cliente',
});

// Chaves de acesso conhecidas em portal_access. 'outros' aceita um rotulo livre.
const PORTAL_SLOTS = Object.freeze(['detran', 'gov', 'outros']);

function normalizeEnum(field, value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = clean(value, 20);
  const candidate = field === 'cnh_category' ? raw.toUpperCase() : raw.toLowerCase();
  if (!ENUMS[field].includes(candidate)) {
    throw new BusinessError(`${ENUM_LABELS[field]} invalido.`);
  }
  return candidate;
}

function uppercaseOrNull(value, maxLength = 4000) {
  const normalized = cleanOrNull(value, maxLength);
  return normalized ? normalized.toLocaleUpperCase('pt-BR') : null;
}

/**
 * Saneia os campos estruturados do cadastro. Sempre devolve o conjunto completo
 * (com null para vazios) para que create/update gravem de forma previsivel.
 * `client_code` NAO entra aqui: sua geracao/edicao mora no modelo (contador).
 */
function normalizeRegistration(input = {}, { partial = false } = {}) {
  const normalized = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const set = (field, value) => {
    if (!partial || has(field)) normalized[field] = value;
  };

  set('client_type', 'pf');
  set('category', normalizeEnum('category', input.category));
  set('rg', uppercaseOrNull(input.rg, 30));
  set('cnh_category', normalizeEnum('cnh_category', input.cnh_category));
  set('whatsapp', cleanOrNull(input.whatsapp, 30));
  set('contact_preference', normalizeEnum('contact_preference', input.contact_preference));
  set('origin', normalizeEnum('origin', input.origin));
  set('responsible_name', null);
  set('additional_info', uppercaseOrNull(input.additional_info, 4000));

  // Todos os servicos desta plataforma sao prestados a pessoa fisica.
  if (!partial || has('client_type') || has('responsible_name')) normalized.responsible_name = null;
  if ((!partial || has('category')) && normalized.category === 'parceiro') normalized.origin = null;
  return normalized;
}

function validateClientRequirements(input = {}) {
  if (!input.category) throw new BusinessError('Categoria do cliente e obrigatoria.');
  const cpf = clean(input.cpf, 20).replace(/\D/g, '');
  if (cpf.length !== 11) throw new BusinessError('CPF e obrigatorio e deve ter 11 digitos.');
  if (input.category !== 'parceiro' && !input.origin) {
    throw new BusinessError('Origem do cliente e obrigatoria.');
  }
}

/**
 * Saneia as credenciais de acesso a portais. Estrutura de saida por slot:
 *   { login, password }            para 'detran' e 'gov'
 *   { label, login, password }     para 'outros'
 * Slots totalmente vazios sao descartados. Retorna:
 *   undefined -> campo ausente no payload (nao alterar no update)
 *   {}        -> limpar todos os acessos
 */
function normalizePortalAccess(input, { cpf = '' } = {}) {
  if (input === undefined) return undefined;
  if (input === null || input === '') return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BusinessError('Acessos do cliente devem ser um objeto.');
  }
  const out = {};
  for (const slot of PORTAL_SLOTS) {
    const raw = input[slot];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const login = slot === 'detran' || slot === 'gov'
      ? clean(cpf, 20).replace(/\D/g, '')
      : clean(raw.login, 160);
    const password = clean(raw.password, 200);
    const label = slot === 'outros' ? uppercaseOrNull(raw.label, 80) || '' : '';
    if ((slot === 'detran' || slot === 'gov') && !password) continue;
    if (!login && !password && !label) continue;
    const entry = { login, password };
    if (slot === 'outros') entry.label = label;
    out[slot] = entry;
  }
  return out;
}

/**
 * Versao segura de portal_access para quem NAO pode ver segredos: remove a senha
 * e sinaliza apenas se existe uma senha salva. Espelha a politica dos dados
 * bancarios do fornecedor (§38) — o banco guarda, a rota decide quem le.
 */
function redactPortalAccess(portalAccess) {
  if (!portalAccess || typeof portalAccess !== 'object') return {};
  const out = {};
  for (const slot of PORTAL_SLOTS) {
    const entry = portalAccess[slot];
    if (!entry || typeof entry !== 'object') continue;
    const safe = { login: entry.login || '', has_password: Boolean(entry.password) };
    if (slot === 'outros') safe.label = entry.label || '';
    out[slot] = safe;
  }
  return out;
}

// Somente perfis com permissao de alteracao do cliente recebem as senhas. Isso
// permite o trabalho operacional e evita expor credenciais em consultas apenas
// de leitura (financeiro, visualizador e back office de consulta).
const PORTAL_SECRET_ROLES = new Set([
  'admin', 'manager', 'operator', 'seller', 'front_office',
  'sales_backoffice', 'operations',
]);

function canViewPortalSecrets(role) {
  return PORTAL_SECRET_ROLES.has(String(role || '').toLowerCase());
}

/**
 * Prepara a linha do cliente para o solicitante: se ele nao puder ver segredos,
 * portal_access sai redigido. Nao muta a linha original.
 */
function clientForViewer(row, canSeeSecrets) {
  if (!row) return row;
  if (canSeeSecrets) return row;
  return { ...row, portal_access: redactPortalAccess(row.portal_access) };
}

/** Snapshot seguro para historico: nunca inclui login ou senha dos portais. */
function clientForAudit(row) {
  if (!row) return row;
  const portalAccess = row.portal_access && typeof row.portal_access === 'object'
    ? Object.fromEntries(PORTAL_SLOTS.map((slot) => [
      slot, Boolean(row.portal_access[slot]),
    ]))
    : {};
  return { ...row, portal_access: portalAccess };
}

module.exports = {
  ENUMS,
  PORTAL_SLOTS,
  normalizeRegistration,
  validateClientRequirements,
  uppercaseOrNull,
  normalizePortalAccess,
  redactPortalAccess,
  canViewPortalSecrets,
  clientForViewer,
  clientForAudit,
};
