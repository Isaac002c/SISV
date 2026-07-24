/* =============================================================================
 * sisv-demo-server.js — Servidor de DEMONSTRAÇÃO local do SISV (Sinal Verde).
 *
 * Roda as ROTAS REAIS (tenant, config, processos, clientes) contra um Postgres
 * em memória (pg-mem), com o tenant SISV + catálogos CNH + dados de exemplo.
 * Serve para smoke test da stack completa SEM banco externo. NÃO usar em produção.
 *
 * Uso:  cd saas-multitenant/backend && node sisv-demo-server.js   (porta 5000)
 * Login demo: gestor@sinalverde.com.br (admin) | operador1@sinalverde.com.br (operator)
 *             — qualquer senha; é só demonstração.
 * ============================================================================= */
// GUARDA DE SEGURANÇA: este arquivo é APENAS demonstração local (banco em
// memória, login sem senha). Nunca pode ser usado como entrypoint de produção.
if (process.env.NODE_ENV === 'production') {
  console.error('[sisv-demo-server] BLOQUEADO: servidor de demonstração não pode rodar com NODE_ENV=production.');
  console.error('[sisv-demo-server] Use "node app.js" como entrypoint de produção.');
  process.exit(1);
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sisv-demo-secret';
process.env.NODE_ENV = 'development';

const { randomUUID } = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { newDb, DataType } = require('pg-mem');

const { SISV_IDENTITY, SISV_MODULES, seedSisvCatalogs } = require('./scripts/sisv_seed_data');

const TENANT = 'sisv-demo-tenant';

// ── 1) pg-mem + schema ───────────────────────────────────────────────────────
const db = newDb();
db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });

db.public.none(`
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT, status TEXT DEFAULT 'ativo', email TEXT,
    logo_url TEXT, brand_color TEXT, brand_color_dark TEXT, tagline TEXT, developer TEXT, modules JSONB,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT, email TEXT,
    password_hash TEXT, role TEXT, seller_id UUID, last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT,
    birth_date DATE, cpf TEXT, cnh TEXT, first_cnh DATE, phone TEXT, email TEXT, address TEXT, notes TEXT,
    status TEXT DEFAULT 'negociacao', lead_id UUID, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_final BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_statuses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_pending BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE tenant_service_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, client_id UUID,
    company_id UUID, vehicle_id UUID, service_type_id INT, seller_id UUID, fine_number TEXT, plate TEXT, organ TEXT,
    infraction_type TEXT, vehicle_model TEXT, infraction_date DATE, due_date DATE, defense_date DATE,
    stage TEXT DEFAULT 'ENTRADA', status TEXT DEFAULT 'PENDENTE', value NUMERIC(15,2) DEFAULT 0, cost NUMERIC(15,2) DEFAULT 0,
    paid_value NUMERIC(15,2) DEFAULT 0, notes TEXT, protocol_number TEXT, department_id UUID, tenant_service_type_id UUID,
    finalized_at TIMESTAMPTZ, reopened_at TIMESTAMPTZ, last_moved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fine_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, name TEXT, file_url TEXT, file_type TEXT, file_size BIGINT, category TEXT, category_id UUID, notes TEXT, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now(), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fine_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, action TEXT, field_name TEXT, old_value TEXT, new_value TEXT, user_id UUID, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE activity_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, user_id UUID, entity TEXT, entity_id UUID, entity_name TEXT, action TEXT, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, contract_id UUID, client_id UUID, company_id UUID, vehicle_id UUID, file_url TEXT, file_name TEXT, file_type TEXT, file_size BIGINT, category TEXT DEFAULT 'outros', description TEXT, category_id UUID, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE document_categories (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, description TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE service_type_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, tenant_service_type_id UUID, category_id UUID, required BOOLEAN DEFAULT FALSE, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
`);

const pgAdapter = db.adapters.createPg();
const pool = new pgAdapter.Pool();

// Injeta o pool no lugar de config/db ANTES de carregar as rotas reais.
const dbModulePath = require.resolve('./config/db');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: pool };

