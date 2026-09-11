-- =============================================================================
-- SISV 2.3 — ajustes do cadastro de clientes solicitados pela operacao.
--
-- Mantem valores historicos de origem "carteira", mas retira essa opcao dos
-- cadastros novos, inclui "campanha" e oculta os campos de pessoa juridica do
-- catalogo configuravel. Aplicar depois de sisv_12_client_registration_fields.
-- =============================================================================

BEGIN;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_origin_check;
ALTER TABLE clients ADD CONSTRAINT clients_origin_check
  CHECK (origin IS NULL OR origin IN
    ('carteira','indicacao','balcao','midia_online','campanha','outros'));

UPDATE client_field_definitions
   SET active = FALSE, updated_at = NOW()
 WHERE storage_kind = 'system'
   AND field_key IN ('client_type', 'responsible_name');

UPDATE client_field_definitions
   SET validation_rules = jsonb_set(
         COALESCE(validation_rules, '{}'::jsonb),
         '{options}',
         '["indicacao","balcao","midia_online","campanha","outros"]'::jsonb,
         TRUE
       ),
       updated_at = NOW()
 WHERE storage_kind = 'system' AND field_key = 'origin';

-- Novos tenants recebem apenas os campos que continuam visiveis no cadastro.
CREATE OR REPLACE FUNCTION seed_client_system_fields_for_tenant()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO client_field_definitions
    (tenant_id, field_key, label, field_type, storage_kind, system_column, validation_rules, sort_order)
  SELECT NEW.id, seed.field_key, seed.label, seed.field_type, 'system', seed.system_column,
         seed.rules::jsonb, seed.sort_order
    FROM (VALUES
      ('cpf',                'CPF',                          'document', 'cpf',                '{}', 10),
      ('birth_date',         'Data de nascimento',           'date',     'birth_date',         '{}', 20),
      ('cnh',                'CNH',                          'document', 'cnh',                '{}', 30),
      ('first_cnh',          'Data da 1ª habilitacao',       'date',     'first_cnh',          '{}', 40),
      ('phone',              'Telefone',                     'phone',    'phone',              '{}', 50),
      ('email',              'E-mail',                       'email',    'email',              '{}', 60),
      ('address',            'Endereco',                     'textarea', 'address',            '{}', 70),
      ('client_code',        'Codigo do cliente',            'text',     'client_code',        '{}', 5),
      ('category',           'Categoria do cliente',         'select',   'category',           '{"options":["standard","fidelidade","empresarial","parceiro","agencia"]}', 7),
      ('rg',                 'RG',                           'document', 'rg',                 '{}', 35),
      ('cnh_category',       'Categoria da CNH',             'select',   'cnh_category',       '{"options":["A","B","C","D","E","AB","AC","AD","AE","ACC"]}', 36),
      ('whatsapp',           'Nº WhatsApp',                  'phone',    'whatsapp',           '{}', 55),
      ('contact_preference', 'Meio de contato preferencial', 'select',   'contact_preference', '{"options":["whatsapp","telefone","email","sms"]}', 65),
      ('origin',             'Origem do cliente',            'select',   'origin',             '{"options":["indicacao","balcao","midia_online","campanha","outros"]}', 75),
      ('additional_info',    'Dados adicionais',             'textarea', 'additional_info',    '{}', 90)
    ) AS seed(field_key, label, field_type, system_column, rules, sort_order)
  ON CONFLICT (tenant_id, LOWER(field_key)) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
