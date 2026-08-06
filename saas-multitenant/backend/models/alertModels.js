'use strict';

const pool = require('../config/db');

const safeText = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

async function createAlert({
  tenant_id,
  recipient_id,
  type,
  title,
  message,
  entity_type = null,
  entity_id = null,
  internal_link = null,
  dedupe_key = null,
}, client = pool) {
  if (!tenant_id || !recipient_id || !type || !title || !message) return null;
  const { rows } = await client.query(
    `INSERT INTO internal_alerts (
       tenant_id, recipient_id, type, title, message,
       entity_type, entity_id, internal_link, dedupe_key
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
     WHERE EXISTS (
       SELECT 1 FROM users
       WHERE id = $2 AND tenant_id = $1 AND COALESCE(is_active, TRUE) = TRUE
     )
     ON CONFLICT (tenant_id, recipient_id, dedupe_key) DO NOTHING
     RETURNING *`,
    [
      tenant_id,
      recipient_id,
      safeText(type, 60),
      safeText(title, 200),
      safeText(message, 2000),
      entity_type ? safeText(entity_type, 60) : null,
      entity_id || null,
      internal_link ? safeText(internal_link, 500) : null,
      dedupe_key ? safeText(dedupe_key, 255) : null,
    ]
  );
  return rows[0] || null;
}

async function listAlerts(tenantId, userId, filters = {}) {
  const clauses = ['tenant_id = $1', 'recipient_id = $2'];
  const params = [tenantId, userId];
  if (filters.unread === true || filters.unread === 'true' || filters.unread === '1') {
    clauses.push('read_at IS NULL');
  }
  if (filters.type) {
    params.push(safeText(filters.type, 60));
    clauses.push(`type = $${params.length}`);
  }
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 30, 1), 100);
  const offset = Math.max(Number.parseInt(filters.offset, 10) || 0, 0);
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT *, (read_at IS NULL) AS unread
     FROM internal_alerts
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(CASE WHEN read_at IS NULL THEN 1 END)::int AS unread
     FROM internal_alerts
     WHERE tenant_id = $1 AND recipient_id = $2`,
    [tenantId, userId]
  );
  return { rows, ...count.rows[0], limit, offset };
}

async function markRead(tenantId, userId, id) {
  const { rows } = await pool.query(
    `UPDATE internal_alerts
     SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND tenant_id = $2 AND recipient_id = $3
     RETURNING *`,
    [id, tenantId, userId]
  );
  return rows[0];
}

async function markAllRead(tenantId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE internal_alerts SET read_at = NOW()
     WHERE tenant_id = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [tenantId, userId]
  );
  return rowCount;
}

async function generateDeadlineAlerts(tenantId, { dueSoonDays = 7 } = {}) {
  const dueEnd = new Date(Date.now() + Math.max(1, Math.min(Number(dueSoonDays) || 7, 90)) * 86400000);
  const { rows } = await pool.query(
    `SELECT f.id, f.fine_number, f.due_date, f.seller_id, c.name AS client_name
     FROM fines f
     LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
     WHERE f.tenant_id = $1
       AND f.finalized_at IS NULL
       AND f.seller_id IS NOT NULL
       AND f.due_date IS NOT NULL
       AND f.due_date <= $2`,
    [tenantId, dueEnd.toISOString().slice(0, 10)]
  );
  let created = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const process of rows) {
    const date = new Date(process.due_date).toISOString().slice(0, 10);
    const overdue = date < today;
    const alert = await createAlert({
      tenant_id: tenantId,
      recipient_id: process.seller_id,
      type: overdue ? 'prazo_vencido' : 'prazo_proximo',
      title: overdue ? 'Processo com prazo vencido' : 'Prazo de processo proximo',
      message: `${process.fine_number || 'Processo'} - ${process.client_name || 'cliente'} (${date})`,
      entity_type: 'processo',
      entity_id: process.id,
      internal_link: `/dashboard?module=multas&tab=processos&process=${process.id}`,
      dedupe_key: `process-deadline:${process.id}:${date}:${overdue ? 'overdue' : 'soon'}`,
    });
    if (alert) created += 1;
  }
  return { examined: rows.length, created };
}

module.exports = {
  createAlert,
  listAlerts,
  markRead,
  markAllRead,
  generateDeadlineAlerts,
};
