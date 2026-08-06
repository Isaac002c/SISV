-- =============================================================================
-- SISV 2.2 - login por nome de usuario (Nome.Sobrenome)
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(80);

-- Mantem tenants legados utilizaveis: o identificador inicial vem da parte
-- local do email. Colisoes dentro do mesmo tenant recebem um sufixo estavel.
WITH normalized AS (
  SELECT id,
         tenant_id,
         LEFT(
           COALESCE(
             NULLIF(LOWER(REGEXP_REPLACE(SPLIT_PART(COALESCE(email, ''), '@', 1), '[^a-z0-9._-]', '', 'g')), ''),
             'usuario'
           ),
           68
         ) AS base_name,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id,
             COALESCE(
               NULLIF(LOWER(REGEXP_REPLACE(SPLIT_PART(COALESCE(email, ''), '@', 1), '[^a-z0-9._-]', '', 'g')), ''),
               'usuario'
             )
           ORDER BY created_at NULLS LAST, id
         ) AS duplicate_number
    FROM users
   WHERE username IS NULL
), resolved AS (
  SELECT id,
         CASE WHEN duplicate_number = 1
              THEN base_name
              ELSE base_name || '.' || duplicate_number::text
          END AS generated_username
    FROM normalized
)
UPDATE users u
   SET username = r.generated_username
  FROM resolved r
 WHERE u.id = r.id;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_format_check;
ALTER TABLE users ADD CONSTRAINT users_username_format_check
  CHECK (username IS NULL OR username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_username_ci
  ON users (tenant_id, LOWER(username))
  WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_username_lookup
  ON users (LOWER(username));
