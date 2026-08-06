'use strict';

process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = 'test-secret';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { newDb, DataType } = require('pg-mem');

let pool;
let tasks;
let alerts;
let operations;
let notes;
let batches;
let permissions;
let requireActiveUser;

const TENANT = randomUUID();
const OTHER = randomUUID();
let adminId;
let operatorId;
let mentionedId;
let otherUserId;
let departmentId;
let serviceId;
let processId;
let otherProcessId;
let taskTypeId;

before(async () => {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });
  db.public.registerFunction({
    name: 'jsonb_build_object',
    args: [DataType.text, DataType.text, DataType.text, DataType.text, DataType.text, DataType.text],
    returns: DataType.jsonb,
    implementation: (key1, value1, key2, value2, key3, value3) => ({
      [key1]: value1,
      [key2]: value2,
      [key3]: value3,
    }),
  });
  db.public.registerFunction({
    name: 'trim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value) => String(value).trim(),
  });
  // pg-mem não registra a subtração de timestamptz; PostgreSQL oferece esse
  // operador nativamente e o Dashboard usa o intervalo para a média.
  db.public.registerOperator({
    operator: '-',
    left: DataType.timestamptz,
    right: DataType.timestamptz,
    returns: DataType.interval,
    implementation: (left, right) => ({ milliseconds: left.getTime() - right.getTime() }),
  });

  db.public.none(`
    CREATE TABLE tenants (
      id UUID PRIMARY KEY, name TEXT, slug TEXT, modules JSONB, user_limit INT
    );
    CREATE TABLE departments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT, color TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT, username TEXT, email TEXT, phone TEXT, password_hash TEXT, role TEXT,
      access_profile TEXT, module_access JSONB, backoffice_level INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE, department_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      name TEXT, cpf TEXT, cnh TEXT, email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE process_stages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT, label TEXT, color TEXT, is_final BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE process_statuses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT, label TEXT, color TEXT, is_pending BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE tenant_service_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT, label TEXT, color TEXT, active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE fines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      client_id UUID, seller_id UUID, department_id UUID,
      tenant_service_type_id UUID, fine_number TEXT, protocol_number TEXT,
      stage TEXT, status TEXT, due_date DATE, infraction_date DATE,
      last_moved_at TIMESTAMPTZ, finalized_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ, custom_data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE task_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      code TEXT, label TEXT, sort_order INT DEFAULT 0, active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE process_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      fine_id UUID NOT NULL, title TEXT NOT NULL, description TEXT,
      task_type_id UUID, priority TEXT DEFAULT 'normal', assignee_id UUID,
      department_id UUID, due_at TIMESTAMPTZ, status TEXT DEFAULT 'aberta',
      created_by UUID, completed_by UUID, completed_at TIMESTAMPTZ,
      completion_result TEXT, completion_note TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ, deleted_by UUID
    );
    CREATE TABLE internal_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      recipient_id UUID NOT NULL, type TEXT, title TEXT, message TEXT,
      entity_type TEXT, entity_id UUID, internal_link TEXT, dedupe_key TEXT,
      read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, recipient_id, dedupe_key)
    );
    CREATE TABLE saved_views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      user_id UUID NOT NULL, name TEXT, view_type TEXT DEFAULT 'processos',
      filters JSONB DEFAULT '{}'::jsonb, sort_config JSONB DEFAULT '{}'::jsonb,
      is_default BOOLEAN DEFAULT FALSE, is_favorite BOOLEAN DEFAULT FALSE,
      shared_tenant BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_id, user_id, name, view_type)
    );
    CREATE TABLE operation_requests (
      tenant_id UUID NOT NULL, request_key TEXT NOT NULL, user_id UUID,
      operation TEXT, result JSONB, created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ, PRIMARY KEY (tenant_id, request_key)
    );
    CREATE TABLE process_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      fine_id UUID NOT NULL, author_id UUID, content TEXT, edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ, deleted_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE process_note_mentions (
      note_id UUID NOT NULL, tenant_id UUID NOT NULL, user_id UUID NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (note_id, user_id)
    );
    CREATE TABLE tenant_operation_settings (
      tenant_id UUID PRIMARY KEY, stale_after_days INT DEFAULT 7,
      due_soon_days INT DEFAULT 7, aging_bands JSONB DEFAULT '[2,5,10]'::jsonb,
      department_required BOOLEAN DEFAULT FALSE, updated_by UUID,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE fine_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      fine_id UUID NOT NULL, action TEXT, field_name TEXT, old_value TEXT,
      new_value TEXT, user_id UUID, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE activity_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      user_id UUID, entity TEXT, entity_id UUID, entity_name TEXT,
      action TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE document_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, name TEXT
    );
    CREATE TABLE service_type_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      tenant_service_type_id UUID, category_id UUID, required BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE fine_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
      fine_id UUID, category_id UUID, name TEXT, original_name TEXT,
      status TEXT DEFAULT 'ativo', removed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const pg = db.adapters.createPg();
  pool = new pg.Pool();
  const dbId = require.resolve('../config/db');
  const stub = new Module(dbId);
  stub.filename = dbId;
  stub.loaded = true;
  stub.exports = pool;
  require.cache[dbId] = stub;

  tasks = require('../models/taskModels');
  alerts = require('../models/alertModels');
  operations = require('../models/operationsModels');
  notes = require('../models/noteModels');
  batches = require('../models/batchModels');
  permissions = require('../models/permissionModels');
  requireActiveUser = require('../middlewares/requireActiveUser');

  await pool.query(
    `INSERT INTO tenants (id,name,slug) VALUES
     ($1,'Sinal Verde','sinal-verde'),($2,'Outro','outro')`,
    [TENANT, OTHER]
  );
  departmentId = (await pool.query(
    `INSERT INTO departments (tenant_id,name) VALUES ($1,'Juridico') RETURNING id`,
    [TENANT]
  )).rows[0].id;
  adminId = (await pool.query(
    `INSERT INTO users (tenant_id,name,email,role,department_id)
     VALUES ($1,'Ana Gestora','ana@sv.test','admin',$2) RETURNING id`,
    [TENANT, departmentId]
  )).rows[0].id;
  operatorId = (await pool.query(
    `INSERT INTO users (tenant_id,name,email,role,department_id)
     VALUES ($1,'Bruno Operador','bruno@sv.test','operator',$2) RETURNING id`,
    [TENANT, departmentId]
  )).rows[0].id;
  mentionedId = (await pool.query(
    `INSERT INTO users (tenant_id,name,username,email,phone,role)
     VALUES ($1,'Beatriz Lima','Beatriz.Lima','beatriz@sv.test','11999999999','operator') RETURNING id`,
    [TENANT]
  )).rows[0].id;
  otherUserId = (await pool.query(
    `INSERT INTO users (tenant_id,name,email,role)
     VALUES ($1,'Outro Usuario','outro@test','operator') RETURNING id`,
    [OTHER]
  )).rows[0].id;
  const clientId = (await pool.query(
    `INSERT INTO clients (tenant_id,name,cpf,cnh,email)
     VALUES ($1,'Maria da Silva','12345678900','998877','maria@sv.test') RETURNING id`,
    [TENANT]
  )).rows[0].id;
  const otherClientId = (await pool.query(
    `INSERT INTO clients (tenant_id,name,cpf) VALUES ($1,'Cliente Externo','999') RETURNING id`,
    [OTHER]
  )).rows[0].id;
  serviceId = (await pool.query(
    `INSERT INTO tenant_service_types (tenant_id,code,label)
     VALUES ($1,'REABILITACAO','Reabilitacao de CNH') RETURNING id`,
    [TENANT]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO process_stages (tenant_id,code,label) VALUES
     ($1,'ENTRADA','Entrada'),($1,'DEFESA','Defesa')`,
    [TENANT]
  );
  await pool.query(
    `INSERT INTO process_statuses (tenant_id,code,label,is_pending) VALUES
     ($1,'PENDENTE','Pendente',TRUE),($1,'EM_ANALISE','Em analise',FALSE)`,
    [TENANT]
  );
  processId = (await pool.query(
    `INSERT INTO fines (
       tenant_id,client_id,seller_id,department_id,tenant_service_type_id,
       fine_number,protocol_number,stage,status,due_date,last_moved_at
     ) VALUES (
       $1,$2,$3,$4,$5,'SV-100','PROTO-100','ENTRADA','PENDENTE',
       CURRENT_DATE - 1,NOW() - INTERVAL '12 days'
     ) RETURNING id`,
    [TENANT, clientId, operatorId, departmentId, serviceId]
  )).rows[0].id;
  otherProcessId = (await pool.query(
    `INSERT INTO fines (tenant_id,client_id,seller_id,fine_number,stage,status)
     VALUES ($1,$2,$3,'OUT-1','ENTRADA','PENDENTE') RETURNING id`,
    [OTHER, otherClientId, otherUserId]
  )).rows[0].id;
  taskTypeId = (await tasks.createTaskType(TENANT, {
    code: 'SOLICITAR_DOCUMENTO',
    label: 'Solicitar documento',
  })).id;
});

