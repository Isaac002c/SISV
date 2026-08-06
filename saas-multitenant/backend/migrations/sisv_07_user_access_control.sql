-- =============================================================================
-- SISV 2.1 - acesso modular por usuário e limite de licenças por tenant
-- =============================================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS user_limit INTEGER;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_user_limit_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_user_limit_check
  CHECK (user_limit IS NULL OR user_limit BETWEEN 1 AND 10000);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_profile VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS module_access JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backoffice_level SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_backoffice_level_check;
ALTER TABLE users ADD CONSTRAINT users_backoffice_level_check
  CHECK (backoffice_level BETWEEN 0 AND 2);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_module_access_array_check;
ALTER TABLE users ADD CONSTRAINT users_module_access_array_check
  CHECK (module_access IS NULL OR jsonb_typeof(module_access) = 'array');

-- A regra é específica do contrato SISV. Outros tenants permanecem sem limite
-- até que um plano configure explicitamente tenants.user_limit.
UPDATE tenants SET user_limit = 4 WHERE slug = 'sisv' AND user_limit IS NULL;

CREATE OR REPLACE FUNCTION enforce_tenant_active_user_limit()
RETURNS TRIGGER AS $$
DECLARE
  configured_limit INTEGER;
  current_active INTEGER;
BEGIN
  IF COALESCE(NEW.is_active, TRUE) = TRUE
     AND (TG_OP = 'INSERT'
          OR COALESCE(OLD.is_active, FALSE) = FALSE
          OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
    SELECT user_limit INTO configured_limit
      FROM tenants WHERE id = NEW.tenant_id;

    IF configured_limit IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text));
      SELECT COUNT(*)::INTEGER INTO current_active
        FROM users
       WHERE tenant_id = NEW.tenant_id
         AND COALESCE(is_active, TRUE) = TRUE
         AND id IS DISTINCT FROM NEW.id;

      IF current_active >= configured_limit THEN
        RAISE EXCEPTION 'USER_LIMIT_REACHED'
          USING ERRCODE = 'P0001',
                DETAIL = format('O tenant permite no máximo %s usuários ativos.', configured_limit);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_tenant_active_user_limit ON users;
CREATE TRIGGER trg_enforce_tenant_active_user_limit
BEFORE INSERT OR UPDATE OF is_active, tenant_id ON users
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_active_user_limit();

CREATE INDEX IF NOT EXISTS idx_users_access_profile ON users(tenant_id, access_profile);
