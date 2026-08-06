-- =============================================================================
-- SISV 2.0 — ecossistema comercial, back office, execucao e financeiro operacional
--
-- Migration incremental, tenant-scoped, NAO destrutiva e idempotente.
-- Aplicar depois de sisv_05_workflow_sla_automation.sql.
-- Rollback: sisv_06_commercial_backoffice_execution_rollback.sql
--
-- Decisoes de modelagem (ver SISV.md §"SISV 2.0"):
--   * NAO duplica clientes (clients) nem processos (fines). O processo continua
--     sendo a tramitacao detalhada; a ordem de servico organiza o compromisso.
--   * Pedido -> Venda -> Ordem de Servico -> Processo (quando aplicavel).
--   * Itens de pedido/venda guardam FOTOGRAFIA de preco, custo e descricao. Uma
--     alteracao posterior no catalogo ou na tabela de precos NAO recalcula nada.
--   * Nenhuma automacao: vendas, comissoes, obrigacoes e pagamentos so existem
--     apos acao explicita do usuario. O banco apenas guarda o que foi confirmado.
--   * Concorrencia via row_version (HTTP 409) e unicidade via indices UNIQUE
--     (uma venda por pedido, uma ordem por venda, um recibo por pagamento).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 0) Numeracao sequencial por tenant e documento ───────────────────────────
-- Contador transacional: SELECT ... FOR UPDATE garante numero unico por tenant
-- sem depender de SEQUENCE global (que vazaria contagem entre tenants).
CREATE TABLE IF NOT EXISTS commercial_counters (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_type       VARCHAR(30) NOT NULL,
  current_number INTEGER NOT NULL DEFAULT 0 CHECK (current_number >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, doc_type)
);

-- ── 0.1) Historico unificado dos dominios comerciais ─────────────────────────
-- Complementa activity_logs (auditoria global) com a linha do tempo por entidade.
CREATE TABLE IF NOT EXISTS commercial_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL,
  entity_id   UUID NOT NULL,
  action      VARCHAR(60) NOT NULL,
  from_status VARCHAR(40),
  to_status   VARCHAR(40),
  reason      TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commercial_history_entity
  ON commercial_history(tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_history_tenant
  ON commercial_history(tenant_id, created_at DESC);

-- =============================================================================
-- 1) CADASTROS MESTRES
-- =============================================================================

-- ── 1.1) Fornecedores / prestadores / parceiros ──────────────────────────────
-- Estrutura comum classificada por `kind`, conforme §6: evita uma tabela isolada
-- por classificacao. Nunca ha exclusao fisica — apenas `active = FALSE`.
CREATE TABLE IF NOT EXISTS suppliers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind               VARCHAR(20) NOT NULL DEFAULT 'fornecedor'
                     CHECK (kind IN ('fornecedor','prestador','parceiro','indicador','correspondente','outro')),
  person_type        VARCHAR(4) NOT NULL DEFAULT 'pj' CHECK (person_type IN ('pf','pj')),
  legal_name         VARCHAR(200) NOT NULL,
  trade_name         VARCHAR(200),
  document           VARCHAR(20),
  state_registration VARCHAR(40),
  contact_name       VARCHAR(160),
  phone              VARCHAR(30),
  whatsapp           VARCHAR(30),
  email              VARCHAR(200),
  address            TEXT,
  bank_details       TEXT,
  pix_key            VARCHAR(200),
  services_provided  TEXT,
  commission_type    VARCHAR(12) CHECK (commission_type IS NULL OR commission_type IN ('percentual','fixo')),
  commission_value   NUMERIC(15,2) CHECK (commission_value IS NULL OR commission_value >= 0),
  payment_terms      VARCHAR(160),
  notes              TEXT,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  row_version        INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant  ON suppliers(tenant_id, active, kind);
