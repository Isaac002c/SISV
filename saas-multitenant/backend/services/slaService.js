'use strict';

const pool = require('../config/db');
const alerts = require('../models/alertModels');

const VALID_UNITS = new Set([
  'minutes', 'business_hours', 'business_days', 'elapsed_hours', 'elapsed_days',
]);
const PAUSE_REASONS = new Set([
  'waiting_client', 'waiting_document', 'waiting_agency',
  'waiting_third_party', 'suspended',
]);

const formatterCache = new Map();
function zonedParts(date, timezone) {
  const key = timezone;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatterCache.set(key, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: weekdays[parts.weekday],
  };
}

const timeToMinutes = (value) => {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeCalendar(calendar) {
  const hours = Array.isArray(calendar.hours) ? calendar.hours : [];
  const exceptions = new Map((Array.isArray(calendar.exceptions) ? calendar.exceptions : [])
    .map((item) => [String(item.exception_date).slice(0, 10), item]));
  return { ...calendar, hours, exceptions };
}

function workingWindowAt(date, rawCalendar) {
  const calendar = normalizeCalendar(rawCalendar);
  const parts = zonedParts(date, calendar.timezone);
  const exception = calendar.exceptions.get(parts.date);
  if (exception) {
    if (!exception.is_working_day) return null;
    return {
      start: timeToMinutes(exception.start_time),
      end: timeToMinutes(exception.end_time),
      breakStart: null,
      breakEnd: null,
      parts,
    };
  }
  const hours = calendar.hours.find((item) =>
    Number(item.weekday) === parts.weekday && item.active !== false);
  if (!hours) return null;
  return {
    start: timeToMinutes(hours.start_time),
    end: timeToMinutes(hours.end_time),
    breakStart: timeToMinutes(hours.break_start),
    breakEnd: timeToMinutes(hours.break_end),
    parts,
  };
}

function isBusinessMinute(date, calendar) {
  const window = workingWindowAt(date, calendar);
  if (!window || window.start === null || window.end === null) return false;
  const inWindow = window.parts.minute >= window.start && window.parts.minute < window.end;
  const inBreak = window.breakStart !== null && window.breakEnd !== null
    && window.parts.minute >= window.breakStart && window.parts.minute < window.breakEnd;
  return inWindow && !inBreak;
}

function addBusinessMinutes(start, minutes, calendar) {
  if (!validateTimezone(calendar.timezone)) throw new Error('Timezone de calendario invalido.');
  let remaining = Math.max(0, Math.ceil(Number(minutes) || 0));
  let cursor = new Date(start);
  cursor.setUTCSeconds(0, 0);
  const maxIterations = 60 * 24 * 366 * 5;
  let iterations = 0;
  while (remaining > 0 || !isBusinessMinute(cursor, calendar)) {
    if (isBusinessMinute(cursor, calendar) && remaining > 0) remaining -= 1;
    cursor = new Date(cursor.getTime() + 60000);
    iterations += 1;
    if (iterations > maxIterations) throw new Error('Calendario sem capacidade util nos proximos cinco anos.');
  }
  return cursor;
}

function businessMinutesBetween(start, end, calendar) {
  let cursor = new Date(start);
  const until = new Date(end);
  cursor.setUTCSeconds(0, 0);
  let minutes = 0;
  const maxIterations = 60 * 24 * 366 * 5;
  let iterations = 0;
  while (cursor < until) {
    if (isBusinessMinute(cursor, calendar)) minutes += 1;
    cursor = new Date(cursor.getTime() + 60000);
    iterations += 1;
    if (iterations > maxIterations) throw new Error('Intervalo de SLA excede cinco anos.');
  }
  return minutes;
}

function defaultBusinessDayMinutes(calendar) {
  const active = (calendar.hours || []).find((item) => item.active !== false);
  if (!active) throw new Error('Calendario nao possui jornada ativa.');
  const total = timeToMinutes(active.end_time) - timeToMinutes(active.start_time);
  const pause = active.break_start && active.break_end
    ? timeToMinutes(active.break_end) - timeToMinutes(active.break_start)
    : 0;
  return total - pause;
}

function durationSeconds(value, unit, calendar) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || !VALID_UNITS.has(unit)) {
    throw new Error('Duracao de SLA invalida.');
  }
  if (unit === 'minutes') return Math.ceil(amount * 60);
  if (unit === 'business_hours') return Math.ceil(amount * 3600);
  if (unit === 'business_days') return Math.ceil(amount * defaultBusinessDayMinutes(calendar) * 60);
  if (unit === 'elapsed_hours') return Math.ceil(amount * 3600);
  return Math.ceil(amount * 86400);
}

