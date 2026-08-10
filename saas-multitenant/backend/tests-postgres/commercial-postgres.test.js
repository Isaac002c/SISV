'use strict';

// =============================================================================
// commercial-postgres.test.js — o que SÓ o PostgreSQL real prova (§51).
//
// Os testes em pg-mem cobrem a regra de aplicação, mas o banco em memória IGNORA
// índices UNIQUE parciais (`WHERE ...`) e funcionais (`COALESCE(...)`). Este
// arquivo ataca o banco diretamente, sem passar pelos models, para garantir que
// a barreira estrutural existe de fato — é ela que segura uma corrida que
// escape da checagem de aplicação.
//
// Roda apenas pelo harness isolado: npm run test:postgres
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

if (process.env.SISV_POSTGRES_TEST !== '1') {
  throw new Error('tests-postgres so pode executar pelo harness isolado.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 });

let tenantId;
let otherTenantId;
let userId;
let clientId;

/** Executa uma inserção esperando violação de unicidade; devolve o erro. */
async function expectUniqueViolation(sql, params) {
  try {
    await pool.query(sql, params);
  } catch (error) {
    return error;
  }
  return null;
}

test.before(async () => {
  tenantId = (await pool.query(
    `INSERT INTO tenants(name,slug,developer) VALUES('SISV Comercial','sisv-comercial','TELUN')
     RETURNING id`)).rows[0].id;
  otherTenantId = (await pool.query(
    `INSERT INTO tenants(name,slug,developer) VALUES('Outro Comercial','outro-comercial','TELUN')
     RETURNING id`)).rows[0].id;
  userId = (await pool.query(
    `INSERT INTO users(tenant_id,name,email,password_hash,role)
     VALUES($1,'Admin','admin@comercial.test','nao-e-um-segredo-real','admin') RETURNING id`,
    [tenantId])).rows[0].id;
  clientId = (await pool.query(
    `INSERT INTO clients(tenant_id,name,cpf) VALUES($1,'Cliente Comercial','11122233344')
     RETURNING id`, [tenantId])).rows[0].id;
});

test.after(async () => { await pool.end(); });

/** Cria pedido + venda, base para os cenários de duplicidade. */
async function createOrderAndSale(suffix) {
  const order = (await pool.query(
    `INSERT INTO orders(tenant_id, number, client_id, created_by, total, subtotal)
     VALUES($1,$2,$3,$4,1000,1000) RETURNING id`,
    [tenantId, `PED-PG-${suffix}`, clientId, userId])).rows[0];
  const sale = (await pool.query(
    `INSERT INTO sales(tenant_id, number, order_id, client_id, net_amount, confirmed_by)
     VALUES($1,$2,$3,$4,1000,$5) RETURNING id`,
    [tenantId, `VEN-PG-${suffix}`, order.id, clientId, userId])).rows[0];
  return { orderId: order.id, saleId: sale.id };
}

test('migration 06 criou todas as tabelas do dominio comercial', async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[
      'suppliers', 'catalog_items', 'price_tables', 'price_table_items',
      'orders', 'order_items', 'order_validations',
      'document_templates', 'generated_documents', 'commercial_contracts',
      'receivables', 'customer_payments', 'sales', 'sale_items',
      'service_orders', 'service_order_items', 'execution_costs',
      'payables', 'commissions', 'fiscal_documents', 'finalization_records',
      'commercial_counters', 'commercial_history',
    ]]);
  assert.equal(rows.length, 23, 'todas as 23 tabelas da migration 06 existem');
});

test('migration 11 criou campos extensveis e sementes nativas por tenant', async () => {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('client_field_definitions','service_client_field_requirements')`
  );
  assert.equal(tables.length, 2);

  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'clients' AND column_name = 'additional_data')
          OR (table_name = 'orders' AND column_name IN
              ('contractor_type','contractor_partner_id','applied_commercial_terms','contracting_model_version'))
          OR (table_name = 'suppliers' AND column_name IN
              ('default_price_table_id','discount_type','discount_value','payment_method','commercial_notes')))`
  );
  assert.equal(columns.length, 10);

  const native = await pool.query(
    `SELECT field_key FROM client_field_definitions
      WHERE tenant_id = $1 AND storage_kind = 'system'`,
    [tenantId]
  );
  // 7 nativos da migration 11 + 10 acrescentados pela migration 12.
  assert.equal(native.rowCount, 17);
});