CREATE INDEX IF NOT EXISTS idx_suppliers_name    ON suppliers(tenant_id, LOWER(legal_name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_document
  ON suppliers(tenant_id, document) WHERE document IS NOT NULL AND document <> '';

-- ── 1.2) Catalogo comercial de servicos e produtos ───────────────────────────
-- Evolui tenant_service_types (que continua sendo o catalogo OPERACIONAL) com a
-- camada comercial. Preco de venda e custo ficam em colunas separadas (§7).
CREATE TABLE IF NOT EXISTS catalog_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                   VARCHAR(40) NOT NULL,
  name                   VARCHAR(200) NOT NULL,
  description            TEXT,
  item_type              VARCHAR(10) NOT NULL DEFAULT 'servico' CHECK (item_type IN ('servico','produto')),
  category               VARCHAR(120),
  unit                   VARCHAR(20) NOT NULL DEFAULT 'un',
  default_price          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  default_cost           NUMERIC(15,2) CHECK (default_cost IS NULL OR default_cost >= 0),
  estimated_duration_days INTEGER CHECK (estimated_duration_days IS NULL OR estimated_duration_days >= 0),
  tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL,
  document_checklist     JSONB NOT NULL DEFAULT '[]'::jsonb,
  requires_process       BOOLEAN NOT NULL DEFAULT FALSE,
  requires_invoice       BOOLEAN NOT NULL DEFAULT FALSE,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant ON catalog_items(tenant_id, active, item_type);
CREATE INDEX IF NOT EXISTS idx_catalog_items_name   ON catalog_items(tenant_id, LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_items_code ON catalog_items(tenant_id, LOWER(code));

-- ── 1.3) Tabelas de preco ────────────────────────────────────────────────────
-- Uma tabela ja utilizada nunca e apagada: apenas inativada. Pedidos antigos
-- preservam o preco no item (order_items.unit_price), nao na tabela.
CREATE TABLE IF NOT EXISTS price_tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(160) NOT NULL,
  description TEXT,
  audience    VARCHAR(120),
  starts_on   DATE,
  ends_on     DATE,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      VARCHAR(12) NOT NULL DEFAULT 'rascunho'
              CHECK (status IN ('rascunho','ativa','inativa')),
  source_table_id UUID REFERENCES price_tables(id) ON DELETE SET NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT price_tables_period_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_price_tables_tenant ON price_tables(tenant_id, status, priority DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_tables_name ON price_tables(tenant_id, LOWER(name));

CREATE TABLE IF NOT EXISTS price_table_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  price_table_id      UUID NOT NULL REFERENCES price_tables(id) ON DELETE CASCADE,
  catalog_item_id     UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  price               NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost                NUMERIC(15,2) CHECK (cost IS NULL OR cost >= 0),
  max_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0
                      CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_table_items_tenant ON price_table_items(tenant_id, price_table_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_table_items
  ON price_table_items(price_table_id, catalog_item_id);

-- =============================================================================
-- 2) FRONT OFFICE — PEDIDOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number         VARCHAR(30) NOT NULL,
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  price_table_id UUID REFERENCES price_tables(id) ON DELETE SET NULL,
  origin_channel VARCHAR(40) NOT NULL DEFAULT 'balcao',
  owner_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  department_id  UUID REFERENCES departments(id) ON DELETE SET NULL,
  status         VARCHAR(30) NOT NULL DEFAULT 'rascunho'
                 CHECK (status IN ('rascunho','aguardando_documentos','aguardando_pagamento',
                                   'pagamento_parcial','enviado_validacao','em_validacao',
                                   'aprovado','convertido','cancelado')),
  subtotal       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  surcharge      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  total          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes          TEXT,
  sent_at        TIMESTAMPTZ,
  approved_at    TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT,
  row_version    INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant   ON orders(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client   ON orders(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_orders_owner    ON orders(tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_orders_dept     ON orders(tenant_id, department_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_number ON orders(tenant_id, number);

-- Itens do pedido: fotografia do catalogo no momento da inclusao (§11).
CREATE TABLE IF NOT EXISTS order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  description      VARCHAR(255) NOT NULL,
  item_type        VARCHAR(10) NOT NULL DEFAULT 'servico' CHECK (item_type IN ('servico','produto')),
  unit             VARCHAR(20) NOT NULL DEFAULT 'un',
  quantity         NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost        NUMERIC(15,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  discount         NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  surcharge        NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  total            NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  commission_type  VARCHAR(12) CHECK (commission_type IS NULL OR commission_type IN ('percentual','fixo')),
  commission_value NUMERIC(15,2) CHECK (commission_value IS NULL OR commission_value >= 0),
  requires_process BOOLEAN NOT NULL DEFAULT FALSE,
  tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL,
  notes            TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','removido')),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(tenant_id, order_id, sort_order);

-- Decisoes do back office sobre o pedido (§17). Devolucao/rejeicao exigem motivo.
CREATE TABLE IF NOT EXISTS order_validations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  decision    VARCHAR(24) NOT NULL
              CHECK (decision IN ('aprovado','devolvido','aguardando_informacao','rejeitado')),
  reason      TEXT,
  checklist   JSONB NOT NULL DEFAULT '{}'::jsonb,
  order_version INTEGER,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_validations_order
  ON order_validations(tenant_id, order_id, created_at DESC);

-- =============================================================================
-- 3) DOCUMENTOS COMERCIAIS
-- =============================================================================

-- Templates com variaveis AUTORIZADAS. O corpo e texto puro com {{variavel}};
-- HTML/script arbitrario e rejeitado na aplicacao (services/templateService.js).
CREATE TABLE IF NOT EXISTS document_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(160) NOT NULL,
  doc_type     VARCHAR(24) NOT NULL
               CHECK (doc_type IN ('ordem_servico','recibo','contrato','formulario',
                                   'termo','protocolo','personalizado')),
  body         TEXT NOT NULL,
  available_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status       VARCHAR(12) NOT NULL DEFAULT 'rascunho'
               CHECK (status IN ('rascunho','publicado','inativo')),
  row_version  INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_templates_tenant
  ON document_templates(tenant_id, doc_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_name
  ON document_templates(tenant_id, LOWER(name), version);

CREATE TABLE IF NOT EXISTS generated_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id      UUID REFERENCES document_templates(id) ON DELETE SET NULL,
  template_version INTEGER,
  doc_type         VARCHAR(24) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  entity_type      VARCHAR(30) NOT NULL,
  entity_id        UUID NOT NULL,
  client_id        UUID REFERENCES clients(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  content          TEXT,
  checksum         VARCHAR(64),
  file_url         TEXT,
  stage            VARCHAR(20) NOT NULL DEFAULT 'pedido'
                   CHECK (stage IN ('atendimento','pedido','pagamento','venda','execucao','finalizacao')),
  status           VARCHAR(16) NOT NULL DEFAULT 'gerado'
                   CHECK (status IN ('gerado','anexado','cancelado','substituido')),
  replaced_by      UUID REFERENCES generated_documents(id) ON DELETE SET NULL,
  cancel_reason    TEXT,
  cancelled_at     TIMESTAMPTZ,
  generated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_documents_entity
  ON generated_documents(tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_documents_client
  ON generated_documents(tenant_id, client_id, stage);

-- Contratos: controle OPERACIONAL. Sem assinatura eletronica nesta rodada — o
-- sistema apenas registra o documento, a via assinada e a situacao.
CREATE TABLE IF NOT EXISTS commercial_contracts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number                VARCHAR(30) NOT NULL,
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  order_id              UUID REFERENCES orders(id) ON DELETE SET NULL,
  title                 VARCHAR(200) NOT NULL,
  generated_document_id UUID REFERENCES generated_documents(id) ON DELETE SET NULL,
  status                VARCHAR(14) NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho','gerado','enviado','assinado',
                                          'recusado','cancelado','substituido')),
  signed_at             DATE,
  signed_by_name        VARCHAR(200),
  responsible_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  witnesses             JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_url              TEXT,
  replaced_by           UUID REFERENCES commercial_contracts(id) ON DELETE SET NULL,
  notes                 TEXT,
  row_version           INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commercial_contracts_tenant
  ON commercial_contracts(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_contracts_client
  ON commercial_contracts(tenant_id, client_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_contracts_number
  ON commercial_contracts(tenant_id, number);

-- =============================================================================
-- 4) CONTAS A RECEBER OPERACIONAIS E PAGAMENTOS DO CLIENTE
-- =============================================================================

CREATE TABLE IF NOT EXISTS receivables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  description     VARCHAR(255) NOT NULL,
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  received_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (received_amount >= 0),
  due_date        DATE,
  payment_method  VARCHAR(30),
  status          VARCHAR(12) NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente','parcial','recebido','vencido','cancelado','estornado')),
  notes           TEXT,
  settled_at      TIMESTAMPTZ,
  row_version     INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receivables_tenant ON receivables(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_receivables_order  ON receivables(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_receivables_client ON receivables(tenant_id, client_id);

-- Um recebivel aceita varios pagamentos. Nenhum pagamento vale como aprovado por
-- ter comprovante anexado: a validacao e explicita (§19/§20).
CREATE TABLE IF NOT EXISTS customer_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receivable_id  UUID NOT NULL REFERENCES receivables(id) ON DELETE CASCADE,
  order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  amount         NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  paid_at        DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(30) NOT NULL DEFAULT 'pix',
  reference      VARCHAR(120),
  proof_url      TEXT,
  status         VARCHAR(14) NOT NULL DEFAULT 'informado'
                 CHECK (status IN ('informado','em_validacao','aprovado','rejeitado','estornado')),
  decision_reason TEXT,
  notes          TEXT,
  registered_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  validated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  validated_at   TIMESTAMPTZ,
  row_version    INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_payments_tenant
  ON customer_payments(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_payments_receivable
  ON customer_payments(tenant_id, receivable_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_order
  ON customer_payments(tenant_id, order_id);

-- =============================================================================
-- 5) VENDAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS sales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            VARCHAR(30) NOT NULL,
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  gross_amount      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (gross_amount >= 0),
  discount_amount   NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount        NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  estimated_cost    NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  estimated_margin  NUMERIC(15,2) NOT NULL DEFAULT 0,
  commission_forecast NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (commission_forecast >= 0),
  owner_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  partner_id        UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  status            VARCHAR(14) NOT NULL DEFAULT 'confirmada'
                    CHECK (status IN ('pendente','confirmada','em_execucao','concluida','cancelada','estornada')),
  notes             TEXT,
  confirmed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id, status, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_client ON sales(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_sales_owner  ON sales(tenant_id, owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_number ON sales(tenant_id, number);
-- Barreira estrutural contra venda duplicada a partir do mesmo pedido (§51).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order ON sales(tenant_id, order_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id          UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  order_item_id    UUID REFERENCES order_items(id) ON DELETE SET NULL,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  description      VARCHAR(255) NOT NULL,
  item_type        VARCHAR(10) NOT NULL DEFAULT 'servico' CHECK (item_type IN ('servico','produto')),
  quantity         NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost        NUMERIC(15,2),
  discount         NUMERIC(15,2) NOT NULL DEFAULT 0,
  total            NUMERIC(15,2) NOT NULL DEFAULT 0,
  supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  commission_type  VARCHAR(12),
  commission_value NUMERIC(15,2),
  requires_process BOOLEAN NOT NULL DEFAULT FALSE,
  tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(tenant_id, sale_id, sort_order);

-- Vinculo do recebivel com a venda (criado apos a confirmacao, sem recalculo).
ALTER TABLE receivables ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_receivables_sale ON receivables(tenant_id, sale_id);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES customer_payments(id) ON DELETE SET NULL;
-- Um recibo operacional por pagamento aprovado (evita recibo duplicado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_documents_receipt
  ON generated_documents(tenant_id, payment_id)
  WHERE payment_id IS NOT NULL AND doc_type = 'recibo' AND status <> 'cancelado';
ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;

-- =============================================================================
-- 6) ORDENS DE SERVICO E EXECUCAO
-- =============================================================================

CREATE TABLE IF NOT EXISTS service_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        VARCHAR(30) NOT NULL,
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  owner_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  priority      VARCHAR(10) NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('baixa','normal','alta','urgente')),
  due_date      DATE,
  planned_date  DATE,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  status        VARCHAR(24) NOT NULL DEFAULT 'rascunho'
                CHECK (status IN ('rascunho','liberada','aguardando_execucao','em_execucao',
                                  'pausada','aguardando_terceiro','concluida','cancelada','arquivada')),
  instructions  TEXT,
  notes         TEXT,
  cancel_reason TEXT,
  archived_at   TIMESTAMPTZ,
  archived_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reopened_at   TIMESTAMPTZ,
  reopened_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reopen_reason TEXT,
  row_version   INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_orders_tenant ON service_orders(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_service_orders_owner  ON service_orders(tenant_id, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_service_orders_client ON service_orders(tenant_id, client_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_orders_number ON service_orders(tenant_id, number);
-- Primeiro ciclo (§4): uma ordem por venda — relacao simples e previsivel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_orders_sale ON service_orders(tenant_id, sale_id);

-- Item da ordem: aponta para o item da venda e, quando o servico exige tramitacao,
-- para o processo (fines) que faz o acompanhamento detalhado. Sem duplicar dados.
CREATE TABLE IF NOT EXISTS service_order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_order_id UUID NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  sale_item_id     UUID REFERENCES sale_items(id) ON DELETE SET NULL,
  process_id       UUID REFERENCES fines(id) ON DELETE SET NULL,
  description      VARCHAR(255) NOT NULL,
  quantity         NUMERIC(12,3) NOT NULL DEFAULT 1,
  supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente','em_execucao','concluido','cancelado')),
  notes            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_order_items_so
  ON service_order_items(tenant_id, service_order_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_service_order_items_process
  ON service_order_items(tenant_id, process_id) WHERE process_id IS NOT NULL;

-- Custos reais/previstos por fornecedor na execucao (§26). Custo pode ficar em
-- aberto na venda e ser preenchido depois por usuario autorizado.
CREATE TABLE IF NOT EXISTS execution_costs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_order_id      UUID NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  service_order_item_id UUID REFERENCES service_order_items(id) ON DELETE SET NULL,
  sale_id               UUID REFERENCES sales(id) ON DELETE SET NULL,
  supplier_id           UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  description           VARCHAR(255) NOT NULL,
  planned_cost          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (planned_cost >= 0),
  actual_cost           NUMERIC(15,2) CHECK (actual_cost IS NULL OR actual_cost >= 0),
  incurred_on           DATE,
  document_ref          VARCHAR(120),
  status                VARCHAR(12) NOT NULL DEFAULT 'previsto'
                        CHECK (status IN ('previsto','confirmado','cancelado')),
  notes                 TEXT,
  row_version           INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_execution_costs_so
  ON execution_costs(tenant_id, service_order_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_costs_supplier
  ON execution_costs(tenant_id, supplier_id);

-- =============================================================================
-- 7) CONTAS A PAGAR OPERACIONAIS E COMISSOES
-- =============================================================================

CREATE TABLE IF NOT EXISTS commissions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id                 UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id            UUID REFERENCES sale_items(id) ON DELETE SET NULL,
  beneficiary_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  beneficiary_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  beneficiary_name        VARCHAR(200) NOT NULL,
  base_amount             NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),
  rate_type               VARCHAR(12) NOT NULL DEFAULT 'percentual'
                          CHECK (rate_type IN ('percentual','fixo')),
  rate_value              NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (rate_value >= 0),
  amount                  NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  status                  VARCHAR(12) NOT NULL DEFAULT 'prevista'
                          CHECK (status IN ('prevista','confirmada','paga','cancelada','estornada')),
  expected_date           DATE,
  paid_at                 DATE,
  proof_url               TEXT,
  notes                   TEXT,
  row_version             INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  confirmed_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at            TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT commissions_beneficiary_check
    CHECK (beneficiary_supplier_id IS NOT NULL OR beneficiary_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_commissions_tenant ON commissions(tenant_id, status, expected_date);
CREATE INDEX IF NOT EXISTS idx_commissions_sale   ON commissions(tenant_id, sale_id);
-- Uma comissao confirmada por beneficiario e item da venda (§51: sem duplicidade).
CREATE UNIQUE INDEX IF NOT EXISTS uq_commissions_sale_item_beneficiary
  ON commissions(tenant_id, sale_id, COALESCE(sale_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(beneficiary_supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(beneficiary_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status <> 'cancelada';

CREATE TABLE IF NOT EXISTS payables (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              VARCHAR(14) NOT NULL
                    CHECK (kind IN ('fornecedor','prestador','parceiro','comissao','despesa')),
  payee_supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  payee_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  payee_name        VARCHAR(200) NOT NULL,
  order_id          UUID REFERENCES orders(id) ON DELETE SET NULL,
  sale_id           UUID REFERENCES sales(id) ON DELETE SET NULL,
  service_order_id  UUID REFERENCES service_orders(id) ON DELETE SET NULL,
  process_id        UUID REFERENCES fines(id) ON DELETE SET NULL,
  execution_cost_id UUID REFERENCES execution_costs(id) ON DELETE SET NULL,
  commission_id     UUID REFERENCES commissions(id) ON DELETE SET NULL,
  description       VARCHAR(255) NOT NULL,
  amount            NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date          DATE,
  payment_method    VARCHAR(30),
  status            VARCHAR(12) NOT NULL DEFAULT 'previsto'
                    CHECK (status IN ('previsto','aprovado','agendado','pago','vencido','cancelado','estornado')),
  proof_url         TEXT,
  paid_at           DATE,
  notes             TEXT,
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  paid_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payables_tenant ON payables(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_payables_sale   ON payables(tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_payables_so     ON payables(tenant_id, service_order_id);
CREATE INDEX IF NOT EXISTS idx_payables_payee  ON payables(tenant_id, payee_supplier_id);
-- Cada custo de execucao gera no maximo uma obrigacao viva (evita pagar 2x).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payables_execution_cost
  ON payables(tenant_id, execution_cost_id)
  WHERE execution_cost_id IS NOT NULL AND status <> 'cancelado';
CREATE UNIQUE INDEX IF NOT EXISTS uq_payables_commission
  ON payables(tenant_id, commission_id)
  WHERE commission_id IS NOT NULL AND status <> 'cancelado';

ALTER TABLE commissions ADD COLUMN IF NOT EXISTS payable_id UUID REFERENCES payables(id) ON DELETE SET NULL;

-- =============================================================================
-- 8) FINALIZACAO, NOTA FISCAL (REGISTRO MANUAL) E ARQUIVAMENTO
-- =============================================================================

-- Controle de nota fiscal APENAS como registro. Sem SEFAZ/prefeitura/NFS-e/NF-e.
CREATE TABLE IF NOT EXISTS fiscal_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id          UUID REFERENCES sales(id) ON DELETE SET NULL,
  service_order_id UUID REFERENCES service_orders(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  client_id        UUID REFERENCES clients(id) ON DELETE SET NULL,
  required         BOOLEAN NOT NULL DEFAULT TRUE,
  status           VARCHAR(16) NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('nao_aplicavel','pendente','solicitada','emitida','cancelada','substituida')),
  number           VARCHAR(40),
  series           VARCHAR(20),
  access_key       VARCHAR(60),
  issued_at        DATE,
  amount           NUMERIC(15,2) CHECK (amount IS NULL OR amount >= 0),
  pdf_url          TEXT,
  xml_url          TEXT,
  issuer           VARCHAR(200),
  notes            TEXT,
  row_version      INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_tenant ON fiscal_documents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_sale   ON fiscal_documents(tenant_id, sale_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale
  ON fiscal_documents(tenant_id, sale_id) WHERE sale_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finalization_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_order_id UUID NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  sale_id          UUID REFERENCES sales(id) ON DELETE SET NULL,
  client_id        UUID REFERENCES clients(id) ON DELETE SET NULL,
  checklist        JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_at     DATE,
  delivery_notes   TEXT,
  final_notes      TEXT,
  status           VARCHAR(12) NOT NULL DEFAULT 'concluida'
                   CHECK (status IN ('concluida','arquivada','reaberta')),
  finalized_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at      TIMESTAMPTZ,
  reopened_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  reopened_at      TIMESTAMPTZ,
  reopen_reason    TEXT,
  row_version      INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_finalization_records_tenant
  ON finalization_records(tenant_id, status, finalized_at DESC);
-- Uma finalizacao viva por ordem (evita finalizacao duplicada — §51).
CREATE UNIQUE INDEX IF NOT EXISTS uq_finalization_service_order
  ON finalization_records(tenant_id, service_order_id);

-- =============================================================================
-- 9) PERFIS OPERACIONAIS ADICIONAIS
-- =============================================================================
-- Novos perfis do SISV 2.0 (§38). O enforcement real fica no backend
-- (middlewares/checkPermission.js); aqui apenas liberamos a CHECK que restringia
-- as roles nas transicoes de workflow, para nao bloquear os perfis novos.
ALTER TABLE workflow_transition_roles DROP CONSTRAINT IF EXISTS workflow_transition_roles_role_check;
ALTER TABLE workflow_transition_roles ADD CONSTRAINT workflow_transition_roles_role_check
  CHECK (role IN ('admin','manager','operator','seller','viewer',
                  'front_office','back_office','finance','operations'));

-- =============================================================================
-- FIM — SISV 2.0 comercial / back office / execucao.
-- Nenhuma tabela existente foi removida ou alterada de forma destrutiva.
-- =============================================================================
