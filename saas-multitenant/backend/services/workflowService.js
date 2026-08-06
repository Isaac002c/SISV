'use strict';

const crypto = require('node:crypto');
const pool = require('../config/db');
const { getPermissionsByRole } = require('../middlewares/checkPermission');
const slaService = require('./slaService');

const ROLES = new Set(['admin', 'manager', 'operator', 'seller', 'viewer']);
const REQUIREMENT_TYPES = new Set([
  'standard_field', 'custom_field', 'document_category', 'approved_document',
  'tasks_completed', 'no_blocking_tasks', 'assignee', 'department', 'due_date', 'permission',
]);
const STANDARD_FIELDS = new Set([
  'fine_number', 'protocol_number', 'plate', 'infraction_date', 'due_date',
  'seller_id', 'department_id', 'tenant_service_type_id', 'notes',
]);

const clean = (value, max = 500) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const asArray = (value) => Array.isArray(value) ? value : [];
const safeJson = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  return JSON.parse(JSON.stringify(value));
};
const requestHash = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value, Object.keys(value || {}).sort()))
  .digest('hex');

function validateStructure(definition) {
  const stages = asArray(definition.stages);
  const transitions = asArray(definition.transitions);
  const errors = [];
  const warnings = [];
  const stageCodes = new Set();
  const initials = stages.filter((stage) => stage.is_initial);
  const finals = stages.filter((stage) => stage.is_final);

  if (!clean(definition.name, 160)) errors.push({ code: 'NAME_REQUIRED', message: 'Informe o nome do fluxo.' });
  for (const stage of stages) {
    const code = clean(stage.stage_code, 60);
    if (!code) errors.push({ code: 'STAGE_CODE_REQUIRED', message: 'Toda etapa deve ter um codigo.' });
    if (stageCodes.has(code)) errors.push({ code: 'DUPLICATE_STAGE', message: `Etapa duplicada: ${code}.` });
    stageCodes.add(code);
  }
  if (initials.length !== 1) {
    errors.push({ code: 'SINGLE_INITIAL_REQUIRED', message: 'O fluxo deve ter exatamente uma etapa inicial.' });
  }
  if (!finals.length) errors.push({ code: 'FINAL_REQUIRED', message: 'O fluxo deve possuir ao menos uma etapa final.' });
  if (definition.initial_stage_code && initials[0]
      && clean(definition.initial_stage_code, 60) !== clean(initials[0].stage_code, 60)) {
    errors.push({ code: 'INITIAL_MISMATCH', message: 'A etapa inicial declarada nao corresponde a estrutura.' });
  }

  const paths = new Set();
  const adjacency = new Map([...stageCodes].map((code) => [code, []]));
  for (const transition of transitions) {
    const from = clean(transition.from_stage_code, 60);
    const to = clean(transition.to_stage_code, 60);
    const key = `${from}->${to}:${clean(transition.target_status_code, 60)}`;
    if (!stageCodes.has(from) || !stageCodes.has(to)) {
      errors.push({ code: 'INVALID_STAGE_REFERENCE', message: `Transicao ${clean(transition.name, 160) || key} referencia etapa invalida.` });
      continue;
    }
    if (from === to) errors.push({ code: 'SELF_TRANSITION', message: `Transicao para a propria etapa: ${from}.` });
    if (paths.has(key)) errors.push({ code: 'DUPLICATE_TRANSITION', message: `Transicao duplicada: ${from} para ${to}.` });
    paths.add(key);
    adjacency.get(from).push(to);
    for (const role of asArray(transition.roles)) {
      if (!ROLES.has(role)) errors.push({ code: 'INVALID_ROLE', message: `Perfil invalido: ${role}.` });
    }
    for (const requirement of asArray(transition.requirements)) {
      if (!REQUIREMENT_TYPES.has(requirement.requirement_type)) {
        errors.push({ code: 'INVALID_REQUIREMENT', message: `Requisito invalido: ${requirement.requirement_type}.` });
      }
      if (requirement.requirement_type === 'standard_field' && !STANDARD_FIELDS.has(requirement.field_key)) {
        errors.push({ code: 'INVALID_STANDARD_FIELD', message: `Campo padrao nao permitido: ${requirement.field_key}.` });
      }
    }
  }

  const initial = initials[0] ? clean(initials[0].stage_code, 60) : null;
  if (initial) {
    const reached = new Set([initial]);
    const queue = [initial];
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    for (const stage of stageCodes) {
      if (!reached.has(stage)) errors.push({ code: 'UNREACHABLE_STAGE', message: `Etapa inacessivel: ${stage}.` });
    }
    if (!finals.some((stage) => reached.has(clean(stage.stage_code, 60)))) {
      errors.push({ code: 'NO_FINAL_PATH', message: 'Nao existe caminho da etapa inicial ate uma etapa final.' });
    }
  }

  const finalCodes = new Set(finals.map((stage) => clean(stage.stage_code, 60)));
  for (const stage of stageCodes) {
    if (!finalCodes.has(stage) && !(adjacency.get(stage) || []).length) {
      errors.push({ code: 'DEAD_END', message: `Etapa sem saida e nao final: ${stage}.` });
    }
  }

  // Ciclos sao validos (ex.: aguardando documento -> analise), mas ficam visiveis.
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  const visit = (node) => {
    if (visiting.has(node)) { cycle = true; return; }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  if (initial) visit(initial);
  if (cycle) warnings.push({ code: 'CYCLE_DETECTED', message: 'O fluxo possui ciclo. Confirme se a retomada e intencional.' });

  return { valid: errors.length === 0, errors, warnings };
}

async function audit(client, {
  tenantId, userId, eventType, entityType, entityId = null, fineId = null,
  outcome = 'success', summary, details = {},
}) {
  await client.query(
    `INSERT INTO governance_audit_events
       (tenant_id,actor_user_id,event_type,entity_type,entity_id,related_fine_id,outcome,summary,safe_details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      tenantId, userId || null, clean(eventType, 80), clean(entityType, 40),
      entityId, fineId, outcome, clean(summary, 300), JSON.stringify(safeJson(details, {})),
    ]
  );
}

async function loadDefinition(tenantId, flowId, client = pool) {
  const flowResult = await client.query(
    `SELECT f.*, st.label AS service_type_label,
            creator.name AS created_by_name, publisher.name AS published_by_name
       FROM workflow_flows f
       LEFT JOIN tenant_service_types st
         ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id
       LEFT JOIN users creator ON creator.id=f.created_by AND creator.tenant_id=f.tenant_id
       LEFT JOIN users publisher ON publisher.id=f.published_by AND publisher.tenant_id=f.tenant_id
      WHERE f.id=$1 AND f.tenant_id=$2`,
    [flowId, tenantId]
  );
  if (!flowResult.rows[0]) return null;
  const [stages, transitions] = await Promise.all([
    client.query(
      `SELECT * FROM workflow_flow_stages
        WHERE flow_id=$1 AND tenant_id=$2 ORDER BY sort_order,stage_code`,
      [flowId, tenantId]
    ),
    client.query(
      `SELECT t.*,
              COALESCE((SELECT json_agg(r.role ORDER BY r.role)
                          FROM workflow_transition_roles r WHERE r.transition_id=t.id),'[]') AS roles,
              COALESCE((SELECT json_agg(d.department_id ORDER BY d.department_id)
                          FROM workflow_transition_departments d WHERE d.transition_id=t.id),'[]') AS departments,
              COALESCE((SELECT json_agg(row_to_json(q) ORDER BY q.sort_order)
                          FROM workflow_transition_requirements q WHERE q.transition_id=t.id),'[]') AS requirements
         FROM workflow_transitions t
        WHERE t.flow_id=$1 AND t.tenant_id=$2
        ORDER BY t.sort_order,t.name`,
      [flowId, tenantId]
    ),
  ]);
  return { ...flowResult.rows[0], stages: stages.rows, transitions: transitions.rows };
}

async function listFlows(tenantId, filters = {}) {
  const params = [tenantId];
  const clauses = ['f.tenant_id=$1'];
  if (filters.status) { params.push(filters.status); clauses.push(`f.status=$${params.length}`); }
  if (filters.tenant_service_type_id) {
    params.push(filters.tenant_service_type_id);
    clauses.push(`f.tenant_service_type_id=$${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT f.*,st.label AS service_type_label,u.name AS created_by_name,
            (SELECT COUNT(*)::int FROM workflow_transitions t WHERE t.flow_id=f.id) AS transition_count
       FROM workflow_flows f
       LEFT JOIN tenant_service_types st ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id
       LEFT JOIN users u ON u.id=f.created_by AND u.tenant_id=f.tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY f.updated_at DESC`,
    params
  );
  return rows;
}

async function validateTenantReferences(client, tenantId, input) {
  const stageCodes = [...new Set(asArray(input.stages).map((stage) => clean(stage.stage_code, 60)).filter(Boolean))];
  if (stageCodes.length) {
    const found = await client.query(
      `SELECT code FROM process_stages WHERE tenant_id=$1 AND active=TRUE AND code=ANY($2::varchar[])`,
      [tenantId, stageCodes]
    );
    const valid = new Set(found.rows.map((row) => row.code));
    const missing = stageCodes.filter((code) => !valid.has(code));
    if (missing.length) return `Etapas inexistentes ou inativas: ${missing.join(', ')}.`;
  }
  if (input.tenant_service_type_id) {
    const found = await client.query(
      'SELECT id FROM tenant_service_types WHERE id=$1 AND tenant_id=$2 AND active=TRUE',
      [input.tenant_service_type_id, tenantId]
    );
    if (!found.rows[0]) return 'Tipo de servico invalido.';
  }
  const departmentIds = [...new Set(asArray(input.transitions).flatMap((item) => asArray(item.departments)))];
  if (departmentIds.length) {
    const found = await client.query(
      `SELECT id FROM departments WHERE tenant_id=$1 AND active=TRUE AND id=ANY($2::uuid[])`,
      [tenantId, departmentIds]
    );
    if (found.rowCount !== departmentIds.length) return 'Uma ou mais transicoes referenciam setor invalido ou inativo.';
  }
  const categoryIds = [...new Set(asArray(input.transitions)
    .flatMap((item) => asArray(item.requirements))
    .map((item) => item.category_id).filter(Boolean))];
  if (categoryIds.length) {
    const found = await client.query(
      `SELECT id FROM document_categories WHERE tenant_id=$1 AND active=TRUE AND id=ANY($2::uuid[])`,
      [tenantId, categoryIds]
    );
    if (found.rowCount !== categoryIds.length) return 'Um ou mais requisitos referenciam categoria documental invalida.';
  }
  return null;
}

async function insertDefinitionChildren(client, tenantId, flowId, input) {
  for (const [index, stage] of asArray(input.stages).entries()) {
    await client.query(
      `INSERT INTO workflow_flow_stages
         (tenant_id,flow_id,stage_code,sort_order,is_initial,is_final)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        tenantId, flowId, clean(stage.stage_code, 60),
        Number.isInteger(Number(stage.sort_order)) ? Number(stage.sort_order) : index,
        Boolean(stage.is_initial), Boolean(stage.is_final),
      ]
    );
  }
  for (const [index, transition] of asArray(input.transitions).entries()) {
    const inserted = await client.query(
      `INSERT INTO workflow_transitions
         (tenant_id,flow_id,name,from_stage_code,to_stage_code,target_status_code,
          justification_required,assignee_required,due_date_required,active,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        tenantId, flowId, clean(transition.name, 160),
        clean(transition.from_stage_code, 60), clean(transition.to_stage_code, 60),
        clean(transition.target_status_code, 60) || null,
        Boolean(transition.justification_required), Boolean(transition.assignee_required),
        Boolean(transition.due_date_required), transition.active !== false,
        Number.isInteger(Number(transition.sort_order)) ? Number(transition.sort_order) : index,
      ]
    );
    const transitionId = inserted.rows[0].id;
    for (const role of [...new Set(asArray(transition.roles))]) {
      await client.query(
        `INSERT INTO workflow_transition_roles(transition_id,tenant_id,role) VALUES($1,$2,$3)`,
        [transitionId, tenantId, role]
      );
    }
    for (const departmentId of [...new Set(asArray(transition.departments))]) {
      await client.query(
        `INSERT INTO workflow_transition_departments(transition_id,tenant_id,department_id)
         VALUES($1,$2,$3)`,
        [transitionId, tenantId, departmentId]
      );
    }
    for (const [requirementIndex, requirement] of asArray(transition.requirements).entries()) {
      await client.query(
        `INSERT INTO workflow_transition_requirements
           (tenant_id,transition_id,requirement_type,field_key,category_id,permission_key,label,config,sort_order)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          tenantId, transitionId, requirement.requirement_type,
          clean(requirement.field_key, 120) || null, requirement.category_id || null,
          clean(requirement.permission_key, 120) || null,
          clean(requirement.label, 180), JSON.stringify(safeJson(requirement.config, {})),
          Number.isInteger(Number(requirement.sort_order)) ? Number(requirement.sort_order) : requirementIndex,
        ]
      );
    }
  }
}

