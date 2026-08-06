'use strict';

const pool = require('../config/db');
const taskModel = require('./taskModels');

const text = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

async function catalogValue(client, tenantId, table, column, value, message) {
  if (!value) return null;
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE tenant_id = $1 AND ${column} = $2 AND COALESCE(active, TRUE) = TRUE`,
    [tenantId, value]
  );
  if (!rows[0]) throw new Error(message);
  return rows[0];
}

async function advancedBatch(tenantId, userId, input) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (!ids.length) return { ok: false, error: 'Selecione ao menos um processo.' };
  if (ids.length > 200) return { ok: false, error: 'Limite de 200 processos por lote.' };
  const requestKey = text(input.request_id, 120);
  if (!requestKey || !/^[A-Za-z0-9._:-]{8,120}$/.test(requestKey)) {
    return { ok: false, error: 'Chave de idempotencia invalida.' };
  }
  const changes = input.changes && typeof input.changes === 'object' ? input.changes : {};
  const note = text(input.note, 5000);
  const task = input.task && typeof input.task === 'object' ? input.task : null;
  const archive = input.archive === true;
  const hasFieldChange = ['seller_id', 'department_id', 'stage', 'status', 'due_date']
    .some((key) => has(changes, key));
  if (!hasFieldChange && !note && !task && !archive) {
    return { ok: false, error: 'Informe ao menos uma acao para o lote.' };
  }

  const client = await pool.connect();
  try {
    const previous = await client.query(
      'SELECT result, completed_at FROM operation_requests WHERE tenant_id=$1 AND request_key=$2',
      [tenantId, requestKey]
    );
    if (previous.rows[0]?.completed_at) {
      return { ok: true, replayed: true, ...previous.rows[0].result };
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO operation_requests (tenant_id,request_key,user_id,operation)
       VALUES ($1,$2,$3,'advanced_batch')
       ON CONFLICT (tenant_id,request_key) DO NOTHING`,
      [tenantId, requestKey, userId || null]
    );

    let seller = null;
    let department = null;
    if (has(changes, 'seller_id') && changes.seller_id) {
      const userResult = await client.query(
        `SELECT * FROM users
         WHERE tenant_id=$1 AND id=$2 AND COALESCE(is_active, TRUE)=TRUE`,
        [tenantId, changes.seller_id]
      );
      seller = userResult.rows[0];
      if (!seller) throw new Error('Responsavel invalido ou inativo.');
    }
    if (has(changes, 'department_id') && changes.department_id) {
      department = await catalogValue(client, tenantId, 'departments', 'id', changes.department_id, 'Setor invalido.');
    }
    if (has(changes, 'stage') && changes.stage) {
      await catalogValue(client, tenantId, 'process_stages', 'code', changes.stage, 'Etapa invalida.');
    }
    if (has(changes, 'status') && changes.status) {
      await catalogValue(client, tenantId, 'process_statuses', 'code', changes.status, 'Status invalido.');
    }
    if (task) {
      if (!text(task.title, 200)) throw new Error('Titulo da pendencia em lote e obrigatorio.');
      const referenceError = await taskModel.validateReferences(tenantId, task, client);
      if (referenceError) throw new Error(referenceError);
    }

    const detail = [];
    const skipped = [];
    let updated = 0;
    let tasksCreated = 0;
    let notesCreated = 0;

    for (const id of ids) {
      const currentResult = await client.query(
        `SELECT f.*, u.name AS seller_name, d.name AS department_name
         FROM fines f
         LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
         LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
         WHERE f.id=$1 AND f.tenant_id=$2 FOR UPDATE`,
        [id, tenantId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        skipped.push({ id, reason: 'nao_encontrado' });
        continue;
      }
      const assignments = [];
      const values = [];
      const logs = [];
      let param = 1;
      const change = (field, value, oldValue, action, oldLabel = oldValue, newLabel = value) => {
        const oldComparable = oldValue === null || oldValue === undefined ? '' : String(oldValue);
        const newComparable = value === null || value === undefined ? '' : String(value);
        if (oldComparable === newComparable) return;
        assignments.push(`${field}=$${param}`);
        values.push(value);
        param += 1;
        logs.push({ action, field, old: oldLabel ?? null, next: newLabel ?? null });
      };

      if (has(changes, 'seller_id')) {
        change('seller_id', changes.seller_id || null, current.seller_id, 'seller_changed', current.seller_name, seller?.name || null);
      }
      if (has(changes, 'department_id')) {
        change('department_id', changes.department_id || null, current.department_id, 'department_changed', current.department_name, department?.name || null);
      }
      if (has(changes, 'stage')) {
        change('stage', changes.stage || null, current.stage, 'stage_changed');
      }
      if (has(changes, 'status')) {
        change('status', changes.status || null, current.status, 'status_changed');
      }
      if (has(changes, 'due_date')) {
        const nextDue = changes.due_date || null;
        const oldDue = current.due_date ? new Date(current.due_date).toISOString().slice(0, 10) : null;
        change('due_date', nextDue, oldDue, 'due_date_changed');
      }
      if (archive) {
        if (current.finalized_at && !current.archived_at) {
          assignments.push(`archived_at=NOW()`);
          logs.push({ action: 'process_archived', field: 'archived_at', old: null, next: 'arquivado' });
        } else if (!current.finalized_at) {
          skipped.push({ id, reason: 'nao_finalizado_para_arquivar' });
        }
      }

      if (assignments.length) {
        assignments.push('last_moved_at=NOW()', 'updated_at=NOW()');
        values.push(id, tenantId);
        await client.query(
          `UPDATE fines SET ${assignments.join(',')}
           WHERE id=$${param} AND tenant_id=$${param + 1}`,
          values
        );
      }
      for (const log of logs) {
        await client.query(
          `INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,old_value,new_value,user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, id, log.action, log.field, log.old, log.next, userId || null]
        );
      }

      if (note) {
        const inserted = await client.query(
          `INSERT INTO process_notes (tenant_id,fine_id,author_id,content)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, id, userId || null, note]
        );
        await client.query(
          `INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id)
           VALUES ($1,$2,'note_created','nota',$3,$4)`,
          [tenantId, id, note, userId || null]
        );
        if (inserted.rows[0]) notesCreated += 1;
      }

      if (task) {
        const taskResult = await taskModel.createTask(tenantId, userId, {
          ...task,
          fine_id: id,
          assignee_id: has(task, 'assignee_id') ? task.assignee_id : (has(changes, 'seller_id') ? changes.seller_id : current.seller_id),
          department_id: has(task, 'department_id') ? task.department_id : (has(changes, 'department_id') ? changes.department_id : current.department_id),
        }, client);
        if (!taskResult.ok) throw new Error(taskResult.error);
        await client.query(
          `INSERT INTO fine_logs (tenant_id,fine_id,action,field_name,new_value,user_id)
           VALUES ($1,$2,'task_created','pendencia',$3,$4)`,
          [tenantId, id, taskResult.task.title, userId || null]
        );
        tasksCreated += 1;
      }

      const touched = assignments.length > 0 || Boolean(note) || Boolean(task);
      if (touched) updated += 1;
      else if (!skipped.some((item) => item.id === id)) skipped.push({ id, reason: 'sem_alteracao' });
      detail.push({
        id,
        changes: logs.map((log) => log.action),
        note: Boolean(note),
        task: Boolean(task),
        assignee_id: logs.some((log) => log.action === 'seller_changed') ? (changes.seller_id || null) : undefined,
      });
    }

    const result = { updated, ignored: skipped.length, skipped, tasks_created: tasksCreated, notes_created: notesCreated, detail };
    await client.query(
      `UPDATE operation_requests SET result=$1::jsonb, completed_at=NOW()
       WHERE tenant_id=$2 AND request_key=$3`,
      [JSON.stringify(result), tenantId, requestKey]
    );
    await client.query(
      `INSERT INTO activity_logs (tenant_id,user_id,entity,action,details)
       VALUES ($1,$2,'processo','advanced_batch',$3::jsonb)`,
      [tenantId, userId || null, JSON.stringify({ request_id: requestKey, ids_count: ids.length, ...result })]
    );
    await client.query('COMMIT');
    return { ok: true, replayed: false, ...result };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    return { ok: false, error: error.message };
  } finally {
    client.release();
  }
}

module.exports = { advancedBatch };
