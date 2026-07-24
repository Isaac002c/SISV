-- =============================================================================
-- SISV — Sistema Integrado da Sinal Verde (TELUN)
-- Migration incremental, IDEMPOTENTE e NÃO-DESTRUTIVA.
--
-- Adiciona, sem remover nada do Nexos:
--   • Configuração por tenant: módulos habilitados + empresa desenvolvedora.
--   • Catálogos operacionais isolados por tenant: setores (departments),
--     etapas (process_stages), status (process_statuses) e tipos de serviço
--     (tenant_service_types).
--   • Colunas de operação nos processos (fines): setor atual, tipo de serviço
--     do tenant, finalização/reabertura e marca de última movimentação.
--
-- Compatibilidade: tenants existentes ficam com modules = NULL (todos os módulos
-- liberados, comportamento atual preservado). Os catálogos por tenant convivem
-- com o service_types global já usado pelos demais tenants.
--
-- Aplicar depois de 000_nexos_schema.sql:
--   psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config.sql
-- Rollback: migrations/sisv_01_tenant_config_rollback.sql
-- =============================================================================

-- ── 1) Configuração do tenant ────────────────────────────────────────────────
-- modules: NULL = todos habilitados (padrão legado). Array JSON de chaves de
-- módulo (ex.: ["processos","clientes","documentos","dashboard","config"])
-- restringe o tenant a esses módulos. developer: empresa que desenvolveu/entrega.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS developer VARCHAR(120);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS modules   JSONB;

-- ── 2) Setores / departamentos (por tenant) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  color      VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_departments_tenant ON departments(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_tenant_name ON departments(tenant_id, LOWER(name));

-- ── 3) Etapas de tramitação (por tenant) ─────────────────────────────────────
-- code: valor canônico persistido em fines.stage. is_final marca etapas de
-- encerramento (usadas na finalização/consulta de concluídos).
CREATE TABLE IF NOT EXISTS process_stages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       VARCHAR(60) NOT NULL,
  label      VARCHAR(120) NOT NULL,
  color      VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_final   BOOLEAN NOT NULL DEFAULT FALSE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_process_stages_tenant ON process_stages(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_process_stages_tenant_code ON process_stages(tenant_id, LOWER(code));

-- ── 4) Status operacionais (por tenant) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS process_statuses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       VARCHAR(60) NOT NULL,
  label      VARCHAR(120) NOT NULL,
  color      VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_pending BOOLEAN NOT NULL DEFAULT FALSE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_process_statuses_tenant ON process_statuses(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_process_statuses_tenant_code ON process_statuses(tenant_id, LOWER(code));

-- ── 5) Tipos de serviço (por tenant) ─────────────────────────────────────────
-- Isolados por tenant (o service_types global permanece para os demais tenants).
CREATE TABLE IF NOT EXISTS tenant_service_types (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       VARCHAR(60) NOT NULL,
  label      VARCHAR(120) NOT NULL,
  color      VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_service_types_tenant ON tenant_service_types(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_service_types_tenant_code ON tenant_service_types(tenant_id, LOWER(code));

-- ── 6) Colunas de operação nos processos (fines) ─────────────────────────────
-- Não remove nem altera colunas existentes. Todas nullable / com default seguro.
ALTER TABLE fines ADD COLUMN IF NOT EXISTS department_id          UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS finalized_at           TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS reopened_at            TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS last_moved_at          TIMESTAMPTZ;

-- Popula last_moved_at para processos já existentes (usa updated_at como base).
UPDATE fines SET last_moved_at = COALESCE(last_moved_at, updated_at, created_at)
  WHERE last_moved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fines_department   ON fines(tenant_id, department_id);
CREATE INDEX IF NOT EXISTS idx_fines_tsvc_type    ON fines(tenant_id, tenant_service_type_id);
CREATE INDEX IF NOT EXISTS idx_fines_tenant_sell  ON fines(tenant_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_fines_last_moved   ON fines(tenant_id, last_moved_at);
CREATE INDEX IF NOT EXISTS idx_fines_finalized    ON fines(tenant_id, finalized_at);

-- =============================================================================
-- FIM — SISV tenant config.
-- =============================================================================
