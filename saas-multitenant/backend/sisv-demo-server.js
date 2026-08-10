/* =============================================================================
 * sisv-demo-server.js — Servidor de DEMONSTRAÇÃO local do SISV (Sinal Verde).
 *
 * Roda as ROTAS REAIS (tenant, config, processos, clientes) contra um Postgres
 * em memória (pg-mem), com o tenant SISV + catálogos CNH + dados de exemplo.
 * Serve para smoke test da stack completa SEM banco externo. NÃO usar em produção.
 *
 * Uso:  cd saas-multitenant/backend && node sisv-demo-server.js   (porta 5000)
 * Login demo: gestor@sinalverde.com.br (admin) | operador1@sinalverde.com.br (operator)
 *             — qualquer senha; é só demonstração.
 * ============================================================================= */
// GUARDA DE SEGURANÇA: este arquivo é APENAS demonstração local (banco em
// memória, login sem senha). Nunca pode ser usado como entrypoint de produção.
if (process.env.NODE_ENV === 'production') {
  console.error('[sisv-demo-server] BLOQUEADO: servidor de demonstração não pode rodar com NODE_ENV=production.');
  console.error('[sisv-demo-server] Use "node app.js" como entrypoint de produção.');
  process.exit(1);
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sisv-demo-secret';
process.env.NODE_ENV = 'development';

const { randomUUID } = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { newDb, DataType } = require('pg-mem');

const { SISV_IDENTITY, SISV_MODULES, seedSisvCatalogs } = require('./scripts/sisv_seed_data');

const TENANT = 'sisv-demo-tenant';

// ── 1) pg-mem + schema ───────────────────────────────────────────────────────
// Os blocos "sisv_05" e "sisv_06" abaixo são GERADOS a partir das migrations.
// Ao criar uma migration nova, regenere e cole em vez de transcrever à mão:
//   node scripts/pgmem-schema-gen.js migrations/<arquivo>.sql
const db = newDb();
db.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value) => String(value).trim() });
// ROUND existe no PostgreSQL real, mas não no pg-mem; relatórios de margem usam
// ROUND(x, 2). Registrar aqui evita adaptar a consulta de produção ao demo.
db.public.registerFunction({
  name: 'round', args: [DataType.float, DataType.integer], returns: DataType.float,
  implementation: (value, digits) => {
    const factor = 10 ** Number(digits || 0);
    return Math.round(Number(value) * factor) / factor;
  },
});
db.public.registerFunction({
  name: 'round', args: [DataType.float], returns: DataType.float,
  implementation: (value) => Math.round(Number(value)),
});
db.public.registerFunction({
  name: 'jsonb_build_object',
  args: [DataType.text, DataType.text, DataType.text, DataType.text, DataType.text, DataType.text],
  returns: DataType.jsonb,
  implementation: (key1, value1, key2, value2, key3, value3) => ({
    [key1]: value1, [key2]: value2, [key3]: value3,
  }),
});
// listNotes usa a função nativa do PostgreSQL; pg-mem precisa da assinatura
// concreta encontrada nessa consulta (chave texto, UUID, chave texto, texto).
db.public.registerFunction({
  name: 'json_build_object',
  args: [DataType.text, DataType.uuid, DataType.text, DataType.text],
  returns: DataType.jsonb,
  implementation: (key1, value1, key2, value2) => ({
    [key1]: value1,
    [key2]: value2,
  }),
});
db.public.registerOperator({
  operator: '-',
  left: DataType.timestamptz,
  right: DataType.timestamptz,
  returns: DataType.interval,
  implementation: (left, right) => ({ milliseconds: left.getTime() - right.getTime() }),
});

