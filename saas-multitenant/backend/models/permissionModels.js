const pool = require('../config/db');

// ============================================
// PERMISSIONS MODEL - Permissões e Roles
// ============================================

// READ - Listar usuários do tenant com informações de role
const getUsersWithRoles = async (tenant_id) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.username, u.email, u.phone, u.role, u.access_profile,
            u.module_access, COALESCE(u.backoffice_level, 0)::int AS backoffice_level,
            COALESCE(u.is_active, true) as is_active,
            u.department_id, d.name AS department_name, u.created_at, u.updated_at,
            COALESCE(f.process_count, 0)::int AS process_count,
            COALESCE(t.task_count, 0)::int AS task_count
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id AND d.tenant_id = u.tenant_id
     LEFT JOIN (
       SELECT tenant_id, seller_id, COUNT(*)::int AS process_count
       FROM fines WHERE finalized_at IS NULL GROUP BY tenant_id, seller_id
     ) f ON f.tenant_id = u.tenant_id AND f.seller_id = u.id
     LEFT JOIN (
       SELECT tenant_id, assignee_id, COUNT(*)::int AS task_count
       FROM process_tasks
       WHERE deleted_at IS NULL
         AND status IN ('aberta','em_andamento','aguardando_terceiro')
       GROUP BY tenant_id, assignee_id
     ) t ON t.tenant_id = u.tenant_id AND t.assignee_id = u.id
     WHERE u.tenant_id = $1 AND u.deleted_at IS NULL
     ORDER BY u.name`,
    [tenant_id]
  );
  return result.rows;
};

// READ - Buscar usuário por ID
const getUserById = async (id, tenant_id) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.username, u.email, u.phone, u.role, u.access_profile,
            u.module_access, COALESCE(u.backoffice_level, 0)::int AS backoffice_level,
            COALESCE(u.is_active, true) as is_active,
            u.department_id, d.name AS department_name, u.created_at, u.updated_at
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id AND d.tenant_id = u.tenant_id
     WHERE u.id = $1 AND u.tenant_id = $2 AND u.deleted_at IS NULL`,
    [id, tenant_id]
  );
  return result.rows[0];
};

// CREATE - Criar novo usuário
const createUser = async ({ 
  tenant_id, name, username, email, phone = null, password, role = 'viewer',
  access_profile = null, module_access = null, backoffice_level = 0,
  department_id = null
}) => {
  const bcrypt = require('bcryptjs');
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const result = await pool.query(
    `INSERT INTO users (
       tenant_id, name, username, email, phone, password_hash, role, is_active,
       access_profile, module_access, backoffice_level, department_id
     )
     VALUES ($1, $2, $3, LOWER($4), $5, $6, $7, true, $8, $9::jsonb, $10, $11)
     RETURNING id, name, username, email, phone, role, is_active, access_profile,
               module_access, backoffice_level, department_id, created_at`,
    [tenant_id, name, username, email, phone || null, hashedPassword, role,
      access_profile || null,
      module_access === null ? null : JSON.stringify(module_access),
      Number(backoffice_level || 0), department_id || null]
  );
  return result.rows[0];
};

