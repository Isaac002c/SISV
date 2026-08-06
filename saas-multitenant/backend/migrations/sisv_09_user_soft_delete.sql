-- =============================================================================
-- SISV 2.3 - exclusao logica de usuarios
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Um identificador volta a ficar disponivel depois da exclusao logica.
DROP INDEX IF EXISTS uq_users_tenant_username_ci;
CREATE UNIQUE INDEX uq_users_tenant_username_ci
  ON users (tenant_id, LOWER(username))
  WHERE username IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant_deleted_at
  ON users (tenant_id, deleted_at);
