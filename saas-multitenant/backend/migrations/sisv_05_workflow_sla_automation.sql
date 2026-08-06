-- =============================================================================
-- SISV 1.1 - operacao governada: workflows, SLA e automacoes internas
--
-- Migration incremental, tenant-scoped, nao destrutiva e idempotente.
-- Aplicar depois de sisv_04_telun_identity.sql.
-- Rollback: sisv_05_workflow_sla_automation_rollback.sql
--
-- Decisoes:
--   * process_stages continua sendo o unico catalogo de etapas.
--   * regras persistem somente tipos/operadores controlados; nunca codigo/SQL.
--   * a fila e baseada em PostgreSQL e preparada para FOR UPDATE SKIP LOCKED.
--   * versoes publicadas sao protegidas tambem por triggers no banco.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Fluxos versionados -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_flows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL,
  source_flow_id         UUID REFERENCES workflow_flows(id) ON DELETE SET NULL,
  name                   VARCHAR(160) NOT NULL,
  description            TEXT,
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','published','disabled','replaced')),
  initial_stage_code     VARCHAR(60) NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  published_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at           TIMESTAMPTZ,
  disabled_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_flows_tenant
  ON workflow_flows(tenant_id, status, tenant_service_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_flow_version
  ON workflow_flows(tenant_id, tenant_service_type_id, LOWER(name), version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_published_service
  ON workflow_flows(tenant_id, tenant_service_type_id)
  WHERE status = 'published' AND tenant_service_type_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_flow_stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id     UUID NOT NULL REFERENCES workflow_flows(id) ON DELETE CASCADE,
  stage_code  VARCHAR(60) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_initial  BOOLEAN NOT NULL DEFAULT FALSE,
  is_final    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, stage_code)
);
CREATE INDEX IF NOT EXISTS idx_workflow_flow_stages_tenant
  ON workflow_flow_stages(tenant_id, flow_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_single_initial
  ON workflow_flow_stages(flow_id) WHERE is_initial = TRUE;

CREATE TABLE IF NOT EXISTS workflow_transitions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flow_id                UUID NOT NULL REFERENCES workflow_flows(id) ON DELETE CASCADE,
  name                   VARCHAR(160) NOT NULL,
  from_stage_code        VARCHAR(60) NOT NULL,
  to_stage_code          VARCHAR(60) NOT NULL,
  target_status_code     VARCHAR(60),
  justification_required BOOLEAN NOT NULL DEFAULT FALSE,
  assignee_required      BOOLEAN NOT NULL DEFAULT FALSE,
  due_date_required      BOOLEAN NOT NULL DEFAULT FALSE,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_stage_code <> to_stage_code)
);
CREATE INDEX IF NOT EXISTS idx_workflow_transitions_lookup
  ON workflow_transitions(tenant_id, flow_id, from_stage_code, active, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_transition_path
  ON workflow_transitions(flow_id, from_stage_code, to_stage_code, COALESCE(target_status_code, ''));

CREATE TABLE IF NOT EXISTS workflow_transition_roles (
  transition_id UUID NOT NULL REFERENCES workflow_transitions(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role          VARCHAR(30) NOT NULL CHECK (role IN ('admin','manager','operator','seller','viewer')),
  PRIMARY KEY (transition_id, role)
);
CREATE INDEX IF NOT EXISTS idx_workflow_transition_roles_tenant
  ON workflow_transition_roles(tenant_id, role);

CREATE TABLE IF NOT EXISTS workflow_transition_departments (
  transition_id UUID NOT NULL REFERENCES workflow_transitions(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (transition_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_transition_departments_tenant
  ON workflow_transition_departments(tenant_id, department_id);

CREATE TABLE IF NOT EXISTS workflow_transition_requirements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transition_id        UUID NOT NULL REFERENCES workflow_transitions(id) ON DELETE CASCADE,
  requirement_type     VARCHAR(40) NOT NULL CHECK (requirement_type IN (
                         'standard_field','custom_field','document_category',
                         'approved_document','tasks_completed','no_blocking_tasks',
                         'assignee','department','due_date','permission'
                       )),
  field_key            VARCHAR(120),
  category_id          UUID REFERENCES document_categories(id) ON DELETE CASCADE,
  permission_key       VARCHAR(120),
  label                VARCHAR(180) NOT NULL,
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (requirement_type IN ('document_category','approved_document') AND category_id IS NOT NULL)
    OR (requirement_type IN ('standard_field','custom_field') AND field_key IS NOT NULL)
    OR (requirement_type = 'permission' AND permission_key IS NOT NULL)
    OR requirement_type IN ('tasks_completed','no_blocking_tasks','assignee','department','due_date')
  )
);
CREATE INDEX IF NOT EXISTS idx_workflow_requirements_transition
  ON workflow_transition_requirements(tenant_id, transition_id, sort_order);

-- Processos vinculam-se explicitamente a uma versao. Legados permanecem NULL.
ALTER TABLE fines ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflow_flows(id) ON DELETE SET NULL;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS workflow_version INTEGER;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS workflow_assigned_at TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS operational_priority VARCHAR(20) NOT NULL DEFAULT 'normal';
CREATE INDEX IF NOT EXISTS idx_fines_workflow
  ON fines(tenant_id, workflow_id, workflow_version, stage);
CREATE INDEX IF NOT EXISTS idx_fines_row_version ON fines(tenant_id, id, row_version);

-- Concorrencia otimista tambem nas demais entidades criticas.
ALTER TABLE process_tasks ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE process_tasks ADD COLUMN IF NOT EXISTS blocks_transition BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE fine_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenant_operation_settings ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

-- Migracao explicita/confirmada entre versoes.
CREATE TABLE IF NOT EXISTS workflow_process_migrations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_flow_id       UUID REFERENCES workflow_flows(id) ON DELETE SET NULL,
  to_flow_id         UUID NOT NULL REFERENCES workflow_flows(id) ON DELETE RESTRICT,
  status             VARCHAR(20) NOT NULL DEFAULT 'preview'
                     CHECK (status IN ('preview','confirmed','completed','partial','failed','cancelled')),
  justification      TEXT NOT NULL,
  incompatibilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at       TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_migrations_tenant
  ON workflow_process_migrations(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_process_migration_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  migration_id        UUID NOT NULL REFERENCES workflow_process_migrations(id) ON DELETE CASCADE,
  fine_id             UUID NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  from_stage_code     VARCHAR(60),
  to_stage_code       VARCHAR(60),
  previous_flow_id    UUID REFERENCES workflow_flows(id) ON DELETE SET NULL,
  previous_version    INTEGER,
  expected_row_version INTEGER NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','compatible','incompatible','migrated','skipped','failed')),
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  migrated_at         TIMESTAMPTZ,
  UNIQUE (migration_id, fine_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_migration_items
  ON workflow_process_migration_items(tenant_id, migration_id, status);

-- Idempotencia transversal -----------------------------------------------------
CREATE TABLE IF NOT EXISTS operation_idempotency (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_scope  VARCHAR(80) NOT NULL,
  idempotency_key  VARCHAR(180) NOT NULL,
  request_hash     VARCHAR(128) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing','completed','failed')),
  http_status      INTEGER,
  response_body    JSONB,
  resource_id      UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  UNIQUE (tenant_id, operation_scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_operation_idempotency_expiry
  ON operation_idempotency(expires_at);

-- Calendarios e SLA ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sla_calendars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(160) NOT NULL,
  timezone    VARCHAR(80) NOT NULL DEFAULT 'America/Sao_Paulo',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_calendar_name
  ON sla_calendars(tenant_id, LOWER(name));

CREATE TABLE IF NOT EXISTS sla_calendar_hours (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  calendar_id   UUID NOT NULL REFERENCES sla_calendars(id) ON DELETE CASCADE,
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  break_start   TIME,
  break_end     TIME,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (start_time < end_time),
  CHECK ((break_start IS NULL AND break_end IS NULL)
     OR (break_start IS NOT NULL AND break_end IS NOT NULL
         AND break_start < break_end AND break_start >= start_time AND break_end <= end_time)),
  UNIQUE (calendar_id, weekday)
);
CREATE INDEX IF NOT EXISTS idx_sla_calendar_hours_tenant
  ON sla_calendar_hours(tenant_id, calendar_id, weekday);

CREATE TABLE IF NOT EXISTS sla_calendar_exceptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  calendar_id   UUID NOT NULL REFERENCES sla_calendars(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  name          VARCHAR(160) NOT NULL,
  is_working_day BOOLEAN NOT NULL DEFAULT FALSE,
  start_time    TIME,
  end_time      TIME,
  CHECK ((is_working_day = FALSE AND start_time IS NULL AND end_time IS NULL)
     OR (is_working_day = TRUE AND start_time IS NOT NULL AND end_time IS NOT NULL
         AND start_time < end_time)),
  UNIQUE (calendar_id, exception_date)
);
CREATE INDEX IF NOT EXISTS idx_sla_calendar_exceptions_lookup
  ON sla_calendar_exceptions(tenant_id, calendar_id, exception_date);

CREATE TABLE IF NOT EXISTS sla_rules (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   VARCHAR(160) NOT NULL,
  description            TEXT,
  entity_type            VARCHAR(30) NOT NULL DEFAULT 'process'
                           CHECK (entity_type IN ('process','task')),
  tenant_service_type_id UUID REFERENCES tenant_service_types(id) ON DELETE SET NULL,
  stage_code             VARCHAR(60),
  task_type_id           UUID REFERENCES task_types(id) ON DELETE SET NULL,
  priority               VARCHAR(20),
  department_id          UUID REFERENCES departments(id) ON DELETE SET NULL,
  duration_value         INTEGER NOT NULL CHECK (duration_value > 0),
  duration_unit          VARCHAR(20) NOT NULL CHECK (duration_unit IN (
                           'minutes','business_hours','business_days','elapsed_hours','elapsed_days'
                         )),
  calendar_id            UUID REFERENCES sla_calendars(id) ON DELETE RESTRICT,
  warning_minutes        INTEGER NOT NULL DEFAULT 0 CHECK (warning_minutes >= 0),
  escalation_actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  pause_reasons          JSONB NOT NULL DEFAULT '["waiting_client","waiting_document","waiting_agency","waiting_third_party","suspended"]'::jsonb,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sla_rules_match
  ON sla_rules(tenant_id, active, entity_type, tenant_service_type_id, stage_code, task_type_id);

CREATE TABLE IF NOT EXISTS sla_instances (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id               UUID NOT NULL REFERENCES sla_rules(id) ON DELETE RESTRICT,
  entity_type           VARCHAR(30) NOT NULL CHECK (entity_type IN ('process','task')),
  entity_id             UUID NOT NULL,
  fine_id               UUID REFERENCES fines(id) ON DELETE CASCADE,
  status                VARCHAR(30) NOT NULL DEFAULT 'not_started' CHECK (status IN (
                          'not_started','running','paused','warning','violated','met','cancelled'
                        )),
  started_at            TIMESTAMPTZ,
  due_at                TIMESTAMPTZ,
  consumed_seconds      BIGINT NOT NULL DEFAULT 0 CHECK (consumed_seconds >= 0),
  remaining_seconds     BIGINT,
  paused_at             TIMESTAMPTZ,
  pause_reason          VARCHAR(80),
  resumed_at            TIMESTAMPTZ,
  violated_at           TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  result                VARCHAR(80),
  warning_alerted_at    TIMESTAMPTZ,
  violation_alerted_at  TIMESTAMPTZ,
  last_evaluated_at     TIMESTAMPTZ,
  row_version           INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sla_instances_monitor
  ON sla_instances(tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_sla_instances_entity
  ON sla_instances(tenant_id, entity_type, entity_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_active_instance
  ON sla_instances(tenant_id, rule_id, entity_type, entity_id)
  WHERE status IN ('not_started','running','paused','warning');

CREATE TABLE IF NOT EXISTS sla_instance_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id    UUID NOT NULL REFERENCES sla_instances(id) ON DELETE CASCADE,
  event_type     VARCHAR(30) NOT NULL CHECK (event_type IN (
                   'started','paused','resumed','warning','violated','completed','cancelled','recalculated'
                 )),
  reason         VARCHAR(180),
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  safe_context   JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sla_events_instance
  ON sla_instance_events(tenant_id, instance_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS operation_attention_flags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type      VARCHAR(30) NOT NULL,
  entity_id        UUID NOT NULL,
  reason_code      VARCHAR(80) NOT NULL,
  severity         VARCHAR(20) NOT NULL DEFAULT 'attention'
                   CHECK (severity IN ('information','attention','critical')),
  title            VARCHAR(180) NOT NULL,
  source_type      VARCHAR(40),
  source_id        UUID,
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attention_flag_open
  ON operation_attention_flags(tenant_id, entity_type, entity_id, reason_code)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attention_flags_queue
  ON operation_attention_flags(tenant_id, severity, created_at DESC)
  WHERE resolved_at IS NULL;

-- Automacoes seguras e fila persistida -----------------------------------------
CREATE TABLE IF NOT EXISTS automation_definitions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              VARCHAR(160) NOT NULL,
  description       TEXT,
  event_type        VARCHAR(50) NOT NULL CHECK (event_type IN (
                      'process_created','process_moved','stage_changed','status_changed',
                      'assignee_changed','due_date_changed','due_date_expired',
                      'document_uploaded','document_approved','document_rejected',
                      'task_completed','process_reopened','process_finalized',
                      'aging_reached','sla_warning','sla_violated'
                    )),
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','disabled')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  max_depth         SMALLINT NOT NULL DEFAULT 5 CHECK (max_depth BETWEEN 1 AND 10),
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  last_executed_at  TIMESTAMPTZ,
  execution_count   BIGINT NOT NULL DEFAULT 0,
  failure_count     BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_definitions_event
  ON automation_definitions(tenant_id, event_type, status, sort_order);

CREATE TABLE IF NOT EXISTS automation_conditions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
  condition_type  VARCHAR(50) NOT NULL CHECK (condition_type IN (
                    'service_type','stage','status','priority','department','assignee',
                    'aging','due_date','sla_status','document_present','document_missing',
                    'document_approved','task_open','task_overdue','custom_field','data_quality'
                  )),
  operator        VARCHAR(20) NOT NULL CHECK (operator IN (
                    'equals','not_equals','in','not_in','gt','gte','lt','lte','exists','not_exists'
                  )),
  field_key       VARCHAR(120),
  value           JSONB NOT NULL DEFAULT 'null'::jsonb,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_conditions
  ON automation_conditions(tenant_id, automation_id, sort_order);

CREATE TABLE IF NOT EXISTS automation_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
  action_type     VARCHAR(50) NOT NULL CHECK (action_type IN (
                    'create_task','assign_user','assign_department','set_priority','set_due_date',
                    'create_alert','add_system_note','mark_attention','start_sla','pause_sla',
                    'complete_sla','request_confirmation'
                  )),
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_actions
  ON automation_actions(tenant_id, automation_id, sort_order);

CREATE TABLE IF NOT EXISTS automation_executions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id     UUID REFERENCES automation_definitions(id) ON DELETE SET NULL,
  event_type        VARCHAR(50) NOT NULL,
  source_entity_type VARCHAR(30),
  source_entity_id  UUID,
  root_execution_id UUID REFERENCES automation_executions(id) ON DELETE SET NULL,
  parent_execution_id UUID REFERENCES automation_executions(id) ON DELETE SET NULL,
  chain             JSONB NOT NULL DEFAULT '[]'::jsonb,
  depth             SMALLINT NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 10),
  idempotency_key   VARCHAR(180) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed','skipped','loop_blocked')),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  error_summary     VARCHAR(500),
  safe_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, automation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_automation_executions_monitor
  ON automation_executions(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_queue_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type          VARCHAR(50) NOT NULL CHECK (job_type IN (
                      'automation','alert','sla_evaluation','aging','data_quality',
                      'large_export','report','workflow_migration'
                    )),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  priority          SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  attempts          SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by         VARCHAR(120),
  locked_at         TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  error_summary     VARCHAR(500),
  idempotency_key   VARCHAR(180) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, job_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_internal_queue_claim
  ON internal_queue_jobs(status, next_attempt_at, priority DESC, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_internal_queue_monitor
  ON internal_queue_jobs(tenant_id, status, created_at DESC);

-- Auditoria governada. safe_details deve conter somente contexto redigido.
CREATE TABLE IF NOT EXISTS governance_audit_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type       VARCHAR(80) NOT NULL,
  entity_type      VARCHAR(40) NOT NULL,
  entity_id        UUID,
  related_fine_id  UUID REFERENCES fines(id) ON DELETE SET NULL,
  outcome          VARCHAR(20) NOT NULL DEFAULT 'success'
                   CHECK (outcome IN ('success','blocked','failed')),
  summary          VARCHAR(300) NOT NULL,
  safe_details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_governance_audit_tenant
  ON governance_audit_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_audit_entity
  ON governance_audit_events(tenant_id, entity_type, entity_id, created_at DESC);

-- Protecao de imutabilidade no banco -------------------------------------------
CREATE OR REPLACE FUNCTION sisv_guard_workflow_definition()
RETURNS TRIGGER AS $$
DECLARE current_status VARCHAR(20);
BEGIN
  SELECT status INTO current_status
    FROM workflow_flows
   WHERE id = COALESCE(NEW.flow_id, OLD.flow_id);
  IF current_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'WORKFLOW_IMMUTABLE: published workflow definitions cannot be changed'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sisv_guard_workflow_version()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'WORKFLOW_IMMUTABLE: published workflow versions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND (
       NEW.name IS DISTINCT FROM OLD.name
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.tenant_service_type_id IS DISTINCT FROM OLD.tenant_service_type_id
    OR NEW.initial_stage_code IS DISTINCT FROM OLD.initial_stage_code
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.source_flow_id IS DISTINCT FROM OLD.source_flow_id
  ) THEN
    RAISE EXCEPTION 'WORKFLOW_IMMUTABLE: published workflow versions cannot be edited'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_workflow_version ON workflow_flows;
CREATE TRIGGER trg_guard_workflow_version
BEFORE UPDATE OR DELETE ON workflow_flows
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_version();

DROP TRIGGER IF EXISTS trg_guard_workflow_stages ON workflow_flow_stages;
CREATE TRIGGER trg_guard_workflow_stages
BEFORE INSERT OR UPDATE OR DELETE ON workflow_flow_stages
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_definition();

DROP TRIGGER IF EXISTS trg_guard_workflow_transitions ON workflow_transitions;
CREATE TRIGGER trg_guard_workflow_transitions
BEFORE INSERT OR UPDATE OR DELETE ON workflow_transitions
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_definition();

-- Roles/departments/requirements nao possuem flow_id direto; validacao por trigger dedicada.
CREATE OR REPLACE FUNCTION sisv_guard_workflow_transition_child()
RETURNS TRIGGER AS $$
DECLARE current_status VARCHAR(20);
BEGIN
  SELECT f.status INTO current_status
    FROM workflow_flows f
    JOIN workflow_transitions t ON t.flow_id = f.id
   WHERE t.id = COALESCE(NEW.transition_id, OLD.transition_id);
  IF current_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'WORKFLOW_IMMUTABLE: published workflow definitions cannot be changed'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_workflow_roles ON workflow_transition_roles;
CREATE TRIGGER trg_guard_workflow_roles
BEFORE INSERT OR UPDATE OR DELETE ON workflow_transition_roles
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_transition_child();

DROP TRIGGER IF EXISTS trg_guard_workflow_departments ON workflow_transition_departments;
CREATE TRIGGER trg_guard_workflow_departments
BEFORE INSERT OR UPDATE OR DELETE ON workflow_transition_departments
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_transition_child();

DROP TRIGGER IF EXISTS trg_guard_workflow_requirements ON workflow_transition_requirements;
CREATE TRIGGER trg_guard_workflow_requirements
BEFORE INSERT OR UPDATE OR DELETE ON workflow_transition_requirements
FOR EACH ROW EXECUTE FUNCTION sisv_guard_workflow_transition_child();

-- FIM -------------------------------------------------------------------------
