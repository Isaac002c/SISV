-- =============================================================================
-- SISV — Organização documental. Migration incremental, IDEMPOTENTE e NÃO-DESTRUTIVA.
--
-- Adiciona sem remover nada:
--   • document_categories: categorias/tipos de documento CONFIGURÁVEIS por tenant.
--   • Metadados e soft-delete em documents e fine_documents (categoria, nome
--     original, nome armazenado, observação, situação ativo/arquivado/removido,
--     autor/data da remoção).
--   • service_type_documents: checklist opcional de documentos por tipo de serviço.
--
-- Preserva a coluna `category` (texto livre) já usada pelos demais tenants; a
-- categorização administrável passa a viver em category_id.
--
-- Aplicar depois de sisv_01_tenant_config.sql:
--   psql "$DATABASE_URL" -f migrations/sisv_02_documents.sql
-- Rollback: migrations/sisv_02_documents_rollback.sql
-- =============================================================================

-- ── 1) Categorias de documento (por tenant) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS document_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  description TEXT,
  color       VARCHAR(20),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_categories_tenant ON document_categories(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_categories_tenant_name ON document_categories(tenant_id, LOWER(name));

-- ── 2) Metadados + soft-delete nos documentos do cliente (documents) ─────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category_id   UUID REFERENCES document_categories(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_name VARCHAR(500);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS stored_name   VARCHAR(255);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status        VARCHAR(20) NOT NULL DEFAULT 'ativo';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS removed_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS removed_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_documents_status   ON documents(tenant_id, status);

-- ── 3) Metadados + soft-delete nos documentos do processo (fine_documents) ───
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS category_id   UUID REFERENCES document_categories(id) ON DELETE SET NULL;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS original_name VARCHAR(500);
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS stored_name   VARCHAR(255);
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS notes         TEXT;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS status        VARCHAR(20) NOT NULL DEFAULT 'ativo';
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS removed_by    UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS removed_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_fine_documents_category ON fine_documents(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_fine_documents_status   ON fine_documents(tenant_id, status);

-- ── 4) Checklist documental por tipo de serviço (opcional, por tenant) ───────
CREATE TABLE IF NOT EXISTS service_type_documents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_service_type_id UUID NOT NULL REFERENCES tenant_service_types(id) ON DELETE CASCADE,
  category_id            UUID NOT NULL REFERENCES document_categories(id) ON DELETE CASCADE,
  required               BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_type_documents_tenant  ON service_type_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_service_type_documents_service ON service_type_documents(tenant_service_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_type_documents
  ON service_type_documents(tenant_service_type_id, category_id);

-- =============================================================================
-- FIM — SISV documentos.
-- =============================================================================
