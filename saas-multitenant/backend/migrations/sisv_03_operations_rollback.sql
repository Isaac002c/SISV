-- Rollback destrutivo do modulo operacional SISV 1.0.
-- Execute somente apos backup e quando nao houver dados a preservar.
DROP TABLE IF EXISTS process_note_mentions;
DROP TABLE IF EXISTS process_notes;
DROP TABLE IF EXISTS saved_views;
DROP TABLE IF EXISTS operation_requests;
DROP TABLE IF EXISTS internal_alerts;
DROP TABLE IF EXISTS process_tasks;
DROP TABLE IF EXISTS task_types;
DROP TABLE IF EXISTS tenant_operation_settings;

ALTER TABLE fines DROP COLUMN IF EXISTS archived_at;
ALTER TABLE fines DROP COLUMN IF EXISTS custom_data;

ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS custom_fields;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS suggested_tasks;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS initial_department_id;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS default_due_days;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS initial_status;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS initial_stage;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS description;

ALTER TABLE users DROP COLUMN IF EXISTS department_id;
ALTER TABLE users DROP COLUMN IF EXISTS is_active;