async function createDraft(tenantId, userId, input) {
  const validation = validateStructure(input);
  // Rascunhos incompletos sao aceitos; somente tipos inseguros/referencias invalidas bloqueiam.
  const unsafe = validation.errors.find((item) =>
    ['INVALID_ROLE', 'INVALID_REQUIREMENT', 'INVALID_STANDARD_FIELD'].includes(item.code));
  if (unsafe) return { ok: false, status: 422, error: unsafe.message, validation };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const referenceError = await validateTenantReferences(client, tenantId, input);
    if (referenceError) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, error: referenceError };
    }
    const inserted = await client.query(
      `INSERT INTO workflow_flows
         (tenant_id,tenant_service_type_id,name,description,version,status,initial_stage_code,created_by)
       VALUES($1,$2,$3,$4,COALESCE($5,1),'draft',$6,$7) RETURNING *`,
      [
        tenantId, input.tenant_service_type_id || null, clean(input.name, 160),
        clean(input.description, 5000) || null, Number(input.version) || 1,
        clean(input.initial_stage_code || asArray(input.stages).find((item) => item.is_initial)?.stage_code, 60),
        userId || null,
      ]
    );
    await insertDefinitionChildren(client, tenantId, inserted.rows[0].id, input);
    await audit(client, {
      tenantId, userId, eventType: 'workflow_created', entityType: 'workflow',
      entityId: inserted.rows[0].id, summary: 'Rascunho de fluxo criado',
      details: { version: inserted.rows[0].version, service_type_id: input.tenant_service_type_id || null },
    });
    await client.query('COMMIT');
    return { ok: true, flow: await loadDefinition(tenantId, inserted.rows[0].id), validation };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    if (error.code === '23505') return { ok: false, status: 409, error: 'Ja existe esta versao do fluxo.' };
    throw error;
  } finally {
    client.release();
  }
}

