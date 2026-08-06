const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { createUser } = require('../models/userModels');
const { createTenant } = require('../models/tenantModels');
const pool = require('../config/db');

const isDev = process.env.NODE_ENV !== 'production';
const log = (...args) => { if (isDev) console.log(...args); };

const getJWTSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET não definido nas variáveis de ambiente');
  return secret;
};

const sendJson = (res, status, data) => {
  res.status(status).setHeader('Content-Type', 'application/json').json(data);
};

// JSONB modules → array | null. NULL/legado = todos os módulos habilitados.
const parseModules = (raw) => {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; }
  catch { return null; }
};

// ✅ Rate limit específico pro login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 1. REGISTER
router.post('/register',
  [
    body('tenantName').notEmpty().trim().escape(),
    body('name').notEmpty().trim().escape(),
    body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
    body('password').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendJson(res, 400, { success: false, message: 'Dados inválidos' });
    }

    try {
      const { tenantName, name, email, password } = req.body;

      const tenant = await createTenant(tenantName);

      const existingUsers = await pool.query(
        'SELECT COUNT(*) as count FROM users WHERE tenant_id = $1',
        [tenant.id]
      );
      const isFirstUser = parseInt(existingUsers.rows[0].count) === 0;

      await createUser({
        name,
        email,
        password,
        tenant_id: tenant.id,
        role: isFirstUser ? 'admin' : 'seller'
      });

      sendJson(res, 201, {
        success: true,
        tenant_id: tenant.id,
        message: 'Tenant + usuário criado com sucesso!'
      });
    } catch (err) {
      console.error('[REGISTER ERROR]', err.message);
      sendJson(res, 500, { success: false, message: 'Erro ao registrar' });
    }
  }
);

// 2. LOGIN
router.post('/login',
  loginLimiter,
  [
    body('login').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('email').optional().isString().trim().isLength({ min: 1, max: 160 }),
    body('password').isLength({ min: 6 }).trim(),
    body().custom((_value, { req }) => {
      if (String(req.body?.login || req.body?.email || '').trim()) return true;
      throw new Error('Informe o usuário.');
    }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendJson(res, 400, { success: false, message: 'Dados inválidos' });
    }

    let client;
    try {
      const login = String(req.body.login || req.body.email || '').trim();
      const { password } = req.body;

      client = await pool.connect();

      // O login oficial usa username. O email permanece apenas como fallback
      // temporário para usuários legados e para o painel master.
      const result = await client.query(
        `SELECT u.id, u.name, u.username, u.email, u.password_hash, u.tenant_id, u.role,
                u.phone, u.access_profile, u.module_access, u.backoffice_level,
                COALESCE(u.is_active, TRUE) AS is_active,
                t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
                t.logo_url as tenant_logo_url, t.brand_color as tenant_brand_color,
                t.brand_color_dark as tenant_brand_color_dark, t.tagline as tenant_tagline,
                t.developer as tenant_developer, t.modules as tenant_modules
         FROM users u
         JOIN tenants t ON u.tenant_id = t.id
         WHERE (LOWER(u.username) = LOWER($1)
            OR LOWER(u.email) = LOWER($1))
           AND u.deleted_at IS NULL
         ORDER BY u.created_at ASC`,
        [login]
      );

      if (result.rows.length === 0) {
        return sendJson(res, 401, { success: false, message: 'Credenciais inválidas' });
      }

      // Valida a senha contra cada usuário encontrado (suporta o mesmo username
      // em tenants diferentes sem misturar os dados).
      let user = null;
      for (const candidate of result.rows) {
        const match = await bcryptjs.compare(password, candidate.password_hash);
        if (match) {
          user = candidate;
          break;
        }
      }

      if (!user) {
        return sendJson(res, 401, { success: false, message: 'Credenciais inválidas' });
      }

      if (!user.is_active) {
        return sendJson(res, 403, { success: false, message: 'Usuario inativo. Contate o administrador.' });
      }

      // Bloqueia login se a empresa (tenant) estiver inativa — super_admin sempre pode entrar.
      if (user.role !== 'super_admin' && user.tenant_status && user.tenant_status !== 'ativo') {
        return sendJson(res, 403, { success: false, message: 'Empresa inativa. Contate o suporte do SISV.' });
      }

      // Aviso operacional: mesmo identificador em múltiplos tenants.
      if (result.rows.length > 1) {
        console.warn(`[LOGIN] Identificador "${login}" existe em ${result.rows.length} tenants. Logando no primeiro com senha válida.`);
      }

      const token = jwt.sign(
        {
          userId: user.id,
          tenantId: user.tenant_id,
          username: user.username,
          email: user.email,
          role: user.role || 'admin'
        },
        getJWTSecret(),
        { expiresIn: '30d' }
      );

      // Último acesso (não bloqueia o login se falhar)
      await client.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]).catch(() => {});
      await client.query(
        `INSERT INTO activity_logs (tenant_id,user_id,entity,entity_id,entity_name,action,details)
         VALUES ($1,$2,'usuario',$2,$3,'login',$4::jsonb)`,
        [user.tenant_id, user.id, user.name, JSON.stringify({ username: user.username })]
      ).catch(() => {});

      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000
      };

      res.cookie('token', token, cookieOptions);
      res.cookie('auth-token', token, cookieOptions);
      res.cookie('tenantId', user.tenant_id.toString(), cookieOptions);

      sendJson(res, 200, {
        success: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role || 'admin',
          phone: user.phone || null,
          access_profile: user.access_profile || null,
          module_access: Array.isArray(user.module_access) ? user.module_access : null,
          backoffice_level: Number(user.backoffice_level || 0)
        },
        tenant: {
          id: user.tenant_id,
          name: user.tenant_name,
          slug: user.tenant_slug || 'default',
          logo_url: user.tenant_logo_url || null,
          brand_color: user.tenant_brand_color || '#751518',
          brand_color_dark: user.tenant_brand_color_dark || '#050708',
          tagline: user.tenant_tagline || 'Plataforma de Gestão',
          developer: user.tenant_developer || null,
          // NULL no banco = todos os módulos habilitados (tenants legados).
          modules: parseModules(user.tenant_modules)
        }
      });
    } catch (err) {
      console.error('[LOGIN ERROR]', err.message);
      sendJson(res, 500, { success: false, message: 'Erro no servidor' });
    } finally {
      if (client) client.release();
    }
  }
);

// 3. VALIDATE TOKEN
router.post('/validate', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return sendJson(res, 401, { success: false, message: 'Token obrigatório' });
    }

    const decoded = jwt.verify(token, getJWTSecret());
    sendJson(res, 200, {
      success: true,
      user: { id: decoded.userId, email: decoded.email },
      tenant: { id: decoded.tenantId },
      role: decoded.role || 'seller',
      sellerId: decoded.sellerId
    });
  } catch (err) {
    sendJson(res, 401, { success: false, message: 'Token inválido' });
  }
});

// 4. LOGOUT
router.post('/logout', async (req, res) => {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  };
  res.clearCookie('token', cookieOptions);
  res.clearCookie('auth-token', cookieOptions);
  res.clearCookie('tenantId', cookieOptions);
  sendJson(res, 200, { success: true, message: 'Logout realizado com sucesso' });
});

module.exports = router;
