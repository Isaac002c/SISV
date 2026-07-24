require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config({ path: __dirname + '/.env' });

// Valida a configuração ANTES de carregar módulos que dependem dela (config/db).
// Em produção, encerra com mensagem clara se faltar algo essencial ou houver
// fallback inseguro (segredo padrão, CORS aberto, modo demo).
require('./config/env').assertEnvOrExit();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const tenantContext = require('./middlewares/tenantContext');
const pool = require('./config/db');

const authRoutes = require('./routes/authRoutes');
const leadsRoutes = require('./routes/leadsRoutes');
const assetRoutes = require('./routes/assetsRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const targetsRoutes = require('./routes/targetsRoutes');
const sellersRoutes = require('./routes/sellersRoutes');
const forecastRoutes = require('./routes/forecastRoutes');
const clientRoutes = require('./routes/clientRoutes');
const contractRoutes = require('./routes/contractRoutes');
const documentRoutes = require('./routes/documentRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const saasRoutes = require('./routes/saasRoutes');
const userManagementRoutes = require('./routes/userManagementRoutes');
const finesRoutes = require('./routes/finesRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const multasLeadsRoutes = require('./routes/multasLeadsRoutes');
const uploadRoutes        = require('./routes/uploadRoutes');
const fineProtocolRoutes  = require('./routes/fineProtocolRoutes');
const approvalRoutes      = require('./routes/approvalRoutes');
const companyRoutes       = require('./routes/companyRoutes');
const calendarEventRoutes = require('./routes/calendarEventRoutes');
const masterRoutes        = require('./routes/masterRoutes');
const financialRoutes     = require('./routes/financialRoutes');
const tenantConfigRoutes  = require('./routes/tenantConfigRoutes');
const processRoutes       = require('./routes/processRoutes');
const tenantRoutes        = require('./routes/tenantRoutes');
const { requireModule }   = require('./middlewares/requireModule');

const app = express();

// Confia no proxy reverso (Nginx) para X-Forwarded-For e X-Forwarded-Proto
// Necessário para rate-limit e cookies secure funcionarem corretamente atrás do Nginx
app.set('trust proxy', 1);

// ============================================
// CORS
// ============================================

// Em produção, defina FRONTEND_URL no .env com o domínio real
const FRONTEND_URL = process.env.FRONTEND_URL || '';

// Origens liberadas no CORS. Em produção, defina FRONTEND_URL com o domínio do
// frontend do Nexos (Vercel). Sem branding/domínios de sistemas anteriores.
const EXTRA_ORIGINS = (process.env.EXTRA_CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  ...(FRONTEND_URL ? [FRONTEND_URL.trim()] : []),
  ...EXTRA_ORIGINS,
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ============================================
// SECURITY HEADERS
// ============================================

const connectSrcDirectives = ["'self'", ...(FRONTEND_URL ? [FRONTEND_URL] : [])];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: connectSrcDirectives,
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

//  Remove header que revela tecnologia
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('Cache-Control', 'no-store');
  next();
});

// ============================================
// RATE LIMIT GLOBAL
// ============================================

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,                  // 200 requests por IP
  message: { success: false, message: 'Muitas requisições. Tente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

// ============================================
// MIDDLEWARES
// ============================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Log simples só em dev
const isDev = process.env.NODE_ENV !== 'production';
app.use((req, res, next) => {
  if (isDev) console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// ROTAS
// ============================================

app.use('/auth', authRoutes);

// Serve arquivos de upload estaticamente (sem autenticação — URL contém tenantId no path)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
  },
}));

app.use('/api', tenantContext);

// ── Identidade e configuração do tenant (SISV) ───────────────────────────────
app.use('/api/tenant', tenantRoutes);
app.use('/api/config', tenantConfigRoutes);

// ── Núcleo operacional (habilitado para todos; SISV usa) ─────────────────────
app.use('/api/clients', clientRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api', saasRoutes);
app.use('/api/fines', finesRoutes);
app.use('/api/processes', requireModule('processos'), processRoutes);
app.use('/api/users/management', userManagementRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/fine-protocols', fineProtocolRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/master', masterRoutes);

// ── Módulos com gate por tenant (fora do escopo do SISV → bloqueados) ────────
// modules == NULL libera tudo (tenants legados). Ver middlewares/requireModule.
app.use('/api/leads', requireModule('leads'), leadsRoutes);
app.use('/api/multas-leads', requireModule('leads'), multasLeadsRoutes);
app.use('/api/companies', requireModule('empresas'), companyRoutes);
app.use('/api/calendar-events', requireModule('agenda'), calendarEventRoutes);
app.use('/api/approvals', requireModule('aprovacoes'), approvalRoutes);
app.use('/api/financial', requireModule('financeiro'), financialRoutes);
app.use('/api/targets', requireModule('comercial'), targetsRoutes);
app.use('/api/sellers', requireModule('comercial'), sellersRoutes);
app.use('/api/forecast', requireModule('comercial'), forecastRoutes);
app.use('/api/contracts', requireModule('comercial'), contractRoutes);

// ============================================
// HEALTH / READY (sem autenticação — para uptime monitors e orquestradores)
// Não expõem secrets, URL do banco, versões ou estrutura interna.
// ============================================

app.use(require('./routes/healthRoutes')(pool));

// ============================================
// 404
// ============================================

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Rota não encontrada' });
});

// ============================================
// GLOBAL ERROR HANDLER
// ============================================

app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR]', err.message);
  res.status(err.status || 500).json({
    success: false,
    error: 'Erro interno do servidor',
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;

// Handlers de crash para evitar queda silenciosa em produção
process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err.message, err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] unhandledRejection:', reason);
  process.exit(1);
});

(async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log(' Conectado ao Banco de Dados');
  } catch (err) {
    console.error(' Erro ao conectar no banco:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Nexos API rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
})();