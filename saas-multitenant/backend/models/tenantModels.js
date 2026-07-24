const pool = require('../config/db');

const createTenant = async (name) => {
    const result = await pool.query(
        'INSERT INTO tenants(name) VALUES($1) RETURNING *',
        [name]
    );
    return result.rows[0];
};

const getAllTenants = async () => {
    const result = await pool.query('SELECT * FROM tenants');
    return result.rows;
};

// Dados de branding do tenant (para recibos/PDF). Tenant-scoped por id.
const getTenantById = async (id) => {
    const result = await pool.query(
        `SELECT id, name, slug, logo_url, brand_color, tagline FROM tenants WHERE id = $1`,
        [id]
    );
    return result.rows[0];
};

// Tenant completo, incluindo identidade (SISV/TELUN) e módulos habilitados.
// Usado no /api/tenant/me e no gating de módulos.
const getTenantFull = async (id) => {
    const result = await pool.query(
        `SELECT id, name, slug, status, email, logo_url, brand_color, brand_color_dark,
                tagline, developer, modules, created_at, updated_at
         FROM tenants WHERE id = $1`,
        [id]
    );
    return result.rows[0];
};

// Módulos habilitados do tenant. NULL no banco = todos habilitados (padrão
// legado). Retorna { modules: string[] | null }. Nunca lança — na dúvida libera
// (comportamento atual dos tenants existentes).
const getTenantModules = async (id) => {
    const result = await pool.query('SELECT modules FROM tenants WHERE id = $1', [id]);
    const raw = result.rows[0]?.modules ?? null;
    if (raw == null) return null;                 // todos habilitados
    if (Array.isArray(raw)) return raw;
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; }
    catch { return null; }
};

// Atualiza identidade/branding/módulos do tenant. Só mexe nos campos enviados.
const updateTenant = async (id, fields = {}) => {
    const allowed = ['name', 'slug', 'status', 'email', 'logo_url', 'brand_color',
        'brand_color_dark', 'tagline', 'developer', 'modules'];
    const sets = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
        if (fields[key] === undefined) continue;
        const val = key === 'modules'
            ? (fields[key] === null ? null : JSON.stringify(fields[key]))
            : fields[key];
        sets.push(`${key} = $${i}`);
        values.push(val);
        i++;
    }
    if (!sets.length) return getTenantFull(id);
    values.push(id);
    const result = await pool.query(
        `UPDATE tenants SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
        values
    );
    return result.rows[0];
};

module.exports = {
    createTenant,
    getAllTenants,
    getTenantById,
    getTenantFull,
    getTenantModules,
    updateTenant,
};