test('migration 12 adicionou colunas, tipo select e sementes de cadastro', async () => {
  const { rows: columns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clients'
        AND column_name IN ('client_code','client_type','category','rg','cnh_category',
          'whatsapp','contact_preference','origin','responsible_name','additional_info','portal_access')`
  );
  assert.equal(columns.length, 11);

  // O tipo 'select' passou a ser aceito pela CHECK do field_type.
  const selects = await pool.query(
    `SELECT field_key, field_type, validation_rules FROM client_field_definitions
      WHERE tenant_id = $1 AND storage_kind = 'system' AND field_type = 'select'
      ORDER BY field_key`,
    [tenantId]
  );
  const selectKeys = selects.rows.map((row) => row.field_key);
  assert.deepEqual([...selectKeys].sort(),
    ['category','client_type','cnh_category','contact_preference','origin'].sort());
  const clientType = selects.rows.find((row) => row.field_key === 'client_type');
  assert.deepEqual(clientType.validation_rules.options, ['pf', 'pj']);

  // O codigo do cliente e unico por tenant quando preenchido.
  await pool.query(
    `UPDATE clients SET client_code = 'CLI-0001' WHERE id = $1`, [clientId]);
  const other = await pool.query(
    `INSERT INTO clients(tenant_id, name) VALUES($1,'Cliente 2') RETURNING id`,
    [tenantId]);
  const duplicate = await expectUniqueViolation(
    `UPDATE clients SET client_code = 'cli-0001' WHERE id = $1`,
    [other.rows[0].id]);
  assert.equal(duplicate.code, '23505');
  // Nao vaza estado de codigo para os demais testes deste arquivo.
  await pool.query(`UPDATE clients SET client_code = NULL WHERE id = $1`, [clientId]);
});

test('migration 11 protege chave de campo e coerencia do contratante', async () => {
  await pool.query(
    `INSERT INTO client_field_definitions(tenant_id,field_key,label)
     VALUES($1,'registro_teste','Registro teste')`,
    [tenantId]
  );
  const duplicate = await expectUniqueViolation(
    `INSERT INTO client_field_definitions(tenant_id,field_key,label)
     VALUES($1,'REGISTRO_TESTE','Duplicado')`,
    [tenantId]
  );
  assert.equal(duplicate.code, '23505');

  const incoherent = await expectUniqueViolation(
    `INSERT INTO orders(tenant_id,number,client_id,contractor_type)
     VALUES($1,'PED-PG-CONTRATANTE',$2,'partner')`,
    [tenantId, clientId]
  );
  assert.equal(incoherent.code, '23514');
});

test('venda duplicada para o mesmo pedido e barrada pelo banco', async () => {
  const { orderId } = await createOrderAndSale('venda');
  const error = await expectUniqueViolation(
    `INSERT INTO sales(tenant_id, number, order_id, client_id, net_amount)
     VALUES($1,'VEN-PG-venda-2',$2,$3,1000)`,
    [tenantId, orderId, clientId]);
  assert.ok(error, 'segunda venda para o mesmo pedido deve falhar');
  assert.equal(error.code, '23505', 'violacao de unicidade');
});

test('ordem de servico duplicada para a mesma venda e barrada pelo banco', async () => {
  const { saleId } = await createOrderAndSale('ordem');
  await pool.query(
    `INSERT INTO service_orders(tenant_id, number, sale_id, client_id, created_by)
     VALUES($1,'OS-PG-1',$2,$3,$4)`,
    [tenantId, saleId, clientId, userId]);
  const error = await expectUniqueViolation(
    `INSERT INTO service_orders(tenant_id, number, sale_id, client_id, created_by)
     VALUES($1,'OS-PG-2',$2,$3,$4)`,
    [tenantId, saleId, clientId, userId]);
  assert.ok(error, 'segunda ordem para a mesma venda deve falhar');
  assert.equal(error.code, '23505');
});

test('indice PARCIAL do recibo: um por pagamento, mas cancelado libera novo', async () => {
  const { orderId } = await createOrderAndSale('recibo');
  const receivable = (await pool.query(
    `INSERT INTO receivables(tenant_id, client_id, order_id, description, total_amount)
     VALUES($1,$2,$3,'Servico',1000) RETURNING id`,
    [tenantId, clientId, orderId])).rows[0];
  const payment = (await pool.query(
    `INSERT INTO customer_payments(tenant_id, receivable_id, client_id, amount, status)
     VALUES($1,$2,$3,500,'aprovado') RETURNING id`,
    [tenantId, receivable.id, clientId])).rows[0];

  const insertReceipt = (title, status) => pool.query(
    `INSERT INTO generated_documents
       (tenant_id, doc_type, title, entity_type, entity_id, payment_id, status)
     VALUES($1,'recibo',$2,'customer_payment',$3,$3,$4)`,
    [tenantId, title, payment.id, status]);

  await insertReceipt('Recibo 1', 'gerado');
  const error = await expectUniqueViolation(
    `INSERT INTO generated_documents
       (tenant_id, doc_type, title, entity_type, entity_id, payment_id, status)
     VALUES($1,'recibo','Recibo 2','customer_payment',$2,$2,'gerado')`,
    [tenantId, payment.id]);
  assert.ok(error, 'segundo recibo vivo para o mesmo pagamento deve falhar');
  assert.equal(error.code, '23505');

  // O indice e PARCIAL (status <> 'cancelado'): cancelar o primeiro libera um novo.
  await pool.query(
    `UPDATE generated_documents SET status = 'cancelado'
      WHERE tenant_id = $1 AND payment_id = $2`, [tenantId, payment.id]);
  await insertReceipt('Recibo 3', 'gerado');
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM generated_documents
      WHERE tenant_id = $1 AND payment_id = $2`, [tenantId, payment.id]);
  assert.equal(rows[0].total, 2, 'o recibo cancelado permanece no historico');
});

