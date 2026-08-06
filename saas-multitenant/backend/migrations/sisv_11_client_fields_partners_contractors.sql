-- =============================================================================
-- SISV 2.1 — campos de cliente por servico, parceiros e contratante do pedido
-- Migration incremental, idempotente e compativel com registros anteriores.
--
-- Registros existentes permanecem na versao 1 da contratacao e recebem o
-- proprio cliente como contratante. Novos pedidos sao gravados pela aplicacao
-- na versao 2 e passam pelas validacoes configuraveis desta migration.
-- =============================================================================

BEGIN;

-- Dados adicionais do cliente ficam em JSONB porque os campos exatos variam por
-- tenant/servico. A definicao abaixo mantem tipo, rotulo, ordem e validacoes.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS additional_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS client_field_definitions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  field_key        VARCHAR(60) NOT NULL,
  label            VARCHAR(120) NOT NULL,
  field_type       VARCHAR(20) NOT NULL DEFAULT 'text'
                   CHECK (field_type IN ('text','textarea','email','phone','date','number','boolean','document')),
  storage_kind     VARCHAR(10) NOT NULL DEFAULT 'custom'
                   CHECK (storage_kind IN ('system','custom')),
  system_column    VARCHAR(40),
  validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  row_version      INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT client_field_system_column_check CHECK (
    (storage_kind = 'system' AND system_column IS NOT NULL)
    OR (storage_kind = 'custom' AND system_column IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_field_key
  ON client_field_definitions(tenant_id, LOWER(field_key));
CREATE INDEX IF NOT EXISTS idx_client_fields_tenant
  ON client_field_definitions(tenant_id, active, sort_order, label);

-- Campos ja existentes viram opcoes configuraveis. Nenhum deles se torna
-- obrigatorio globalmente; a obrigatoriedade nasce apenas na relacao do servico.
INSERT INTO client_field_definitions
  (tenant_id, field_key, label, field_type, storage_kind, system_column, sort_order)
SELECT t.id, seed.field_key, seed.label, seed.field_type, 'system', seed.system_column, seed.sort_order
  FROM tenants t
 CROSS JOIN (VALUES
   ('cpf',        'CPF',                    'document', 'cpf',        10),
   ('birth_date', 'Data de nascimento',     'date',     'birth_date', 20),
   ('cnh',        'CNH',                    'document', 'cnh',        30),
   ('first_cnh',  'Data da 1ª habilitacao', 'date',     'first_cnh',  40),
   ('phone',      'Telefone',               'phone',    'phone',      50),
   ('email',      'E-mail',                 'email',    'email',      60),
   ('address',    'Endereco',               'textarea', 'address',    70)
 ) AS seed(field_key, label, field_type, system_column, sort_order)
ON CONFLICT (tenant_id, LOWER(field_key)) DO NOTHING;

-- Tenants criados depois do deploy tambem recebem o conjunto nativo. O gatilho
-- nao configura obrigatoriedade; apenas torna os campos existentes selecionaveis.
CREATE OR REPLACE FUNCTION seed_client_system_fields_for_tenant()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO client_field_definitions
    (tenant_id, field_key, label, field_type, storage_kind, system_column, sort_order)
  SELECT NEW.id, seed.field_key, seed.label, seed.field_type, 'system', seed.system_column, seed.sort_order
    FROM (VALUES
      ('cpf',        'CPF',                    'document', 'cpf',        10),
      ('birth_date', 'Data de nascimento',     'date',     'birth_date', 20),
      ('cnh',        'CNH',                    'document', 'cnh',        30),
      ('first_cnh',  'Data da 1ª habilitacao', 'date',     'first_cnh',  40),
      ('phone',      'Telefone',               'phone',    'phone',      50),
      ('email',      'E-mail',                 'email',    'email',      60),
      ('address',    'Endereco',               'textarea', 'address',    70)
    ) AS seed(field_key, label, field_type, system_column, sort_order)
  ON CONFLICT (tenant_id, LOWER(field_key)) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_client_system_fields ON tenants;
CREATE TRIGGER trg_seed_client_system_fields
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_client_system_fields_for_tenant();

CREATE TABLE IF NOT EXISTS service_client_field_requirements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  catalog_item_id     UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  field_definition_id UUID NOT NULL REFERENCES client_field_definitions(id) ON DELETE CASCADE,
  required            BOOLEAN NOT NULL DEFAULT TRUE,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  display_order       INTEGER NOT NULL DEFAULT 0,
  label_override      VARCHAR(120),
  validation_rules    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (catalog_item_id, field_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_service_client_fields_service
  ON service_client_field_requirements(tenant_id, catalog_item_id, active, required);

-- Condicoes comerciais configuraveis do parceiro. Esses dados sao referencia;
-- a aplicacao apenas usa a tabela de preco selecionada e fotografa as demais
-- condicoes. Nao ha recalculo financeiro automatico silencioso.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_price_table_id UUID REFERENCES price_tables(id) ON DELETE SET NULL;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS discount_type VARCHAR(12);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS discount_value NUMERIC(15,2);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_method VARCHAR(40);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS commercial_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_discount_type_check') THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_discount_type_check
      CHECK (discount_type IS NULL OR discount_type IN ('percentual','fixo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_discount_value_check') THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_discount_value_check
      CHECK (discount_value IS NULL OR discount_value >= 0);
  END IF;
END $$;

-- `client_id` continua sendo o cliente atendido para compatibilidade. Os novos
-- campos identificam explicitamente quem contrata e guardam uma fotografia das
-- condicoes, impedindo alteracao retroativa quando o parceiro for editado.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contractor_type VARCHAR(12) NOT NULL DEFAULT 'client';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contractor_partner_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS applied_commercial_terms JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commercial_terms_applied_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS contracting_model_version SMALLINT NOT NULL DEFAULT 1;

UPDATE orders
   SET contractor_type = 'client'
 WHERE contractor_type IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_contractor_type_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_contractor_type_check
      CHECK (contractor_type IN ('client','partner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_contractor_partner_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_contractor_partner_check
      CHECK (
        (contractor_type = 'client' AND contractor_partner_id IS NULL)
        OR (contractor_type = 'partner' AND contractor_partner_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_contractor_partner
  ON orders(tenant_id, contractor_partner_id)
  WHERE contractor_partner_id IS NOT NULL;

COMMIT;