function calculateDueAt(start, value, unit, calendar) {
  const seconds = durationSeconds(value, unit, calendar);
  if (unit.startsWith('business_')) {
    return addBusinessMinutes(start, Math.ceil(seconds / 60), calendar);
  }
  return new Date(new Date(start).getTime() + seconds * 1000);
}

async function loadCalendar(client, tenantId, calendarId) {
  const calendar = await client.query(
    'SELECT * FROM sla_calendars WHERE id=$1 AND tenant_id=$2 AND active=TRUE',
    [calendarId, tenantId]
  );
  if (!calendar.rows[0]) return null;
  const [hours, exceptions] = await Promise.all([
    client.query(
      'SELECT * FROM sla_calendar_hours WHERE calendar_id=$1 AND tenant_id=$2 ORDER BY weekday',
      [calendarId, tenantId]
    ),
    client.query(
      'SELECT * FROM sla_calendar_exceptions WHERE calendar_id=$1 AND tenant_id=$2 ORDER BY exception_date',
      [calendarId, tenantId]
    ),
  ]);
  return { ...calendar.rows[0], hours: hours.rows, exceptions: exceptions.rows };
}

async function governanceAudit(client, tenantId, userId, eventType, entityId, fineId, summary, details = {}, outcome = 'success') {
  await client.query(
    `INSERT INTO governance_audit_events
       (tenant_id,actor_user_id,event_type,entity_type,entity_id,related_fine_id,outcome,summary,safe_details)
     VALUES($1,$2,$3,'sla',$4,$5,$6,$7,$8::jsonb)`,
    [tenantId, userId || null, eventType, entityId, fineId || null, outcome, summary, JSON.stringify(details)]
  );
}

