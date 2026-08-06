'use strict';

// =============================================================================
// sisv-commercial.test.js — cobertura do SISV 2.0 (§52).
//
// Além do caminho feliz, os testes cobrem sobretudo o que a rodada PROÍBE:
//   * anexar comprovante NAO aprova pagamento;
//   * aprovar pagamento NAO cria venda;
//   * confirmar venda NAO cria obrigacao nem comissao;
//   * venda, ordem, recibo, comissao, obrigacao e finalizacao nao duplicam;
//   * devolucao/rejeicao/cancelamento/estorno/reabertura exigem justificativa;
//   * pedido antigo preserva o preco mesmo depois de a tabela mudar;
//   * tenant nunca enxerga dado de outro tenant.
// =============================================================================

process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { newDb, DataType } = require('pg-mem');

let suppliers;
let catalog;
let clientFields;
let orders;
let sales;
let execution;
let docs;
let backoffice;
let pool;

const TENANT = randomUUID();
const OTHER = randomUUID();
let adminId;
let otherAdminId;
let clientId;
let otherClientId;
let serviceTypeId;

before(async () => {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid', returns: DataType.uuid, impure: true,
    implementation: () => randomUUID(),
  });
  db.public.registerFunction({
    name: 'trim', args: [DataType.text], returns: DataType.text,
    implementation: (value) => String(value).trim(),
  });
  // ROUND existe no PostgreSQL, mas nao no pg-mem. Registrar aqui evita
  // deformar a consulta de producao so para o banco de teste (relatorio de
  // margem usa ROUND(x, 2)).
  db.public.registerFunction({
    name: 'round', args: [DataType.float, DataType.integer], returns: DataType.float,
    implementation: (value, digits) => {
      const factor = 10 ** Number(digits || 0);
      return Math.round(Number(value) * factor) / factor;
    },
  });
  db.public.registerFunction({
    name: 'round', args: [DataType.float], returns: DataType.float,
    implementation: (value) => Math.round(Number(value)),
  });

  // Schema derivado das migrations sisv_06 (ver scripts/pgmem-schema-gen.js).
  // Mantido explicito aqui para o teste não depender de leitura de arquivo.
  db.public.none(`
    CREATE TABLE tenants (id UUID PRIMARY KEY, name TEXT, slug TEXT, developer TEXT,
      tagline TEXT, modules JSONB);
    CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT, email TEXT, role TEXT, is_active BOOLEAN DEFAULT TRUE, department_id UUID);
    CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, name TEXT);
    CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT, cpf TEXT, phone TEXT, email TEXT, address TEXT, additional_data JSONB DEFAULT '{}'::jsonb,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tenant_service_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT, label TEXT, active BOOLEAN DEFAULT TRUE, initial_stage TEXT, initial_status TEXT,
      default_due_days INT, initial_department_id UUID);
    CREATE TABLE fines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      client_id UUID, seller_id UUID, department_id UUID, tenant_service_type_id UUID,
      fine_number TEXT, protocol_number TEXT, stage TEXT, status TEXT, value NUMERIC(15,2) DEFAULT 0,
      cost NUMERIC(15,2) DEFAULT 0, due_date DATE, notes TEXT, last_moved_at TIMESTAMPTZ,
      finalized_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE process_tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      fine_id UUID NOT NULL, title TEXT, status TEXT DEFAULT 'aberta', deleted_at TIMESTAMPTZ);
    CREATE TABLE activity_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      user_id UUID, entity TEXT, entity_id UUID, entity_name TEXT, action TEXT,
      details JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW());

    CREATE TABLE commercial_counters (tenant_id UUID NOT NULL, doc_type TEXT NOT NULL,
      current_number INT DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (tenant_id, doc_type));
    CREATE TABLE commercial_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      entity_type TEXT NOT NULL, entity_id UUID NOT NULL, action TEXT NOT NULL, from_status TEXT,
      to_status TEXT, reason TEXT, details JSONB DEFAULT '{}'::jsonb, user_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE suppliers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      kind TEXT DEFAULT 'fornecedor', person_type TEXT DEFAULT 'pj', legal_name TEXT NOT NULL,
      trade_name TEXT, document TEXT, state_registration TEXT, contact_name TEXT, phone TEXT,
      whatsapp TEXT, email TEXT, address TEXT, bank_details TEXT, pix_key TEXT,
      services_provided TEXT, commission_type TEXT, commission_value NUMERIC(15,2),
      payment_terms TEXT, default_price_table_id UUID, discount_type TEXT, discount_value NUMERIC(15,2),
      payment_method TEXT, commercial_notes TEXT, notes TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
      row_version INT NOT NULL DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE catalog_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT NOT NULL, name TEXT NOT NULL, description TEXT, item_type TEXT DEFAULT 'servico',
      category TEXT, unit TEXT DEFAULT 'un', default_price NUMERIC(15,2) DEFAULT 0,
      default_cost NUMERIC(15,2), estimated_duration_days INT, tenant_service_type_id UUID,
      document_checklist JSONB DEFAULT '[]'::jsonb, requires_process BOOLEAN DEFAULT FALSE,
      requires_invoice BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE,
      row_version INT NOT NULL DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE price_tables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT NOT NULL, description TEXT, audience TEXT, starts_on DATE, ends_on DATE,
      priority INT DEFAULT 0, status TEXT DEFAULT 'rascunho', source_table_id UUID,
      row_version INT NOT NULL DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE price_table_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      price_table_id UUID NOT NULL, catalog_item_id UUID NOT NULL, price NUMERIC(15,2) DEFAULT 0,
      cost NUMERIC(15,2), max_discount_percent NUMERIC(5,2) DEFAULT 0, notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (price_table_id, catalog_item_id));
    CREATE TABLE client_field_definitions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      field_key TEXT NOT NULL, label TEXT NOT NULL, field_type TEXT DEFAULT 'text', storage_kind TEXT DEFAULT 'custom',
      system_column TEXT, validation_rules JSONB DEFAULT '{}'::jsonb, active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0, row_version INT DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(tenant_id, field_key));
    CREATE TABLE service_client_field_requirements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      catalog_item_id UUID NOT NULL, field_definition_id UUID NOT NULL, required BOOLEAN DEFAULT TRUE,
      active BOOLEAN DEFAULT TRUE, display_order INT DEFAULT 0, label_override TEXT,
      validation_rules JSONB DEFAULT '{}'::jsonb, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(catalog_item_id, field_definition_id));
    CREATE TABLE orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      number TEXT NOT NULL, client_id UUID NOT NULL, price_table_id UUID,
      origin_channel TEXT DEFAULT 'balcao', owner_id UUID, department_id UUID,
      status TEXT DEFAULT 'rascunho', subtotal NUMERIC(15,2) DEFAULT 0, discount NUMERIC(15,2) DEFAULT 0,
      surcharge NUMERIC(15,2) DEFAULT 0, total NUMERIC(15,2) DEFAULT 0, notes TEXT,
      sent_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT,
      contractor_type TEXT DEFAULT 'client', contractor_partner_id UUID,
      applied_commercial_terms JSONB DEFAULT '{}'::jsonb, commercial_terms_applied_at TIMESTAMPTZ,
      contracting_model_version SMALLINT DEFAULT 1,
      row_version INT NOT NULL DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, number));
    CREATE TABLE order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      order_id UUID NOT NULL, catalog_item_id UUID, description TEXT NOT NULL,
      item_type TEXT DEFAULT 'servico', unit TEXT DEFAULT 'un', quantity NUMERIC(12,3) DEFAULT 1,
      unit_price NUMERIC(15,2) DEFAULT 0, unit_cost NUMERIC(15,2), discount NUMERIC(15,2) DEFAULT 0,
      surcharge NUMERIC(15,2) DEFAULT 0, total NUMERIC(15,2) DEFAULT 0, supplier_id UUID,
      commission_type TEXT, commission_value NUMERIC(15,2), requires_process BOOLEAN DEFAULT FALSE,
      tenant_service_type_id UUID, notes TEXT, status TEXT DEFAULT 'ativo', sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE order_validations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      order_id UUID NOT NULL, decision TEXT NOT NULL, reason TEXT, checklist JSONB DEFAULT '{}'::jsonb,
      order_version INT, reviewed_by UUID, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE document_templates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT NOT NULL, doc_type TEXT NOT NULL, body TEXT NOT NULL,
      available_fields JSONB DEFAULT '[]'::jsonb, version INT DEFAULT 1, status TEXT DEFAULT 'rascunho',
      row_version INT NOT NULL DEFAULT 1, created_by UUID, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE generated_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      template_id UUID, template_version INT, doc_type TEXT NOT NULL, title TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id UUID NOT NULL, client_id UUID, order_id UUID,
      sale_id UUID, payment_id UUID, content TEXT, checksum TEXT, file_url TEXT,
      stage TEXT DEFAULT 'pedido', status TEXT DEFAULT 'gerado', replaced_by UUID,
      cancel_reason TEXT, cancelled_at TIMESTAMPTZ, generated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE commercial_contracts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      number TEXT NOT NULL, client_id UUID NOT NULL, order_id UUID, sale_id UUID, title TEXT NOT NULL,
      generated_document_id UUID, status TEXT DEFAULT 'rascunho', signed_at DATE, signed_by_name TEXT,
      responsible_id UUID, witnesses JSONB DEFAULT '[]'::jsonb, file_url TEXT, replaced_by UUID,
      notes TEXT, row_version INT NOT NULL DEFAULT 1, created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, number));
    CREATE TABLE receivables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      client_id UUID NOT NULL, order_id UUID, sale_id UUID, description TEXT NOT NULL,
      total_amount NUMERIC(15,2) DEFAULT 0, received_amount NUMERIC(15,2) DEFAULT 0, due_date DATE,
      payment_method TEXT, status TEXT DEFAULT 'pendente', notes TEXT, settled_at TIMESTAMPTZ,
      row_version INT NOT NULL DEFAULT 1, created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE customer_payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      receivable_id UUID NOT NULL, order_id UUID, sale_id UUID, client_id UUID NOT NULL,
      amount NUMERIC(15,2) NOT NULL, paid_at DATE, payment_method TEXT DEFAULT 'pix', reference TEXT,
      proof_url TEXT, status TEXT DEFAULT 'informado', decision_reason TEXT, notes TEXT,
      registered_by UUID, validated_by UUID, validated_at TIMESTAMPTZ,
      row_version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE sales (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      number TEXT NOT NULL, order_id UUID NOT NULL, client_id UUID NOT NULL,
      gross_amount NUMERIC(15,2) DEFAULT 0, discount_amount NUMERIC(15,2) DEFAULT 0,
      net_amount NUMERIC(15,2) DEFAULT 0, estimated_cost NUMERIC(15,2) DEFAULT 0,
      estimated_margin NUMERIC(15,2) DEFAULT 0, commission_forecast NUMERIC(15,2) DEFAULT 0,
      owner_id UUID, partner_id UUID, status TEXT DEFAULT 'confirmada', notes TEXT,
      confirmed_by UUID, confirmed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT,
      row_version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, number), UNIQUE (tenant_id, order_id));
    CREATE TABLE sale_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      sale_id UUID NOT NULL, order_item_id UUID, catalog_item_id UUID, description TEXT NOT NULL,
      item_type TEXT DEFAULT 'servico', quantity NUMERIC(12,3) DEFAULT 1,
      unit_price NUMERIC(15,2) DEFAULT 0, unit_cost NUMERIC(15,2), discount NUMERIC(15,2) DEFAULT 0,
      total NUMERIC(15,2) DEFAULT 0, supplier_id UUID, commission_type TEXT,
      commission_value NUMERIC(15,2), requires_process BOOLEAN DEFAULT FALSE,
      tenant_service_type_id UUID, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE service_orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      number TEXT NOT NULL, sale_id UUID NOT NULL, order_id UUID, client_id UUID NOT NULL,
      department_id UUID, owner_id UUID, priority TEXT DEFAULT 'normal', due_date DATE,
      planned_date DATE, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, status TEXT DEFAULT 'rascunho',
      instructions TEXT, notes TEXT, cancel_reason TEXT, archived_at TIMESTAMPTZ, archived_by UUID,
      reopened_at TIMESTAMPTZ, reopened_by UUID, reopen_reason TEXT, row_version INT NOT NULL DEFAULT 1,
      created_by UUID, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, number), UNIQUE (tenant_id, sale_id));
    CREATE TABLE service_order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      service_order_id UUID NOT NULL, sale_item_id UUID, process_id UUID, description TEXT NOT NULL,
      quantity NUMERIC(12,3) DEFAULT 1, supplier_id UUID, status TEXT DEFAULT 'pendente', notes TEXT,
      sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE execution_costs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      service_order_id UUID NOT NULL, service_order_item_id UUID, sale_id UUID, supplier_id UUID,
      description TEXT NOT NULL, planned_cost NUMERIC(15,2) DEFAULT 0, actual_cost NUMERIC(15,2),
      incurred_on DATE, document_ref TEXT, status TEXT DEFAULT 'previsto', notes TEXT,
      row_version INT NOT NULL DEFAULT 1, created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE commissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      sale_id UUID NOT NULL, sale_item_id UUID, beneficiary_supplier_id UUID, beneficiary_user_id UUID,
      beneficiary_name TEXT NOT NULL, base_amount NUMERIC(15,2) DEFAULT 0,
      rate_type TEXT DEFAULT 'percentual', rate_value NUMERIC(15,2) DEFAULT 0,
      amount NUMERIC(15,2) DEFAULT 0, status TEXT DEFAULT 'prevista', expected_date DATE,
      paid_at DATE, proof_url TEXT, notes TEXT, payable_id UUID, row_version INT NOT NULL DEFAULT 1,
      confirmed_by UUID, confirmed_at TIMESTAMPTZ, created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      kind TEXT NOT NULL, payee_supplier_id UUID, payee_user_id UUID, payee_name TEXT NOT NULL,
      order_id UUID, sale_id UUID, service_order_id UUID, process_id UUID, execution_cost_id UUID,
      commission_id UUID, description TEXT NOT NULL, amount NUMERIC(15,2) NOT NULL, due_date DATE,
      payment_method TEXT, status TEXT DEFAULT 'previsto', proof_url TEXT, paid_at DATE, notes TEXT,
      row_version INT NOT NULL DEFAULT 1, created_by UUID, approved_by UUID, approved_at TIMESTAMPTZ,
      paid_by UUID, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE fiscal_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      sale_id UUID, service_order_id UUID, order_id UUID, client_id UUID,
      required BOOLEAN DEFAULT TRUE, status TEXT DEFAULT 'pendente', number TEXT, series TEXT,
      access_key TEXT, issued_at DATE, amount NUMERIC(15,2), pdf_url TEXT, xml_url TEXT,
      issuer TEXT, notes TEXT, row_version INT NOT NULL DEFAULT 1, created_by UUID, updated_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE finalization_records (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      service_order_id UUID NOT NULL, sale_id UUID, client_id UUID, checklist JSONB DEFAULT '{}'::jsonb,
      delivered_at DATE, delivery_notes TEXT, final_notes TEXT, status TEXT DEFAULT 'concluida',
      finalized_by UUID, finalized_at TIMESTAMPTZ DEFAULT NOW(), archived_by UUID,
      archived_at TIMESTAMPTZ, reopened_by UUID, reopened_at TIMESTAMPTZ, reopen_reason TEXT,
      row_version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, service_order_id));
  `);

  const adapter = db.adapters.createPg();
  pool = new adapter.Pool();
  const dbModulePath = require.resolve('../config/db');
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: pool };

  suppliers = require('../models/supplierModels');
  catalog = require('../models/catalogModels');
  clientFields = require('../models/clientFieldModels');
  orders = require('../models/orderModels');
  sales = require('../models/saleModels');
  execution = require('../models/executionModels');
  docs = require('../models/commercialDocModels');
  backoffice = require('../models/backofficeModels');

  for (const [id, slug] of [[TENANT, 'sisv'], [OTHER, 'outro']]) {
    await pool.query(`INSERT INTO tenants (id,name,slug,developer) VALUES ($1,$2,$3,'TELUN')`,
      [id, slug, slug]);
  }
  adminId = (await pool.query(
    `INSERT INTO users (tenant_id,name,email,role) VALUES ($1,'Admin','a@t.test','admin') RETURNING id`,
    [TENANT])).rows[0].id;
  otherAdminId = (await pool.query(
    `INSERT INTO users (tenant_id,name,email,role) VALUES ($1,'Outro','b@o.test','admin') RETURNING id`,
    [OTHER])).rows[0].id;
  clientId = (await pool.query(
    `INSERT INTO clients (tenant_id,name,cpf) VALUES ($1,'Cliente Teste','12345678900') RETURNING id`,
    [TENANT])).rows[0].id;
  otherClientId = (await pool.query(
    `INSERT INTO clients (tenant_id,name,cpf) VALUES ($1,'Cliente Outro','99999999999') RETURNING id`,
    [OTHER])).rows[0].id;
  serviceTypeId = (await pool.query(
    `INSERT INTO tenant_service_types (tenant_id,code,label,initial_stage,initial_status,default_due_days)
     VALUES ($1,'REAB','Reabilitacao','ENTRADA','PENDENTE',30) RETURNING id`,
    [TENANT])).rows[0].id;
});