test('pendencias: cria, valida tenant e lista atraso com relacionamento', async () => {
  const result = await tasks.createTask(TENANT, adminId, {
    fine_id: processId,
    title: 'Solicitar CNH',
    description: 'Confirmar documento atualizado',
    task_type_id: taskTypeId,
    priority: 'critica',
    assignee_id: operatorId,
    department_id: departmentId,
    due_at: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.equal(result.ok, true);

  const crossProcess = await tasks.createTask(TENANT, adminId, {
    fine_id: otherProcessId,
    title: 'Nao permitido',
  });
  assert.equal(crossProcess.ok, false);

  const crossUser = await tasks.createTask(TENANT, adminId, {
    fine_id: processId,
    title: 'Nao atribuir fora',
    assignee_id: otherUserId,
  });
  assert.equal(crossUser.ok, false);

  const overdue = await tasks.listTasks(TENANT, { overdue: true });
  assert.equal(overdue.total, 1);
  assert.equal(overdue.rows[0].client_name, 'Maria da Silva');
  assert.equal(overdue.rows[0].overdue, true);
});

test('pendencias: edita, inicia, conclui com rastreabilidade, cancela e reabre', async () => {
  const created = await tasks.createTask(TENANT, adminId, {
    fine_id: processId,
    title: 'Revisar defesa',
    priority: 'alta',
    assignee_id: operatorId,
  });
  const id = created.task.id;
  const edited = await tasks.updateTask(TENANT, id, {
    title: 'Revisar defesa administrativa',
    department_id: departmentId,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.task.title, 'Revisar defesa administrativa');

  assert.equal((await tasks.transitionTask(TENANT, id, 'em_andamento', operatorId)).ok, true);
  const missingNote = await tasks.transitionTask(TENANT, id, 'concluida', operatorId);
  assert.equal(missingNote.ok, false);
  const completed = await tasks.transitionTask(TENANT, id, 'concluida', operatorId, {
    result: 'Revisado',
    completion_note: 'Defesa pronta para protocolo',
  });
  assert.equal(completed.ok, true);
  assert.ok(completed.task.completed_at);
  assert.equal(completed.task.completed_by, operatorId);

  const reopened = await tasks.transitionTask(TENANT, id, 'aberta', adminId);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.task.completed_at, null);
  const cancelled = await tasks.transitionTask(TENANT, id, 'cancelada', operatorId);
  assert.equal(cancelled.ok, true);
  assert.equal((await tasks.transitionTask(TENANT, id, 'aberta', adminId)).ok, true);
});

test('alertas: deduplica evento, preserva link, leitura e isolamento', async () => {
  const payload = {
    tenant_id: TENANT,
    recipient_id: operatorId,
    type: 'pendencia_atribuida',
    title: 'Nova pendencia',
    message: 'Solicitar CNH',
    entity_type: 'pendencia',
    entity_id: processId,
    internal_link: `/dashboard?module=multas&tab=processos&process=${processId}`,
    dedupe_key: `task:${processId}:operator`,
  };
  const first = await alerts.createAlert(payload);
  const duplicate = await alerts.createAlert(payload);
  assert.ok(first);
  // PostgreSQL retorna zero linhas no segundo INSERT; pg-mem pode devolver a
  // linha conflitante. O contrato essencial é não persistir duplicidade.
  assert.ok(duplicate === null || duplicate.id === first.id);
  assert.equal(Number((await pool.query(
    'SELECT COUNT(*)::int AS total FROM internal_alerts WHERE tenant_id=$1 AND recipient_id=$2 AND dedupe_key=$3',
    [TENANT, operatorId, payload.dedupe_key]
  )).rows[0].total), 1);

  const inbox = await alerts.listAlerts(TENANT, operatorId, { unread: true });
  assert.equal(inbox.rows.length, 1);
  assert.match(inbox.rows[0].internal_link, new RegExp(processId));
  assert.equal((await alerts.listAlerts(OTHER, operatorId)).rows.length, 0);

  await alerts.markRead(TENANT, operatorId, first.id);
  assert.equal((await alerts.listAlerts(TENANT, operatorId, { unread: true })).rows.length, 0);
});

test('notas: texto rastreavel gera mencao e alerta interno sem HTML executavel', async () => {
  const created = await notes.createNote(TENANT, processId, adminId, {
    content: '@Beatriz revisar <script>alert(1)</script>\u0000',
  });
  assert.equal(created.ok, true);
  assert.equal(created.mentions[0].id, mentionedId);
  assert.doesNotMatch(created.note.content, /\u0000/);

  const mentionRows = await pool.query(
    'SELECT * FROM process_note_mentions WHERE tenant_id=$1 AND note_id=$2',
    [TENANT, created.note.id]
  );
  assert.equal(mentionRows.rowCount, 1);
  const inbox = await alerts.listAlerts(TENANT, mentionedId, { unread: true });
  assert.ok(inbox.rows.some((item) => item.type === 'mencao_nota'));
  assert.ok(inbox.rows.some((item) => item.internal_link.includes(String(processId))));

  const forbidden = await notes.updateNote(TENANT, created.note.id, operatorId, 'operator', {
    content: 'Tentativa',
  });
  assert.equal(forbidden.status, 403);
  const edited = await notes.updateNote(TENANT, created.note.id, adminId, 'admin', {
    content: 'Conteudo revisado',
  });
  assert.ok(edited.note.edited_at);
});

test('visualizacoes: valida JSON, isola usuario/tenant e permite compartilhar por gestor', async () => {
  const invalid = operations.validateViewPayload({
    name: 'Invalida',
    view_type: 'processos',
    filters: { sql: 'DROP TABLE fines' },
  }, 'admin');
  assert.equal(invalid.ok, false);

  const forbiddenShare = operations.validateViewPayload({
    name: 'Compartilhada',
    view_type: 'processos',
    filters: { overdue: true },
    shared_tenant: true,
  }, 'operator');
  assert.equal(forbiddenShare.status, 403);

  const created = await operations.createView(TENANT, adminId, 'admin', {
    name: 'Vencidos',
    view_type: 'processos',
    filters: { overdue: true, department_id: String(departmentId) },
    sort_config: { by: 'due_date', dir: 'asc' },
    is_default: true,
    shared_tenant: true,
  });
  assert.equal(created.ok, true);
  assert.equal((await operations.listViews(TENANT, operatorId, 'processos')).length, 1);
  assert.equal((await operations.listViews(OTHER, otherUserId, 'processos')).length, 0);

  const crossDelete = await operations.deleteView(TENANT, operatorId, created.view.id);
  assert.equal(crossDelete, undefined);
  const renamed = await operations.updateView(TENANT, adminId, 'admin', created.view.id, {
    name: 'Prazos vencidos',
  });
  assert.equal(renamed.view.name, 'Prazos vencidos');
  assert.ok(await operations.deleteView(TENANT, adminId, created.view.id));
});

test('lote avancado: transacao, historico, nota, pendencia, isolamento e idempotencia', async () => {
  const requestId = `batch-${randomUUID()}`;
  const result = await batches.advancedBatch(TENANT, adminId, {
    request_id: requestId,
    ids: [processId, otherProcessId],
    changes: {
      stage: 'DEFESA',
      status: 'EM_ANALISE',
      due_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      seller_id: mentionedId,
    },
    note: 'Atualizacao operacional em lote',
    task: {
      title: 'Comunicar alteracao ao cliente',
      priority: 'alta',
      task_type_id: taskTypeId,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.tasks_created, 1);
  assert.equal(result.notes_created, 1);

  const process = (await pool.query('SELECT * FROM fines WHERE id=$1', [processId])).rows[0];
  assert.equal(process.stage, 'DEFESA');
  assert.equal(process.status, 'EM_ANALISE');
  assert.equal(process.seller_id, mentionedId);
  const historyCount = Number((await pool.query(
    'SELECT COUNT(*)::int AS total FROM fine_logs WHERE tenant_id=$1 AND fine_id=$2',
    [TENANT, processId]
  )).rows[0].total);
  assert.ok(historyCount >= 6);

  const replay = await batches.advancedBatch(TENANT, adminId, {
    request_id: requestId,
    ids: [processId],
    changes: { stage: 'ENTRADA' },
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal((await pool.query('SELECT stage FROM fines WHERE id=$1', [processId])).rows[0].stage, 'DEFESA');
  assert.equal(Number((await pool.query(
    'SELECT COUNT(*)::int AS total FROM fine_logs WHERE tenant_id=$1 AND fine_id=$2',
    [TENANT, processId]
  )).rows[0].total), historyCount);
});

test('operacao: busca, aging, central e qualidade usam tenant e dados reais', async () => {
  const search = await operations.globalSearch(TENANT, 'Maria', { limit: 9 });
  assert.ok(search.some((item) => item.type === 'cliente' && item.title === 'Maria da Silva'));
  assert.ok(search.every((item) => item.href.startsWith('/dashboard')));
  assert.equal((await operations.globalSearch(OTHER, 'Maria')).length, 0);

  assert.equal(operations.agingLabel(1, [2, 5, 10]), 'ate_2');
  assert.equal(operations.agingLabel(11, [2, 5, 10]), 'acima_10');

  await pool.query(
    `INSERT INTO fines (
       tenant_id,client_id,seller_id,department_id,tenant_service_type_id,
       fine_number,stage,status,due_date,last_moved_at
     )
     SELECT tenant_id,client_id,$2,department_id,tenant_service_type_id,
            'SV-ATRASADO','ENTRADA','PENDENTE',CURRENT_DATE - 2,NOW() - INTERVAL '15 days'
     FROM fines WHERE id=$1`,
    [processId, operatorId]
  );
  const attention = await operations.getAttention(TENANT);
  const attentionCounts = Object.fromEntries(attention.cards.map((card) => [card.key, card.count]));
  assert.ok(Number(attentionCounts.process_overdue) >= 1);
  assert.ok(Number(attentionCounts.stale) >= 1);
  assert.ok(Array.isArray(attention.staleBySeller));
  assert.ok(attention.quality.total >= 0);

  await pool.query(
    `INSERT INTO fines (tenant_id,client_id,fine_number,stage,status)
     SELECT tenant_id,client_id,'SV-INCOMPLETO',NULL,NULL FROM fines WHERE id=$1`,
    [processId]
  );
  const quality = await operations.getQualityIssues(TENANT);
  assert.ok(quality.rows.some((item) => item.issue === 'sem_responsavel'));
  assert.ok(quality.rows.some((item) => item.issue === 'sem_etapa'));
  assert.ok(quality.rows.some((item) => item.issue === 'sem_status'));
});

test('dashboard, relatorios e auditoria: totais, periodo, produtividade e tenant', async () => {
  assert.deepEqual(
    operations.redactAuditDetails({
      safe: 'ok',
      password_hash: 'nao-expor',
      nested: { access_token: 'nao-expor', field: 'visivel' },
    }),
    { safe: 'ok', nested: { field: 'visivel' } }
  );
  await pool.query(
    `INSERT INTO activity_logs (tenant_id,user_id,entity,entity_id,entity_name,action,details)
     VALUES ($1,$2,'processo',$3,'SV-100','process_reviewed','{"safe":true}'::jsonb)`,
    [TENANT, adminId, processId]
  );
  const dashboard = await operations.getDashboardV2(TENANT, {
    date_from: new Date(Date.now() - 30 * 86400000).toISOString(),
    date_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(Number(dashboard.overview.in_progress) >= 1);
  assert.ok(Number(dashboard.overview.task_open) >= 1);
  assert.ok(Array.isArray(dashboard.operation.byStage));
  assert.ok(Object.keys(dashboard.operation.aging).length >= 1);
  assert.ok(Array.isArray(dashboard.productivity.workload));

  const byStage = await operations.reportData(TENANT, 'processos-etapa', {
    date_from: new Date(Date.now() - 30 * 86400000).toISOString(),
    date_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(byStage.ok, true);
  assert.ok(byStage.rows.some((row) => Number(row.total) >= 1));

  const taskReport = await operations.reportData(TENANT, 'pendencias', {
    date_from: new Date(Date.now() - 30 * 86400000).toISOString(),
    date_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(taskReport.ok, true);
  assert.ok(taskReport.rows.length >= 1);
  assert.equal((await operations.reportData(OTHER, 'pendencias')).rows.length, 0);
  assert.equal((await operations.reportData(TENANT, 'sql-livre')).ok, false);

  const audit = await operations.listAudit(TENANT, { limit: 100 });
  assert.ok(audit.rows.some((row) => row.action === 'advanced_batch'));
  assert.ok(audit.rows.some((row) => row.action === 'process_reviewed'));
  assert.ok(audit.rows.some((row) => row.source === 'processo'));
  assert.equal((await operations.listAudit(OTHER, { limit: 100 })).rows.length, 0);
});

test('usuarios: impede desativacao com carga e redistribui sem apagar historico', async () => {
  const blocked = await permissions.deactivateUser(mentionedId, TENANT);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);

  const done = await permissions.deactivateUser(mentionedId, TENANT, {
    redistribute_to: operatorId,
  });
  assert.equal(done.ok, true);
  assert.equal(done.user.is_active, false);
  assert.equal((await pool.query('SELECT seller_id FROM fines WHERE id=$1', [processId])).rows[0].seller_id, operatorId);
  assert.equal(Number((await pool.query(
    'SELECT COUNT(*)::int AS total FROM process_tasks WHERE tenant_id=$1 AND assignee_id=$2',
    [TENANT, operatorId]
  )).rows[0].total) > 0, true);
});

test('seguranca: middleware invalida imediatamente token de usuario desativado', async () => {
  const execute = (userId, tenantId) => new Promise((resolve) => {
    const req = { userId, tenantId, userRole: 'operator' };
    const res = {
      status(value) { this.statusCode = value; return this; },
      json(body) { resolve({ allowed: false, status: this.statusCode, body }); },
    };
    requireActiveUser(req, res, () => resolve({ allowed: true, role: req.userRole }));
  });
  const inactive = await execute(mentionedId, TENANT);
  assert.equal(inactive.allowed, false);
  assert.equal(inactive.status, 401);
  assert.equal((await execute(operatorId, TENANT)).allowed, true);
  assert.equal((await execute(otherUserId, TENANT)).allowed, false);
});

test('usuarios: exclusao logica exige inatividade, libera login e preserva registro', async () => {
  const active = await permissions.softDeleteUser(operatorId, TENANT);
  assert.equal(active.ok, false);
  assert.equal(active.status, 409);

  const removed = await permissions.softDeleteUser(mentionedId, TENANT);
  assert.equal(removed.ok, true);
  assert.equal(removed.original.username, 'Beatriz.Lima');

  const row = (await pool.query(
    'SELECT name, username, email, phone, is_active, deleted_at FROM users WHERE id=$1',
    [mentionedId]
  )).rows[0];
  assert.equal(row.name, 'Beatriz Lima');
  assert.equal(row.username, null);
  assert.equal(row.email, `deleted.${mentionedId}@login.sisv.local`);
  assert.equal(row.phone, null);
  assert.equal(row.is_active, false);
  assert.ok(row.deleted_at);
  assert.equal(await permissions.getUserById(mentionedId, TENANT), undefined);
  assert.equal(await permissions.checkUsernameExists('Beatriz.Lima', TENANT), false);
});