async function listCalendars(tenantId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE((SELECT json_agg(h ORDER BY h.weekday) FROM sla_calendar_hours h
                       WHERE h.calendar_id=c.id),'[]') AS hours,
            COALESCE((SELECT json_agg(e ORDER BY e.exception_date) FROM sla_calendar_exceptions e
                       WHERE e.calendar_id=c.id),'[]') AS exceptions
       FROM sla_calendars c WHERE c.tenant_id=$1 ORDER BY c.name`,
    [tenantId]
  );
  return rows;
}

async function saveCalendar(tenantId, userId, input, id = null) {
  const name = String(input.name || '').trim().slice(0, 160);
  const timezone = String(input.timezone || 'America/Sao_Paulo').trim().slice(0, 80);
  if (!name || !validateTimezone(timezone)) return { ok: false, status: 422, error: 'Nome ou timezone invalido.' };
  const hours = Array.isArray(input.hours) ? input.hours : [];
  const weekdays = new Set();
  for (const item of hours) {
    if (weekdays.has(Number(item.weekday))) return { ok: false, status: 422, error: 'Dia da semana duplicado.' };
    weekdays.add(Number(item.weekday));
    const start = timeToMinutes(item.start_time);
    const end = timeToMinutes(item.end_time);
    if (start === null || end === null || start >= end) return { ok: false, status: 422, error: 'Jornada de calendario invalida.' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let calendar;
    if (id) {
      const updated = await client.query(
        `UPDATE sla_calendars SET name=$1,timezone=$2,active=$3,row_version=row_version+1,updated_at=NOW()
          WHERE id=$4 AND tenant_id=$5 AND row_version=$6 RETURNING *`,
        [name, timezone, input.active !== false, id, tenantId, Number(input.expected_version)]
      );
      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Calendario alterado por outro usuario.' };
      }
      calendar = updated.rows[0];
      await client.query('DELETE FROM sla_calendar_hours WHERE calendar_id=$1 AND tenant_id=$2', [id, tenantId]);
      await client.query('DELETE FROM sla_calendar_exceptions WHERE calendar_id=$1 AND tenant_id=$2', [id, tenantId]);
    } else {
      const inserted = await client.query(
        `INSERT INTO sla_calendars(tenant_id,name,timezone,active,created_by)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, name, timezone, input.active !== false, userId]
      );
      calendar = inserted.rows[0];
    }
    for (const item of hours) {
      await client.query(
        `INSERT INTO sla_calendar_hours
           (tenant_id,calendar_id,weekday,start_time,end_time,break_start,break_end,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          tenantId, calendar.id, Number(item.weekday), item.start_time, item.end_time,
          item.break_start || null, item.break_end || null, item.active !== false,
        ]
      );
    }
    for (const exception of (Array.isArray(input.exceptions) ? input.exceptions : [])) {
      await client.query(
        `INSERT INTO sla_calendar_exceptions
           (tenant_id,calendar_id,exception_date,name,is_working_day,start_time,end_time)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          tenantId, calendar.id, exception.exception_date,
          String(exception.name || 'Excecao').slice(0, 160), Boolean(exception.is_working_day),
          exception.is_working_day ? exception.start_time : null,
          exception.is_working_day ? exception.end_time : null,
        ]
      );
    }
    await governanceAudit(
      client, tenantId, userId, id ? 'sla_calendar_updated' : 'sla_calendar_created',
      calendar.id, null, id ? 'Calendario de SLA atualizado' : 'Calendario de SLA criado',
      { timezone, working_days: hours.filter((item) => item.active !== false).length }
    );
    await client.query('COMMIT');
    return { ok: true, data: await loadCalendar(pool, tenantId, calendar.id) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    if (error.code === '23505') return { ok: false, status: 409, error: 'Ja existe calendario com este nome.' };
    throw error;
  } finally {
    client.release();
  }
}

async function listRules(tenantId) {
  const { rows } = await pool.query(
    `SELECT r.*,c.name AS calendar_name,st.label AS service_type_label,
            d.name AS department_name,tt.label AS task_type_label
       FROM sla_rules r
       LEFT JOIN sla_calendars c ON c.id=r.calendar_id AND c.tenant_id=r.tenant_id
       LEFT JOIN tenant_service_types st ON st.id=r.tenant_service_type_id AND st.tenant_id=r.tenant_id
       LEFT JOIN departments d ON d.id=r.department_id AND d.tenant_id=r.tenant_id
       LEFT JOIN task_types tt ON tt.id=r.task_type_id AND tt.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 ORDER BY r.active DESC,r.name`,
    [tenantId]
  );
  return rows;
}

async function saveRule(tenantId, userId, input, id = null) {
  if (!VALID_UNITS.has(input.duration_unit) || Number(input.duration_value) <= 0) {
    return { ok: false, status: 422, error: 'Duracao ou unidade de SLA invalida.' };
  }
  if (input.duration_unit.startsWith('business_') && !input.calendar_id) {
    return { ok: false, status: 422, error: 'SLA em tempo util exige calendario.' };
  }
  const params = [
    String(input.name || '').trim().slice(0, 160),
    String(input.description || '').trim().slice(0, 5000) || null,
    input.entity_type || 'process',
    input.tenant_service_type_id || null,
    input.stage_code || null,
    input.task_type_id || null,
    input.priority || null,
    input.department_id || null,
    Number(input.duration_value),
    input.duration_unit,
    input.calendar_id || null,
    Math.max(0, Number(input.warning_minutes) || 0),
    JSON.stringify(Array.isArray(input.escalation_actions) ? input.escalation_actions : []),
    JSON.stringify(Array.isArray(input.pause_reasons) ? input.pause_reasons : [...PAUSE_REASONS]),
    input.active !== false,
  ];
  let result;
  if (id) {
    result = await pool.query(
      `UPDATE sla_rules SET name=$1,description=$2,entity_type=$3,tenant_service_type_id=$4,
              stage_code=$5,task_type_id=$6,priority=$7,department_id=$8,duration_value=$9,
              duration_unit=$10,calendar_id=$11,warning_minutes=$12,escalation_actions=$13::jsonb,
              pause_reasons=$14::jsonb,active=$15,row_version=row_version+1,updated_at=NOW()
        WHERE id=$16 AND tenant_id=$17 AND row_version=$18 RETURNING *`,
      [...params, id, tenantId, Number(input.expected_version)]
    );
    if (!result.rows[0]) return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'Regra alterada por outro usuario.' };
  } else {
    result = await pool.query(
      `INSERT INTO sla_rules
         (tenant_id,name,description,entity_type,tenant_service_type_id,stage_code,task_type_id,
          priority,department_id,duration_value,duration_unit,calendar_id,warning_minutes,
          escalation_actions,pause_reasons,active,created_by)
       VALUES($16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$17)
       RETURNING *`,
      [...params, tenantId, userId]
    );
  }
  await governanceAudit(
    pool, tenantId, userId, id ? 'sla_rule_updated' : 'sla_rule_created',
    result.rows[0].id, null, id ? 'Regra de SLA atualizada' : 'Regra de SLA criada',
    { duration_unit: input.duration_unit, duration_value: Number(input.duration_value) }
  );
  return { ok: true, data: result.rows[0] };
}

