-- Rollback estrutural da migration SISV 2.1.
-- ATENCAO: remover additional_data e as tabelas abaixo descarta dados novos.
-- Execute somente depois de restaurar/confirmar backup e voltar a aplicacao.

BEGIN;

DROP INDEX IF EXISTS idx_orders_contractor_partner;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_contractor_partner_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_contractor_type_check;
ALTER TABLE orders DROP COLUMN IF EXISTS contracting_model_version;
ALTER TABLE orders DROP COLUMN IF EXISTS commercial_terms_applied_at;
ALTER TABLE orders DROP COLUMN IF EXISTS applied_commercial_terms;
ALTER TABLE orders DROP COLUMN IF EXISTS contractor_partner_id;
ALTER TABLE orders DROP COLUMN IF EXISTS contractor_type;

ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_discount_value_check;
ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_discount_type_check;
ALTER TABLE suppliers DROP COLUMN IF EXISTS commercial_notes;
ALTER TABLE suppliers DROP COLUMN IF EXISTS payment_method;
ALTER TABLE suppliers DROP COLUMN IF EXISTS discount_value;
ALTER TABLE suppliers DROP COLUMN IF EXISTS discount_type;
ALTER TABLE suppliers DROP COLUMN IF EXISTS default_price_table_id;

DROP TRIGGER IF EXISTS trg_seed_client_system_fields ON tenants;
DROP FUNCTION IF EXISTS seed_client_system_fields_for_tenant();
DROP TABLE IF EXISTS service_client_field_requirements;
DROP TABLE IF EXISTS client_field_definitions;
ALTER TABLE clients DROP COLUMN IF EXISTS additional_data;

COMMIT;