test('indice FUNCIONAL da comissao impede duplicata por venda/item/beneficiario', async () => {
  const { saleId } = await createOrderAndSale('comissao');
  const supplier = (await pool.query(
    `INSERT INTO suppliers(tenant_id, legal_name, kind) VALUES($1,'Parceiro PG','parceiro')
     RETURNING id`, [tenantId])).rows[0];

  const insertCommission = (status) => pool.query(
    `INSERT INTO commissions
       (tenant_id, sale_id, beneficiary_supplier_id, beneficiary_name, amount, status)
     VALUES($1,$2,$3,'Parceiro PG',100,$4)`,
    [tenantId, saleId, supplier.id, status]);

  await insertCommission('confirmada');
  // sale_item_id é NULL nos dois: só o índice funcional com COALESCE pega isso.
  const error = await expectUniqueViolation(
    `INSERT INTO commissions
       (tenant_id, sale_id, beneficiary_supplier_id, beneficiary_name, amount, status)
     VALUES($1,$2,$3,'Parceiro PG',100,'confirmada')`,
    [tenantId, saleId, supplier.id]);
  assert.ok(error, 'comissao duplicada deve falhar mesmo com sale_item_id nulo');
  assert.equal(error.code, '23505');

  // Cancelada sai do indice parcial e permite registrar de novo.
  await pool.query(
    `UPDATE commissions SET status = 'cancelada' WHERE tenant_id = $1 AND sale_id = $2`,
    [tenantId, saleId]);
  await insertCommission('confirmada');
});

test('obrigacao nao duplica por custo de execucao nem por comissao', async () => {
  const { saleId } = await createOrderAndSale('payable');
  const supplier = (await pool.query(
    `INSERT INTO suppliers(tenant_id, legal_name) VALUES($1,'Fornecedor PG') RETURNING id`,
    [tenantId])).rows[0];
  const serviceOrder = (await pool.query(
    `INSERT INTO service_orders(tenant_id, number, sale_id, client_id, created_by)
     VALUES($1,'OS-PG-PAY',$2,$3,$4) RETURNING id`,
    [tenantId, saleId, clientId, userId])).rows[0];
  const cost = (await pool.query(
    `INSERT INTO execution_costs(tenant_id, service_order_id, supplier_id, description, planned_cost)
     VALUES($1,$2,$3,'Taxa',200) RETURNING id`,
    [tenantId, serviceOrder.id, supplier.id])).rows[0];

  await pool.query(
    `INSERT INTO payables(tenant_id, kind, payee_supplier_id, payee_name, description,
                          amount, execution_cost_id, status)
     VALUES($1,'fornecedor',$2,'Fornecedor PG','Taxa',200,$3,'previsto')`,
    [tenantId, supplier.id, cost.id]);
  const error = await expectUniqueViolation(
    `INSERT INTO payables(tenant_id, kind, payee_supplier_id, payee_name, description,
                          amount, execution_cost_id, status)
     VALUES($1,'fornecedor',$2,'Fornecedor PG','Taxa de novo',200,$3,'previsto')`,
    [tenantId, supplier.id, cost.id]);
  assert.ok(error, 'segunda obrigacao viva para o mesmo custo deve falhar');
  assert.equal(error.code, '23505');
});