async function createEvent(client, instance, eventType, userId, reason, safeContext = {}) {
  await client.query(
    `INSERT INTO sla_instance_events
       (tenant_id,instance_id,event_type,reason,actor_user_id,safe_context)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [instance.tenant_id, instance.id, eventType, reason || null, userId || null, JSON.stringify(safeContext)]
  );
}

async function processRecipient(client, tenantId, fineId) {
  if (!fineId) return null;
  const result = await client.query(
    'SELECT seller_id FROM fines WHERE id=$1 AND tenant_id=$2',
    [fineId, tenantId]
  );
  return result.rows[0]?.seller_id || null;
}

async function notifyInstance(client, instance, type, title, message, suffix) {
  const recipient = await processRecipient(client, instance.tenant_id, instance.fine_id);
  if (!recipient) return;
  await alerts.createAlert({
    tenant_id: instance.tenant_id,
    recipient_id: recipient,
    type,
    title,
    message,
    entity_type: instance.entity_type,
    entity_id: instance.entity_id,
    internal_link: `/dashboard?module=multas&tab=processos&process=${instance.fine_id || instance.entity_id}`,
    dedupe_key: `sla:${instance.id}:${suffix}`,
  }, client);
}

async function startInstance(client, tenantId, rule, entity, userId = null, now = new Date()) {
  const calendar = rule.calendar_id ? await loadCalendar(client, tenantId, rule.calendar_id) : {
    timezone: 'UTC', hours: [], exceptions: [],
  };
  if (rule.calendar_id && !calendar) throw new Error('Calendario de SLA indisponivel.');
  const dueAt = calculateDueAt(now, rule.duration_value, rule.duration_unit, calendar);
  const totalSeconds = durationSeconds(rule.duration_value, rule.duration_unit, calendar);
  const inserted = await client.query(
    `INSERT INTO sla_instances
       (tenant_id,rule_id,entity_type,entity_id,fine_id,status,started_at,due_at,
        consumed_seconds,remaining_seconds,last_evaluated_at)
     VALUES($1,$2,$3,$4,$5,'running',$6,$7,0,$8,$6)
     ON CONFLICT (tenant_id,rule_id,entity_type,entity_id)
       WHERE status IN ('not_started','running','paused','warning')
     DO NOTHING RETURNING *`,
    [
      tenantId, rule.id, rule.entity_type, entity.id,
      rule.entity_type === 'process' ? entity.id : entity.fine_id,
      now, dueAt, totalSeconds,
    ]
  );
  const instance = inserted.rows[0];
  if (!instance) return null;
  await createEvent(client, instance, 'started', userId, null, { due_at: dueAt.toISOString() });
  await governanceAudit(client, tenantId, userId, 'sla_started', instance.id, instance.fine_id, 'SLA iniciado', { rule_id: rule.id, due_at: dueAt.toISOString() });
  await notifyInstance(client, instance, 'sla_iniciado', 'SLA iniciado', `Prazo operacional: ${dueAt.toLocaleString('pt-BR')}`, 'started');
  return instance;
}

async function startMatchingForProcess(client, tenantId, process, userId = null, now = new Date()) {
  const rules = await client.query(
    `SELECT * FROM sla_rules
      WHERE tenant_id=$1 AND active=TRUE AND entity_type='process'
        AND (tenant_service_type_id IS NULL OR tenant_service_type_id=$2)
        AND (stage_code IS NULL OR stage_code=$3)
        AND (priority IS NULL OR priority=$4)
        AND (department_id IS NULL OR department_id=$5)
      ORDER BY created_at`,
    [
      tenantId, process.tenant_service_type_id || null, process.stage,
      process.operational_priority || 'normal', process.department_id || null,
    ]
  );
  const created = [];
  for (const rule of rules.rows) {
    const instance = await startInstance(client, tenantId, rule, process, userId, now);
    if (instance) created.push(instance);
  }
  return created;
}

async function handleProcessTransition(
  client, tenantId, previousProcess, currentProcess, userId = null, now = new Date()
) {
  const active = await client.query(
    `SELECT i.* FROM sla_instances i
       JOIN sla_rules r ON r.id=i.rule_id AND r.tenant_id=i.tenant_id
      WHERE i.tenant_id=$1 AND i.fine_id=$2
        AND i.status IN ('running','warning','paused')
        AND (r.stage_code=$3 OR ($4::boolean=TRUE AND r.stage_code IS NULL))
      FOR UPDATE OF i`,
    [
      tenantId, currentProcess.id, previousProcess.stage,
      Boolean(currentProcess.finalized_at),
    ]
  );
  for (const instance of active.rows) {
    const completed = await client.query(
      `UPDATE sla_instances SET status='met',completed_at=$1,result='stage_completed',
              row_version=row_version+1,updated_at=NOW()
        WHERE id=$2 RETURNING *`,
      [now, instance.id]
    );
    await createEvent(client, completed.rows[0], 'completed', userId, 'stage_completed');
    await governanceAudit(
      client, tenantId, userId, 'sla_completed', instance.id, currentProcess.id,
      'SLA cumprido pela movimentacao de etapa', { previous_stage: previousProcess.stage }
    );
  }
  if (!currentProcess.finalized_at) {
    return startMatchingForProcess(client, tenantId, currentProcess, userId, now);
  }
  return [];
}

async function listInstances(tenantId, filters = {}) {
  const params = [tenantId];
  const clauses = ['i.tenant_id=$1'];
  if (filters.status) { params.push(filters.status); clauses.push(`i.status=$${params.length}`); }
  if (filters.fine_id) { params.push(filters.fine_id); clauses.push(`i.fine_id=$${params.length}`); }
  const { rows } = await pool.query(
    `SELECT i.*,r.name AS rule_name,r.duration_unit,r.duration_value,r.warning_minutes,
            f.fine_number,c.name AS client_name,u.name AS assignee_name,d.name AS department_name
       FROM sla_instances i
       JOIN sla_rules r ON r.id=i.rule_id AND r.tenant_id=i.tenant_id
       LEFT JOIN fines f ON f.id=i.fine_id AND f.tenant_id=i.tenant_id
       LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
       LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY i.due_at NULLS LAST,i.created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

async function pauseInstance(tenantId, instanceId, userId, input, now = new Date()) {
  const reason = String(input.reason || '').trim().slice(0, 80);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT i.*,r.duration_unit,r.calendar_id,r.pause_reasons
         FROM sla_instances i JOIN sla_rules r ON r.id=i.rule_id AND r.tenant_id=i.tenant_id
        WHERE i.id=$1 AND i.tenant_id=$2 FOR UPDATE`,
      [instanceId, tenantId]
    );
    const instance = current.rows[0];
    if (!instance) { await client.query('ROLLBACK'); return { ok: false, status: 404, error: 'SLA nao encontrado.' }; }
    if (!['running', 'warning'].includes(instance.status)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'Somente SLA em andamento pode ser pausado.' };
    }
    if (!Array.isArray(instance.pause_reasons) || !instance.pause_reasons.includes(reason)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, error: 'Motivo de pausa nao permitido pela regra.' };
    }
    if (Number(input.expected_version) !== instance.row_version) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'SLA alterado por outro usuario.' };
    }
    const anchor = instance.resumed_at || instance.started_at;
    let segmentSeconds;
    if (instance.duration_unit.startsWith('business_')) {
      const calendar = await loadCalendar(client, tenantId, instance.calendar_id);
      segmentSeconds = businessMinutesBetween(anchor, now, calendar) * 60;
    } else {
      segmentSeconds = Math.max(0, Math.floor((now - new Date(anchor)) / 1000));
    }
    const consumed = Number(instance.consumed_seconds) + segmentSeconds;
    const remaining = Math.max(0, Number(instance.remaining_seconds) - segmentSeconds);
    const updated = await client.query(
      `UPDATE sla_instances SET status='paused',paused_at=$1,pause_reason=$2,
              consumed_seconds=$3,remaining_seconds=$4,row_version=row_version+1,updated_at=NOW()
        WHERE id=$5 AND tenant_id=$6 RETURNING *`,
      [now, reason, consumed, remaining, instanceId, tenantId]
    );
    await createEvent(client, updated.rows[0], 'paused', userId, reason, { remaining_seconds: remaining });
    await governanceAudit(client, tenantId, userId, 'sla_paused', instanceId, instance.fine_id, 'SLA pausado', { reason, remaining_seconds: remaining });
    await notifyInstance(client, updated.rows[0], 'sla_pausado', 'SLA pausado', `Motivo: ${reason}`, `paused:${updated.rows[0].row_version}`);
    await client.query('COMMIT');
    return { ok: true, data: updated.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally { client.release(); }
}

async function resumeInstance(tenantId, instanceId, userId, input, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT i.*,r.duration_unit,r.calendar_id
         FROM sla_instances i JOIN sla_rules r ON r.id=i.rule_id AND r.tenant_id=i.tenant_id
        WHERE i.id=$1 AND i.tenant_id=$2 FOR UPDATE`,
      [instanceId, tenantId]
    );
    const instance = current.rows[0];
    if (!instance) { await client.query('ROLLBACK'); return { ok: false, status: 404, error: 'SLA nao encontrado.' }; }
    if (instance.status !== 'paused') {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'Somente SLA pausado pode ser retomado.' };
    }
    if (Number(input.expected_version) !== instance.row_version) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'SLA alterado por outro usuario.' };
    }
    let dueAt;
    if (instance.duration_unit.startsWith('business_')) {
      const calendar = await loadCalendar(client, tenantId, instance.calendar_id);
      dueAt = addBusinessMinutes(now, Math.ceil(Number(instance.remaining_seconds) / 60), calendar);
    } else {
      dueAt = new Date(now.getTime() + Number(instance.remaining_seconds) * 1000);
    }
    const updated = await client.query(
      `UPDATE sla_instances SET status='running',resumed_at=$1,due_at=$2,paused_at=NULL,
              pause_reason=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [now, dueAt, instanceId, tenantId]
    );
    await createEvent(client, updated.rows[0], 'resumed', userId, null, { due_at: dueAt.toISOString() });
    await governanceAudit(client, tenantId, userId, 'sla_resumed', instanceId, instance.fine_id, 'SLA retomado', { due_at: dueAt.toISOString() });
    await notifyInstance(client, updated.rows[0], 'sla_retomado', 'SLA retomado', `Novo limite: ${dueAt.toLocaleString('pt-BR')}`, `resumed:${updated.rows[0].row_version}`);
    await client.query('COMMIT');
    return { ok: true, data: updated.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally { client.release(); }
}

async function finishInstance(tenantId, instanceId, userId, result, now = new Date()) {
  const status = result === 'cancelled' ? 'cancelled' : 'met';
  const updated = await pool.query(
    `UPDATE sla_instances SET status=$1,completed_at=$2,result=$3,row_version=row_version+1,updated_at=NOW()
      WHERE id=$4 AND tenant_id=$5 AND status IN ('running','warning','paused')
      RETURNING *`,
    [status, now, result || status, instanceId, tenantId]
  );
  if (!updated.rows[0]) return { ok: false, status: 409, error: 'SLA nao esta ativo ou ja foi alterado.' };
  await createEvent(pool, updated.rows[0], status === 'met' ? 'completed' : 'cancelled', userId, result);
  await governanceAudit(pool, tenantId, userId, status === 'met' ? 'sla_completed' : 'sla_cancelled',
    instanceId, updated.rows[0].fine_id, status === 'met' ? 'SLA cumprido' : 'SLA cancelado', { result });
  await notifyInstance(pool, updated.rows[0], status === 'met' ? 'sla_cumprido' : 'sla_cancelado',
    status === 'met' ? 'SLA cumprido' : 'SLA cancelado', status === 'met' ? 'Prazo operacional cumprido.' : 'Prazo operacional cancelado.', status);
  return { ok: true, data: updated.rows[0] };
}

async function evaluateDue(tenantId = null, now = new Date()) {
  const params = [now];
  let tenantClause = '';
  if (tenantId) { params.push(tenantId); tenantClause = ` AND i.tenant_id=$${params.length}`; }
  const due = await pool.query(
    `SELECT i.*,r.warning_minutes,r.escalation_actions,r.name AS rule_name
       FROM sla_instances i JOIN sla_rules r ON r.id=i.rule_id AND r.tenant_id=i.tenant_id
      WHERE i.status IN ('running','warning')${tenantClause}
        AND i.due_at <= $1 + (r.warning_minutes * INTERVAL '1 minute')
      ORDER BY i.due_at LIMIT 500`,
    params
  );
  let warnings = 0;
  let violations = 0;
  for (const instance of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM sla_instances WHERE id=$1 AND tenant_id=$2
          AND status IN ('running','warning') FOR UPDATE`,
        [instance.id, instance.tenant_id]
      );
      if (!locked.rows[0]) { await client.query('ROLLBACK'); continue; }
      if (new Date(locked.rows[0].due_at) <= now) {
        const updated = await client.query(
          `UPDATE sla_instances SET status='violated',violated_at=$1,violation_alerted_at=$1,
                  last_evaluated_at=$1,row_version=row_version+1,updated_at=NOW()
            WHERE id=$2 RETURNING *`,
          [now, instance.id]
        );
        await createEvent(client, updated.rows[0], 'violated', null, null);
        await governanceAudit(client, instance.tenant_id, null, 'sla_violated', instance.id,
          instance.fine_id, 'SLA violado', { rule_id: instance.rule_id });
        await notifyInstance(client, updated.rows[0], 'sla_violado', 'SLA violado',
          `O prazo operacional ${instance.rule_name} foi violado.`, 'violated');
        await client.query(
          `INSERT INTO operation_attention_flags
             (tenant_id,entity_type,entity_id,reason_code,severity,title,source_type,source_id)
           VALUES($1,$2,$3,$4,'critical',$5,'sla',$6)
           ON CONFLICT (tenant_id,entity_type,entity_id,reason_code)
             WHERE resolved_at IS NULL DO NOTHING`,
          [
            instance.tenant_id, instance.entity_type, instance.entity_id,
            `sla_violated:${instance.rule_id}`, `SLA violado: ${instance.rule_name}`, instance.id,
          ]
        );
        await client.query(
          `INSERT INTO internal_queue_jobs(tenant_id,job_type,payload,priority,idempotency_key)
           VALUES($1,'automation',$2::jsonb,90,$3)
           ON CONFLICT (tenant_id,job_type,idempotency_key) DO NOTHING`,
          [
            instance.tenant_id,
            JSON.stringify({
              event_type: 'sla_violated', entity_type: instance.entity_type,
              entity_id: instance.entity_id, fine_id: instance.fine_id,
              sla_instance_id: instance.id, depth: 0, chain: [],
            }),
            `sla-violated:${instance.id}`,
          ]
        );
        violations += 1;
      } else if (locked.rows[0].status === 'running') {
        const updated = await client.query(
          `UPDATE sla_instances SET status='warning',warning_alerted_at=$1,last_evaluated_at=$1,
                  row_version=row_version+1,updated_at=NOW()
            WHERE id=$2 RETURNING *`,
          [now, instance.id]
        );
        await createEvent(client, updated.rows[0], 'warning', null, null);
        await notifyInstance(client, updated.rows[0], 'sla_proximo', 'SLA proximo do vencimento',
          `O prazo operacional ${instance.rule_name} esta proximo.`, 'warning');
        warnings += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw error;
    } finally { client.release(); }
  }
  return { examined: due.rowCount, warnings, violations };
}