/** Executa uma ação esperando erro e devolve o erro capturado. */
async function expectError(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

// ── FORNECEDORES (§52) ───────────────────────────────────────────────────────

test('fornecedores: criar, editar, inativar, isolar por tenant e manter historico', async () => {
  const supplier = await suppliers.create(TENANT, adminId, {
    kind: 'parceiro', legal_name: 'Parceiro Um', document: '11.222.333/0001-44',
    email: 'p@teste.com', commission_type: 'percentual', commission_value: 10,
  });
  assert.equal(supplier.kind, 'parceiro');
  // O documento é normalizado para apenas dígitos.
  assert.equal(supplier.document, '11222333000144');

  const duplicate = await expectError(() => suppliers.create(TENANT, adminId, {
    legal_name: 'Outro nome', document: '11222333000144',
  }));
  assert.match(duplicate.message, /Ja existe cadastro/);

  const invalidCommission = await expectError(() => suppliers.create(TENANT, adminId, {
    legal_name: 'Comissao alta', commission_type: 'percentual', commission_value: 150,
  }));
  assert.match(invalidCommission.message, /nao pode ultrapassar 100/);

  const updated = await suppliers.update(TENANT, adminId, supplier.id,
    { trade_name: 'Parceiro Fantasia' }, supplier.row_version);
  assert.equal(updated.trade_name, 'Parceiro Fantasia');
  assert.equal(Number(updated.row_version), Number(supplier.row_version) + 1);

  // Conflito de edição: versão desatualizada devolve 409 (§51).
  const conflict = await expectError(() => suppliers.update(TENANT, adminId, supplier.id,
    { trade_name: 'Outro' }, supplier.row_version));
  assert.equal(conflict.status, 409);

  // Inativação exige motivo e nunca apaga o registro (§5).
  const noReason = await expectError(() => suppliers.setActive(TENANT, adminId, supplier.id, false, ''));
  assert.match(noReason.message, /motivo/i);
  const inactive = await suppliers.setActive(TENANT, adminId, supplier.id, false, 'Contrato encerrado');
  assert.equal(inactive.active, false);
  const stillThere = await suppliers.getById(TENANT, supplier.id);
  assert.ok(stillThere, 'fornecedor inativado permanece consultavel');

  // Isolamento: outro tenant não enxerga nem altera.
  assert.equal(await suppliers.getById(OTHER, supplier.id), null);
  const crossTenant = await expectError(() => suppliers.update(OTHER, otherAdminId, supplier.id,
    { trade_name: 'Invasao' }));
  assert.equal(crossTenant.status, 404);

  const detail = await suppliers.getById(TENANT, supplier.id);
  assert.equal(detail.trade_name, 'Parceiro Fantasia');

  const { rows: history } = await pool.query(
    `SELECT action FROM commercial_history
      WHERE tenant_id = $1 AND entity_type = 'supplier' AND entity_id = $2`,
    [TENANT, supplier.id]);
  const actions = history.map((row) => row.action);
  assert.ok(actions.includes('criado'));
  assert.ok(actions.includes('inativado'));
});

// ── CATÁLOGO E TABELAS DE PREÇO (§52) ────────────────────────────────────────

test('catalogo: item, preco separado do custo e margem derivada', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'serv-01', name: 'Servico A', default_price: 1000, default_cost: 400,
  });
  assert.equal(item.code, 'SERV-01');
  assert.equal(Number(item.default_price), 1000);
  assert.equal(Number(item.default_cost), 400);
  assert.equal(item.estimated_margin_percent, 60);

  // Item sem custo definido é válido (§7).
  const noCost = await catalog.createItem(TENANT, adminId, {
    code: 'SERV-02', name: 'Servico B', default_price: 500,
  });
  assert.equal(noCost.default_cost, null);
  assert.equal(noCost.estimated_margin_percent, null);

  const duplicate = await expectError(() => catalog.createItem(TENANT, adminId, {
    code: 'SERV-01', name: 'Repetido', default_price: 10,
  }));
  assert.match(duplicate.message, /codigo/i);

  // Outro tenant pode usar o mesmo código sem colidir.
  const otherItem = await catalog.createItem(OTHER, otherAdminId, {
    code: 'SERV-01', name: 'Servico do outro tenant', default_price: 99,
  });
  assert.ok(otherItem.id);
  assert.equal((await catalog.listItems(OTHER, {})).total, 1);
});

