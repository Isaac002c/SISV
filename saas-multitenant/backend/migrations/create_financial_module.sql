-- =============================================================================
-- Migration: Módulo Financeiro (MVP)  —  NEXO Despachantes CRM by ChronosTek
-- -----------------------------------------------------------------------------
-- Cria as tabelas do módulo financeiro. TODAS as statements são idempotentes
-- (CREATE TABLE/INDEX IF NOT EXISTS, ADD CONSTRAINT protegido por DO/EXCEPTION),
-- portanto o script pode ser reexecutado com segurança.
--
-- NÃO altera nem remove nenhuma tabela/coluna existente. Puramente aditivo.
-- Preserva o tenant CR Recursos e todos os dados atuais.
--
-- Convenções seguidas do projeto:
--   * PKs UUID (gen_random_uuid) — extensão pgcrypto.
--   * tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE.
--   * Valores monetários em NUMERIC(15,2) (mesmo padrão de fines.value/leads.value).
--   * created_at / updated_at TIMESTAMPTZ DEFAULT NOW().
--   * Enums implementados como VARCHAR + CHECK (mesmo padrão de approval_requests).
--
-- Referências a client_id / fine_id (processo) usam ON DELETE SET NULL para
-- PRESERVAR o histórico financeiro caso um cliente/processo seja excluído.
-- Rollback: ver create_financial_module_rollback.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. financial_categories — categorias de entradas e saídas por tenant
-- =============================================================================
CREATE TABLE IF NOT EXISTS financial_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  type        VARCHAR(10)  NOT NULL CHECK (type IN ('entrada','saida')),
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_financial_categories UNIQUE (tenant_id, type, name)
);

CREATE INDEX IF NOT EXISTS idx_fin_categories_tenant ON financial_categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fin_categories_type   ON financial_categories(tenant_id, type);

