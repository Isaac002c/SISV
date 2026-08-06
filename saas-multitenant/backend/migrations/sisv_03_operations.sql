-- =============================================================================
-- SISV 1.0 - operacao diaria, produtividade e governanca
--
-- Migration incremental e idempotente. Mantem `fines` como entidade de processo
-- e `activity_logs`/`fine_logs` como trilhas de auditoria existentes.
-- =============================================================================

-- Usuarios operacionais nao sao removidos: ficam inativos e continuam legiveis
-- no historico. O setor permite medir e redistribuir carga.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant_active ON users(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(tenant_id, department_id);

-- Configuracao operacional por tenant. aging_bands representa os limites das
-- faixas: ate 2, 3-5, 6-10 e acima de 10 dias por padrao.
CREATE TABLE IF NOT EXISTS tenant_operation_settings (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stale_after_days      INTEGER NOT NULL DEFAULT 7 CHECK (stale_after_days BETWEEN 1 AND 365),
  due_soon_days         INTEGER NOT NULL DEFAULT 7 CHECK (due_soon_days BETWEEN 1 AND 90),
  aging_bands           JSONB NOT NULL DEFAULT '[2,5,10]'::jsonb,
  department_required   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tenant_operation_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Tipos de pendencia configuraveis por tenant.
CREATE TABLE IF NOT EXISTS task_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        VARCHAR(60) NOT NULL,
  label       VARCHAR(120) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_task_types_tenant ON task_types(tenant_id, active, sort_order);

INSERT INTO task_types (tenant_id, code, label, sort_order)
SELECT t.id, v.code, v.label, v.sort_order
FROM tenants t
CROSS JOIN (VALUES
  ('CONTATO_CLIENTE', 'Contato com cliente', 1),
  ('SOLICITAR_DOCUMENTO', 'Solicitar documento', 2),
  ('ANALISAR_DOCUMENTO', 'Analisar documento', 3),
  ('ELABORAR_DEFESA', 'Elaborar defesa', 4),
  ('PROTOCOLAR', 'Protocolar', 5),
  ('ACOMPANHAR_JULGAMENTO', 'Acompanhar julgamento', 6),
  ('REVISAR_PROCESSO', 'Revisar processo', 7),
  ('ATUALIZAR_CLIENTE', 'Atualizar cliente', 8),
  ('PENDENCIA_INTERNA', 'Pendencia interna', 9),
  ('OUTRA', 'Outra', 10)
) AS v(code, label, sort_order)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Pendencias/atividades operacionais. Exclusao comum e logica.
CREATE TABLE IF NOT EXISTS process_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fine_id               UUID NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  title                 VARCHAR(200) NOT NULL,
  description           TEXT,
  task_type_id          UUID REFERENCES task_types(id) ON DELETE SET NULL,
  priority              VARCHAR(20) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('baixa','normal','alta','critica')),
  assignee_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  department_id         UUID REFERENCES departments(id) ON DELETE SET NULL,
  due_at                TIMESTAMPTZ,
  status                VARCHAR(30) NOT NULL DEFAULT 'aberta'
                        CHECK (status IN ('aberta','em_andamento','aguardando_terceiro','concluida','cancelada')),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at          TIMESTAMPTZ,
  completion_result     VARCHAR(200),
  completion_note       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,
  deleted_by            UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_process_tasks_fine ON process_tasks(tenant_id, fine_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_process_tasks_assignee ON process_tasks(tenant_id, assignee_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_process_tasks_attention ON process_tasks(tenant_id, status, priority, due_at)
  WHERE deleted_at IS NULL;

-- Alertas internos idempotentes. dedupe_key impede duplicidade do mesmo evento.
CREATE TABLE IF NOT EXISTS internal_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(60) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  message         TEXT NOT NULL,
  entity_type     VARCHAR(60),
  entity_id       UUID,
  internal_link   TEXT,
  dedupe_key      VARCHAR(255),
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, recipient_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_internal_alerts_inbox
  ON internal_alerts(tenant_id, recipient_id, read_at, created_at DESC);

-- Visualizacoes salvas: filtros sao JSON validado pela API, nunca codigo.
CREATE TABLE IF NOT EXISTS saved_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  view_type       VARCHAR(40) NOT NULL DEFAULT 'processos',
  filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  is_favorite     BOOLEAN NOT NULL DEFAULT FALSE,
  shared_tenant   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, name, view_type)
);
CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(tenant_id, user_id, view_type);

-- Chaves de idempotencia para impedir duplo envio de operacoes em lote.
CREATE TABLE IF NOT EXISTS operation_requests (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_key    VARCHAR(120) NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  operation      VARCHAR(60) NOT NULL,
  result         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, request_key)
);

-- Notas rastreaveis e mencoes. Conteudo e texto puro; a UI nao renderiza HTML.
CREATE TABLE IF NOT EXISTS process_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fine_id     UUID NOT NULL REFERENCES fines(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  edited_at   TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_process_notes_fine ON process_notes(tenant_id, fine_id, created_at DESC);

CREATE TABLE IF NOT EXISTS process_note_mentions (
  note_id      UUID NOT NULL REFERENCES process_notes(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_note_mentions_user ON process_note_mentions(tenant_id, user_id, created_at DESC);

-- Tipos de servico passam a funcionar como templates operacionais.
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS initial_stage VARCHAR(60);
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS initial_status VARCHAR(40);
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS default_due_days INTEGER;
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS initial_department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS suggested_tasks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenant_service_types ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Dados complementares simples e arquivamento controlado de finalizados.
ALTER TABLE fines ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_fines_tenant_archived ON fines(tenant_id, archived_at);

-- Indices para dashboard, central, busca e relatorios.
CREATE INDEX IF NOT EXISTS idx_fines_attention
  ON fines(tenant_id, finalized_at, due_date, last_moved_at);
CREATE INDEX IF NOT EXISTS idx_fines_workload
  ON fines(tenant_id, seller_id, department_id, finalized_at);
CREATE INDEX IF NOT EXISTS idx_fine_logs_productivity
  ON fine_logs(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_audit
  ON activity_logs(tenant_id, created_at DESC, action, entity);