test('tabela de preco: vigencia, duplicacao e desconto maximo', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'PRECO-01', name: 'Item com tabela', default_price: 1000, default_cost: 300,
  });
  const table = await catalog.createTable(TENANT, adminId, {
    name: 'Tabela 2026', status: 'ativa', priority: 10,
  });
  await catalog.setTableItems(TENANT, adminId, table.id, [
    { catalog_item_id: item.id, price: 800, cost: 250, max_discount_percent: 10 },
  ]);

  const resolved = await catalog.resolvePrice(TENANT, item.id, table.id);
  assert.equal(resolved.unit_price, 800, 'preco da tabela vence o do catalogo');
  assert.equal(resolved.max_discount_percent, 10);
  assert.equal(resolved.source, 'tabela');

  // Vigência futura não vale para hoje: cai no preço padrão do catálogo.
  const future = await catalog.createTable(TENANT, adminId, {
    name: 'Tabela futura', status: 'ativa', priority: 99, starts_on: '2099-01-01',
  });
  await catalog.setTableItems(TENANT, adminId, future.id, [
    { catalog_item_id: item.id, price: 5, max_discount_percent: 0 },
  ]);
  const today = await catalog.resolvePrice(TENANT, item.id, null);
  assert.notEqual(today.unit_price, 5, 'tabela fora de vigencia nao e aplicada');

  // Duplicar preserva a original.
  const copy = await catalog.duplicateTable(TENANT, adminId, table.id, 'Tabela 2026 copia');
  assert.equal(copy.status, 'rascunho');
  assert.equal(copy.source_table_id, table.id);
  const original = await catalog.getTable(TENANT, table.id);
  assert.equal(original.items.length, 1, 'a tabela original continua intacta');

  // Item de outro tenant é recusado na grade (isolamento).
  const foreign = await catalog.createItem(OTHER, otherAdminId, {
    code: 'FOREIGN', name: 'De outro tenant', default_price: 1,
  });
  const crossTenant = await expectError(() => catalog.setTableItems(TENANT, adminId, table.id, [
    { catalog_item_id: foreign.id, price: 1 },
  ]));
  assert.match(crossTenant.message, /nao pertencem a este tenant/);
});

test('catalogo e tabela: exclusao logica remove da rotina e preserva consulta explicita', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: `DEL-${randomUUID().slice(0, 6)}`, name: 'Item removivel', default_price: 20,
  });
  const deletedItem = await catalog.deleteItem(TENANT, adminId, item.id, 'Nao sera mais vendido.');
  assert.equal(deletedItem.active, false);
  assert.ok(!(await catalog.listItems(TENANT, { active: 'true' })).rows.some((row) => row.id === item.id));

  const table = await catalog.createTable(TENANT, adminId, {
    name: `Tabela removivel ${randomUUID()}`, status: 'rascunho',
  });
  const deletedTable = await catalog.deleteTable(TENANT, adminId, table.id, 'Tabela obsoleta.');
  assert.equal(deletedTable.status, 'inativa');
  assert.ok(!(await catalog.listTables(TENANT, {})).rows.some((row) => row.id === table.id));
  assert.ok((await catalog.listTables(TENANT, { status: 'inativa' })).rows.some((row) => row.id === table.id));
});

