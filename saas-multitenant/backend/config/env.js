'use strict';
// =============================================================================
// env.js — Validação da configuração no STARTUP.
//
// Em produção o backend deve falhar de forma clara (e não subir) quando faltar
// configuração essencial ou quando houver fallback inseguro (segredo padrão,
// CORS aberto, modo demo). Em desenvolvimento apenas avisa, para não travar o
// fluxo local.
//
// Não é executado no `require` — chame validateEnv()/assertEnvOrExit() a partir
// do entrypoint (app.js). Assim os testes seguem livres para injetar env.
// =============================================================================

// Valores que jamais podem ser usados como segredo em produção.
const WEAK_SECRETS = new Set([
  'TROQUE_ISSO_POR_UMA_CHAVE_SEGURA_DE_64_BYTES',
  'demo-secret', 'sisv-demo-secret', 'test-secret',
  'changeme', 'secret', 'jwtsecret', 'password', '123456',
]);

const MIN_SECRET_LENGTH = 32;

function collectOrigins() {
  const extra = (process.env.EXTRA_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [process.env.FRONTEND_URL, ...extra].map((s) => (s || '').trim()).filter(Boolean);
}

/**
 * Valida a configuração atual. Não lança — devolve o diagnóstico.
 * @returns {{ok:boolean, errors:string[], warnings:string[], env:string, isProd:boolean}}
 */
function validateEnv() {
  const env = process.env.NODE_ENV || 'development';
  const isProd = env === 'production';
  const errors = [];
  const warnings = [];

  // ── Obrigatórios em qualquer ambiente ──────────────────────────────────────
  if (!process.env.DATABASE_URL) errors.push('DATABASE_URL ausente.');
  const secret = process.env.JWT_SECRET;
  if (!secret) errors.push('JWT_SECRET ausente.');

  // ── Regras estritas de produção ────────────────────────────────────────────
  if (isProd) {
    if (secret && WEAK_SECRETS.has(secret)) {
      errors.push('JWT_SECRET usa um valor padrão/conhecido — gere um segredo próprio.');
    }
    if (secret && secret.length < MIN_SECRET_LENGTH) {
      errors.push(`JWT_SECRET muito curto (mínimo ${MIN_SECRET_LENGTH} caracteres em produção).`);
    }

    const origins = collectOrigins();
    if (origins.length === 0) {
      errors.push('FRONTEND_URL (ou EXTRA_CORS_ORIGINS) ausente — o CORS não pode ficar aberto em produção.');
    }
    if (origins.some((o) => o === '*' || o.includes('*'))) {
      errors.push('CORS com curinga (*) não é permitido em produção.');
    }

    if (process.env.SISV_DEMO === '1' || process.env.DEMO_MODE === '1') {
      errors.push('Modo demonstração não pode ser habilitado em produção.');
    }
    if (process.env.SEED_ON_START === '1') {
      errors.push('Seed automático no start não pode ser habilitado em produção.');
    }
    if (!process.env.BASE_URL) {
      warnings.push('BASE_URL não definida — links de arquivo podem sair com host incorreto.');
    }
  } else {
    if (secret && WEAK_SECRETS.has(secret)) {
      warnings.push('JWT_SECRET é um valor de desenvolvimento — nunca use em produção.');
    }
  }

  return { ok: errors.length === 0, errors, warnings, env, isProd };
}

/**
 * Valida e ENCERRA o processo se a configuração for inválida.
 * Imprime apenas NOMES de variáveis — nunca os valores (evita vazar segredo em log).
 */
function assertEnvOrExit() {
  const r = validateEnv();
  for (const w of r.warnings) console.warn(`[config] aviso: ${w}`);
  if (!r.ok) {
    console.error(`[config] Configuração inválida para NODE_ENV=${r.env}. O servidor não será iniciado:`);
    for (const e of r.errors) console.error(`  - ${e}`);
    console.error('[config] Consulte backend/.env.example e a documentação de deploy (DEPLOY_SISV.md).');
    process.exit(1);
  }
  console.log(`[config] Configuração validada (NODE_ENV=${r.env}).`);
  return r;
}

// Limite de upload (bytes) configurável, com teto de segurança.
function uploadLimitBytes() {
  const mb = Number(process.env.UPLOAD_MAX_MB || 10);
  const safe = Number.isFinite(mb) && mb > 0 && mb <= 50 ? mb : 10;
  return safe * 1024 * 1024;
}

module.exports = { validateEnv, assertEnvOrExit, uploadLimitBytes, WEAK_SECRETS, MIN_SECRET_LENGTH };