async function updateDraft(tenantId, userId, flowId, expectedVersion, input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT * FROM workflow_flows WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [flowId, tenantId]
    );
    const flow = current.rows[0];
    if (!flow) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Fluxo nao encontrado.' };
    }
    if (flow.status !== 'draft') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'WORKFLOW_IMMUTABLE', error: 'Versoes publicadas nao podem ser editadas.' };
    }
    if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) !== flow.row_version) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'O rascunho foi alterado por outro usuario. Recarregue antes de salvar.', current_version: flow.row_version };
    }
    const merged = { ...flow, ...input, stages: input.stages || [], transitions: input.transitions || [] };
    const validation = validateStructure(merged);
    const unsafe = validation.errors.find((item) =>
      ['INVALID_ROLE', 'INVALID_REQUIREMENT', 'INVALID_STANDARD_FIELD'].includes(item.code));
    if (unsafe) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, error: unsafe.message, validation };
    }
    const referenceError = await validateTenantReferences(client, tenantId, merged);
    if (referenceError) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, error: referenceError };
    }

    await client.query('DELETE FROM workflow_flow_stages WHERE flow_id=$1 AND tenant_id=$2', [flowId, tenantId]);
    await client.query('DELETE FROM workflow_transitions WHERE flow_id=$1 AND tenant_id=$2', [flowId, tenantId]);
    await client.query(
      `UPDATE workflow_flows SET tenant_service_type_id=$1,name=$2,description=$3,
              initial_stage_code=$4,row_version=row_version+1,updated_at=NOW()
        WHERE id=$5 AND tenant_id=$6`,
      [
        merged.tenant_service_type_id || null, clean(merged.name, 160),
        clean(merged.description, 5000) || null,
        clean(merged.initial_stage_code || asArray(merged.stages).find((item) => item.is_initial)?.stage_code, 60),
        flowId, tenantId,
      ]
    );
    await insertDefinitionChildren(client, tenantId, flowId, merged);
    await audit(client, {
      tenantId, userId, eventType: 'workflow_draft_updated', entityType: 'workflow',
      entityId: flowId, summary: 'Rascunho de fluxo atualizado',
      details: { previous_row_version: flow.row_version },
    });
    await client.query('COMMIT');
    return { ok: true, flow: await loadDefinition(tenantId, flowId), validation };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function validateForPublish(tenantId, flowId, client = pool) {
  const definition = await loadDefinition(tenantId, flowId, client);
  if (!definition) return { valid: false, errors: [{ code: 'NOT_FOUND', message: 'Fluxo nao encontrado.' }], warnings: [] };
  const validation = validateStructure(definition);
  const statusCodes = [...new Set(definition.transitions.map((item) => item.target_status_code).filter(Boolean))];
  if (statusCodes.length) {
    const found = await client.query(
      `SELECT code FROM process_statuses WHERE tenant_id=$1 AND active=TRUE AND code=ANY($2::varchar[])`,
      [tenantId, statusCodes]
    );
    const existing = new Set(found.rows.map((row) => row.code));
    for (const code of statusCodes) {
      if (!existing.has(code)) validation.errors.push({ code: 'INVALID_STATUS_REFERENCE', message: `Status inexistente ou inativo: ${code}.` });
    }
  }
  validation.valid = validation.errors.length === 0;
  return validation;
}