test('campos do cliente: configuracao por servico, validacao e isolamento por tenant', async () => {
  const service = await catalog.createItem(TENANT, adminId, {
    code: `DOC-${randomUUID().slice(0, 6)}`,
    name: 'Servico com dado especifico',
    item_type: 'servico',
    default_price: 150,
  });
  const optionalService = await catalog.createItem(TENANT, adminId, {
    code: `LIVRE-${randomUUID().slice(0, 6)}`,
    name: 'Servico sem campos extras',
    item_type: 'servico',
    default_price: 90,
  });
  const field = await clientFields.createDefinition(TENANT, adminId, {
    field_key: `registro_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    label: 'Registro do veiculo',
    field_type: 'document',
    validation_rules: { min_length: 5, max_length: 20 },
  });

  await clientFields.setServiceRequirements(TENANT, adminId, service.id, [
    { field_definition_id: field.id, required: true },
  ]);
  const configured = await clientFields.getServiceRequirements(TENANT, service.id);
  assert.ok(configured.fields.some((item) => item.id === field.id && item.required));
  const optional = await clientFields.getServiceRequirements(TENANT, optionalService.id);
  assert.ok(optional.fields.every((item) => !item.required));

  const foreignField = await clientFields.createDefinition(OTHER, otherAdminId, {
    field_key: `estrangeiro_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    label: 'Campo estrangeiro',
  });
  const crossTenant = await expectError(() => clientFields.setServiceRequirements(
    TENANT, adminId, service.id, [{ field_definition_id: foreignField.id }]
  ));
  assert.match(crossTenant.message, /nao pertencem a este tenant/i);

  const unknownField = await expectError(() => clientFields.normalizeAdditionalData(TENANT, {
    campo_nao_configurado: 'valor',
  }));
  assert.match(unknownField.message, /desconhecido/i);

  const order = await orders.create(TENANT, adminId, { client_id: clientId });
  await orders.addItem(TENANT, adminId, order.id, { catalog_item_id: service.id, quantity: 1 });
  const validation = await clientFields.validateOrderClient(pool, TENANT, order.id);
  assert.equal(validation.valid, false);
  assert.equal(validation.missing_fields[0].field_key, field.field_key);

  const blocked = await expectError(() => orders.changeStatus(
    TENANT, adminId, order.id, 'enviado_validacao'
  ));
  assert.equal(blocked.code, 'CLIENT_REQUIRED_FIELDS_MISSING');
  assert.match(blocked.message, /Registro do veiculo/);

  const normalized = await clientFields.normalizeAdditionalData(TENANT, {
    [field.field_key]: 'ABC12345',
  });
  await pool.query(
    'UPDATE clients SET additional_data = $3::jsonb WHERE id = $1 AND tenant_id = $2',
    [clientId, TENANT, JSON.stringify(normalized)]
  );
  const valid = await clientFields.validateOrderClient(pool, TENANT, order.id);
  assert.equal(valid.valid, true);
  assert.equal((await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao')).status,
    'enviado_validacao');
});

test('parceiros: contratante separado, condicoes fotografadas e inativacao segura', async () => {
  const table = await catalog.createTable(TENANT, adminId, {
    name: `Tabela parceiro ${randomUUID()}`,
    status: 'ativa',
  });
  const partner = await suppliers.create(TENANT, adminId, {
    kind: 'parceiro',
    legal_name: `Parceiro contratante ${randomUUID()}`,
    document: '44.555.666/0001-77',
    default_price_table_id: table.id,
    discount_type: 'percentual',
    discount_value: 12,
    payment_terms: '30 dias',
    payment_method: 'boleto',
    commission_type: 'percentual',
    commission_value: 5,
    commercial_notes: 'Condicao negociada em agosto.',
    bank_details: 'dado que nao pertence ao seletor',
    pix_key: 'chave-privada',
  });

  const selectable = await suppliers.listActivePartners(TENANT);
  const safePartner = selectable.find((item) => item.id === partner.id);
  assert.ok(safePartner);
  assert.equal(Object.prototype.hasOwnProperty.call(safePartner, 'bank_details'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(safePartner, 'pix_key'), false);

  const order = await orders.create(TENANT, adminId, {
    client_id: clientId,
    contractor_type: 'partner',
    contractor_partner_id: partner.id,
  });
  assert.equal(order.client_id, clientId, 'client_id continua sendo o cliente atendido');
  assert.equal(order.contractor_type, 'partner');
  assert.equal(order.contractor_partner_id, partner.id);
  assert.equal(order.price_table_id, table.id);
  assert.equal(order.applied_commercial_terms.discount_value, 12);
  assert.equal(order.applied_commercial_terms.payment_terms, '30 dias');

  const updatedPartner = await suppliers.update(TENANT, adminId, partner.id, {
    discount_value: 20,
    payment_terms: '45 dias',
  }, partner.row_version);
  assert.equal(Number(updatedPartner.discount_value), 20);
  const historicalOrder = await orders.getById(TENANT, order.id);
  assert.equal(historicalOrder.applied_commercial_terms.discount_value, 12);
  assert.equal(historicalOrder.applied_commercial_terms.payment_terms, '30 dias');
  assert.equal(historicalOrder.contractor_partner_name, partner.legal_name);

  const directOrder = await orders.create(TENANT, adminId, {
    client_id: clientId,
    contractor_type: 'client',
  });
  assert.equal(directOrder.contractor_type, 'client');
  assert.equal(directOrder.contractor_partner_id, null);

  await suppliers.setActive(TENANT, adminId, partner.id, false, 'Parceria encerrada.');
  assert.ok(!(await suppliers.listActivePartners(TENANT)).some((item) => item.id === partner.id));
  const harmlessEdit = await orders.update(TENANT, adminId, order.id, {
    owner_id: adminId,
    contractor_type: 'partner',
    contractor_partner_id: partner.id,
  }, order.row_version);
  assert.equal(harmlessEdit.contractor_partner_id, partner.id,
    'editar outro dado nao recaptura nem invalida um contratante historico');
  assert.equal(harmlessEdit.applied_commercial_terms.discount_value, 12);
  const inactiveBlocked = await expectError(() => orders.create(TENANT, adminId, {
    client_id: clientId,
    contractor_type: 'partner',
    contractor_partner_id: partner.id,
  }));
  assert.match(inactiveBlocked.message, /inativo/i);
  assert.ok(await orders.getById(TENANT, order.id), 'pedido historico continua consultavel');
});

// ── PEDIDOS (§52) ────────────────────────────────────────────────────────────

test('pedidos: criar, itens, desconto limitado, envio, concorrencia e cancelamento', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'PED-01', name: 'Servico do pedido', default_price: 1000, default_cost: 300,
  });
  const table = await catalog.createTable(TENANT, adminId, { name: 'Tabela pedido', status: 'ativa' });
  await catalog.setTableItems(TENANT, adminId, table.id, [
    { catalog_item_id: item.id, price: 1000, cost: 300, max_discount_percent: 10 },
  ]);

  const order = await orders.create(TENANT, adminId, { client_id: clientId, price_table_id: table.id });
  assert.match(order.number, /^PED-\d{4}-\d{5}$/);
  assert.equal(order.status, 'rascunho');

  // Cliente de outro tenant é recusado.
  const foreignClient = await expectError(() => orders.create(TENANT, adminId, { client_id: otherClientId }));
  assert.equal(foreignClient.status, 404);

  // Enviar sem item é bloqueado.
  const emptySend = await expectError(() => orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao'));
  assert.match(emptySend.message, /ao menos um item/);

  // Desconto acima do teto da tabela é recusado no servidor.
  const overDiscount = await expectError(() => orders.addItem(TENANT, adminId, order.id, {
    catalog_item_id: item.id, quantity: 1, discount: 500,
  }));
  assert.match(overDiscount.message, /excede o maximo/);

  const added = await orders.addItem(TENANT, adminId, order.id, {
    catalog_item_id: item.id, quantity: 2, discount: 100,
  });
  assert.equal(Number(added.item.total), 1900);
  assert.equal(added.totals.total, 1900);
  assert.equal(added.totals.subtotal, 2000);

  // Transição inválida é recusada.
  const invalid = await expectError(() => orders.changeStatus(TENANT, adminId, order.id, 'convertido'));
  assert.match(invalid.message, /Nao e possivel mudar/);

  const sent = await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao');
  assert.equal(sent.status, 'enviado_validacao');
  assert.ok(sent.sent_at);

  // Pedido fora das situações editáveis não aceita novo item.
  const locked = await expectError(() => orders.addItem(TENANT, adminId, order.id, {
    catalog_item_id: item.id, quantity: 1,
  }));
  assert.match(locked.message, /nao aceita novos itens/);

  // Concorrência: versão desatualizada devolve 409.
  const conflict = await expectError(() => orders.changeStatus(TENANT, adminId, order.id, 'aprovado', null, 1));
  assert.equal(conflict.status, 409);

  // Isolamento na consulta.
  assert.equal(await orders.getById(OTHER, order.id), null);
  assert.equal((await orders.list(OTHER, {})).total, 0);
});

test('pedidos: preco fica congelado mesmo quando a tabela muda depois (§8)', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'CONGELA', name: 'Item congelado', default_price: 200,
  });
  const table = await catalog.createTable(TENANT, adminId, { name: 'Tabela congela', status: 'ativa' });
  await catalog.setTableItems(TENANT, adminId, table.id, [
    { catalog_item_id: item.id, price: 200, max_discount_percent: 0 },
  ]);

  const order = await orders.create(TENANT, adminId, { client_id: clientId, price_table_id: table.id });
  await orders.addItem(TENANT, adminId, order.id, { catalog_item_id: item.id, quantity: 1 });

  // Preço da tabela e do catálogo mudam DEPOIS do lançamento.
  await catalog.setTableItems(TENANT, adminId, table.id, [
    { catalog_item_id: item.id, price: 950, max_discount_percent: 0 },
  ]);
  await catalog.updateItem(TENANT, adminId, item.id, { default_price: 999 });

  const reloaded = await orders.getById(TENANT, order.id);
  assert.equal(Number(reloaded.items[0].unit_price), 200, 'o item preserva o preco praticado');
  assert.equal(Number(reloaded.total), 200, 'o total do pedido nao e recalculado');
});

