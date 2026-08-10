-- =============================================================================
-- SISV 2.2 — campos de cadastro de cliente (identificacao, categoria, contato,
-- origem, responsavel PJ) e acessos a portais (credenciais).
--
-- Migration incremental, idempotente e NAO destrutiva. Clientes existentes
-- permanecem validos: todas as colunas novas sao opcionais (nullable) e os
-- registros atuais ficam com valor nulo ate serem editados.
--
-- Decisoes:
--   * Campos estruturados viram COLUNAS de verdade em clients (busca/filtro).
--   * Enums controlados por CHECK; a aplicacao normaliza para minusculo
--     (exceto cnh_category, que e maiuscula por convencao de habilitacao).
--   * client_code e unico por tenant quando preenchido; a aplicacao gera um
--     sequencial (editavel) no cadastro.
--   * portal_access (credenciais DETRAN/gov.br/outros) fica em JSONB e e
--     REDIGIDO na camada de rota conforme a permissao (mesma politica dos
--     dados bancarios do fornecedor). O banco apenas guarda; nao ha automacao.
--   * O sistema de campos configuraveis ganha o tipo 'select' (lista fechada),
--     e os novos campos sao registrados como definicoes 'system' para
--     aparecerem/serem exigiveis por servico junto dos demais.
-- Aplicar depois de sisv_11_client_fields_partners_contractors.sql.
-- Rollback: sisv_12_client_registration_fields_rollback.sql
-- =============================================================================

BEGIN;

-- ── 1) Colunas estruturadas do cliente ───────────────────────────────────────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_code        VARCHAR(40);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_type        VARCHAR(2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS category           VARCHAR(20);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rg                 VARCHAR(30);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cnh_category       VARCHAR(4);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS whatsapp           VARCHAR(30);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_preference VARCHAR(12);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS origin             VARCHAR(20);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS responsible_name   VARCHAR(160);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS additional_info    TEXT;

-- Credenciais de acesso a portais (DETRAN, gov.br, outros). Estrutura esperada:
--   { "detran": {"login": "...", "password": "..."},
--     "gov":    {"login": "...", "password": "..."},
--     "outros": {"label": "...", "login": "...", "password": "..."} }
-- Sensivel: redigido por permissao na camada de rota; nunca sai em log/CSV cru.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_access JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 2) CHECKs dos enums (guardados; so criam se ainda nao existirem) ─────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_client_type_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_client_type_check
      CHECK (client_type IS NULL OR client_type IN ('pf','pj'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_category_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_category_check
      CHECK (category IS NULL OR category IN ('standard','fidelidade','empresarial','parceiro','agencia'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_cnh_category_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_cnh_category_check
      CHECK (cnh_category IS NULL OR cnh_category IN ('A','B','C','D','E','AB','AC','AD','AE','ACC'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_contact_preference_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_contact_preference_check
      CHECK (contact_preference IS NULL OR contact_preference IN ('whatsapp','telefone','email','sms'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_origin_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_origin_check
      CHECK (origin IS NULL OR origin IN ('carteira','indicacao','balcao','midia_online','outros'));
  END IF;
END $$;

-- Codigo do cliente unico POR TENANT (so quando preenchido). Um indice parcial
-- permite muitos nulos e impede repeticao dentro do mesmo tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_code
  ON clients(tenant_id, LOWER(client_code))
  WHERE client_code IS NOT NULL AND client_code <> '';
CREATE INDEX IF NOT EXISTS idx_clients_category ON clients(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_clients_type     ON clients(tenant_id, client_type);

-- Contador de numeracao do codigo de cliente (reaproveita commercial_counters).
-- Sem linha inicial: a aplicacao faz UPSERT sob transacao ao gerar o codigo.

-- ── 3) Tipo 'select' no sistema de campos configuraveis ──────────────────────
ALTER TABLE client_field_definitions DROP CONSTRAINT IF EXISTS client_field_definitions_field_type_check;
ALTER TABLE client_field_definitions ADD CONSTRAINT client_field_definitions_field_type_check
  CHECK (field_type IN ('text','textarea','email','phone','date','number','boolean','document','select'));

-- ── 4) Registrar os novos campos como definicoes 'system' ────────────────────
-- Aparecem no cadastro junto dos demais e podem ser exigidos por servico. Os
-- enums levam as opcoes em validation_rules.options (lista fechada).
INSERT INTO client_field_definitions
  (tenant_id, field_key, label, field_type, storage_kind, system_column, validation_rules, sort_order)
SELECT t.id, seed.field_key, seed.label, seed.field_type, 'system', seed.system_column,
       seed.rules::jsonb, seed.sort_order
  FROM tenants t
 CROSS JOIN (VALUES
   ('client_code',        'Codigo do cliente',            'text',     'client_code',        '{}', 5),
   ('client_type',        'Tipo de cliente',              'select',   'client_type',        '{"options":["pf","pj"]}', 6),
   ('category',           'Categoria do cliente',         'select',   'category',           '{"options":["standard","fidelidade","empresarial","parceiro","agencia"]}', 7),
   ('rg',                 'RG',                           'document', 'rg',                 '{}', 35),
   ('cnh_category',       'Categoria da CNH',             'select',   'cnh_category',       '{"options":["A","B","C","D","E","AB","AC","AD","AE","ACC"]}', 36),
   ('whatsapp',           'Nº WhatsApp',                  'phone',    'whatsapp',           '{}', 55),
   ('contact_preference', 'Meio de contato preferencial', 'select',   'contact_preference', '{"options":["whatsapp","telefone","email","sms"]}', 65),
   ('origin',             'Origem do cliente',            'select',   'origin',             '{"options":["carteira","indicacao","balcao","midia_online","outros"]}', 75),
   ('responsible_name',   'Responsavel (PJ)',             'text',     'responsible_name',   '{}', 80),
   ('additional_info',    'Dados adicionais',             'textarea', 'additional_info',    '{}', 90)
 ) AS seed(field_key, label, field_type, system_column, rules, sort_order)
ON CONFLICT (tenant_id, LOWER(field_key)) DO NOTHING;

-- Novos tenants tambem recebem o conjunto ampliado. Substitui a funcao criada
-- na migration 11, agora com os campos desta rodada (idempotente por ON CONFLICT).
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
      ('client_type',        'Tipo de cliente',              'select',   'client_type',        '{"options":["pf","pj"]}', 6),
      ('category',           'Categoria do cliente',         'select',   'category',           '{"options":["standard","fidelidade","empresarial","parceiro","agencia"]}', 7),
      ('rg',                 'RG',                           'document', 'rg',                 '{}', 35),
      ('cnh_category',       'Categoria da CNH',             'select',   'cnh_category',       '{"options":["A","B","C","D","E","AB","AC","AD","AE","ACC"]}', 36),
      ('whatsapp',           'Nº WhatsApp',                  'phone',    'whatsapp',           '{}', 55),
      ('contact_preference', 'Meio de contato preferencial', 'select',   'contact_preference', '{"options":["whatsapp","telefone","email","sms"]}', 65),
      ('origin',             'Origem do cliente',            'select',   'origin',             '{"options":["carteira","indicacao","balcao","midia_online","outros"]}', 75),
      ('responsible_name',   'Responsavel (PJ)',             'text',     'responsible_name',   '{}', 80),
      ('additional_info',    'Dados adicionais',             'textarea', 'additional_info',    '{}', 90)
    ) AS seed(field_key, label, field_type, system_column, rules, sort_order)
  ON CONFLICT (tenant_id, LOWER(field_key)) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
