'use strict';
// =============================================================================
// create_admin.js — Criação SEGURA do primeiro administrador do SISV.
//
// Regras (produção):
//   • A senha NUNCA fica no código nem é impressa. Ela vem da variável de
//     ambiente SISV_NEW_ADMIN_PASSWORD, definida pelo operador fora do repo.
//   • Impede duplicidade (e-mail já existente no tenant).
//   • Por padrão, recusa criar se o tenant já tiver um administrador
//     (use --force para casos legítimos de reposição).
//   • Hash com bcrypt (custo 12).
//
// Uso:
//   SISV_NEW_ADMIN_PASSWORD='<senha-forte>' \
//   DATABASE_URL=... node scripts/create_admin.js \
//     --tenant sisv --email pessoa@empresa.com --name "Nome Completo"
//
// Dica para gerar uma senha forte (não fica em histórico se usar leitura segura):
//   node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
// =============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const MIN_PASSWORD_LENGTH = 12;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const tenantRef = arg('tenant');
  const email = (arg('email') || '').trim().toLowerCase();
  const name = (arg('name') || '').trim();
  const force = process.argv.includes('--force');
  const password = process.env.SISV_NEW_ADMIN_PASSWORD || '';

  // ── Validação de entrada ───────────────────────────────────────────────────
  if (!tenantRef || !email || !name) {
    return fail('Uso: node scripts/create_admin.js --tenant <slug|id> --email <email> --name "<nome>"');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('E-mail inválido.');
  if (!password) {
    return fail('Defina a senha na variável de ambiente SISV_NEW_ADMIN_PASSWORD (ela nunca é impressa nem gravada em arquivo).');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`A senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`);
  }

  // ── Tenant (por slug ou id) ────────────────────────────────────────────────
  const t = await pool.query(
    'SELECT id, name, slug FROM tenants WHERE slug = $1 OR id::text = $1 LIMIT 1', [tenantRef]);
  const tenant = t.rows[0];
  if (!tenant) return fail(`Tenant "${tenantRef}" não encontrado. Rode o seed do tenant antes.`);

  // ── Duplicidade ────────────────────────────────────────────────────────────
  const existing = await pool.query(
    'SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2', [tenant.id, email]);
  if (existing.rows[0]) return fail(`Já existe um usuário com o e-mail ${email} neste tenant.`);

  const admins = await pool.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'admin'", [tenant.id]);
  if (admins.rows[0].n > 0 && !force) {
    return fail(`O tenant "${tenant.slug}" já possui ${admins.rows[0].n} administrador(es). Use --force se a criação for intencional.`);
  }

  // ── Criação ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(password, 12);
  const created = await pool.query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
    [tenant.id, name, email, hash]
  );

  // Confirmação SEM imprimir a senha.
  console.log('✓ Administrador criado com sucesso.');
  console.log(`  tenant : ${tenant.name} (${tenant.slug})`);
  console.log(`  nome   : ${name}`);
  console.log(`  e-mail : ${email}`);
  console.log(`  id     : ${created.rows[0].id}`);
  console.log('  senha  : (definida via SISV_NEW_ADMIN_PASSWORD — não exibida)');
  console.log('\n  Oriente a pessoa a trocar a senha no primeiro acesso.');
  console.log('  Limpe a variável do shell:  unset SISV_NEW_ADMIN_PASSWORD');
}

main()
  .catch((err) => { console.error('✗ Falha ao criar administrador:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