test('pedidos: validacao do back office exige justificativa em devolucao e rejeicao', async () => {
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'VALID-01', name: 'Item validacao', default_price: 300,
  });
  const order = await orders.create(TENANT, adminId, { client_id: clientId });
  await orders.addItem(TENANT, adminId, order.id, { catalog_item_id: item.id, quantity: 1 });
  await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao');

  const noReason = await expectError(() => orders.validateOrder(TENANT, adminId, order.id, {
    decision: 'devolvido',
  }));
  assert.match(noReason.message, /justificativa/i);

  const returned = await orders.validateOrder(TENANT, adminId, order.id, {
    decision: 'devolvido', reason: 'Falta comprovante de residencia.',
  });
  assert.equal(returned.status, 'rascunho');

  await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao');
  const approved = await orders.validateOrder(TENANT, adminId, order.id, {
    decision: 'aprovado', checklist: { cliente: true, documentos: true, coisa_invalida: true },
  });
  assert.equal(approved.status, 'aprovado');

  const { rows: validations } = await pool.query(
    `SELECT decision, reason, checklist, order_version FROM order_validations
      WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at`,
    [TENANT, order.id]);
  assert.equal(validations.length, 2);
  assert.equal(validations[0].decision, 'devolvido');
  assert.ok(validations[0].reason);
  assert.ok(validations[0].order_version, 'a decisao guarda a versao do pedido');
  // Chave desconhecida não entra no checklist.
  assert.equal(validations[1].checklist.coisa_invalida, undefined);
  assert.equal(validations[1].checklist.cliente, true);
});

// ── PAGAMENTOS DO CLIENTE (§52) ──────────────────────────────────────────────

test('pagamentos: comprovante nao aprova, aprovacao e explicita, parcial e estorno', async () => {
  const receivable = await sales.createReceivable(TENANT, adminId, {
    client_id: clientId, description: 'Servico', total_amount: 1000,
  });
  assert.equal(receivable.status, 'pendente');
  assert.equal(receivable.pending_amount, 1000);

  // Anexar comprovante NÃO aprova nada (§19).
  const payment = await sales.registerPayment(TENANT, adminId, {
    receivable_id: receivable.id, amount: 400, proof_url: '/uploads/comprovante.pdf',
  });
  assert.equal(payment.status, 'informado');
  const untouched = await sales.getReceivable(TENANT, receivable.id);
  assert.equal(Number(untouched.received_amount), 0, 'o saldo so muda apos a validacao');

  // Aprovação explícita: recebível vira parcial.
  const decided = await sales.decidePayment(TENANT, adminId, payment.id, { decision: 'aprovado' });
  assert.equal(decided.payment.status, 'aprovado');
  assert.equal(decided.receivable.status, 'parcial');
  assert.equal(Number(decided.receivable.received_amount), 400);
  assert.equal(decided.receivable.pending_amount, 600);

  // Reprocessar a mesma decisão é recusado (evita aplicar duas vezes — §51).
  const twice = await expectError(() => sales.decidePayment(TENANT, adminId, payment.id, {
    decision: 'aprovado',
  }));
  assert.match(twice.message, /nao pode ser validado novamente/);

  // Segundo pagamento quita.
  const rest = await sales.registerPayment(TENANT, adminId, {
    receivable_id: receivable.id, amount: 600,
  });
  const settled = await sales.decidePayment(TENANT, adminId, rest.id, { decision: 'aprovado' });
  assert.equal(settled.receivable.status, 'recebido');
  assert.equal(Number(settled.receivable.received_amount), 1000);

  // Rejeição exige justificativa.
  const third = await sales.registerPayment(TENANT, adminId, {
    receivable_id: receivable.id, amount: 50,
  });
  const noReason = await expectError(() => sales.decidePayment(TENANT, adminId, third.id, {
    decision: 'rejeitado',
  }));
  assert.match(noReason.message, /justificativa/i);
  const rejected = await sales.decidePayment(TENANT, adminId, third.id, {
    decision: 'rejeitado', reason: 'Comprovante ilegivel.',
  });
  assert.equal(rejected.payment.status, 'rejeitado');
  const afterReject = await sales.getReceivable(TENANT, receivable.id);
  assert.equal(Number(afterReject.received_amount), 1000, 'pagamento rejeitado nao soma');

  // Estorno exige justificativa e recalcula o saldo.
  const noJustification = await expectError(() => sales.reversePayment(TENANT, adminId, rest.id, ''));
  assert.match(noJustification.message, /justificativa/i);
  const reversed = await sales.reversePayment(TENANT, adminId, rest.id, 'Chargeback do cliente.');
  assert.equal(reversed.payment.status, 'estornado');
  assert.equal(Number(reversed.receivable.received_amount), 400);
  assert.equal(reversed.receivable.status, 'parcial');
});

// ── VENDAS (§52) ─────────────────────────────────────────────────────────────

test('vendas: previa nao persiste, confirmacao e explicita e nao duplica', async () => {
  const supplier = await suppliers.create(TENANT, adminId, {
    kind: 'parceiro', legal_name: 'Parceiro da venda', commission_type: 'percentual', commission_value: 10,
  });
  const item = await catalog.createItem(TENANT, adminId, {
    code: 'VENDA-01', name: 'Servico vendido', default_price: 1000, default_cost: 400,
    requires_process: true, tenant_service_type_id: serviceTypeId,
  });
  const order = await orders.create(TENANT, adminId, { client_id: clientId });
  await orders.addItem(TENANT, adminId, order.id, {
    catalog_item_id: item.id, quantity: 1, supplier_id: supplier.id,
  });
  await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao');
  await orders.validateOrder(TENANT, adminId, order.id, { decision: 'aprovado' });

  const preview = await sales.previewSaleConfirmation(TENANT, order.id);
  assert.equal(preview.can_confirm, true);
  assert.equal(preview.custos.estimado, 400);
  assert.equal(preview.comissoes_sugeridas.length, 1);
  assert.equal(preview.comissoes_sugeridas[0].amount, 100);
  assert.equal(preview.destino_operacional.itens_com_processo, 1);

  // A prévia é somente leitura: nenhuma comissão foi gravada.
  const { rows: noCommissions } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM commissions WHERE tenant_id = $1', [TENANT]);
  assert.equal(noCommissions[0].total, 0, 'a previa nao registra comissao');

  const sale = await sales.confirmSale(TENANT, adminId, order.id, {});
  assert.match(sale.number, /^VEN-\d{4}-\d{5}$/);
  assert.equal(sale.status, 'confirmada');
  assert.equal(Number(sale.net_amount), 1000);
  assert.equal(Number(sale.estimated_cost), 400);
  assert.equal(Number(sale.estimated_margin), 600);

  // Confirmar a venda NÃO cria obrigação nem comissão (§22).
  const { rows: commissionRows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM commissions WHERE tenant_id = $1 AND sale_id = $2',
    [TENANT, sale.id]);
  const { rows: payableRows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM payables WHERE tenant_id = $1 AND sale_id = $2',
    [TENANT, sale.id]);
  assert.equal(commissionRows[0].total, 0, 'confirmar venda nao gera comissao');
  assert.equal(payableRows[0].total, 0, 'confirmar venda nao gera obrigacao');

  // Venda duplicada é recusada com 409.
  const duplicate = await expectError(() => sales.confirmSale(TENANT, adminId, order.id, {}));
  assert.equal(duplicate.status, 409);

  // Os valores da venda são uma fotografia do pedido.
  const detail = await sales.getSale(TENANT, sale.id);
  assert.equal(detail.items.length, 1);
  assert.equal(Number(detail.items[0].unit_price), 1000);
  assert.equal(detail.order_number, order.number);

  const reloadedOrder = await orders.getById(TENANT, order.id);
  assert.equal(reloadedOrder.status, 'convertido');

  // Pedido cancelado não vira venda.
  const cancelled = await orders.create(TENANT, adminId, { client_id: clientId });
  await orders.changeStatus(TENANT, adminId, cancelled.id, 'cancelado', 'Cliente desistiu.');
  assert.ok(!(await orders.list(TENANT, {})).rows.some((row) => row.id === cancelled.id));
  assert.ok((await orders.list(TENANT, { status: 'cancelado' })).rows.some((row) => row.id === cancelled.id));
  const invalid = await expectError(() => sales.confirmSale(TENANT, adminId, cancelled.id, {}));
  assert.match(invalid.message, /cancelado/i);
});

// ── ORDENS DE SERVIÇO E EXECUÇÃO (§52) ───────────────────────────────────────

