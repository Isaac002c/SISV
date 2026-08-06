// =============================================================================
// branding.js — Resolve a identidade a exibir em recibos/páginas financeiras.
//
// Regra do produto:
//   * Usa o branding do tenant quando configurado (settings financeiras ou tenants).
//   * Cai para o padrão SISV / TELUN quando o tenant não possui identidade própria.
//   * NUNCA fixa branding de cliente nos componentes — tudo vem de dados.
//   * A assinatura TELUN só aparece no fallback padrão, para não
//     substituir a marca de um tenant existente (ex.: CR Recursos).
// =============================================================================

const { DEFAULT_BRANDING } = require('./constants');

function resolveBranding({ tenant = null, settings = null, receipt = null } = {}) {
  const hasOwnIdentity = !!(
    (settings && (settings.razao_social || settings.logo_url)) ||
    (tenant && (tenant.logo_url || tenant.name))
  );

  const name =
    (receipt && receipt.issuer_name) ||
    (settings && settings.razao_social) ||
    (tenant && tenant.name) ||
    DEFAULT_BRANDING.name;

  const document =
    (receipt && receipt.issuer_document) ||
    (settings && settings.document) ||
    null;

  const address =
    (receipt && receipt.issuer_address) ||
    (settings && settings.address) ||
    null;

  const logo_url =
    (settings && settings.logo_url) ||
    (tenant && tenant.logo_url) ||
    null;

  const phone = (settings && settings.phone) || null;
  const email = (settings && settings.email) || null;

  return {
    name,
    document,
    address,
    logo_url,
    phone,
    email,
    // Assinatura padrão do produto apenas quando não há identidade própria.
    signature: hasOwnIdentity ? null : DEFAULT_BRANDING.signature,
    is_default: !hasOwnIdentity,
  };
}

module.exports = { resolveBranding };
