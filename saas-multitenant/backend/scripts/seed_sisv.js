'use strict';
// =============================================================================
// seed_sisv.js — Provisiona (idempotente) o tenant da Sinal Verde (SISV/TELUN).
//
// Cria/atualiza:
//   • tenant "SISV" com identidade TELUN, branding e módulos habilitados;
//   • até 4 usuários (1 gestor + 3 operacionais);
//   • catálogos CNH: etapas, status, tipos de serviço e setores.
//
// Pré-requisito: migrations aplicadas
//   psql "$DATABASE_URL" -f migrations/000_nexos_schema.sql
//   psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql
//
// Uso:
//   DATABASE_URL=... node scripts/seed_sisv.js
//
// Senhas: nunca inventadas. Use env SISV_<KEY>_PASSWORD (ex.: SISV_ADMIN_PASSWORD)
// ou deixe o script gerar uma senha aleatória forte por usuário — impressa UMA
// única vez no final para você repassar e forçar a troca no primeiro acesso.
// =============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
const crypto = require('crypto');
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const {
  SISV_SLUG, SISV_IDENTITY, SISV_MODULES, SISV_USERS, seedSisvCatalogs,
} = require('./sisv_seed_data');

const randomPassword = () =>
  crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + 'A9!';

async function upsertTenant() {
  const found = await pool.query('SELECT id FROM tenants WHERE slug = $1', [SISV_SLUG]);
  let tenantId = found.rows[0]?.id;

  if (!tenantId) {
    const ins = await pool.query(
      `INSERT INTO tenants (name, slug, status, brand_color, brand_color_dark, tagline, developer, modules, logo_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [SISV_IDENTITY.name, SISV_IDENTITY.slug, SISV_IDENTITY.status,
       SISV_IDENTITY.brand_color, SISV_IDENTITY.brand_color_dark, SISV_IDENTITY.tagline,
       SISV_IDENTITY.developer, JSON.stringify(SISV_MODULES), SISV_IDENTITY.logo_url]
    );
    tenantId = ins.rows[0].id;
    console.log(`✓ Tenant SISV criado (${tenantId})`);
  } else {
    await pool.query(
      `UPDATE tenants SET name=$2, status=$3, brand_color=$4, brand_color_dark=$5,
              tagline=$6, developer=$7, modules=$8::jsonb, updated_at=NOW()
       WHERE id=$1`,
      [tenantId, SISV_IDENTITY.name, SISV_IDENTITY.status, SISV_IDENTITY.brand_color,
       SISV_IDENTITY.brand_color_dark, SISV_IDENTITY.tagline, SISV_IDENTITY.developer,
       JSON.stringify(SISV_MODULES)]
    );
    console.log(`✓ Tenant SISV atualizado (${tenantId})`);
  }
  return tenantId;
}

async function ensureUser(tenantId, u) {
  const exists = await pool.query(
    'SELECT id FROM users WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)',
    [tenantId, u.email]
  );
  if (exists.rows[0]) {
    console.log(`  · usuário já existe: ${u.email} (${u.role})`);
    return null;
  }
  const password = process.env[`SISV_${u.key.toUpperCase()}_PASSWORD`] || randomPassword();
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    [tenantId, u.name, u.email, hash, u.role]
  );
  const generated = !process.env[`SISV_${u.key.toUpperCase()}_PASSWORD`];
  return { email: u.email, role: u.role, password, generated };
}

async function main() {
  console.log('== Seed SISV — Sinal Verde / TELUN ==');
  const tenantId = await upsertTenant();

  const created = [];
  for (const u of SISV_USERS) {
    const res = await ensureUser(tenantId, u);
    if (res) created.push(res);
  }

  await seedSisvCatalogs(pool, tenantId);
  console.log('✓ Catálogos CNH (etapas, status, tipos de serviço, setores) garantidos.');

  if (created.length) {
    console.log('\n── Credenciais provisórias (troque no primeiro acesso) ──────────────');
    for (const c of created) {
      const tag = c.generated ? '(gerada)' : '(via env)';
      console.log(`  ${c.role.padEnd(9)} ${c.email.padEnd(32)} senha: ${c.password} ${tag}`);
    }
    console.log('─────────────────────────────────────────────────────────────────────');
    console.log('  Repasse por canal seguro. As senhas geradas NÃO ficam salvas em lugar nenhum.');
  } else {
    console.log('\nNenhum usuário novo criado (todos já existiam).');
  }

  console.log('\n✓ Seed SISV concluído.');
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error('✗ Falha no seed SISV:', err.message); pool.end(); process.exit(1); });
