-- =============================================================================
-- SISV 2.4 - exclusão lógica de clientes
-- Preserva pedidos, contratos, documentos e histórico ligados ao cliente.
-- =============================================================================

BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS delete_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_tenant_active
  ON clients (tenant_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clients_tenant_deleted_at
  ON clients (tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMIT;
