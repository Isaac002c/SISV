const pool = require('../config/db');

const create = async ({ tenant_id, requested_by, target_type, target_id, target_label, reason }) => {
  if (!tenant_id)    throw new Error('tenant_id é obrigatório');
  if (!target_type)  throw new Error('target_type é obrigatório');
  if (!target_id)    throw new Error('target_id é obrigatório');
  const r = await pool.query(
    `INSERT INTO approval_requests
       (tenant_id, requested_by, target_type, target_id, target_label, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenant_id, requested_by || null, target_type, target_id, target_label || null, reason || null]
  );
  return r.rows[0];
};

const listByTenant = async (tenant_id, status) => {
  let q = `SELECT ar.*,
              u1.name AS requester_name, u1.email AS requester_email,
              u2.name AS reviewer_name
           FROM approval_requests ar
           LEFT JOIN users u1 ON ar.requested_by = u1.id
           LEFT JOIN users u2 ON ar.reviewed_by  = u2.id
           WHERE ar.tenant_id = $1`;
  const params = [tenant_id];
  if (status) { q += ` AND ar.status = $2`; params.push(status); }
  q += ' ORDER BY ar.created_at DESC';
  const r = await pool.query(q, params);
  return r.rows;
};

const getById = async (id, tenant_id) => {
  const r = await pool.query(
    'SELECT * FROM approval_requests WHERE id=$1 AND tenant_id=$2',
    [id, tenant_id]
  );
  return r.rows[0];
};

const approve = async (id, reviewed_by, tenant_id) => {
  const req = await getById(id, tenant_id);
  if (!req) throw new Error('Solicitação não encontrada');
  if (req.status !== 'pending') throw new Error('Solicitação já processada');

  // Executar a exclusão real de acordo com o tipo
  const ttl = req.target_type;
  if (ttl === 'lead') {
    await pool.query('DELETE FROM multas_leads WHERE id=$1 AND tenant_id=$2', [req.target_id, tenant_id]);
  } else if (ttl === 'client') {
    await pool.query(
      `UPDATE clients
       SET deleted_at=NOW(), deleted_by=$1, delete_reason=$2, updated_at=NOW()
       WHERE id=$3 AND tenant_id=$4 AND deleted_at IS NULL`,
      [reviewed_by || null, req.reason || 'Exclusão aprovada pelo administrador', req.target_id, tenant_id]
    );
  } else if (ttl === 'contract') {
    await pool.query('DELETE FROM fines WHERE id=$1 AND tenant_id=$2', [req.target_id, tenant_id]);
  } else if (ttl === 'document') {
    await pool.query('DELETE FROM documents WHERE id=$1 AND tenant_id=$2', [req.target_id, tenant_id]);
  }

  const r = await pool.query(
    `UPDATE approval_requests SET status='approved', reviewed_by=$1, reviewed_at=NOW()
     WHERE id=$2 AND tenant_id=$3 RETURNING *`,
    [reviewed_by, id, tenant_id]
  );
  return r.rows[0];
};

const reject = async (id, reviewed_by, tenant_id) => {
  const req = await getById(id, tenant_id);
  if (!req) throw new Error('Solicitação não encontrada');
  if (req.status !== 'pending') throw new Error('Solicitação já processada');
  const r = await pool.query(
    `UPDATE approval_requests SET status='rejected', reviewed_by=$1, reviewed_at=NOW()
     WHERE id=$2 AND tenant_id=$3 RETURNING *`,
    [reviewed_by, id, tenant_id]
  );
  return r.rows[0];
};

module.exports = { create, listByTenant, getById, approve, reject };