async function publish(tenantId, userId, flowId, expectedVersion) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM workflow_flows WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [flowId, tenantId]
    );
    const flow = current.rows[0];
    if (!flow) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Fluxo nao encontrado.' };
    }
    if (flow.status !== 'draft') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'WORKFLOW_IMMUTABLE', error: 'Somente rascunhos podem ser publicados.' };
    }
    if (Number(expectedVersion) !== flow.row_version) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'O rascunho mudou. Recarregue antes de publicar.', current_version: flow.row_version };
    }
    const validation = await validateForPublish(tenantId, flowId, client);
    if (!validation.valid) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, code: 'INVALID_WORKFLOW', error: 'O fluxo possui inconsistencias criticas.', validation };
    }

    await client.query(
      `UPDATE workflow_flows SET status='replaced',disabled_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND tenant_service_type_id IS NOT DISTINCT FROM $2
          AND status='published' AND id<>$3`,
      [tenantId, flow.tenant_service_type_id, flowId]
    );
    await client.query(
      `UPDATE workflow_flows SET status='published',published_by=$1,published_at=NOW(),
              row_version=row_version+1,updated_at=NOW()
        WHERE id=$2 AND tenant_id=$3`,
      [userId || null, flowId, tenantId]
    );
    await audit(client, {
      tenantId, userId, eventType: 'workflow_published', entityType: 'workflow',
      entityId: flowId, summary: 'Versao de fluxo publicada',
      details: { version: flow.version, warnings: validation.warnings.map((item) => item.code) },
    });
    await client.query('COMMIT');
    return { ok: true, flow: await loadDefinition(tenantId, flowId), validation };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function cloneVersion(tenantId, userId, flowId) {
  const original = await loadDefinition(tenantId, flowId);
  if (!original) return { ok: false, status: 404, error: 'Fluxo nao encontrado.' };
  const versionResult = await pool.query(
    `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM workflow_flows
      WHERE tenant_id=$1 AND tenant_service_type_id IS NOT DISTINCT FROM $2 AND LOWER(name)=LOWER($3)`,
    [tenantId, original.tenant_service_type_id, original.name]
  );
  const input = {
    ...original,
    version: versionResult.rows[0].next_version,
    stages: original.stages.map((item) => ({
      stage_code: item.stage_code, sort_order: item.sort_order,
      is_initial: item.is_initial, is_final: item.is_final,
    })),
    transitions: original.transitions.map((item) => ({
      ...item,
      roles: item.roles,
      departments: item.departments,
      requirements: item.requirements.map((requirement) => ({
        requirement_type: requirement.requirement_type,
        field_key: requirement.field_key,
        category_id: requirement.category_id,
        permission_key: requirement.permission_key,
        label: requirement.label,
        config: requirement.config,
        sort_order: requirement.sort_order,
      })),
    })),
  };
  const result = await createDraft(tenantId, userId, input);
  if (result.ok) {
    await pool.query('UPDATE workflow_flows SET source_flow_id=$1 WHERE id=$2 AND tenant_id=$3',
      [flowId, result.flow.id, tenantId]);
    await audit(pool, {
      tenantId, userId, eventType: 'workflow_cloned', entityType: 'workflow',
      entityId: result.flow.id, summary: 'Versao de fluxo clonada',
      details: { source_flow_id: flowId, new_version: result.flow.version },
    });
    result.flow = await loadDefinition(tenantId, result.flow.id);
  }
  return result;
}

