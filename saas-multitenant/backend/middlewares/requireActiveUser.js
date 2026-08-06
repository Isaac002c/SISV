'use strict';

const pool = require('../config/db');

// JWT autentica a identidade; o estado ativo vem do banco para que a
// desativacao tenha efeito imediato, inclusive em tokens ja emitidos.
module.exports = async function requireActiveUser(req, res, next) {
  try {
    if (!req.userId || !req.tenantId) {
      return res.status(401).json({ success: false, error: 'Usuario invalido.' });
    }
    const { rows } = await pool.query(
      `SELECT id, role, module_access, backoffice_level, access_profile FROM users
       WHERE id = $1 AND tenant_id = $2
         AND COALESCE(is_active, TRUE) = TRUE
         AND deleted_at IS NULL`,
      [req.userId, req.tenantId]
    );
    if (!rows[0]) {
      return res.status(401).json({ success: false, error: 'Usuario inativo ou nao encontrado.' });
    }
    req.userRole = rows[0].role || req.userRole || 'viewer';
    req.userModules = Array.isArray(rows[0].module_access) ? rows[0].module_access : null;
    req.backofficeLevel = Number(rows[0].backoffice_level || 0);
    req.accessProfile = rows[0].access_profile || null;
    next();
  } catch (error) {
    console.error('[active-user]', error?.message || error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
};