db.public.none(`
  CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT, status TEXT DEFAULT 'ativo', email TEXT,
    logo_url TEXT, brand_color TEXT, brand_color_dark TEXT, tagline TEXT, developer TEXT, modules JSONB,
    user_limit INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT, name TEXT, email TEXT,
    password_hash TEXT, role TEXT, seller_id UUID, last_login TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE, department_id UUID, phone TEXT, access_profile TEXT,
    module_access JSONB, backoffice_level SMALLINT DEFAULT 0, username TEXT, deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE clients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT,
    birth_date DATE, cpf TEXT, cnh TEXT, first_cnh DATE, phone TEXT, email TEXT, address TEXT, notes TEXT,
    status TEXT DEFAULT 'negociacao', lead_id UUID, additional_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    client_code TEXT, client_type TEXT, category TEXT, rg TEXT, cnh_category TEXT, whatsapp TEXT,
    contact_preference TEXT, origin TEXT, responsible_name TEXT, additional_info TEXT,
    portal_access JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted_at TIMESTAMPTZ, deleted_by UUID, delete_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_final BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_statuses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, is_pending BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE tenant_service_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, description TEXT, initial_stage TEXT, initial_status TEXT, default_due_days INT, initial_department_id UUID, suggested_tasks JSONB DEFAULT '[]', custom_fields JSONB DEFAULT '[]', row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, client_id UUID,
    company_id UUID, vehicle_id UUID, service_type_id INT, seller_id UUID, fine_number TEXT, plate TEXT, organ TEXT,
    infraction_type TEXT, vehicle_model TEXT, infraction_date DATE, due_date DATE, defense_date DATE,
    stage TEXT DEFAULT 'ENTRADA', status TEXT DEFAULT 'PENDENTE', value NUMERIC(15,2) DEFAULT 0, cost NUMERIC(15,2) DEFAULT 0,
    paid_value NUMERIC(15,2) DEFAULT 0, notes TEXT, protocol_number TEXT, department_id UUID, tenant_service_type_id UUID,
    finalized_at TIMESTAMPTZ, reopened_at TIMESTAMPTZ, last_moved_at TIMESTAMPTZ,
    custom_data JSONB DEFAULT '{}', archived_at TIMESTAMPTZ, row_version INTEGER NOT NULL DEFAULT 1,
    protocol_date DATE, protocol_status TEXT, protocol_notes TEXT, protocol_file_url TEXT,
    workflow_id UUID, workflow_version INT, workflow_assigned_at TIMESTAMPTZ,
    operational_priority TEXT NOT NULL DEFAULT 'normal',
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fine_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, name TEXT, file_url TEXT, file_type TEXT, file_size BIGINT, category TEXT, category_id UUID, notes TEXT, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now(), row_version INTEGER NOT NULL DEFAULT 1, review_status TEXT NOT NULL DEFAULT 'pending', reviewed_by UUID, reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE fine_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID, action TEXT, field_name TEXT, old_value TEXT, new_value TEXT, user_id UUID, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE activity_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, user_id UUID, entity TEXT, entity_id UUID, entity_name TEXT, action TEXT, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, contract_id UUID, client_id UUID, company_id UUID, vehicle_id UUID, file_url TEXT, file_name TEXT, file_type TEXT, file_size BIGINT, category TEXT DEFAULT 'outros', description TEXT, category_id UUID, stored_name TEXT, original_name TEXT, status TEXT DEFAULT 'ativo', archived_at TIMESTAMPTZ, removed_by UUID, removed_at TIMESTAMPTZ, uploaded_by UUID, uploaded_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE document_categories (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT, description TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE service_type_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, tenant_service_type_id UUID, category_id UUID, required BOOLEAN DEFAULT FALSE, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE tenant_operation_settings (tenant_id TEXT PRIMARY KEY, stale_after_days INT DEFAULT 7, due_soon_days INT DEFAULT 7, aging_bands JSONB DEFAULT '[2,5,10]', department_required BOOLEAN DEFAULT FALSE, row_version INTEGER NOT NULL DEFAULT 1, updated_by UUID, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE task_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code TEXT, label TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID NOT NULL, title TEXT NOT NULL, description TEXT, task_type_id UUID, priority TEXT DEFAULT 'normal', assignee_id UUID, department_id UUID, due_at TIMESTAMPTZ, status TEXT DEFAULT 'aberta', created_by UUID, completed_by UUID, completed_at TIMESTAMPTZ, completion_result TEXT, completion_note TEXT, row_version INTEGER NOT NULL DEFAULT 1, blocks_transition BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ, deleted_by UUID);
  CREATE TABLE internal_alerts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, recipient_id UUID NOT NULL, type TEXT, title TEXT, message TEXT, entity_type TEXT, entity_id UUID, internal_link TEXT, dedupe_key TEXT, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(tenant_id,recipient_id,dedupe_key));
  CREATE TABLE saved_views (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, user_id UUID NOT NULL, name TEXT, view_type TEXT DEFAULT 'processos', filters JSONB DEFAULT '{}', sort_config JSONB DEFAULT '{}', is_default BOOLEAN DEFAULT FALSE, is_favorite BOOLEAN DEFAULT FALSE, shared_tenant BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(tenant_id,user_id,name,view_type));
  CREATE TABLE operation_requests (tenant_id TEXT NOT NULL, request_key TEXT NOT NULL, user_id UUID, operation TEXT, result JSONB, created_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,request_key));
  CREATE TABLE process_notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, fine_id UUID NOT NULL, author_id UUID, content TEXT, edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, deleted_by UUID, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE process_note_mentions (note_id UUID NOT NULL, tenant_id TEXT NOT NULL, user_id UUID NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(note_id,user_id));

  -- ── sisv_05: workflows, SLA, automações e governança ──────────────────────
  CREATE TABLE workflow_flows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, tenant_service_type_id UUID, source_flow_id UUID, name VARCHAR(160) NOT NULL, description TEXT, version INTEGER NOT NULL DEFAULT 1, status VARCHAR(20) NOT NULL DEFAULT 'draft', initial_stage_code VARCHAR(60) NOT NULL, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, published_by UUID, published_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE workflow_flow_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, flow_id UUID NOT NULL, stage_code VARCHAR(60) NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_initial BOOLEAN NOT NULL DEFAULT FALSE, is_final BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (flow_id, stage_code));
  CREATE TABLE workflow_transitions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, flow_id UUID NOT NULL, name VARCHAR(160) NOT NULL, from_stage_code VARCHAR(60) NOT NULL, to_stage_code VARCHAR(60) NOT NULL, target_status_code VARCHAR(60), justification_required BOOLEAN NOT NULL DEFAULT FALSE, assignee_required BOOLEAN NOT NULL DEFAULT FALSE, due_date_required BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE workflow_transition_roles (transition_id UUID NOT NULL, tenant_id TEXT NOT NULL, role VARCHAR(30) NOT NULL, PRIMARY KEY (transition_id, role));
  CREATE TABLE workflow_transition_departments (transition_id UUID NOT NULL, tenant_id TEXT NOT NULL, department_id UUID NOT NULL, PRIMARY KEY (transition_id, department_id));
  CREATE TABLE workflow_transition_requirements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, transition_id UUID NOT NULL, requirement_type VARCHAR(40) NOT NULL, field_key VARCHAR(120), category_id UUID, permission_key VARCHAR(120), label VARCHAR(180) NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE workflow_process_migrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, from_flow_id UUID, to_flow_id UUID NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'preview', justification TEXT NOT NULL, incompatibilities JSONB NOT NULL DEFAULT '[]'::jsonb, requested_by UUID, confirmed_by UUID, confirmed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE workflow_process_migration_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, migration_id UUID NOT NULL, fine_id UUID NOT NULL, from_stage_code VARCHAR(60), to_stage_code VARCHAR(60), previous_flow_id UUID, previous_version INTEGER, expected_row_version INTEGER NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', issues JSONB NOT NULL DEFAULT '[]'::jsonb, migrated_at TIMESTAMPTZ, UNIQUE (migration_id, fine_id));
  CREATE TABLE operation_idempotency (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, operation_scope VARCHAR(80) NOT NULL, idempotency_key VARCHAR(180) NOT NULL, request_hash VARCHAR(128) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'processing', http_status INTEGER, response_body JSONB, resource_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'), UNIQUE (tenant_id, operation_scope, idempotency_key));
  CREATE TABLE sla_calendars (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name VARCHAR(160) NOT NULL, timezone VARCHAR(80) NOT NULL DEFAULT 'America/Sao_Paulo', active BOOLEAN NOT NULL DEFAULT TRUE, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE sla_calendar_hours (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, calendar_id UUID NOT NULL, weekday SMALLINT NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL, break_start TIME, break_end TIME, active BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE (calendar_id, weekday));
  CREATE TABLE sla_calendar_exceptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, calendar_id UUID NOT NULL, exception_date DATE NOT NULL, name VARCHAR(160) NOT NULL, is_working_day BOOLEAN NOT NULL DEFAULT FALSE, start_time TIME, end_time TIME, UNIQUE (calendar_id, exception_date));
  CREATE TABLE sla_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name VARCHAR(160) NOT NULL, description TEXT, entity_type VARCHAR(30) NOT NULL DEFAULT 'process', tenant_service_type_id UUID, stage_code VARCHAR(60), task_type_id UUID, priority VARCHAR(20), department_id UUID, duration_value INTEGER NOT NULL, duration_unit VARCHAR(20) NOT NULL, calendar_id UUID, warning_minutes INTEGER NOT NULL DEFAULT 0, escalation_actions JSONB NOT NULL DEFAULT '[]'::jsonb, pause_reasons JSONB NOT NULL DEFAULT '["waiting_client", "waiting_document", "waiting_agency", "waiting_third_party", "suspended"]'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE sla_instances (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, rule_id UUID NOT NULL, entity_type VARCHAR(30) NOT NULL, entity_id UUID NOT NULL, fine_id UUID, status VARCHAR(30) NOT NULL DEFAULT 'not_started', started_at TIMESTAMPTZ, due_at TIMESTAMPTZ, consumed_seconds BIGINT NOT NULL DEFAULT 0, remaining_seconds BIGINT, paused_at TIMESTAMPTZ, pause_reason VARCHAR(80), resumed_at TIMESTAMPTZ, violated_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, result VARCHAR(80), warning_alerted_at TIMESTAMPTZ, violation_alerted_at TIMESTAMPTZ, last_evaluated_at TIMESTAMPTZ, row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE sla_instance_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, instance_id UUID NOT NULL, event_type VARCHAR(30) NOT NULL, reason VARCHAR(180), actor_user_id UUID, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), safe_context JSONB NOT NULL DEFAULT '{}'::jsonb);
  CREATE TABLE operation_attention_flags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, entity_type VARCHAR(30) NOT NULL, entity_id UUID NOT NULL, reason_code VARCHAR(80) NOT NULL, severity VARCHAR(20) NOT NULL DEFAULT 'attention', title VARCHAR(180) NOT NULL, source_type VARCHAR(40), source_id UUID, resolved_at TIMESTAMPTZ, resolved_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE automation_definitions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name VARCHAR(160) NOT NULL, description TEXT, event_type VARCHAR(50) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', sort_order INTEGER NOT NULL DEFAULT 0, max_depth SMALLINT NOT NULL DEFAULT 5, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, last_executed_at TIMESTAMPTZ, execution_count BIGINT NOT NULL DEFAULT 0, failure_count BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE automation_conditions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, automation_id UUID NOT NULL, condition_type VARCHAR(50) NOT NULL, operator VARCHAR(20) NOT NULL, field_key VARCHAR(120), value JSONB NOT NULL DEFAULT 'null'::jsonb, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE automation_actions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, automation_id UUID NOT NULL, action_type VARCHAR(50) NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE automation_executions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, automation_id UUID, event_type VARCHAR(50) NOT NULL, source_entity_type VARCHAR(30), source_entity_id UUID, root_execution_id UUID, parent_execution_id UUID, chain JSONB NOT NULL DEFAULT '[]'::jsonb, depth SMALLINT NOT NULL DEFAULT 0, idempotency_key VARCHAR(180) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'queued', started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, duration_ms INTEGER, error_summary VARCHAR(500), safe_context JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tenant_id, automation_id, idempotency_key));
  CREATE TABLE internal_queue_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, job_type VARCHAR(50) NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(20) NOT NULL DEFAULT 'pending', priority SMALLINT NOT NULL DEFAULT 50, attempts SMALLINT NOT NULL DEFAULT 0, max_attempts SMALLINT NOT NULL DEFAULT 5, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_by VARCHAR(120), locked_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, duration_ms INTEGER, error_summary VARCHAR(500), idempotency_key VARCHAR(180) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tenant_id, job_type, idempotency_key));
  CREATE TABLE governance_audit_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, actor_user_id UUID, event_type VARCHAR(80) NOT NULL, entity_type VARCHAR(40) NOT NULL, entity_id UUID, related_fine_id UUID, outcome VARCHAR(20) NOT NULL DEFAULT 'success', summary VARCHAR(300) NOT NULL, safe_details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

  -- ── sisv_06: comercial, back office, execução e financeiro operacional ─────
  CREATE TABLE commercial_counters (tenant_id TEXT NOT NULL, doc_type VARCHAR(30) NOT NULL, current_number INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id, doc_type));
  CREATE TABLE commercial_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, entity_type VARCHAR(40) NOT NULL, entity_id UUID NOT NULL, action VARCHAR(60) NOT NULL, from_status VARCHAR(40), to_status VARCHAR(40), reason TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, user_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE suppliers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'fornecedor', person_type VARCHAR(4) NOT NULL DEFAULT 'pj', legal_name VARCHAR(200) NOT NULL, trade_name VARCHAR(200), document VARCHAR(20), state_registration VARCHAR(40), contact_name VARCHAR(160), phone VARCHAR(30), whatsapp VARCHAR(30), email VARCHAR(200), address TEXT, bank_details TEXT, pix_key VARCHAR(200), services_provided TEXT, commission_type VARCHAR(12), commission_value NUMERIC(15,2), payment_terms VARCHAR(160), default_price_table_id UUID, discount_type VARCHAR(12), discount_value NUMERIC(15,2), payment_method VARCHAR(40), commercial_notes TEXT, notes TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE catalog_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, code VARCHAR(40) NOT NULL, name VARCHAR(200) NOT NULL, description TEXT, item_type VARCHAR(10) NOT NULL DEFAULT 'servico', category VARCHAR(120), unit VARCHAR(20) NOT NULL DEFAULT 'un', default_price NUMERIC(15,2) NOT NULL DEFAULT 0, default_cost NUMERIC(15,2), estimated_duration_days INTEGER, tenant_service_type_id UUID, document_checklist JSONB NOT NULL DEFAULT '[]'::jsonb, requires_process BOOLEAN NOT NULL DEFAULT FALSE, requires_invoice BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE price_tables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name VARCHAR(160) NOT NULL, description TEXT, audience VARCHAR(120), starts_on DATE, ends_on DATE, priority INTEGER NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL DEFAULT 'rascunho', source_table_id UUID, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE price_table_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, price_table_id UUID NOT NULL, catalog_item_id UUID NOT NULL, price NUMERIC(15,2) NOT NULL DEFAULT 0, cost NUMERIC(15,2), max_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(price_table_id, catalog_item_id));
  CREATE TABLE client_field_definitions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, field_key VARCHAR(60) NOT NULL, label VARCHAR(120) NOT NULL, field_type VARCHAR(20) NOT NULL DEFAULT 'text', storage_kind VARCHAR(10) NOT NULL DEFAULT 'custom', system_column VARCHAR(40), validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, field_key));
  CREATE TABLE service_client_field_requirements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, catalog_item_id UUID NOT NULL, field_definition_id UUID NOT NULL, required BOOLEAN NOT NULL DEFAULT TRUE, active BOOLEAN NOT NULL DEFAULT TRUE, display_order INTEGER NOT NULL DEFAULT 0, label_override VARCHAR(120), validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(catalog_item_id, field_definition_id));
  CREATE TABLE orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, number VARCHAR(30) NOT NULL, client_id UUID NOT NULL, price_table_id UUID, origin_channel VARCHAR(40) NOT NULL DEFAULT 'balcao', owner_id UUID, department_id UUID, status VARCHAR(30) NOT NULL DEFAULT 'rascunho', subtotal NUMERIC(15,2) NOT NULL DEFAULT 0, discount NUMERIC(15,2) NOT NULL DEFAULT 0, surcharge NUMERIC(15,2) NOT NULL DEFAULT 0, total NUMERIC(15,2) NOT NULL DEFAULT 0, notes TEXT, sent_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT, contractor_type VARCHAR(12) NOT NULL DEFAULT 'client', contractor_partner_id UUID, applied_commercial_terms JSONB NOT NULL DEFAULT '{}'::jsonb, commercial_terms_applied_at TIMESTAMPTZ, contracting_model_version SMALLINT NOT NULL DEFAULT 1, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, number));
  CREATE TABLE order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, order_id UUID NOT NULL, catalog_item_id UUID, description VARCHAR(255) NOT NULL, item_type VARCHAR(10) NOT NULL DEFAULT 'servico', unit VARCHAR(20) NOT NULL DEFAULT 'un', quantity NUMERIC(12,3) NOT NULL DEFAULT 1, unit_price NUMERIC(15,2) NOT NULL DEFAULT 0, unit_cost NUMERIC(15,2), discount NUMERIC(15,2) NOT NULL DEFAULT 0, surcharge NUMERIC(15,2) NOT NULL DEFAULT 0, total NUMERIC(15,2) NOT NULL DEFAULT 0, supplier_id UUID, commission_type VARCHAR(12), commission_value NUMERIC(15,2), requires_process BOOLEAN NOT NULL DEFAULT FALSE, tenant_service_type_id UUID, notes TEXT, status VARCHAR(20) NOT NULL DEFAULT 'ativo', sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE order_validations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, order_id UUID NOT NULL, decision VARCHAR(24) NOT NULL, reason TEXT, checklist JSONB NOT NULL DEFAULT '{}'::jsonb, order_version INTEGER, reviewed_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE document_templates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name VARCHAR(160) NOT NULL, doc_type VARCHAR(24) NOT NULL, body TEXT NOT NULL, available_fields JSONB NOT NULL DEFAULT '[]'::jsonb, version INTEGER NOT NULL DEFAULT 1, status VARCHAR(12) NOT NULL DEFAULT 'rascunho', row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE generated_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, template_id UUID, template_version INTEGER, doc_type VARCHAR(24) NOT NULL, title VARCHAR(200) NOT NULL, entity_type VARCHAR(30) NOT NULL, entity_id UUID NOT NULL, client_id UUID, order_id UUID, content TEXT, checksum VARCHAR(64), file_url TEXT, stage VARCHAR(20) NOT NULL DEFAULT 'pedido', status VARCHAR(16) NOT NULL DEFAULT 'gerado', replaced_by UUID, cancel_reason TEXT, cancelled_at TIMESTAMPTZ, generated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sale_id UUID, payment_id UUID);
  CREATE TABLE commercial_contracts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, number VARCHAR(30) NOT NULL, client_id UUID NOT NULL, order_id UUID, title VARCHAR(200) NOT NULL, generated_document_id UUID, status VARCHAR(14) NOT NULL DEFAULT 'rascunho', signed_at DATE, signed_by_name VARCHAR(200), responsible_id UUID, witnesses JSONB NOT NULL DEFAULT '[]'::jsonb, file_url TEXT, replaced_by UUID, notes TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, number), sale_id UUID);
  CREATE TABLE receivables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, client_id UUID NOT NULL, order_id UUID, description VARCHAR(255) NOT NULL, total_amount NUMERIC(15,2) NOT NULL DEFAULT 0, received_amount NUMERIC(15,2) NOT NULL DEFAULT 0, due_date DATE, payment_method VARCHAR(30), status VARCHAR(12) NOT NULL DEFAULT 'pendente', notes TEXT, settled_at TIMESTAMPTZ, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sale_id UUID);
  CREATE TABLE customer_payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, receivable_id UUID NOT NULL, order_id UUID, client_id UUID NOT NULL, amount NUMERIC(15,2) NOT NULL, paid_at DATE NOT NULL DEFAULT CURRENT_DATE, payment_method VARCHAR(30) NOT NULL DEFAULT 'pix', reference VARCHAR(120), proof_url TEXT, status VARCHAR(14) NOT NULL DEFAULT 'informado', decision_reason TEXT, notes TEXT, registered_by UUID, validated_by UUID, validated_at TIMESTAMPTZ, row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sale_id UUID);
  CREATE TABLE sales (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, number VARCHAR(30) NOT NULL, order_id UUID NOT NULL, client_id UUID NOT NULL, gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0, discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0, net_amount NUMERIC(15,2) NOT NULL DEFAULT 0, estimated_cost NUMERIC(15,2) NOT NULL DEFAULT 0, estimated_margin NUMERIC(15,2) NOT NULL DEFAULT 0, commission_forecast NUMERIC(15,2) NOT NULL DEFAULT 0, owner_id UUID, partner_id UUID, status VARCHAR(14) NOT NULL DEFAULT 'confirmada', notes TEXT, confirmed_by UUID, confirmed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, number), UNIQUE(tenant_id, order_id));
  CREATE TABLE sale_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, sale_id UUID NOT NULL, order_item_id UUID, catalog_item_id UUID, description VARCHAR(255) NOT NULL, item_type VARCHAR(10) NOT NULL DEFAULT 'servico', quantity NUMERIC(12,3) NOT NULL DEFAULT 1, unit_price NUMERIC(15,2) NOT NULL DEFAULT 0, unit_cost NUMERIC(15,2), discount NUMERIC(15,2) NOT NULL DEFAULT 0, total NUMERIC(15,2) NOT NULL DEFAULT 0, supplier_id UUID, commission_type VARCHAR(12), commission_value NUMERIC(15,2), requires_process BOOLEAN NOT NULL DEFAULT FALSE, tenant_service_type_id UUID, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE service_orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, number VARCHAR(30) NOT NULL, sale_id UUID NOT NULL, order_id UUID, client_id UUID NOT NULL, department_id UUID, owner_id UUID, priority VARCHAR(10) NOT NULL DEFAULT 'normal', due_date DATE, planned_date DATE, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, status VARCHAR(24) NOT NULL DEFAULT 'rascunho', instructions TEXT, notes TEXT, cancel_reason TEXT, archived_at TIMESTAMPTZ, archived_by UUID, reopened_at TIMESTAMPTZ, reopened_by UUID, reopen_reason TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, number), UNIQUE(tenant_id, sale_id));
  CREATE TABLE service_order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, service_order_id UUID NOT NULL, sale_item_id UUID, process_id UUID, description VARCHAR(255) NOT NULL, quantity NUMERIC(12,3) NOT NULL DEFAULT 1, supplier_id UUID, status VARCHAR(16) NOT NULL DEFAULT 'pendente', notes TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE execution_costs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, service_order_id UUID NOT NULL, service_order_item_id UUID, sale_id UUID, supplier_id UUID, description VARCHAR(255) NOT NULL, planned_cost NUMERIC(15,2) NOT NULL DEFAULT 0, actual_cost NUMERIC(15,2), incurred_on DATE, document_ref VARCHAR(120), status VARCHAR(12) NOT NULL DEFAULT 'previsto', notes TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE commissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, sale_id UUID NOT NULL, sale_item_id UUID, beneficiary_supplier_id UUID, beneficiary_user_id UUID, beneficiary_name VARCHAR(200) NOT NULL, base_amount NUMERIC(15,2) NOT NULL DEFAULT 0, rate_type VARCHAR(12) NOT NULL DEFAULT 'percentual', rate_value NUMERIC(15,2) NOT NULL DEFAULT 0, amount NUMERIC(15,2) NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL DEFAULT 'prevista', expected_date DATE, paid_at DATE, proof_url TEXT, notes TEXT, row_version INTEGER NOT NULL DEFAULT 1, confirmed_by UUID, confirmed_at TIMESTAMPTZ, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payable_id UUID);
  CREATE TABLE payables (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, kind VARCHAR(14) NOT NULL, payee_supplier_id UUID, payee_user_id UUID, payee_name VARCHAR(200) NOT NULL, order_id UUID, sale_id UUID, service_order_id UUID, process_id UUID, execution_cost_id UUID, commission_id UUID, description VARCHAR(255) NOT NULL, amount NUMERIC(15,2) NOT NULL, due_date DATE, payment_method VARCHAR(30), status VARCHAR(12) NOT NULL DEFAULT 'previsto', proof_url TEXT, paid_at DATE, notes TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, approved_by UUID, approved_at TIMESTAMPTZ, paid_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE fiscal_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, sale_id UUID, service_order_id UUID, order_id UUID, client_id UUID, required BOOLEAN NOT NULL DEFAULT TRUE, status VARCHAR(16) NOT NULL DEFAULT 'pendente', number VARCHAR(40), series VARCHAR(20), access_key VARCHAR(60), issued_at DATE, amount NUMERIC(15,2), pdf_url TEXT, xml_url TEXT, issuer VARCHAR(200), notes TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE finalization_records (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, service_order_id UUID NOT NULL, sale_id UUID, client_id UUID, checklist JSONB NOT NULL DEFAULT '{}'::jsonb, delivered_at DATE, delivery_notes TEXT, final_notes TEXT, status VARCHAR(12) NOT NULL DEFAULT 'concluida', finalized_by UUID, finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), archived_by UUID, archived_at TIMESTAMPTZ, reopened_by UUID, reopened_at TIMESTAMPTZ, reopen_reason TEXT, row_version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id, service_order_id));
`);