async function disable(tenantId, userId, flowId) {
  const result = await pool.query(
    `UPDATE workflow_flows SET status='disabled',disabled_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2 AND status IN ('published','draft') RETURNING *`,
    [flowId, tenantId]
  );
  if (!result.rows[0]) return { ok: false, status: 404, error: 'Fluxo ativo ou rascunho nao encontrado.' };
  await audit(pool, {
    tenantId, userId, eventType: 'workflow_disabled', entityType: 'workflow',
    entityId: flowId, summary: 'Fluxo desativado',
  });
  return { ok: true, flow: result.rows[0] };
}

async function findPublishedFlow(tenantId, serviceTypeId, client = pool) {
  if (!serviceTypeId) return null;
  const { rows } = await client.query(
    `SELECT * FROM workflow_flows
      WHERE tenant_id=$1 AND tenant_service_type_id=$2 AND status='published'
      ORDER BY version DESC LIMIT 1`,
    [tenantId, serviceTypeId]
  );
  return rows[0] || null;
}

async function evaluateRequirements(client, tenantId, process, transition, actor) {
  const requirements = await client.query(
    `SELECT * FROM workflow_transition_requirements
      WHERE tenant_id=$1 AND transition_id=$2 ORDER BY sort_order`,
    [tenantId, transition.id]
  );
  const results = [];
  const openStatuses = ['aberta', 'em_andamento', 'aguardando_terceiro'];
  for (const requirement of requirements.rows) {
    let satisfied = false;
    let status = 'missing';
    switch (requirement.requirement_type) {
      case 'standard_field':
        satisfied = STANDARD_FIELDS.has(requirement.field_key)
          && process[requirement.field_key] !== null
          && process[requirement.field_key] !== undefined
          && String(process[requirement.field_key]).trim() !== '';
        break;
      case 'custom_field':
        satisfied = process.custom_data
          && process.custom_data[requirement.field_key] !== null
          && process.custom_data[requirement.field_key] !== undefined
          && String(process.custom_data[requirement.field_key]).trim() !== '';
        break;
      case 'document_category':
      case 'approved_document': {
        const document = await client.query(
          `SELECT id,review_status FROM fine_documents
            WHERE tenant_id=$1 AND fine_id=$2 AND category_id=$3
              AND COALESCE(status,'ativo')='ativo' AND removed_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          [tenantId, process.id, requirement.category_id]
        );
        satisfied = Boolean(document.rows[0])
          && (requirement.requirement_type !== 'approved_document'
            || document.rows[0].review_status === 'approved');
        status = !document.rows[0] ? 'missing'
          : (satisfied ? 'satisfied' : document.rows[0].review_status || 'pending');
        break;
      }
      case 'tasks_completed': {
        const tasks = await client.query(
          `SELECT COUNT(*)::int AS count FROM process_tasks
            WHERE tenant_id=$1 AND fine_id=$2 AND deleted_at IS NULL AND status=ANY($3::varchar[])`,
          [tenantId, process.id, openStatuses]
        );
        satisfied = tasks.rows[0].count === 0;
        status = satisfied ? 'satisfied' : 'open';
        break;
      }
      case 'no_blocking_tasks': {
        const tasks = await client.query(
          `SELECT COUNT(*)::int AS count FROM process_tasks
            WHERE tenant_id=$1 AND fine_id=$2 AND deleted_at IS NULL
              AND blocks_transition=TRUE AND status=ANY($3::varchar[])`,
          [tenantId, process.id, openStatuses]
        );
        satisfied = tasks.rows[0].count === 0;
        status = satisfied ? 'satisfied' : 'blocking';
        break;
      }
      case 'assignee': satisfied = Boolean(process.seller_id); break;
      case 'department': satisfied = Boolean(process.department_id); break;
      case 'due_date': satisfied = Boolean(process.due_date); break;
      case 'permission':
        satisfied = actor.permissions.includes(requirement.permission_key);
        status = satisfied ? 'satisfied' : 'unauthorized';
        break;
      default: satisfied = false;
    }
    if (satisfied) status = 'satisfied';
    results.push({
      id: requirement.id,
      type: requirement.requirement_type,
      label: requirement.label,
      status,
      satisfied,
    });
  }
  if (transition.justification_required) {
    const satisfied = Boolean(clean(actor.justification, 2000));
    results.push({ type: 'justification', label: 'Justificativa', status: satisfied ? 'satisfied' : 'missing', satisfied });
  }
  if (transition.assignee_required) {
    const satisfied = Boolean(process.seller_id);
    results.push({ type: 'assignee', label: 'Responsavel definido', status: satisfied ? 'satisfied' : 'missing', satisfied });
  }
  if (transition.due_date_required) {
    const satisfied = Boolean(process.due_date);
    results.push({ type: 'due_date', label: 'Prazo definido', status: satisfied ? 'satisfied' : 'missing', satisfied });
  }
  return results;
}

async function authorizedTransitions(client, tenantId, process, actor, includeRequirements = false) {
  if (!process.workflow_id) return [];
  const result = await client.query(
    `SELECT t.*
       FROM workflow_transitions t
      WHERE t.tenant_id=$1 AND t.flow_id=$2 AND t.from_stage_code=$3 AND t.active=TRUE
        AND (
          NOT EXISTS (SELECT 1 FROM workflow_transition_roles r WHERE r.transition_id=t.id)
          OR EXISTS (SELECT 1 FROM workflow_transition_roles r WHERE r.transition_id=t.id AND r.role=$4)
        )
        AND (
          NOT EXISTS (SELECT 1 FROM workflow_transition_departments d WHERE d.transition_id=t.id)
          OR EXISTS (SELECT 1 FROM workflow_transition_departments d
                      WHERE d.transition_id=t.id AND d.department_id=$5)
        )
      ORDER BY t.sort_order,t.name`,
    [tenantId, process.workflow_id, process.stage, actor.role, actor.departmentId || null]
  );
  if (!includeRequirements) return result.rows;
  const rows = [];
  for (const transition of result.rows) {
    rows.push({
      ...transition,
      requirements: await evaluateRequirements(client, tenantId, process, transition, actor),
    });
  }
  return rows;
}

async function getProcessContext(tenantId, processId, user) {
  const processResult = await pool.query(
    `SELECT f.*,wf.name AS workflow_name,wf.status AS workflow_status
       FROM fines f
       LEFT JOIN workflow_flows wf ON wf.id=f.workflow_id AND wf.tenant_id=f.tenant_id
      WHERE f.id=$1 AND f.tenant_id=$2`,
    [processId, tenantId]
  );
  const process = processResult.rows[0];
  if (!process) return null;
  const actor = {
    role: user.role,
    departmentId: user.departmentId,
    permissions: getPermissionsByRole(user.role),
    justification: '',
  };
  return {
    workflow: process.workflow_id ? {
      id: process.workflow_id,
      name: process.workflow_name,
      version: process.workflow_version,
      status: process.workflow_status,
      assigned_at: process.workflow_assigned_at,
    } : null,
    stage: process.stage,
    row_version: process.row_version,
    legacy_mode: !process.workflow_id,
    allowed_transitions: await authorizedTransitions(pool, tenantId, process, actor, true),
  };
}

async function transitionProcess(tenantId, processId, transitionId, user, input) {
  const key = clean(input.idempotency_key, 180);
  if (!key) return { ok: false, status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Informe Idempotency-Key para movimentar o processo.' };
  const hash = requestHash({
    processId, transitionId, expected_version: input.expected_version,
    justification: clean(input.justification, 2000),
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idemInsert = await client.query(
      `INSERT INTO operation_idempotency
         (tenant_id,operation_scope,idempotency_key,request_hash,status)
       VALUES($1,'workflow_transition',$2,$3,'processing')
       ON CONFLICT (tenant_id,operation_scope,idempotency_key) DO NOTHING
       RETURNING id`,
      [tenantId, key, hash]
    );
    if (!idemInsert.rows[0]) {
      const existing = await client.query(
        `SELECT * FROM operation_idempotency
          WHERE tenant_id=$1 AND operation_scope='workflow_transition' AND idempotency_key=$2`,
        [tenantId, key]
      );
      await client.query('ROLLBACK');
      const stored = existing.rows[0];
      if (stored.request_hash !== hash) {
        return { ok: false, status: 409, code: 'IDEMPOTENCY_CONFLICT', error: 'A chave ja foi usada com outro conteudo.' };
      }
      if (stored.status === 'completed') {
        return { ok: true, status: stored.http_status || 200, replayed: true, ...stored.response_body };
      }
      return { ok: false, status: 409, code: 'REQUEST_IN_PROGRESS', error: 'A mesma operacao ainda esta em processamento.' };
    }

    const processResult = await client.query(
      `SELECT f.*,wf.name AS workflow_name,wf.status AS workflow_status
         FROM fines f
         LEFT JOIN workflow_flows wf ON wf.id=f.workflow_id AND wf.tenant_id=f.tenant_id
        WHERE f.id=$1 AND f.tenant_id=$2 FOR UPDATE OF f`,
      [processId, tenantId]
    );
    const process = processResult.rows[0];
    if (!process) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Processo nao encontrado.' };
    }
    if (!process.workflow_id) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'WORKFLOW_NOT_ASSIGNED', error: 'Processo legado sem fluxo. Associe uma versao de forma controlada.' };
    }
    if (Number(input.expected_version) !== process.row_version) {
      await client.query('ROLLBACK');
      return {
        ok: false, status: 409, code: 'VERSION_CONFLICT',
        error: 'O processo foi alterado por outro usuario. Recarregue antes de movimentar.',
        current_version: process.row_version,
      };
    }
    const actorData = await client.query(
      'SELECT department_id FROM users WHERE id=$1 AND tenant_id=$2 AND COALESCE(is_active,TRUE)=TRUE',
      [user.id, tenantId]
    );
    if (!actorData.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 403, error: 'Usuario inativo ou fora do tenant.' };
    }
    const actor = {
      role: user.role,
      departmentId: actorData.rows[0].department_id,
      permissions: getPermissionsByRole(user.role),
      justification: input.justification,
    };
    const allowed = await authorizedTransitions(client, tenantId, process, actor, false);
    const transition = allowed.find((item) => String(item.id) === String(transitionId));
    if (!transition) {
      const response = {
        code: 'TRANSITION_BLOCKED',
        message: 'Nao foi possivel realizar a movimentacao.',
        requirements: [{ type: 'authorization', label: 'Transicao inexistente ou nao autorizada', status: 'blocked' }],
        allowed_transitions: allowed.map((item) => ({ id: item.id, name: item.name, to_stage_code: item.to_stage_code })),
      };
      await audit(client, {
        tenantId, userId: user.id, eventType: 'workflow_transition_blocked',
        entityType: 'process', entityId: processId, fineId: processId, outcome: 'blocked',
        summary: 'Movimentacao bloqueada por autorizacao ou etapa',
        details: { requested_transition_id: transitionId, row_version: process.row_version },
      });
      await client.query(
        `UPDATE operation_idempotency SET status='completed',http_status=422,response_body=$1::jsonb,completed_at=NOW()
          WHERE tenant_id=$2 AND operation_scope='workflow_transition' AND idempotency_key=$3`,
        [JSON.stringify(response), tenantId, key]
      );
      await client.query('COMMIT');
      return { ok: false, status: 422, ...response };
    }

    const requirements = await evaluateRequirements(client, tenantId, process, transition, actor);
    const pending = requirements.filter((item) => !item.satisfied);
    if (pending.length) {
      const response = {
        code: 'TRANSITION_BLOCKED',
        message: 'Nao foi possivel realizar a movimentacao.',
        requirements,
        allowed_transitions: allowed.map((item) => ({ id: item.id, name: item.name, to_stage_code: item.to_stage_code })),
      };
      await audit(client, {
        tenantId, userId: user.id, eventType: 'workflow_transition_blocked',
        entityType: 'process', entityId: processId, fineId: processId, outcome: 'blocked',
        summary: 'Movimentacao bloqueada por requisitos pendentes',
        details: { transition_id: transition.id, requirement_types: pending.map((item) => item.type) },
      });
      await client.query(
        `UPDATE operation_idempotency SET status='completed',http_status=422,response_body=$1::jsonb,completed_at=NOW()
          WHERE tenant_id=$2 AND operation_scope='workflow_transition' AND idempotency_key=$3`,
        [JSON.stringify(response), tenantId, key]
      );
      await client.query('COMMIT');
      return { ok: false, status: 422, ...response };
    }

    const finalStage = await client.query(
      `SELECT is_final FROM workflow_flow_stages
        WHERE tenant_id=$1 AND flow_id=$2 AND stage_code=$3`,
      [tenantId, process.workflow_id, transition.to_stage_code]
    );
    const updated = await client.query(
      `UPDATE fines SET stage=$1,status=COALESCE($2,status),
              finalized_at=CASE WHEN $3 THEN COALESCE(finalized_at,NOW()) ELSE NULL END,
              reopened_at=CASE WHEN finalized_at IS NOT NULL AND NOT $3 THEN NOW() ELSE reopened_at END,
              last_moved_at=NOW(),updated_at=NOW(),row_version=row_version+1
        WHERE id=$4 AND tenant_id=$5 AND row_version=$6 RETURNING *`,
      [
        transition.to_stage_code, transition.target_status_code || null,
        Boolean(finalStage.rows[0]?.is_final), processId, tenantId, process.row_version,
      ]
    );
    if (!updated.rows[0]) throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' });
    await slaService.handleProcessTransition(
      client, tenantId, process, updated.rows[0], user.id, new Date()
    );
    await client.query(
      `INSERT INTO fine_logs(tenant_id,fine_id,action,field_name,old_value,new_value,user_id)
       VALUES($1,$2,'workflow_transition','stage',$3,$4,$5)`,
      [tenantId, processId, process.stage, transition.to_stage_code, user.id]
    );
    await audit(client, {
      tenantId, userId: user.id, eventType: 'workflow_transition_completed',
      entityType: 'process', entityId: processId, fineId: processId,
      summary: `Processo movimentado: ${process.stage} para ${transition.to_stage_code}`,
      details: {
        transition_id: transition.id, workflow_id: process.workflow_id,
        workflow_version: process.workflow_version,
        justification_present: Boolean(clean(input.justification, 2000)),
      },
    });
    await client.query(
      `INSERT INTO internal_queue_jobs(tenant_id,job_type,payload,priority,idempotency_key)
       VALUES($1,'automation',$2::jsonb,70,$3)
       ON CONFLICT (tenant_id,job_type,idempotency_key) DO NOTHING`,
      [
        tenantId,
        JSON.stringify({
          event_type: 'stage_changed', entity_type: 'process', entity_id: processId,
          fine_id: processId, previous_stage: process.stage,
          current_stage: transition.to_stage_code, actor_user_id: user.id, depth: 0, chain: [],
        }),
        `workflow-transition:${key}`,
      ]
    );
    const response = { data: updated.rows[0], transition: { id: transition.id, name: transition.name }, requirements };
    await client.query(
      `UPDATE operation_idempotency SET status='completed',http_status=200,response_body=$1::jsonb,
              resource_id=$2,completed_at=NOW()
        WHERE tenant_id=$3 AND operation_scope='workflow_transition' AND idempotency_key=$4`,
      [JSON.stringify(response), processId, tenantId, key]
    );
    await client.query('COMMIT');
    return { ok: true, status: 200, ...response };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    if (error.code === 'VERSION_CONFLICT') {
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Conflito de atualizacao. Recarregue o processo.' };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function previewMigration(tenantId, userId, input) {
  const ids = [...new Set(asArray(input.process_ids).map(String))].slice(0, 200);
  if (!ids.length || !input.to_flow_id || !clean(input.justification, 2000)) {
    return { ok: false, status: 400, error: 'Informe processos, fluxo de destino e justificativa.' };
  }
  const target = await loadDefinition(tenantId, input.to_flow_id);
  if (!target || target.status !== 'published') return { ok: false, status: 422, error: 'Fluxo de destino deve estar publicado.' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migration = await client.query(
      `INSERT INTO workflow_process_migrations
         (tenant_id,to_flow_id,status,justification,requested_by)
       VALUES($1,$2,'preview',$3,$4) RETURNING *`,
      [tenantId, target.id, clean(input.justification, 2000), userId]
    );
    const allowedStages = new Set(target.stages.map((stage) => stage.stage_code));
    const items = [];
    for (const id of ids) {
      const current = await client.query(
        `SELECT id,stage,workflow_id,workflow_version,row_version FROM fines
          WHERE id=$1 AND tenant_id=$2`,
        [id, tenantId]
      );
      if (!current.rows[0]) continue;
      const row = current.rows[0];
      const mapped = input.stage_mapping?.[row.stage] || row.stage;
      const issues = [];
      if (!allowedStages.has(mapped)) issues.push({ code: 'STAGE_NOT_MAPPED', stage: row.stage });
      const status = issues.length ? 'incompatible' : 'compatible';
      const inserted = await client.query(
        `INSERT INTO workflow_process_migration_items
           (tenant_id,migration_id,fine_id,from_stage_code,to_stage_code,previous_flow_id,
            previous_version,expected_row_version,status,issues)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [
          tenantId, migration.rows[0].id, id, row.stage, mapped, row.workflow_id,
          row.workflow_version, row.row_version, status, JSON.stringify(issues),
        ]
      );
      items.push(inserted.rows[0]);
    }
    await client.query(
      `UPDATE workflow_process_migrations
          SET from_flow_id=(SELECT previous_flow_id FROM workflow_process_migration_items
                             WHERE migration_id=$1 LIMIT 1),
              incompatibilities=$2::jsonb
        WHERE id=$1`,
      [migration.rows[0].id, JSON.stringify(items.filter((item) => item.status === 'incompatible').map((item) => ({ fine_id: item.fine_id, issues: item.issues })))]
    );
    await audit(client, {
      tenantId, userId, eventType: 'workflow_migration_previewed', entityType: 'workflow_migration',
      entityId: migration.rows[0].id, summary: 'Previa de migracao de processos criada',
      details: { total: items.length, compatible: items.filter((item) => item.status === 'compatible').length },
    });
    await client.query('COMMIT');
    return { ok: true, migration: { ...migration.rows[0], items } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function confirmMigration(tenantId, userId, migrationId, input = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const migrationResult = await client.query(
      `SELECT * FROM workflow_process_migrations
        WHERE id=$1 AND tenant_id=$2 AND status='preview' FOR UPDATE`,
      [migrationId, tenantId]
    );
    const migration = migrationResult.rows[0];
    if (!migration) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Previa pendente nao encontrada.' };
    }
    if (input.confirm !== true) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Confirmacao explicita obrigatoria.' };
    }
    const items = await client.query(
      `SELECT * FROM workflow_process_migration_items
        WHERE migration_id=$1 AND tenant_id=$2 ORDER BY id FOR UPDATE`,
      [migrationId, tenantId]
    );
    let migrated = 0;
    let skipped = 0;
    for (const item of items.rows) {
      if (item.status !== 'compatible') { skipped += 1; continue; }
      const updated = await client.query(
        `UPDATE fines SET workflow_id=$1,
                workflow_version=(SELECT version FROM workflow_flows WHERE id=$1 AND tenant_id=$2),
                workflow_assigned_at=NOW(),stage=$3,row_version=row_version+1,updated_at=NOW()
          WHERE id=$4 AND tenant_id=$2 AND row_version=$5 RETURNING id`,
        [migration.to_flow_id, tenantId, item.to_stage_code, item.fine_id, item.expected_row_version]
      );
      const status = updated.rows[0] ? 'migrated' : 'failed';
      await client.query(
        `UPDATE workflow_process_migration_items SET status=$1,migrated_at=CASE WHEN $1='migrated' THEN NOW() ELSE NULL END,
                issues=CASE WHEN $1='failed' THEN '[{"code":"VERSION_CONFLICT"}]'::jsonb ELSE issues END
          WHERE id=$2`,
        [status, item.id]
      );
      if (status === 'migrated') migrated += 1; else skipped += 1;
    }
    const finalStatus = migrated && skipped ? 'partial' : (migrated ? 'completed' : 'failed');
    await client.query(
      `UPDATE workflow_process_migrations SET status=$1,confirmed_by=$2,confirmed_at=NOW(),completed_at=NOW()
        WHERE id=$3 AND tenant_id=$4`,
      [finalStatus, userId, migrationId, tenantId]
    );
    await audit(client, {
      tenantId, userId, eventType: 'workflow_migration_completed', entityType: 'workflow_migration',
      entityId: migrationId, summary: 'Migracao controlada de processos concluida',
      details: { migrated, skipped, ignored_incompatibilities: Boolean(input.ignore_incompatibilities) },
    });
    await client.query('COMMIT');
    return { ok: true, data: { id: migrationId, status: finalStatus, migrated, skipped } };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  validateStructure,
  loadDefinition,
  listFlows,
  createDraft,
  updateDraft,
  validateForPublish,
  publish,
  cloneVersion,
  disable,
  findPublishedFlow,
  getProcessContext,
  transitionProcess,
  previewMigration,
  confirmMigration,
};