/** Monta pedido → venda pronta para gerar ordem. */
async function buildSale({ requiresProcess = true, supplierId = null } = {}) {
  const code = `OS-${randomUUID().slice(0, 8)}`;
  const item = await catalog.createItem(TENANT, adminId, {
    code, name: `Servico ${code}`, default_price: 1000, default_cost: 300,
    requires_process: requiresProcess, tenant_service_type_id: serviceTypeId,
  });
  const order = await orders.create(TENANT, adminId, { client_id: clientId });
  await orders.addItem(TENANT, adminId, order.id, {
    catalog_item_id: item.id, quantity: 1, supplier_id: supplierId,
  });
  await orders.changeStatus(TENANT, adminId, order.id, 'enviado_validacao');
  await orders.validateOrder(TENANT, adminId, order.id, { decision: 'aprovado' });
  return { order, sale: await sales.confirmSale(TENANT, adminId, order.id, {}) };
}

test('ordens: criacao com processo vinculado, execucao, conclusao e nao duplicacao', async () => {
  const { sale } = await buildSale();

  const serviceOrder = await execution.createServiceOrder(TENANT, adminId, {
    sale_id: sale.id, create_processes: true, due_date: '2026-12-31',
  });
  assert.match(serviceOrder.number, /^OS-\d{4}-\d{5}$/);
  assert.equal(serviceOrder.status, 'rascunho');
  assert.equal(serviceOrder.processes_created, 1);

  // Ordem duplicada para a mesma venda é recusada (§51).
  const duplicate = await expectError(() => execution.createServiceOrder(TENANT, adminId, {
    sale_id: sale.id,
  }));
  assert.equal(duplicate.status, 409);

  // O processo criado reutiliza o módulo existente (fines), sem tabela nova.
  const detail = await execution.getServiceOrder(TENANT, serviceOrder.id);
  assert.equal(detail.items.length, 1);
  assert.ok(detail.items[0].process_id, 'item exige tramitacao e ganhou processo');
  const { rows: processRows } = await pool.query(
    'SELECT tenant_id, client_id, stage FROM fines WHERE id = $1', [detail.items[0].process_id]);
  assert.equal(processRows[0].tenant_id, TENANT);
  assert.equal(processRows[0].stage, 'ENTRADA');

  // Iniciar exige responsável.
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'liberada');
  await pool.query('UPDATE service_orders SET owner_id = NULL WHERE id = $1', [serviceOrder.id]);
  const noOwner = await expectError(() => execution.changeServiceOrderStatus(
    TENANT, adminId, serviceOrder.id, 'em_execucao'));
  assert.match(noOwner.message, /responsavel/i);

  await execution.assignServiceOrder(TENANT, adminId, serviceOrder.id, { owner_id: adminId });
  const started = await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'em_execucao');
  assert.equal(started.status, 'em_execucao');
  assert.ok(started.started_at);

  // Pausa exige motivo.
  const noReason = await expectError(() => execution.changeServiceOrderStatus(
    TENANT, adminId, serviceOrder.id, 'pausada'));
  assert.match(noReason.message, /motivo/i);
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'pausada', 'Aguardando orgao.');
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'em_execucao');

  const finished = await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'concluida');
  assert.equal(finished.status, 'concluida');
  assert.ok(finished.finished_at);

  // A venda acompanha a conclusão da execução.
  const reloadedSale = await sales.getSale(TENANT, sale.id);
  assert.equal(reloadedSale.status, 'concluida');

  // Isolamento.
  assert.equal(await execution.getServiceOrder(OTHER, serviceOrder.id), null);
});

test('ordens: servico simples nao gera processo separado (§24)', async () => {
  const { sale } = await buildSale({ requiresProcess: false });
  const serviceOrder = await execution.createServiceOrder(TENANT, adminId, {
    sale_id: sale.id, create_processes: true,
  });
  assert.equal(serviceOrder.processes_created, 0);
  const detail = await execution.getServiceOrder(TENANT, serviceOrder.id);
  assert.equal(detail.items[0].process_id, null, 'servico simples e executado na propria ordem');
});

test('ordens: cancelar venda com ordem viva e bloqueado', async () => {
  const { sale } = await buildSale();
  const serviceOrder = await execution.createServiceOrder(TENANT, adminId, { sale_id: sale.id });
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'liberada');

  const blocked = await expectError(() => sales.changeSaleStatus(TENANT, adminId, sale.id,
    'cancelada', 'Desistencia'));
  assert.match(blocked.message, /Cancele antes a ordem/);

  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'cancelada', 'Erro no pedido.');
  const cancelled = await sales.changeSaleStatus(TENANT, adminId, sale.id, 'cancelada', 'Desistencia do cliente.');
  assert.equal(cancelled.status, 'cancelada');
});

// ── CUSTOS, OBRIGAÇÕES E COMISSÕES (§52) ─────────────────────────────────────

test('obrigacoes: previa nao grava, confirmacao grava e nao duplica', async () => {
  const supplier = await suppliers.create(TENANT, adminId, {
    kind: 'prestador', legal_name: 'Prestador da execucao',
    commission_type: 'percentual', commission_value: 5,
  });
  const { sale } = await buildSale({ supplierId: supplier.id });
  const serviceOrder = await execution.createServiceOrder(TENANT, adminId, { sale_id: sale.id });

  // Custo com valor real informado já nasce confirmado.
  const cost = await execution.addExecutionCost(TENANT, adminId, serviceOrder.id, {
    supplier_id: supplier.id, description: 'Taxa do orgao', planned_cost: 200, actual_cost: 220,
  });
  assert.equal(cost.status, 'confirmado');
  assert.equal(Number(cost.actual_cost), 220);

  // Custo sem valor real fica como previsão e pode ser preenchido depois (§26).
  const pendingCost = await execution.addExecutionCost(TENANT, adminId, serviceOrder.id, {
    supplier_id: supplier.id, description: 'Servico a definir', planned_cost: 100,
  });
  assert.equal(pendingCost.status, 'previsto');
  assert.equal(pendingCost.actual_cost, null);
  const updatedCost = await execution.updateExecutionCost(TENANT, adminId, pendingCost.id, {
    actual_cost: 130,
  });
  assert.equal(Number(updatedCost.actual_cost), 130);
  assert.equal(updatedCost.status, 'confirmado');

  const preview = await execution.prepareObligations(TENANT, sale.id);
  assert.equal(preview.custos.length, 2);
  assert.equal(preview.comissoes.length, 1);
  assert.match(preview.aviso, /Nada e registrado/);

  // A prévia não persiste nada.
  const { rows: before } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM payables WHERE tenant_id = $1 AND sale_id = $2',
    [TENANT, sale.id]);
  assert.equal(before[0].total, 0);

  const created = await execution.confirmObligations(TENANT, adminId, sale.id, {
    obligations: [...preview.custos, ...preview.comissoes],
  });
  assert.equal(created.payables.length, 3);
  assert.equal(created.commissions.length, 1);
  assert.equal(created.commissions[0].status, 'confirmada');
  assert.ok(created.commissions[0].confirmed_at);

  // Confirmar a mesma prévia de novo é recusado (§51: sem comissão duplicada).
  const duplicate = await expectError(() => execution.confirmObligations(TENANT, adminId, sale.id, {
    obligations: preview.comissoes,
  }));
  assert.equal(duplicate.status, 409);

  // Uma segunda prévia já não sugere o que virou obrigação.
  const second = await execution.prepareObligations(TENANT, sale.id);
  assert.equal(second.custos.length, 0);
  assert.equal(second.comissoes.length, 0);
});

test('pagamentos operacionais: aprovar, pagar, nao pagar duas vezes e refletir na comissao', async () => {
  const supplier = await suppliers.create(TENANT, adminId, {
    kind: 'fornecedor', legal_name: 'Fornecedor a pagar',
  });
  const payable = await execution.createPayable(TENANT, adminId, {
    kind: 'fornecedor', payee_supplier_id: supplier.id, description: 'Servico avulso', amount: 500,
  });
  assert.equal(payable.status, 'previsto');
  assert.equal(payable.payee_name, 'Fornecedor a pagar');

  const approved = await execution.decidePayable(TENANT, adminId, payable.id, { status: 'aprovado' });
  assert.equal(approved.status, 'aprovado');
  assert.ok(approved.approved_at);

  const paid = await execution.decidePayable(TENANT, adminId, payable.id, {
    status: 'pago', paid_at: '2026-08-01',
  });
  assert.equal(paid.status, 'pago');
  assert.ok(paid.paid_at);

  // Pagar de novo é recusado.
  const twice = await expectError(() => execution.decidePayable(TENANT, adminId, payable.id, {
    status: 'pago',
  }));
  assert.equal(twice.status, 409);

  // Cancelamento exige justificativa.
  const other = await execution.createPayable(TENANT, adminId, {
    kind: 'despesa', payee_supplier_id: supplier.id, description: 'Despesa', amount: 30,
  });
  const noReason = await expectError(() => execution.decidePayable(TENANT, adminId, other.id, {
    status: 'cancelado',
  }));
  assert.match(noReason.message, /justificativa/i);

  // Pagar a obrigação de uma comissão marca a comissão como paga.
  const { sale } = await buildSale({ supplierId: supplier.id });
  await pool.query(
    `UPDATE sale_items SET commission_type = 'fixo', commission_value = 80 WHERE sale_id = $1`,
    [sale.id]);
  const preview = await execution.prepareObligations(TENANT, sale.id);
  const created = await execution.confirmObligations(TENANT, adminId, sale.id, {
    obligations: preview.comissoes,
  });
  const commissionPayable = created.payables[0];
  await execution.decidePayable(TENANT, adminId, commissionPayable.id, { status: 'pago' });
  const { rows: commissionRows } = await pool.query(
    'SELECT status FROM commissions WHERE id = $1', [created.commissions[0].id]);
  assert.equal(commissionRows[0].status, 'paga');
});

