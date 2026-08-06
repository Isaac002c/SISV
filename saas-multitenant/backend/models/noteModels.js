'use strict';

const pool = require('../config/db');
const alerts = require('./alertModels');

const cleanContent = (value) => String(value ?? '')
  .replace(/\u0000/g, '')
  .replace(/\r\n?/g, '\n')
  .trim()
  .slice(0, 5000);

async function listNotes(tenantId, fineId, { includeDeleted = false } = {}) {
  const { rows } = await pool.query(
    `SELECT n.id, n.fine_id, n.author_id, n.content, n.edited_at, n.deleted_at,
            n.created_at, n.updated_at, u.name AS author_name,
            COALESCE(
              json_agg(json_build_object('id', mu.id, 'name', mu.name))
                FILTER (WHERE mu.id IS NOT NULL),
              '[]'
            ) AS mentions
     FROM process_notes n
     LEFT JOIN users u ON u.id = n.author_id AND u.tenant_id = n.tenant_id
     LEFT JOIN process_note_mentions m ON m.note_id = n.id AND m.tenant_id = n.tenant_id
     LEFT JOIN users mu ON mu.id = m.user_id AND mu.tenant_id = n.tenant_id
     WHERE n.tenant_id = $1 AND n.fine_id = $2${includeDeleted ? '' : ' AND n.deleted_at IS NULL'}
     GROUP BY n.id, u.name
     ORDER BY n.created_at DESC`,
    [tenantId, fineId]
  );
  return rows;
}

async function resolveMentions(tenantId, content, explicitIds = [], client = pool) {
  const { rows } = await client.query(
    `SELECT id, name FROM users
     WHERE tenant_id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
    [tenantId]
  );
  const ids = new Set((Array.isArray(explicitIds) ? explicitIds : []).map(String));
  const lower = content.toLocaleLowerCase('pt-BR');
  for (const user of rows) {
    const name = String(user.name || '').trim().toLocaleLowerCase('pt-BR');
    const first = name.split(/\s+/)[0];
    if ((name && lower.includes(`@${name}`)) || (first && lower.includes(`@${first}`))) {
      ids.add(String(user.id));
    }
  }
  return rows.filter((user) => ids.has(String(user.id)));
}

async function createNote(tenantId, fineId, authorId, input) {
  const content = cleanContent(input.content);
  if (!content) return { ok: false, error: 'Conteudo da nota e obrigatorio.' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const process = await client.query(
      `SELECT f.id, f.fine_number, c.name AS client_name
       FROM fines f
       LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
       WHERE f.id = $1 AND f.tenant_id = $2`,
      [fineId, tenantId]
    );
    if (!process.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Processo nao encontrado.' };
    }
    const { rows } = await client.query(
      `INSERT INTO process_notes (tenant_id, fine_id, author_id, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, fineId, authorId || null, content]
    );
    const note = rows[0];
    const mentions = await resolveMentions(tenantId, content, input.mention_ids, client);
    for (const user of mentions) {
      await client.query(
        `INSERT INTO process_note_mentions (note_id, tenant_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT (note_id, user_id) DO NOTHING`,
        [note.id, tenantId, user.id]
      );
      if (String(user.id) !== String(authorId)) {
        await alerts.createAlert({
          tenant_id: tenantId,
          recipient_id: user.id,
          type: 'mencao_nota',
          title: 'Voce foi mencionado em uma nota',
          message: `${process.rows[0].fine_number || 'Processo'} - ${content.slice(0, 160)}`,
          entity_type: 'processo',
          entity_id: fineId,
          internal_link: `/dashboard?module=multas&tab=processos&process=${fineId}&section=notas`,
          dedupe_key: `note-mention:${note.id}:${user.id}`,
        }, client);
      }
    }
    await client.query(
      `UPDATE fines SET last_moved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [fineId, tenantId]
    );
    await client.query('COMMIT');
    return { ok: true, note, mentions };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function updateNote(tenantId, id, actorId, role, input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM process_notes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [id, tenantId]
    );
    const note = current.rows[0];
    if (!note) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Nota nao encontrada.' };
    }
    if (String(note.author_id) !== String(actorId) && role !== 'admin' && role !== 'manager') {
      await client.query('ROLLBACK');
      return { ok: false, status: 403, error: 'Somente o autor ou gestor pode editar esta nota.' };
    }
    const content = cleanContent(input.content);
    if (!content) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Conteudo da nota e obrigatorio.' };
    }
    const { rows } = await client.query(
      `UPDATE process_notes SET content = $1, edited_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [content, id, tenantId]
    );
    const mentions = await resolveMentions(tenantId, content, input.mention_ids, client);
    const process = await client.query(
      'SELECT fine_number FROM fines WHERE id=$1 AND tenant_id=$2',
      [note.fine_id, tenantId]
    );
    for (const user of mentions) {
      await client.query(
        `INSERT INTO process_note_mentions (note_id, tenant_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT (note_id, user_id) DO NOTHING`,
        [id, tenantId, user.id]
      );
      if (String(user.id) !== String(actorId)) {
        await alerts.createAlert({
          tenant_id: tenantId,
          recipient_id: user.id,
          type: 'mencao_nota',
          title: 'Voce foi mencionado em uma nota editada',
          message: `${process.rows[0]?.fine_number || 'Processo'} - ${content.slice(0, 160)}`,
          entity_type: 'processo',
          entity_id: note.fine_id,
          internal_link: `/dashboard?module=multas&tab=processos&process=${note.fine_id}&section=notas`,
          dedupe_key: `note-mention:${id}:${user.id}`,
        }, client);
      }
    }
    await client.query('COMMIT');
    return { ok: true, note: rows[0], previous: note, mentions };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function deleteNote(tenantId, id, actorId, role) {
  const current = await pool.query(
    'SELECT * FROM process_notes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [id, tenantId]
  );
  const note = current.rows[0];
  if (!note) return { ok: false, status: 404, error: 'Nota nao encontrada.' };
  if (String(note.author_id) !== String(actorId) && role !== 'admin' && role !== 'manager') {
    return { ok: false, status: 403, error: 'Somente o autor ou gestor pode arquivar esta nota.' };
  }
  await pool.query(
    `UPDATE process_notes SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3`,
    [actorId || null, id, tenantId]
  );
  return { ok: true, note };
}

module.exports = {
  cleanContent,
  listNotes,
  resolveMentions,
  createNote,
  updateNote,
  deleteNote,
};
