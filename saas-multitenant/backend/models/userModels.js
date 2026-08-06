const pool = require('../config/db');
const bcrypt = require('bcryptjs');

const createUser = async ({ name, username, email, password, tenant_id, role = 'seller' }) => {
    const hashedPassword = await bcrypt.hash(password, 10);
    const resolvedUsername = username || String(email || '').split('@')[0];
    const result = await pool.query(
        'INSERT INTO users(name, username, email, password_hash, tenant_id, role) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [name, resolvedUsername, email, hashedPassword, tenant_id, role]
    );
    return result.rows[0];
};

const getUserByEmail = async (email) => {
    const result = await pool.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [email]);
    return result.rows[0];
};

// Atualizar role do usuário
const updateUserRole = async (userId, role) => {
    const result = await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING *',
        [role, userId]
    );
    return result.rows[0];
};

// Atualizar seller_id do usuário
const updateUserSeller = async (userId, sellerId) => {
    const result = await pool.query(
        'UPDATE users SET seller_id = $1 WHERE id = $2 RETURNING *',
        [sellerId, userId]
    );
    return result.rows[0];
};

// Buscar usuário por id (tenant-scoped) — usado p/ nome do responsável em recibos
const getUserById = async (userId, tenantId) => {
    const result = await pool.query(
        'SELECT id, name, username, email, role FROM users WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [userId, tenantId]
    );
    return result.rows[0];
};

// Buscar usuários por tenant
const getUsersByTenant = async (tenantId) => {
    const result = await pool.query(
        `SELECT id, name, username, email, role, seller_id, created_at
         FROM users
         WHERE tenant_id = $1 AND COALESCE(is_active, TRUE) = TRUE AND deleted_at IS NULL
         ORDER BY name`,
        [tenantId]
    );
    return result.rows;
};

module.exports = {
    createUser,
    getUserByEmail,
    getUserById,
    updateUserRole,
    updateUserSeller,
    getUsersByTenant
};