// UPDATE - Atualizar usuário
const updateUser = async (id, {
  name, username, email, phone, role, is_active, department_id,
  access_profile, module_access, backoffice_level,
}, tenant_id) => {
  const updates = [];
  const params = [];
  let paramIndex = 1;
  
  if (name !== undefined) {
    updates.push(`name = $${paramIndex}`);
    params.push(name);
    paramIndex++;
  }
  
  if (email !== undefined) {
    updates.push(`email = LOWER($${paramIndex})`);
    params.push(email);
    paramIndex++;
  }

  if (username !== undefined) {
    updates.push(`username = $${paramIndex}`);
    params.push(username);
    paramIndex++;
  }

  if (phone !== undefined) {
    updates.push(`phone = $${paramIndex}`);
    params.push(phone || null);
    paramIndex++;
  }
  
  if (role !== undefined) {
    updates.push(`role = $${paramIndex}`);
    params.push(role);
    paramIndex++;
  }
  
  if (is_active !== undefined) {
    updates.push(`is_active = $${paramIndex}`);
    params.push(is_active);
    paramIndex++;
  }

  if (department_id !== undefined) {
    updates.push(`department_id = $${paramIndex}`);
    params.push(department_id || null);
    paramIndex++;
  }

  if (access_profile !== undefined) {
    updates.push(`access_profile = $${paramIndex}`);
    params.push(access_profile || null);
    paramIndex++;
  }

  if (module_access !== undefined) {
    updates.push(`module_access = $${paramIndex}::jsonb`);
    params.push(module_access === null ? null : JSON.stringify(module_access));
    paramIndex++;
  }

  if (backoffice_level !== undefined) {
    updates.push(`backoffice_level = $${paramIndex}`);
    params.push(Number(backoffice_level || 0));
    paramIndex++;
  }
  
  if (updates.length === 0) {
    return null;
  }
  
  updates.push(`updated_at = NOW()`);
  params.push(id, tenant_id);
  
  const query = `
    UPDATE users 
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND deleted_at IS NULL
    RETURNING id, name, username, email, phone, role, is_active, access_profile,
              module_access, backoffice_level, department_id, updated_at
  `;
  
  const result = await pool.query(query, params);
  return result.rows[0];
};

// UPDATE - Atualizar senha
const updateUserPassword = async (id, password, tenant_id) => {
  const bcrypt = require('bcryptjs');
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const result = await pool.query(
    `UPDATE users 
     SET password_hash = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
     RETURNING id`,
    [hashedPassword, id, tenant_id]
  );
  return result.rows[0];
};

// DELETE - Deletar usuário
const softDeleteUser = async (id, tenant_id) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT id, name, username, email, role, is_active
         FROM users
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [id, tenant_id]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Usuario nao encontrado.' };
    }
    if (current.rows[0].is_active !== false) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'Desative o usuario antes de exclui-lo.' };
    }

    const { rows } = await client.query(
      `UPDATE users
          SET is_active = FALSE,
              deleted_at = NOW(),
              username = NULL,
              email = 'deleted.' || id::text || '@login.sisv.local',
              phone = NULL,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        RETURNING id, name, role, is_active, deleted_at`,
      [id, tenant_id]
    );
    await client.query('COMMIT');
    return { ok: true, user: rows[0], original: current.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
};

// READ - Contar usuários do tenant
const countUsers = async (tenant_id) => {
  const result = await pool.query(
    'SELECT COUNT(*) as total FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
    [tenant_id]
  );
  return parseInt(result.rows[0].total);
};

// READ - Contar usuários ativos
const countActiveUsers = async (tenant_id) => {
  const result = await pool.query(
    'SELECT COUNT(*) as total FROM users WHERE tenant_id = $1 AND COALESCE(is_active, true) = true AND deleted_at IS NULL',
    [tenant_id]
  );
  return parseInt(result.rows[0].total);
};

// READ - Estatísticas de usuários por role
const getUsersStats = async (tenant_id) => {
  const result = await pool.query(
    `SELECT role, COUNT(*) as count, COUNT(CASE WHEN is_active = true THEN 1 END) as active_count
     FROM users 
     WHERE tenant_id = $1 AND deleted_at IS NULL
     GROUP BY role`,
    [tenant_id]
  );
  return result.rows;
};

// Verificar se email já existe no tenant
const checkEmailExists = async (email, tenant_id) => {
  const result = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND deleted_at IS NULL',
    [email, tenant_id]
  );
  return result.rows.length > 0;
};