// ── DOCUMENTOS, RECIBOS E TEMPLATES (§13, §15) ───────────────────────────────

test('templates: recusam HTML e variavel nao autorizada; publicado nao muda corpo', async () => {
  const withHtml = await expectError(() => docs.createTemplate(TENANT, adminId, {
    name: 'Inseguro', doc_type: 'contrato', body: '<script>alert(1)</script>',
  }));
  assert.match(withHtml.message, /nao permitido/i);

  const unknownField = await expectError(() => docs.createTemplate(TENANT, adminId, {
    name: 'Campo invalido', doc_type: 'contrato', body: 'Ola {{cliente.senha}}',
  }));
  assert.match(unknownField.message, /nao autorizada/i);

  const template = await docs.createTemplate(TENANT, adminId, {
    name: 'Contrato padrao', doc_type: 'contrato',
    body: 'Contrato de {{cliente.nome}}, pedido {{pedido.numero}}, total {{valores.total}}.',
  });
  assert.equal(template.status, 'rascunho');
  assert.equal(template.version, 1);

  // Template em rascunho não gera documento.
  const order = await orders.create(TENANT, adminId, { client_id: clientId });
  const draftUse = await expectError(() => docs.generateDocument(TENANT, adminId, {
    template_id: template.id, entity_type: 'order', entity_id: order.id,
  }));
  assert.match(draftUse.message, /publicados/i);

  const published = await docs.updateTemplate(TENANT, adminId, template.id,
    { status: 'publicado' }, template.row_version);
  assert.equal(published.status, 'publicado');

  // Publicado não permite alterar o corpo — precisa de nova versão.
  const bodyChange = await expectError(() => docs.updateTemplate(TENANT, adminId, template.id,
    { body: 'Outro corpo {{cliente.nome}}' }, published.row_version));
  assert.match(bodyChange.message, /nova versao/i);

  // Mesmo nome cria a versão 2, preservando a anterior.
  const v2 = await docs.createTemplate(TENANT, adminId, {
    name: 'Contrato padrao', doc_type: 'contrato', body: 'Versao 2 para {{cliente.nome}}.',
  });
  assert.equal(v2.version, 2);

  const item = await catalog.createItem(TENANT, adminId, {
    code: `DOC-${randomUUID().slice(0, 6)}`, name: 'Item do documento', default_price: 150,
  });
  await orders.addItem(TENANT, adminId, order.id, { catalog_item_id: item.id, quantity: 1 });

  const document = await docs.generateDocument(TENANT, adminId, {
    template_id: template.id, entity_type: 'order', entity_id: order.id,
  });
  assert.equal(document.doc_type, 'contrato');
  assert.equal(document.template_version, 1);
  assert.ok(document.checksum, 'documento gerado guarda checksum');
  assert.match(document.content, /Cliente Teste/);
  assert.ok(!document.content.includes('{{'), 'todas as variaveis foram substituidas');

  // Cancelar exige motivo.
  const noReason = await expectError(() => docs.cancelDocument(TENANT, adminId, document.id, ''));
  assert.match(noReason.message, /justificativa/i);
  const cancelled = await docs.cancelDocument(TENANT, adminId, document.id, 'Gerado por engano.');
  assert.equal(cancelled.status, 'cancelado');
});

test('anexos: aceitam somente upload interno, permitem editar e excluir com historico', async () => {
  const external = await expectError(() => docs.attachDocument(TENANT, adminId, {
    entity_type: 'client', entity_id: clientId, title: 'Link externo',
    file_url: 'https://drive.example/arquivo.pdf',
  }));
  assert.match(external.message, /Links externos/i);

  const attached = await docs.attachDocument(TENANT, adminId, {
    entity_type: 'client', entity_id: clientId, title: 'Documento enviado',
    file_url: `https://api.example/uploads/${TENANT}/${randomUUID()}.pdf`,
  });
  assert.equal(attached.status, 'anexado');

  const updated = await docs.updateDocument(TENANT, adminId, attached.id, {
    title: 'Documento revisado', doc_type: 'protocolo', stage: 'atendimento',
  });
  assert.equal(updated.title, 'Documento revisado');
  assert.equal(updated.doc_type, 'protocolo');

  await docs.cancelDocument(TENANT, adminId, attached.id, 'Arquivo duplicado.');
  const visible = await docs.listDocuments(TENANT, { entity_type: 'client' });
  assert.ok(!visible.rows.some((row) => row.id === attached.id));
  const history = await pool.query(
    `SELECT action FROM commercial_history WHERE tenant_id = $1 AND entity_id = $2
      ORDER BY created_at`, [TENANT, clientId]);
  assert.ok(history.rows.some((row) => row.action === 'documento_atualizado'));
  assert.ok(history.rows.some((row) => row.action === 'documento_cancelado'));
});

test('templates: exclusao logica remove da rotina e preserva documentos existentes', async () => {
  const template = await docs.createTemplate(TENANT, adminId, {
    name: `Template removivel ${randomUUID()}`, doc_type: 'termo', body: 'Termo de {{cliente.nome}}.',
  });
  const deleted = await docs.deleteTemplate(TENANT, adminId, template.id, 'Modelo obsoleto.');
  assert.equal(deleted.status, 'inativo');
  const visible = await docs.listTemplates(TENANT, {});
  assert.ok(!visible.rows.some((row) => row.id === template.id));
  const inactive = await docs.listTemplates(TENANT, { status: 'inativo' });
  assert.ok(inactive.rows.some((row) => row.id === template.id));
});

test('recibos: so para pagamento aprovado, um por pagamento e distinto de nota fiscal', async () => {
  const receivable = await sales.createReceivable(TENANT, adminId, {
    client_id: clientId, description: 'Recibo teste', total_amount: 300,
  });
  const payment = await sales.registerPayment(TENANT, adminId, {
    receivable_id: receivable.id, amount: 300,
  });

  const notApproved = await expectError(() => docs.issueReceipt(TENANT, adminId, payment.id, {}));
  assert.match(notApproved.message, /aprovados/i);

  await sales.decidePayment(TENANT, adminId, payment.id, { decision: 'aprovado' });
  const receipt = await docs.issueReceipt(TENANT, adminId, payment.id, {});
  assert.equal(receipt.doc_type, 'recibo');
  assert.match(receipt.content, /NAO substitui nota fiscal/);

  const duplicate = await expectError(() => docs.issueReceipt(TENANT, adminId, payment.id, {}));
  assert.equal(duplicate.status, 409);
});

test('contratos: registro manual de assinatura e substituicao preservando a via anterior', async () => {
  const contract = await docs.createContract(TENANT, adminId, {
    client_id: clientId, title: 'Contrato de prestacao',
  });
  assert.match(contract.number, /^CTR-\d{4}-\d{5}$/);
  assert.equal(contract.status, 'rascunho');

  // Marcar como assinado exige a data.
  const noDate = await expectError(() => docs.updateContract(TENANT, adminId, contract.id,
    { status: 'assinado' }, contract.row_version));
  assert.match(noDate.message, /data da assinatura/i);

  const signed = await docs.updateContract(TENANT, adminId, contract.id,
    { status: 'assinado', signed_at: '2026-08-01', signed_by_name: 'Cliente Teste' },
    contract.row_version);
  assert.equal(signed.status, 'assinado');

  const replacement = await docs.replaceContract(TENANT, adminId, contract.id, { title: 'Contrato v2' });
  assert.equal(replacement.status, 'rascunho');
  const { rows: previous } = await pool.query(
    'SELECT status, replaced_by FROM commercial_contracts WHERE id = $1', [contract.id]);
  assert.equal(previous[0].status, 'substituido');
  assert.equal(previous[0].replaced_by, replacement.id);
});

