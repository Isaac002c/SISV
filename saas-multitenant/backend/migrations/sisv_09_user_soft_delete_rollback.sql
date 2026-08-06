DROP INDEX IF EXISTS idx_users_tenant_deleted_at;
DROP INDEX IF EXISTS uq_users_tenant_username_ci;

CREATE UNIQUE INDEX uq_users_tenant_username_ci
  ON users (tenant_id, LOWER(username))
  WHERE username IS NOT NULL;

ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