async function dashboard(tenantId, filters = {}) {
  const from = filters.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = filters.to || new Date().toISOString();
  const [totals, byUser, byDepartment, byService, pauseReasons] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('running','paused','warning'))::int AS active,
              COUNT(*) FILTER (WHERE status='warning')::int AS warning,
              COUNT(*) FILTER (WHERE status='violated')::int AS violated,
              COUNT(*) FILTER (WHERE status='met')::int AS met,
              ROUND(100.0 * COUNT(*) FILTER (WHERE status='met')
                    / NULLIF(COUNT(*) FILTER (WHERE status IN ('met','violated')),0),1) AS compliance_rate,
              ROUND(AVG(EXTRACT(EPOCH FROM (completed_at-started_at))/60)
                    FILTER (WHERE status='met'),1) AS avg_response_minutes
         FROM sla_instances WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3`,
      [tenantId, from, to]
    ),
    pool.query(
      `SELECT u.id,u.name,COUNT(*) FILTER (WHERE i.status='met')::int AS met,
              COUNT(*) FILTER (WHERE i.status='violated')::int AS violated
         FROM sla_instances i JOIN fines f ON f.id=i.fine_id AND f.tenant_id=i.tenant_id
         LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
        WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3
        GROUP BY u.id,u.name ORDER BY met DESC LIMIT 20`,
      [tenantId, from, to]
    ),
    pool.query(
      `SELECT d.id,d.name,COUNT(*) FILTER (WHERE i.status='met')::int AS met,
              COUNT(*) FILTER (WHERE i.status='violated')::int AS violated
         FROM sla_instances i JOIN fines f ON f.id=i.fine_id AND f.tenant_id=i.tenant_id
         LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
        WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3
        GROUP BY d.id,d.name ORDER BY met DESC LIMIT 20`,
      [tenantId, from, to]
    ),
    pool.query(
      `SELECT st.id,st.label,COUNT(*) FILTER (WHERE i.status='met')::int AS met,
              COUNT(*) FILTER (WHERE i.status='violated')::int AS violated
         FROM sla_instances i JOIN fines f ON f.id=i.fine_id AND f.tenant_id=i.tenant_id
         LEFT JOIN tenant_service_types st ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id
        WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3
        GROUP BY st.id,st.label ORDER BY met DESC LIMIT 20`,
      [tenantId, from, to]
    ),
    pool.query(
      `SELECT reason,COUNT(*)::int AS count FROM sla_instance_events
        WHERE tenant_id=$1 AND event_type='paused' AND occurred_at BETWEEN $2 AND $3
        GROUP BY reason ORDER BY count DESC LIMIT 10`,
      [tenantId, from, to]
    ),
  ]);
  return {
    period: { from, to },
    totals: totals.rows[0],
    by_user: byUser.rows,
    by_department: byDepartment.rows,
    by_service_type: byService.rows,
    pause_reasons: pauseReasons.rows,
  };
}

module.exports = {
  validateTimezone,
  zonedParts,
  isBusinessMinute,
  addBusinessMinutes,
  businessMinutesBetween,
  defaultBusinessDayMinutes,
  durationSeconds,
  calculateDueAt,
  loadCalendar,
  listCalendars,
  saveCalendar,
  listRules,
  saveRule,
  startInstance,
  startMatchingForProcess,
  handleProcessTransition,
  listInstances,
  pauseInstance,
  resumeInstance,
  finishInstance,
  evaluateDue,
  dashboard,
};