test('contratos: arquivo externo e bloqueado e exclusao logica exige motivo', async () => {
  const invalid = await expectError(() => docs.createContract(TENANT, adminId, {
    client_id: clientId, title: 'Contrato externo', file_url: 'https://example.com/contrato.pdf',
  }));
  assert.match(invalid.message, /Links externos/i);

  const contract = await docs.createContract(TENANT, adminId, {
    client_id: clientId, title: 'Contrato removivel',
    file_url: `https://api.example/uploads/${TENANT}/${randomUUID()}.pdf`,
  });
  const withoutReason = await expectError(() => docs.deleteContract(TENANT, adminId, contract.id, ''));
  assert.match(withoutReason.message, /motivo/i);
  const deleted = await docs.deleteContract(TENANT, adminId, contract.id, 'Criado por engano.');
  assert.equal(deleted.status, 'cancelado');
  const visible = await docs.listContracts(TENANT, {});
  assert.ok(!visible.rows.some((row) => row.id === contract.id));
});

// ── FINALIZAÇÃO, NOTA FISCAL E ARQUIVAMENTO (§52) ────────────────────────────

test('finalizacao: checklist, nota manual, arquivamento e reabertura justificada', async () => {
  const { sale } = await buildSale();
  const serviceOrder = await execution.createServiceOrder(TENANT, adminId, {
    sale_id: sale.id, create_processes: true,
  });
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'liberada');
  await execution.assignServiceOrder(TENANT, adminId, serviceOrder.id, { owner_id: adminId });
  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'em_execucao');

  // Antes de concluir a execução, a finalização é bloqueada.
  const early = await docs.finalizationChecklist(TENANT, serviceOrder.id);
  assert.equal(early.can_finalize, false);
  assert.ok(early.blockers.length > 0);
  const blocked = await expectError(() => docs.finalize(TENANT, adminId, serviceOrder.id, {}));
  assert.match(blocked.message, /Conclua a execucao/);

  await execution.changeServiceOrderStatus(TENANT, adminId, serviceOrder.id, 'concluida');

  // Nota fiscal: apenas REGISTRO manual. Emitida exige número e data.
  const missingNumber = await expectError(() => docs.upsertFiscalDocument(TENANT, adminId, {
    sale_id: sale.id, status: 'emitida',
  }));
  assert.match(missingNumber.message, /numero/i);

  const fiscal = await docs.upsertFiscalDocument(TENANT, adminId, {
    sale_id: sale.id, status: 'emitida', number: '000123', series: '1', issued_at: '2026-08-02',
  });
  assert.equal(fiscal.status, 'emitida');
  assert.equal(fiscal.number, '000123');

  // Atualizar o mesmo registro não cria uma segunda nota para a venda.
  const updatedFiscal = await docs.upsertFiscalDocument(TENANT, adminId, {
    sale_id: sale.id, status: 'cancelada', number: '000123',
  });
  assert.equal(updatedFiscal.id, fiscal.id);
  assert.equal(updatedFiscal.status, 'cancelada');

  const ready = await docs.finalizationChecklist(TENANT, serviceOrder.id);
  assert.equal(ready.can_finalize, true);
  // O checklist informa, mas só a execução concluída é bloqueante (§30).
  assert.ok(ready.checks.some((check) => check.key === 'situacao_financeira' && check.blocking === false));

  const record = await docs.finalize(TENANT, adminId, serviceOrder.id, {
    checklist: { execucao_concluida: true, entrega_cliente: true }, delivered_at: '2026-08-03',
  });
  assert.equal(record.status, 'concluida');

  // Finalização duplicada é recusada (§51).
  const duplicate = await expectError(() => docs.finalize(TENANT, adminId, serviceOrder.id, {}));
  assert.equal(duplicate.status, 409);

  const archived = await docs.archive(TENANT, adminId, serviceOrder.id);
  assert.equal(archived.status, 'arquivada');
  assert.ok(archived.archived_at);

  // Arquivar duas vezes é recusado.
  const archiveTwice = await expectError(() => docs.archive(TENANT, adminId, serviceOrder.id));
  assert.equal(archiveTwice.status, 409);

  // Nada foi apagado: o atendimento arquivado continua consultável.
  const stillThere = await execution.getServiceOrder(TENANT, serviceOrder.id);
  assert.ok(stillThere);
  assert.equal(stillThere.items.length, 1);
  assert.ok(stillThere.finalization, 'a finalizacao permanece registrada');

  // Reabertura exige justificativa.
  const noReason = await expectError(() => docs.reopen(TENANT, adminId, serviceOrder.id, ''));
  assert.match(noReason.message, /justificativa/i);
  const reopened = await docs.reopen(TENANT, adminId, serviceOrder.id, 'Cliente pediu revisao.');
  assert.equal(reopened.status, 'em_execucao');
  assert.ok(reopened.reopened_at);
});

// ── BACK OFFICE, DASHBOARD E VISÃO 360 ───────────────────────────────────────

test('back office: filas, dashboard e visao 360 respeitam o tenant', async () => {
  const summary = await backoffice.queueSummary(TENANT);
  assert.ok(summary.pedidos_validacao, 'a fila de validacao existe');
  for (const key of backoffice.QUEUE_KEYS) {
    assert.ok(typeof summary[key].total === 'number', `fila ${key} devolve contador`);
  }

  const queue = await backoffice.queueItems(TENANT, 'pedidos_validacao', {});
  assert.ok(Array.isArray(queue.rows));
  assert.equal(await backoffice.queueItems(TENANT, 'fila_inexistente', {}), null);

  const dashboard = await backoffice.executiveDashboard(TENANT, {});
  assert.ok(dashboard.comercial);
  assert.ok(dashboard.recebimentos);
  assert.ok(dashboard.operacao);
  assert.ok(dashboard.custos);
  assert.ok(dashboard.finalizacao);
  assert.ok(typeof dashboard.finalizacao.notas_pendentes === 'number');

  const overview = await backoffice.clientOverview(TENANT, clientId);
  assert.equal(overview.client.id, clientId);
  assert.ok(overview.totals.pedidos > 0);

  const tab = await backoffice.clientTab(TENANT, clientId, 'pedidos', { limit: 5 });
  assert.equal(tab.tab, 'pedidos');
  assert.ok(tab.rows.length > 0);
  assert.equal(await backoffice.clientTab(TENANT, clientId, 'aba_inexistente', {}), null);

  // Isolamento: o outro tenant não vê nada deste cliente.
  assert.equal(await backoffice.clientOverview(OTHER, clientId), null);
  const otherTab = await backoffice.clientTab(OTHER, clientId, 'pedidos', {});
  assert.equal(otherTab.rows.length, 0);

  // Busca global respeita o tenant.
  const found = await backoffice.globalSearch(TENANT, 'PED');
  assert.ok(Array.isArray(found));
  assert.ok(found.some((row) => row.type === 'pedido'), 'encontra pedidos do proprio tenant');
  const crossTenant = await backoffice.globalSearch(OTHER, 'Cliente Teste');
  assert.equal(crossTenant.length, 0, 'busca nao vaza registros de outro tenant');
});

test('relatorios: tipos conhecidos respondem e tipo invalido e recusado', async () => {
  const invalid = await backoffice.report(TENANT, 'nao_existe', {});
  assert.equal(invalid.ok, false);

  for (const type of backoffice.REPORT_KEYS) {
    const result = await backoffice.report(TENANT, type, {
      date_from: '2020-01-01', date_to: '2099-12-31',
    });
    assert.equal(result.ok, true, `relatorio ${type} responde`);
    assert.ok(Array.isArray(result.rows), `relatorio ${type} devolve linhas`);
  }
});

// ── AUDITORIA (§39) ──────────────────────────────────────────────────────────

test('auditoria: eventos do ciclo comercial ficam registrados sem conteudo sensivel', async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT action FROM commercial_history WHERE tenant_id = $1`, [TENANT]);
  const actions = rows.map((row) => row.action);
  for (const expected of [
    'criado', 'item_adicionado', 'situacao_alterada', 'validacao_aprovado',
    'pagamento_aprovado', 'venda_confirmada', 'obrigacao_criada', 'comissao_confirmada',
    'documento_gerado', 'nota_registrada', 'finalizado', 'arquivado', 'reaberto',
  ]) {
    assert.ok(actions.includes(expected), `historico registra "${expected}"`);
  }

  // O histórico guarda identificadores e valores, nunca o conteúdo do documento.
  const { rows: documentEvents } = await pool.query(
    `SELECT details FROM commercial_history
      WHERE tenant_id = $1 AND action = 'documento_gerado' LIMIT 1`, [TENANT]);
  const details = documentEvents[0].details;
  assert.ok(details.checksum, 'guarda o prefixo do checksum');
  assert.equal(details.content, undefined, 'nao guarda o conteudo do documento');
  assert.ok(String(details.checksum).length <= 12, 'apenas o prefixo do checksum');
});
