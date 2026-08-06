-- =============================================================================
-- ROLLBACK — SISV 2.0 comercial / back office / execucao.
--
-- Remove SOMENTE o que sisv_06_commercial_backoffice_execution.sql criou.
-- Nao toca em tabelas anteriores (clients, fines, documents, workflows, SLA...).
--
-- ATENCAO: apaga os dados comerciais (pedidos, vendas, ordens, recebimentos,
-- obrigacoes, comissoes, documentos gerados, notas e finalizacoes). Faca backup
-- antes de executar em ambiente com dados reais.
--
-- Uso: psql "$DATABASE_URL" -f migrations/sisv_06_commercial_backoffice_execution_rollback.sql
-- =============================================================================

-- Ordem inversa das dependencias (filhos antes dos pais).
DROP TABLE IF EXISTS finalization_records CASCADE;
DROP TABLE IF EXISTS fiscal_documents CASCADE;
DROP TABLE IF EXISTS payables CASCADE;
DROP TABLE IF EXISTS commissions CASCADE;
DROP TABLE IF EXISTS execution_costs CASCADE;
DROP TABLE IF EXISTS service_order_items CASCADE;
DROP TABLE IF EXISTS service_orders CASCADE;
DROP TABLE IF EXISTS commercial_contracts CASCADE;
DROP TABLE IF EXISTS generated_documents CASCADE;
DROP TABLE IF EXISTS document_templates CASCADE;
DROP TABLE IF EXISTS customer_payments CASCADE;
DROP TABLE IF EXISTS receivables CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS order_validations CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS price_table_items CASCADE;
DROP TABLE IF EXISTS price_tables CASCADE;
DROP TABLE IF EXISTS catalog_items CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS commercial_history CASCADE;
DROP TABLE IF EXISTS commercial_counters CASCADE;

-- Restaura a CHECK original das roles nas transicoes de workflow (sisv_05).
ALTER TABLE workflow_transition_roles DROP CONSTRAINT IF EXISTS workflow_transition_roles_role_check;
ALTER TABLE workflow_transition_roles ADD CONSTRAINT workflow_transition_roles_role_check
  CHECK (role IN ('admin','manager','operator','seller','viewer'));

-- =============================================================================
-- FIM — rollback SISV 2.0.
-- =============================================================================
