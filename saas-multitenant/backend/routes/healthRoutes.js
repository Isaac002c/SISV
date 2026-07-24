'use strict';
// =============================================================================
// healthRoutes — Liveness e Readiness (sem autenticação, para uptime monitors
// e orquestradores). NUNCA expõem secrets, URL do banco, versões de bibliotecas,
// stack trace ou dados de tenant.
//
//   GET /health → só confirma que o processo responde (não toca no banco).
//   GET /ready  → valida dependências essenciais (banco e armazenamento).
// =============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

module.exports = function healthRoutes(pool) {
  const router = express.Router();

  // Liveness — barato e sem dependências.
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // Readiness — banco e armazenamento. Detalhe do erro fica só no log.
  router.get('/ready', async (req, res) => {
    const checks = { database: 'down', storage: 'down' };
    try {
      await pool.query('SELECT 1');
      checks.database = 'up';
    } catch (err) {
      console.error('[ready] banco indisponível:', err.message);
    }
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.accessSync(UPLOADS_DIR, fs.constants.W_OK);
      checks.storage = 'up';
    } catch (err) {
      console.error('[ready] armazenamento indisponível:', err.message);
    }
    const ready = Object.values(checks).every((v) => v === 'up');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });

  return router;
};