test('finalizacao duplicada para a mesma ordem e barrada pelo banco', async () => {
  const { saleId } = await createOrderAndSale('final');
  const serviceOrder = (await pool.query(
    `INSERT INTO service_orders(tenant_id, number, sale_id, client_id, created_by, status)
     VALUES($1,'OS-PG-FIN',$2,$3,$4,'concluida') RETURNING id`,
    [tenantId, saleId, clientId, userId])).rows[0];

  await pool.query(
    `INSERT INTO finalization_records(tenant_id, service_order_id, sale_id, client_id, finalized_by)
     VALUES($1,$2,$3,$4,$5)`, [tenantId, serviceOrder.id, saleId, clientId, userId]);
  const error = await expectUniqueViolation(
    `INSERT INTO finalization_records(tenant_id, service_order_id, sale_id, client_id, finalized_by)
     VALUES($1,$2,$3,$4,$5)`, [tenantId, serviceOrder.id, saleId, clientId, userId]);
  assert.ok(error, 'segunda finalizacao para a mesma ordem deve falhar');
  assert.equal(error.code, '23505');
});

test('numeracao e documento de fornecedor sao unicos POR TENANT, nao globais', async () => {
  // Mesmo numero de pedido em outro tenant deve ser aceito.
  const otherClient = (await pool.query(
    `INSERT INTO clients(tenant_id,name) VALUES($1,'Cliente Outro') RETURNING id`,
    [otherTenantId])).rows[0];
  await pool.query(
    `INSERT INTO orders(tenant_id, number, client_id, total, subtotal)
     VALUES($1,'PED-PG-venda',$2,10,10)`, [otherTenantId, otherClient.id]);

  // E o mesmo CNPJ tambem, porque o indice e (tenant_id, document).
  await pool.query(
    `INSERT INTO suppliers(tenant_id, legal_name, document) VALUES($1,'Forn A','99887766000155')`,
    [tenantId]);
  await pool.query(
    `INSERT INTO suppliers(tenant_id, legal_name, document) VALUES($1,'Forn B','99887766000155')`,
    [otherTenantId]);

  // Dentro do MESMO tenant, o documento nao repete.
  const error = await expectUniqueViolation(
    `INSERT INTO suppliers(tenant_id, legal_name, document) VALUES($1,'Forn C','99887766000155')`,
    [tenantId]);
  assert.ok(error, 'documento repetido no mesmo tenant deve falhar');
  assert.equal(error.code, '23505');
});

test('CHECKs de dominio recusam situacao e valores invalidos', async () => {
  const badStatus = await expectUniqueViolation(
    `INSERT INTO orders(tenant_id, number, client_id, status, total, subtotal)
     VALUES($1,'PED-PG-bad',$2,'situacao_inventada',10,10)`, [tenantId, clientId]);
  assert.ok(badStatus, 'situacao fora da lista deve falhar');
  assert.equal(badStatus.code, '23514', 'violacao de CHECK');

  const negative = await expectUniqueViolation(
    `INSERT INTO orders(tenant_id, number, client_id, total, subtotal)
     VALUES($1,'PED-PG-neg',$2,-5,-5)`, [tenantId, clientId]);
  assert.ok(negative, 'total negativo deve falhar');
  assert.equal(negative.code, '23514');

  const noBeneficiary = await expectUniqueViolation(
    `INSERT INTO commissions(tenant_id, sale_id, beneficiary_name, amount)
     VALUES($1,(SELECT id FROM sales WHERE tenant_id=$1 LIMIT 1),'Sem beneficiario',10)`,
    [tenantId]);
  assert.ok(noBeneficiary, 'comissao sem beneficiario deve falhar');
  assert.equal(noBeneficiary.code, '23514');
});

test('ON DELETE RESTRICT protege fornecedor com historico financeiro', async () => {
  const supplier = (await pool.query(
    `INSERT INTO suppliers(tenant_id, legal_name) VALUES($1,'Forn Protegido') RETURNING id`,
    [tenantId])).rows[0];
  await pool.query(
    `INSERT INTO payables(tenant_id, kind, payee_supplier_id, payee_name, description, amount)
     VALUES($1,'fornecedor',$2,'Forn Protegido','Servico',100)`,
    [tenantId, supplier.id]);

  const error = await expectUniqueViolation(
    'DELETE FROM suppliers WHERE id = $1', [supplier.id]);
  assert.ok(error, 'fornecedor com obrigacao nao pode ser apagado');
  // ON DELETE RESTRICT levanta 23001 (restrict_violation); 23503 e a violacao
  // generica de chave estrangeira. Aceitamos os dois — o que importa e o recuse.
  assert.ok(['23001', '23503'].includes(error.code),
    `esperado erro de integridade referencial, veio ${error.code}`);
});