const tenantContext = require('./middlewares/tenantContext');
const { requireModule } = require('./middlewares/requireModule');
const tenantRoutes = require('./routes/tenantRoutes');
const tenantConfigRoutes = require('./routes/tenantConfigRoutes');
const processRoutes = require('./routes/processRoutes');
const clientRoutes = require('./routes/clientRoutes');
const finesRoutes = require('./routes/finesRoutes');
const documentRoutes = require('./routes/documentRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const path = require('path');
const express0 = require('express');

let ADMIN_ID, OP_ID;

async function seed() {
  await pool.query(
    `INSERT INTO tenants (id,name,slug,status,brand_color,brand_color_dark,tagline,developer,modules)
     VALUES ($1,$2,$3,'ativo',$4,$5,$6,$7,$8::jsonb)`,
    [TENANT, SISV_IDENTITY.name, SISV_IDENTITY.slug, SISV_IDENTITY.brand_color,
     SISV_IDENTITY.brand_color_dark, SISV_IDENTITY.tagline, SISV_IDENTITY.developer, JSON.stringify(SISV_MODULES)]
  );
  ADMIN_ID = (await pool.query(`INSERT INTO users (tenant_id,name,email,password_hash,role) VALUES ($1,'Gestor Sinal Verde','gestor@sinalverde.com.br','x','admin') RETURNING id`, [TENANT])).rows[0].id;
  OP_ID = (await pool.query(`INSERT INTO users (tenant_id,name,email,password_hash,role) VALUES ($1,'Operador 1','operador1@sinalverde.com.br','x','operator') RETURNING id`, [TENANT])).rows[0].id;

  await seedSisvCatalogs(pool, TENANT);
  const dept = async (n) => (await pool.query(`SELECT id FROM departments WHERE tenant_id=$1 AND name=$2`, [TENANT, n])).rows[0].id;
  const svc = async (c) => (await pool.query(`SELECT id FROM tenant_service_types WHERE tenant_id=$1 AND code=$2`, [TENANT, c])).rows[0].id;
  const dAtd = await dept('Atendimento'); const dJur = await dept('Jurídico');
  const sRea = await svc('REABILITACAO'); const sRen = await svc('RENOVACAO');

  const clients = [];
  for (const [name, cpf, phone] of [
    ['Maria Oliveira', '12345678909', '(21) 99888-1122'],
    ['João Santos', '98765432100', '(21) 97777-3344'],
    ['Ana Souza', '45678912300', '(21) 96666-5566'],
  ]) {
    clients.push((await pool.query(`INSERT INTO clients (tenant_id,name,cpf,phone,status) VALUES ($1,$2,$3,$4,'fechado') RETURNING id`, [TENANT, name, cpf, phone])).rows[0].id);
  }

  const mk = async (client_id, num, stage, status, seller_id, department_id, tsvc, movedDaysAgo) => {
    const moved = new Date(Date.now() - movedDaysAgo * 86400000).toISOString();
    const r = await pool.query(
      `INSERT INTO fines (tenant_id,client_id,fine_number,stage,status,seller_id,department_id,tenant_service_type_id,last_moved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [TENANT, client_id, num, stage, status, seller_id, department_id, tsvc, moved]);
    await pool.query(`INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id) VALUES ($1,$2,'created','processo',$3,$4)`, [TENANT, r.rows[0].id, `Processo ${num}`, ADMIN_ID]);
    return r.rows[0].id;
  };
  await mk(clients[0], 'SV-0001', 'DEFESA', 'EM_ANALISE', OP_ID, dJur, sRea, 1);
  await mk(clients[1], 'SV-0002', 'ENTRADA', 'PENDENTE', OP_ID, dAtd, sRen, 10);
  await mk(clients[2], 'SV-0003', 'ELABORACAO', 'AGUARDANDO_DOCUMENTO', null, dAtd, sRea, 3);
  await mk(clients[0], 'SV-0004', 'FINALIZADO', 'DEFERIDO', ADMIN_ID, dJur, sRea, 20);
  // finaliza o SV-0004
  await pool.query(`UPDATE fines SET finalized_at = NOW() WHERE fine_number='SV-0004' AND tenant_id=$1`, [TENANT]);

  console.log('✓ Seed SISV demo concluído.');
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const tokenFor = (u) => jwt.sign({ userId: u.id, tenantId: TENANT, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1d' });

app.post('/auth/login', async (req, res) => {
  const email = (req.body?.email || 'gestor@sinalverde.com.br').toLowerCase();
  const u = (await pool.query(`SELECT id,name,email,role FROM users WHERE tenant_id=$1 AND LOWER(email)=$2`, [TENANT, email])).rows[0];
  if (!u) return res.status(401).json({ success: false, message: 'Usuário demo não encontrado' });
  const token = tokenFor(u);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.cookie('auth-token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({
    success: true, token, user: { id: u.id, name: u.name, email: u.email, role: u.role },
    tenant: {
      id: TENANT, name: SISV_IDENTITY.name, slug: SISV_IDENTITY.slug,
      brand_color: SISV_IDENTITY.brand_color, brand_color_dark: SISV_IDENTITY.brand_color_dark,
      tagline: SISV_IDENTITY.tagline, developer: SISV_IDENTITY.developer, modules: SISV_MODULES,
    },
  });
});
app.post('/auth/logout', (req, res) => res.json({ success: true }));

// Health/Readiness reais (mesmo router usado em produção).
app.use(require('./routes/healthRoutes')(pool));

app.use('/api', tenantContext);
app.use('/api/tenant', tenantRoutes);
app.use('/api/config', tenantConfigRoutes);
app.use('/api/processes', requireModule('processos'), processRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/fines', finesRoutes);
app.use('/api/upload', uploadRoutes);
// Serve uploads estaticamente (compatibilidade) — o download controlado é via /api
app.use('/uploads', express0.static(path.join(__dirname, 'uploads')));

// Stubs de módulos desabilitados (para provar o gating retornando 403 real).
app.use('/api/financial', requireModule('financeiro'), (req, res) => res.json({ success: true, data: [] }));
app.use('/api/leads', requireModule('leads'), (req, res) => res.json({ success: true, data: [] }));

// Catch-all silencioso para outros GET do dashboard.
app.get('/api/*', (req, res) => res.json({ success: true, data: [] }));
app.use((req, res) => res.status(404).json({ success: false, error: 'Rota não encontrada (demo)' }));

const PORT = process.env.PORT || 5000;
seed()
  .then(() => app.listen(PORT, () => console.log(`\n🟢 SISV DEMO backend em http://localhost:${PORT}\n   login: gestor@sinalverde.com.br (admin) | operador1@sinalverde.com.br (operator)\n`)))
  .catch((err) => { console.error('Falha no seed SISV demo:', err); process.exit(1); });