const pgAdapter = db.adapters.createPg();
const pool = new pgAdapter.Pool();

// Injeta o pool no lugar de config/db ANTES de carregar as rotas reais.
const dbModulePath = require.resolve('./config/db');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: pool };

const tenantContext = require('./middlewares/tenantContext');
const { requireModule } = require('./middlewares/requireModule');
const tenantRoutes = require('./routes/tenantRoutes');
const tenantConfigRoutes = require('./routes/tenantConfigRoutes');
const processRoutes = require('./routes/processRoutes');
const clientRoutes = require('./routes/clientRoutes');
const clientFieldRoutes = require('./routes/clientFieldRoutes');
const finesRoutes = require('./routes/finesRoutes');
const documentRoutes = require('./routes/documentRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const taskRoutes = require('./routes/taskRoutes');
const alertRoutes = require('./routes/alertRoutes');
const operationsRoutes = require('./routes/operationsRoutes');
const noteRoutes = require('./routes/noteRoutes');
// SISV 2.0 — mesmas rotas reais do app.js, para o E2E percorrer a jornada toda.
const commercialRoutes = require('./routes/commercialRoutes');
const orderRoutes = require('./routes/orderRoutes');
const salesRoutes = require('./routes/salesRoutes');
const executionRoutes = require('./routes/executionRoutes');
const commercialDocRoutes = require('./routes/commercialDocRoutes');
const backofficeRoutes = require('./routes/backofficeRoutes');
const userManagementRoutes = require('./routes/userManagementRoutes');
const requireActiveUser = require('./middlewares/requireActiveUser');
const path = require('path');
const express0 = require('express');

let ADMIN_ID, OP_ID;

async function seed() {
  await pool.query(
    `INSERT INTO tenants (id,name,slug,status,brand_color,brand_color_dark,tagline,developer,modules)
     VALUES ($1,$2,$3,'ativo',$4,$5,$6,$7,$8::jsonb)`,
    [TENANT, SISV_IDENTITY.name, SISV_IDENTITY.slug, SISV_IDENTITY.brand_color,
     SISV_IDENTITY.brand_color_dark, SISV_IDENTITY.tagline, SISV_IDENTITY.developer, JSON.stringify(SISV_MODULES)]
  );
  ADMIN_ID = (await pool.query(`INSERT INTO users (tenant_id,name,username,email,password_hash,role) VALUES ($1,'Gestor Sinal Verde','gestor.sinalverde','gestor@sinalverde.com.br','x','admin') RETURNING id`, [TENANT])).rows[0].id;
  OP_ID = (await pool.query(`INSERT INTO users (tenant_id,name,username,email,password_hash,role) VALUES ($1,'Operador 1','operador.1','operador1@sinalverde.com.br','x','operator') RETURNING id`, [TENANT])).rows[0].id;

  for (const [fieldKey, label, fieldType, systemColumn, sortOrder, rules = {}] of [
    ['client_code', 'Código do cliente', 'text', 'client_code', 5],
    ['client_type', 'Tipo de cliente', 'select', 'client_type', 6, { options: ['pf', 'pj'] }],
    ['category', 'Categoria do cliente', 'select', 'category', 7,
      { options: ['standard', 'fidelidade', 'empresarial', 'parceiro', 'agencia'] }],
    ['cpf', 'CPF', 'document', 'cpf', 10],
    ['birth_date', 'Data de nascimento', 'date', 'birth_date', 20],
    ['cnh', 'CNH', 'document', 'cnh', 30],
    ['rg', 'RG', 'document', 'rg', 35],
    ['cnh_category', 'Categoria da CNH', 'select', 'cnh_category', 36,
      { options: ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE', 'ACC'] }],
    ['first_cnh', 'Data da 1a habilitacao', 'date', 'first_cnh', 40],
    ['phone', 'Telefone', 'phone', 'phone', 50],
    ['whatsapp', 'Nº WhatsApp', 'phone', 'whatsapp', 55],
    ['email', 'E-mail', 'email', 'email', 60],
    ['contact_preference', 'Meio de contato preferencial', 'select', 'contact_preference', 65,
      { options: ['whatsapp', 'telefone', 'email', 'sms'] }],
    ['address', 'Endereço', 'textarea', 'address', 70],
    ['origin', 'Origem do cliente', 'select', 'origin', 75,
      { options: ['carteira', 'indicacao', 'balcao', 'midia_online', 'outros'] }],
    ['responsible_name', 'Responsável (PJ)', 'text', 'responsible_name', 80],
    ['additional_info', 'Dados adicionais', 'textarea', 'additional_info', 90],
  ]) {
    await pool.query(
      `INSERT INTO client_field_definitions
         (tenant_id,field_key,label,field_type,storage_kind,system_column,sort_order,validation_rules)
       VALUES ($1,$2,$3,$4,'system',$5,$6,$7::jsonb)`,
      [TENANT, fieldKey, label, fieldType, systemColumn, sortOrder, JSON.stringify(rules)]
    );
  }

  await seedSisvCatalogs(pool, TENANT);
  await pool.query(`INSERT INTO tenant_operation_settings (tenant_id) VALUES ($1)`, [TENANT]);
  for (const [code, label, order] of [
    ['CONTATO_CLIENTE', 'Contato com cliente', 1],
    ['SOLICITAR_DOCUMENTO', 'Solicitar documento', 2],
    ['ANALISAR_DOCUMENTO', 'Analisar documento', 3],
    ['ELABORAR_DEFESA', 'Elaborar defesa', 4],
    ['PROTOCOLAR', 'Protocolar', 5],
    ['ACOMPANHAR_JULGAMENTO', 'Acompanhar julgamento', 6],
    ['REVISAR_PROCESSO', 'Revisar processo', 7],
    ['ATUALIZAR_CLIENTE', 'Atualizar cliente', 8],
    ['PENDENCIA_INTERNA', 'Pendencia interna', 9],
    ['OUTRA', 'Outra', 10],
  ]) {
    await pool.query(
      `INSERT INTO task_types (tenant_id,code,label,sort_order) VALUES ($1,$2,$3,$4)`,
      [TENANT, code, label, order]
    );
  }
  const dept = async (n) => (await pool.query(`SELECT id FROM departments WHERE tenant_id=$1 AND name=$2`, [TENANT, n])).rows[0].id;
  const svc = async (c) => (await pool.query(`SELECT id FROM tenant_service_types WHERE tenant_id=$1 AND code=$2`, [TENANT, c])).rows[0].id;
  const dAtd = await dept('Atendimento'); const dJur = await dept('Jurídico');
  const sRea = await svc('REABILITACAO'); const sRen = await svc('RENOVACAO');
  await pool.query(
    `UPDATE tenant_service_types
     SET description=$1, initial_stage='ENTRADA', initial_status='PENDENTE',
         default_due_days=30, initial_department_id=$2,
         suggested_tasks=$3::jsonb, custom_fields=$4::jsonb
     WHERE tenant_id=$5 AND id=$6`,
    [
      'Template demo com prazo, setor, checklist, pendência sugerida e campo complementar.',
      dAtd,
      JSON.stringify([{ title: 'Conferir documentação inicial', priority: 'alta', due_days: 2 }]),
      JSON.stringify([{
        key: 'origem_caso', name: 'Origem do caso', type: 'texto_curto',
        required: false, order: 1, active: true, default_value: 'Atendimento',
      }]),
      TENANT,
      sRea,
    ]
  );
  const checklistCategories = await pool.query(
    `SELECT id FROM document_categories
     WHERE tenant_id=$1 AND name IN ('CNH','Documento pessoal')
     ORDER BY sort_order`,
    [TENANT]
  );
  for (const [index, category] of checklistCategories.rows.entries()) {
    await pool.query(
      `INSERT INTO service_type_documents
       (tenant_id, tenant_service_type_id, category_id, required, sort_order)
       VALUES ($1,$2,$3,TRUE,$4)`,
      [TENANT, sRea, category.id, index + 1]
    );
  }

  const clients = [];
  for (const [name, cpf, phone] of [
    ['Maria Oliveira', '12345678909', '(21) 99888-1122'],
    ['João Santos', '98765432100', '(21) 97777-3344'],
    ['Ana Souza', '45678912300', '(21) 96666-5566'],
  ]) {
    clients.push((await pool.query(`INSERT INTO clients (tenant_id,name,cpf,phone,status) VALUES ($1,$2,$3,$4,'fechado') RETURNING id`, [TENANT, name, cpf, phone])).rows[0].id);
  }

  const mk = async (client_id, num, stage, status, seller_id, department_id, tsvc, movedDaysAgo) => {
    const moved = new Date(Date.now() - movedDaysAgo * 86400000).toISOString();
    const r = await pool.query(
      `INSERT INTO fines (tenant_id,client_id,fine_number,stage,status,seller_id,department_id,tenant_service_type_id,last_moved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [TENANT, client_id, num, stage, status, seller_id, department_id, tsvc, moved]);
    await pool.query(`INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id) VALUES ($1,$2,'created','processo',$3,$4)`, [TENANT, r.rows[0].id, `Processo ${num}`, ADMIN_ID]);
    return r.rows[0].id;
  };
  const p1 = await mk(clients[0], 'SV-0001', 'DEFESA', 'EM_ANALISE', OP_ID, dJur, sRea, 1);
  const p2 = await mk(clients[1], 'SV-0002', 'ENTRADA', 'PENDENTE', OP_ID, dAtd, sRen, 10);
  await mk(clients[2], 'SV-0003', 'ELABORACAO', 'AGUARDANDO_DOCUMENTO', null, dAtd, sRea, 3);
  await mk(clients[0], 'SV-0004', 'FINALIZADO', 'DEFERIDO', ADMIN_ID, dJur, sRea, 20);
  // finaliza o SV-0004
  await pool.query(`UPDATE fines SET finalized_at = NOW() WHERE fine_number='SV-0004' AND tenant_id=$1`, [TENANT]);
  const contactType = (await pool.query(
    `SELECT id FROM task_types WHERE tenant_id=$1 AND code='CONTATO_CLIENTE'`,
    [TENANT]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO process_tasks (tenant_id,fine_id,title,task_type_id,priority,assignee_id,department_id,due_at,created_by)
     VALUES ($1,$2,'Atualizar cliente sobre andamento',$3,'alta',$4,$5,NOW() + INTERVAL '1 day',$6),
            ($1,$7,'Revisar documentos pendentes',$3,'critica',$4,$5,NOW() - INTERVAL '1 day',$6)`,
    [TENANT, p1, contactType, OP_ID, dAtd, ADMIN_ID, p2]
  );

  console.log('✓ Seed SISV demo concluído.');
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const tokenFor = (u) => jwt.sign({ userId: u.id, tenantId: TENANT, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1d' });

app.post('/auth/login', async (req, res) => {
  const login = String(req.body?.login || req.body?.email || 'gestor.sinalverde').toLowerCase();
  const u = (await pool.query(
    `SELECT id,name,username,email,role FROM users
      WHERE tenant_id=$1 AND (LOWER(username)=$2 OR LOWER(email)=$2)`,
    [TENANT, login]
  )).rows[0];
  if (!u) return res.status(401).json({ success: false, message: 'Usuário demo não encontrado' });
  const token = tokenFor(u);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.cookie('auth-token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({
    success: true, token, user: { id: u.id, name: u.name, username: u.username, email: u.email, role: u.role },
    tenant: {
      id: TENANT, name: SISV_IDENTITY.name, slug: SISV_IDENTITY.slug,
      brand_color: SISV_IDENTITY.brand_color, brand_color_dark: SISV_IDENTITY.brand_color_dark,
      tagline: SISV_IDENTITY.tagline, developer: SISV_IDENTITY.developer, modules: SISV_MODULES,
    },
  });
});
app.post('/auth/logout', (req, res) => res.json({ success: true }));

// Health/Readiness reais (mesmo router usado em produção).
app.use(require('./routes/healthRoutes')(pool));

app.use('/api', tenantContext);
app.use('/api', requireActiveUser);
app.use('/api/tenant', tenantRoutes);
app.use('/api/config', tenantConfigRoutes);
app.use('/api/processes', requireModule('processos'), processRoutes);
app.use('/api/tasks', requireModule('processos'), taskRoutes);
app.use('/api/alerts', requireModule('processos'), alertRoutes);
app.use('/api/operations', requireModule('processos'), operationsRoutes);
app.use('/api/notes', requireModule('processos'), noteRoutes);
app.use('/api/commercial', requireModule('processos'), commercialRoutes);
app.use('/api/orders', requireModule('processos'), orderRoutes);
app.use('/api', requireModule('processos'), salesRoutes);
app.use('/api', requireModule('processos'), executionRoutes);
app.use('/api', requireModule('processos'), commercialDocRoutes);
app.use('/api/backoffice', requireModule('processos'), backofficeRoutes);
app.use('/api/users/management', userManagementRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/client-fields', requireModule('processos'), clientFieldRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/fines', finesRoutes);
app.use('/api/upload', uploadRoutes);
// Serve uploads estaticamente (compatibilidade) — o download controlado é via /api
app.use('/uploads', express0.static(path.join(__dirname, 'uploads')));

// Stubs de módulos desabilitados (para provar o gating retornando 403 real).
app.use('/api/financial', requireModule('financeiro'), (req, res) => res.json({ success: true, data: [] }));
app.use('/api/leads', requireModule('leads'), (req, res) => res.json({ success: true, data: [] }));

// Catch-all silencioso para outros GET do dashboard.
app.get('/api/*', (req, res) => res.json({ success: true, data: [] }));
app.use((req, res) => res.status(404).json({ success: false, error: 'Rota não encontrada (demo)' }));

const PORT = process.env.PORT || 5000;
seed()
  .then(() => app.listen(PORT, () => console.log(`\n🟢 SISV DEMO backend em http://localhost:${PORT}\n   login: gestor@sinalverde.com.br (admin) | operador1@sinalverde.com.br (operator)\n`)))
  .catch((err) => { console.error('Falha no seed SISV demo:', err); process.exit(1); });
