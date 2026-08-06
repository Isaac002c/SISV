BEGIN;

DROP INDEX IF EXISTS idx_clients_tenant_deleted_at;
DROP INDEX IF EXISTS idx_clients_tenant_active;

ALTER TABLE clients DROP COLUMN IF EXISTS delete_reason;
ALTER TABLE clients DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE clients DROP COLUMN IF EXISTS deleted_at;

COMMIT;
