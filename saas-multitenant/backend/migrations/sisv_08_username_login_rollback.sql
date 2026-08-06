DROP INDEX IF EXISTS idx_users_username_lookup;
DROP INDEX IF EXISTS uq_users_tenant_username_ci;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_format_check;
ALTER TABLE users DROP COLUMN IF EXISTS username;
