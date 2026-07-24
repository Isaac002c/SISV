-- =============================================================================
-- ROLLBACK de sisv_01_tenant_config.sql
--
-- Remove APENAS os objetos criados pela migration do SISV. Não toca em nenhuma
-- tabela/coluna do Nexos anterior a esta adaptação.
--
-- ATENÇÃO: dropar as colunas/tabelas apaga a configuração e os vínculos de
-- setor/tipo-de-serviço dos processos. Faça backup antes em produção.
--   psql "$DATABASE_URL" -f migrations/sisv_01_tenant_config_rollback.sql
-- =============================================================================

-- Colunas de operação nos processos (fines)
ALTER TABLE fines DROP COLUMN IF EXISTS last_moved_at;
ALTER TABLE fines DROP COLUMN IF EXISTS reopened_at;
ALTER TABLE fines DROP COLUMN IF EXISTS finalized_at;
ALTER TABLE fines DROP COLUMN IF EXISTS tenant_service_type_id;
ALTER TABLE fines DROP COLUMN IF EXISTS department_id;

-- Catálogos por tenant
DROP TABLE IF EXISTS tenant_service_types;
DROP TABLE IF EXISTS process_statuses;
DROP TABLE IF EXISTS process_stages;
DROP TABLE IF EXISTS departments;

-- Configuração do tenant
ALTER TABLE tenants DROP COLUMN IF EXISTS modules;
ALTER TABLE tenants DROP COLUMN IF EXISTS developer;
