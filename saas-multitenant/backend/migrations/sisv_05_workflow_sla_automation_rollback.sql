-- =============================================================================
-- Rollback SISV 1.1 - SOMENTE estruturas da migration 05.
-- Use apenas em banco descartavel ou mediante plano de mudanca aprovado.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_guard_workflow_requirements ON workflow_transition_requirements;
DROP TRIGGER IF EXISTS trg_guard_workflow_departments ON workflow_transition_departments;
DROP TRIGGER IF EXISTS trg_guard_workflow_roles ON workflow_transition_roles;
DROP TRIGGER IF EXISTS trg_guard_workflow_transitions ON workflow_transitions;
DROP TRIGGER IF EXISTS trg_guard_workflow_stages ON workflow_flow_stages;
DROP TRIGGER IF EXISTS trg_guard_workflow_version ON workflow_flows;
DROP FUNCTION IF EXISTS sisv_guard_workflow_transition_child();
DROP FUNCTION IF EXISTS sisv_guard_workflow_definition();
DROP FUNCTION IF EXISTS sisv_guard_workflow_version();

DROP TABLE IF EXISTS governance_audit_events;
DROP TABLE IF EXISTS internal_queue_jobs;
DROP TABLE IF EXISTS automation_executions;
DROP TABLE IF EXISTS automation_actions;
DROP TABLE IF EXISTS automation_conditions;
DROP TABLE IF EXISTS automation_definitions;
DROP TABLE IF EXISTS operation_attention_flags;
DROP TABLE IF EXISTS sla_instance_events;
DROP TABLE IF EXISTS sla_instances;
DROP TABLE IF EXISTS sla_rules;
DROP TABLE IF EXISTS sla_calendar_exceptions;
DROP TABLE IF EXISTS sla_calendar_hours;
DROP TABLE IF EXISTS sla_calendars;
DROP TABLE IF EXISTS operation_idempotency;
DROP TABLE IF EXISTS workflow_process_migration_items;
DROP TABLE IF EXISTS workflow_process_migrations;

ALTER TABLE tenant_operation_settings DROP COLUMN IF EXISTS row_version;
ALTER TABLE tenant_service_types DROP COLUMN IF EXISTS row_version;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS review_status;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS row_version;
ALTER TABLE process_tasks DROP COLUMN IF EXISTS blocks_transition;
ALTER TABLE process_tasks DROP COLUMN IF EXISTS row_version;

ALTER TABLE fines DROP COLUMN IF EXISTS operational_priority;
ALTER TABLE fines DROP COLUMN IF EXISTS row_version;
ALTER TABLE fines DROP COLUMN IF EXISTS workflow_assigned_at;
ALTER TABLE fines DROP COLUMN IF EXISTS workflow_version;
ALTER TABLE fines DROP COLUMN IF EXISTS workflow_id;

DROP TABLE IF EXISTS workflow_transition_requirements;
DROP TABLE IF EXISTS workflow_transition_departments;
DROP TABLE IF EXISTS workflow_transition_roles;
DROP TABLE IF EXISTS workflow_transitions;
DROP TABLE IF EXISTS workflow_flow_stages;
DROP TABLE IF EXISTS workflow_flows;