const checkUsernameExists = async (username, tenant_id, exclude_id = null) => {
  const result = await pool.query(
    `SELECT id FROM users
      WHERE LOWER(username) = LOWER($1)
        AND tenant_id = $2
        AND deleted_at IS NULL
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [username, tenant_id, exclude_id]
  );
  return result.rows.length > 0;
};

const getTenantUserCapacity = async (tenant_id) => {
  const result = await pool.query(
    `SELECT t.user_limit,
            COUNT(u.id) FILTER (WHERE COALESCE(u.is_active, TRUE) = TRUE)::int AS active,
            COUNT(u.id)::int AS total
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id AND u.deleted_at IS NULL
      WHERE t.id = $1
      GROUP BY t.id, t.user_limit`,
    [tenant_id]
  );
  const row = result.rows[0] || { user_limit: null, active: 0, total: 0 };
  const limit = row.user_limit === null ? null : Number(row.user_limit);
  const active = Number(row.active || 0);
  const total = Number(row.total || 0);
  return {
    limit,
    active,
    inactive: Math.max(0, total - active),
    total,
    remaining: limit === null ? null : Math.max(0, limit - active),
    over_limit: limit !== null && active > limit,
  };
};

const getUserWorkload = async (id, tenant_id) => {
  const [processes, tasks] = await Promise.all([
    pool.query(
      `SELECT f.id, f.fine_number, f.stage, f.status, f.due_date, c.name AS client_name
       FROM fines f LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
       WHERE f.tenant_id=$1 AND f.seller_id=$2 AND f.finalized_at IS NULL
       ORDER BY f.due_date NULLS LAST LIMIT 200`,
      [tenant_id, id]
    ),
    pool.query(
      `SELECT t.id, t.title, t.priority, t.status, t.due_at, f.fine_number
       FROM process_tasks t JOIN fines f ON f.id=t.fine_id AND f.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.assignee_id=$2 AND t.deleted_at IS NULL
         AND t.status IN ('aberta','em_andamento','aguardando_terceiro')
       ORDER BY t.due_at NULLS LAST LIMIT 200`,
      [tenant_id, id]
    ),
  ]);
  return {
    counts: { processes: processes.rows.length, tasks: tasks.rows.length },
    processes: processes.rows,
    tasks: tasks.rows,
  };
};

const deactivateUser = async (id, tenant_id, { redistribute_to = null } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT id,name,is_active FROM users
        WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [id, tenant_id]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'Usuario nao encontrado.' };
    }
    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM fines WHERE tenant_id=$1 AND seller_id=$2 AND finalized_at IS NULL) AS processes,
         (SELECT COUNT(*)::int FROM process_tasks WHERE tenant_id=$1 AND assignee_id=$2
            AND deleted_at IS NULL AND status IN ('aberta','em_andamento','aguardando_terceiro')) AS tasks`,
      [tenant_id, id]
    );
    const workload = counts.rows[0];
    if ((workload.processes > 0 || workload.tasks > 0) && !redistribute_to) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, error: 'Redistribua a carga antes de desativar.', workload };
    }
    if (redistribute_to) {
      if (String(redistribute_to) === String(id)) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'Escolha outro usuario para redistribuicao.' };
      }
      const target = await client.query(
        `SELECT id FROM users WHERE id=$1 AND tenant_id=$2
          AND COALESCE(is_active,TRUE)=TRUE AND deleted_at IS NULL`,
        [redistribute_to, tenant_id]
      );
      if (!target.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'Usuario de destino invalido.' };
      }
      await client.query(
        `UPDATE fines SET seller_id=$1,last_moved_at=NOW(),updated_at=NOW()
         WHERE tenant_id=$2 AND seller_id=$3 AND finalized_at IS NULL`,
        [redistribute_to, tenant_id, id]
      );
      await client.query(
        `UPDATE process_tasks SET assignee_id=$1,updated_at=NOW()
         WHERE tenant_id=$2 AND assignee_id=$3 AND deleted_at IS NULL
           AND status IN ('aberta','em_andamento','aguardando_terceiro')`,
        [redistribute_to, tenant_id, id]
      );
    }
    const { rows } = await client.query(
      `UPDATE users SET is_active=FALSE,updated_at=NOW()
       WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL
       RETURNING id,name,email,role,is_active`,
      [id, tenant_id]
    );
    await client.query('COMMIT');
    return { ok: true, user: rows[0], workload, redistributed_to: redistribute_to };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  getUsersWithRoles,
  getUserById,
  createUser,
  updateUser,
  updateUserPassword,
  softDeleteUser,
  countUsers,
  countActiveUsers,
  getTenantUserCapacity,
  getUsersStats,
  checkEmailExists,
  checkUsernameExists,
  getUserWorkload,
  deactivateUser
};

