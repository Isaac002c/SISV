-- =============================================================================
-- ROLLBACK — SISV 2.2 campos de cadastro de cliente.
--
-- Remove SOMENTE o que sisv_12 criou. Preserva os campos das rodadas anteriores.
-- ATENCAO: apaga os valores gravados nas colunas novas (codigo, tipo, categoria,
-- RG, categoria CNH, whatsapp, meio de contato, origem, responsavel, dados
-- adicionais e credenciais de portal). Faca backup antes.
-- =============================================================================

BEGIN;

-- Remove as definicoes de campo registradas nesta rodada.
DELETE FROM client_field_definitions
 WHERE field_key IN ('client_code','client_type','category','rg','cnh_category',
                     'whatsapp','contact_preference','origin','responsible_name','additional_info')
   AND storage_kind = 'system'
   AND system_column = field_key;

-- Restaura o gatilho de novos tenants para o conjunto da migration 11.
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

-- Restaura a CHECK do field_type sem 'select' (so se nenhum campo usar 'select').
UPDATE client_field_definitions SET field_type = 'text' WHERE field_type = 'select';
ALTER TABLE client_field_definitions DROP CONSTRAINT IF EXISTS client_field_definitions_field_type_check;
ALTER TABLE client_field_definitions ADD CONSTRAINT client_field_definitions_field_type_check
  CHECK (field_type IN ('text','textarea','email','phone','date','number','boolean','document'));

-- Remove indices, constraints e colunas.
DROP INDEX IF EXISTS uq_clients_code;
DROP INDEX IF EXISTS idx_clients_category;
DROP INDEX IF EXISTS idx_clients_type;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_client_type_check;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_category_check;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_cnh_category_check;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_contact_preference_check;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_origin_check;

ALTER TABLE clients DROP COLUMN IF EXISTS client_code;
ALTER TABLE clients DROP COLUMN IF EXISTS client_type;
ALTER TABLE clients DROP COLUMN IF EXISTS category;
ALTER TABLE clients DROP COLUMN IF EXISTS rg;
ALTER TABLE clients DROP COLUMN IF EXISTS cnh_category;
ALTER TABLE clients DROP COLUMN IF EXISTS whatsapp;
ALTER TABLE clients DROP COLUMN IF EXISTS contact_preference;
ALTER TABLE clients DROP COLUMN IF EXISTS origin;
ALTER TABLE clients DROP COLUMN IF EXISTS responsible_name;
ALTER TABLE clients DROP COLUMN IF EXISTS additional_info;
ALTER TABLE clients DROP COLUMN IF EXISTS portal_access;

COMMIT;
