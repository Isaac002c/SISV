'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const pool = require('../config/db');
const queue = require('../services/queueService');

const once = process.argv.includes('--once');
const intervalMs = Math.max(250, Number(process.env.WORKER_POLL_MS) || 1500);
let stopping = false;
let timer = null;

async function cycle() {
  if (stopping) return;
  try {
    const result = await queue.runOnce();
    if (once || !result.claimed) {
      if (once) return shutdown(0);
      timer = setTimeout(cycle, intervalMs);
    } else {
      setImmediate(cycle);
    }
  } catch (error) {
    console.error('[worker] ciclo falhou:', String(error.message).slice(0, 500));
    if (once) return shutdown(1);
    timer = setTimeout(cycle, intervalMs);
  }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  try { await pool.end(); } catch { /* encerramento best effort */ }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

cycle();