-- =============================================================================
-- 2. service_billings — faturamento por processo (fine) / serviço
--    Tabela separada de fines (não polui a tabela crítica de produção e
--    separa o "valor da multa" do "valor do serviço do despachante").
-- =============================================================================
CREATE TABLE IF NOT EXISTS service_billings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id        UUID REFERENCES clients(id)  ON DELETE SET NULL,
  company_id       UUID,
  fine_id          UUID REFERENCES fines(id)    ON DELETE SET NULL,  -- processo vinculado
  service_type_id  INTEGER,                                          -- serviço (service_types.id)
  description      TEXT,
  original_amount  NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (original_amount >= 0),
  discount         NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  surcharge        NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  final_amount     NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (final_amount >= 0),
  paid_amount      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  installments     INTEGER NOT NULL DEFAULT 1 CHECK (installments >= 1),
  due_date         DATE,
  payment_method   VARCHAR(30),
  financial_status VARCHAR(20) NOT NULL DEFAULT 'faturado'
                   CHECK (financial_status IN
                     ('nao_faturado','faturado','parcialmente_pago','pago','vencido','cancelado')),
  notes            TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billings_tenant  ON service_billings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_billings_client  ON service_billings(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_billings_fine    ON service_billings(tenant_id, fine_id);
CREATE INDEX IF NOT EXISTS idx_billings_status  ON service_billings(tenant_id, financial_status);
CREATE INDEX IF NOT EXISTS idx_billings_due     ON service_billings(tenant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_billings_created ON service_billings(tenant_id, created_at);

-- =============================================================================
-- 3. payments — pagamentos totais/parciais/sinal/parcelas
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  billing_id          UUID REFERENCES service_billings(id) ON DELETE SET NULL,
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  fine_id             UUID REFERENCES fines(id)   ON DELETE SET NULL,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method      VARCHAR(30),
  status              VARCHAR(20) NOT NULL DEFAULT 'confirmado'
                      CHECK (status IN ('confirmado','cancelado')),
  installment_number  INTEGER NOT NULL DEFAULT 1 CHECK (installment_number >= 1),
  installments_total  INTEGER NOT NULL DEFAULT 1 CHECK (installments_total >= 1),
  is_deposit          BOOLEAN NOT NULL DEFAULT FALSE,   -- sinal
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  canceled_at         TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant  ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_billing ON payments(tenant_id, billing_id);
CREATE INDEX IF NOT EXISTS idx_payments_client  ON payments(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_payments_fine    ON payments(tenant_id, fine_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_date    ON payments(tenant_id, payment_date);

-- =============================================================================
-- 4. financial_transactions — lançamentos (entradas/saídas) = Caixa
-- =============================================================================
CREATE TABLE IF NOT EXISTS financial_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type              VARCHAR(10) NOT NULL CHECK (type IN ('entrada','saida')),
  category_id       UUID REFERENCES financial_categories(id) ON DELETE RESTRICT,
  description       TEXT,
  amount            NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  transaction_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date          DATE,
  payment_method    VARCHAR(30),
  status            VARCHAR(20) NOT NULL DEFAULT 'pago'
                    CHECK (status IN ('previsto','pendente','pago','recebido','vencido','cancelado')),
  client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  fine_id           UUID REFERENCES fines(id)   ON DELETE SET NULL,
  billing_id        UUID REFERENCES service_billings(id) ON DELETE SET NULL,
  payment_id        UUID REFERENCES payments(id) ON DELETE SET NULL,
  origin            VARCHAR(20) NOT NULL DEFAULT 'manual'
                    CHECK (origin IN ('manual','pagamento','sistema')),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT,
  canceled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fin_tx_tenant   ON financial_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_type     ON financial_transactions(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_fin_tx_status   ON financial_transactions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_fin_tx_category ON financial_transactions(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_client   ON financial_transactions(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_fine     ON financial_transactions(tenant_id, fine_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_billing  ON financial_transactions(tenant_id, billing_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_txdate   ON financial_transactions(tenant_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_fin_tx_duedate  ON financial_transactions(tenant_id, due_date);
CREATE INDEX IF NOT EXISTS idx_fin_tx_created  ON financial_transactions(tenant_id, created_at);

-- Idempotência: um pagamento gera NO MÁXIMO uma entrada financeira (Caixa).
-- Impede duplicidade mesmo em confirmações simultâneas / reprocessamento.
-- Índice único NÃO parcial de propósito: no PostgreSQL múltiplos NULL são
-- DISTINTOS entre si, então lançamentos manuais (payment_id NULL) não colidem;
-- e `ON CONFLICT (payment_id)` só funciona como árbitro em índice não-parcial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_tx_payment
  ON financial_transactions(payment_id);

-- =============================================================================
-- 5. receipts — recibos vinculados a pagamentos, numeração única por tenant
-- =============================================================================
CREATE TABLE IF NOT EXISTS receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL,               -- sequencial por tenant
  prefix            VARCHAR(20) NOT NULL DEFAULT 'NEXO',
  full_number       VARCHAR(40) NOT NULL,           -- ex.: NEXO-000001
  status            VARCHAR(20) NOT NULL DEFAULT 'emitido'
                    CHECK (status IN ('emitido','cancelado')),
  issue_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  client_id         UUID REFERENCES clients(id) ON DELETE SET NULL,
  payment_id        UUID REFERENCES payments(id) ON DELETE SET NULL,
  billing_id        UUID REFERENCES service_billings(id) ON DELETE SET NULL,
  fine_id           UUID REFERENCES fines(id) ON DELETE SET NULL,
  -- Snapshot (dados congelados no momento da emissão) --------------------------
  client_name       VARCHAR(255),
  client_document   VARCHAR(40),
  service_description TEXT,
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  payment_method    VARCHAR(30),
  issuer_name       VARCHAR(255),
  issuer_document   VARCHAR(40),
  issuer_address    TEXT,
  notes             TEXT,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name   VARCHAR(255),
  canceled_at       TIMESTAMPTZ,
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_receipts_tenant_number UNIQUE (tenant_id, number)
);

CREATE INDEX IF NOT EXISTS idx_receipts_tenant  ON receipts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_receipts_client  ON receipts(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipts(tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_number  ON receipts(tenant_id, number);
CREATE INDEX IF NOT EXISTS idx_receipts_status  ON receipts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(tenant_id, created_at);

-- =============================================================================
-- 6. tenant_financial_settings — configurações financeiras por tenant
--    last_receipt_number: usado com bloqueio de linha (UPDATE ... RETURNING)
--    para gerar números sequenciais de recibo sem colisão.
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenant_financial_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_prefix           VARCHAR(20) NOT NULL DEFAULT 'SISV',
  last_receipt_number      INTEGER NOT NULL DEFAULT 0 CHECK (last_receipt_number >= 0),
  razao_social             VARCHAR(255),
  document                 VARCHAR(40),
  address                  TEXT,
  phone                    VARCHAR(40),
  email                    VARCHAR(255),
  logo_url                 TEXT,
  enabled_payment_methods  JSONB NOT NULL DEFAULT
    '["pix","dinheiro","cartao_credito","cartao_debito","boleto","transferencia","outro"]'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_fin_settings_tenant ON tenant_financial_settings(tenant_id);

-- =============================================================================
-- FIM — Módulo Financeiro criado com sucesso.
-- =============================================================================
