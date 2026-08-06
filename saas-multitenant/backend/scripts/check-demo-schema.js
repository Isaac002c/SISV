'use strict';

// =============================================================================
// check-demo-schema.js — verifica se o schema declarado no sisv-demo-server.js
// cobre TODAS as colunas que as migrations do SISV criam.
//
// O demo server usa pg-mem com schema escrito a mao. Quando uma migration nova
// adiciona colunas e o demo nao acompanha, o E2E falha tarde e com mensagem
// obscura ("column ... does not exist"). Este script antecipa a falha.
//
// Uso:  node scripts/check-demo-schema.js
// Sai com codigo 1 e lista as colunas faltantes quando ha divergencia.
// =============================================================================

const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(__dirname, '..');
const migrationsDir = path.join(backendDir, 'migrations');
const demoFile = path.join(backendDir, 'sisv-demo-server.js');

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

/** Extrai o corpo de cada CREATE TABLE, equilibrando parenteses. */
function extractTables(sql, pattern) {
  const tables = new Map();
  const re = new RegExp(pattern, 'gi');
  let match;
  while ((match = re.exec(sql))) {
    const name = match[1];
    let i = re.lastIndex;
    let depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    tables.set(name, sql.slice(re.lastIndex, i - 1));
  }
  return tables;
}

/** Nomes de coluna no nivel superior da definicao da tabela. */
function columnNames(body) {
  const names = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const part = current.replace(/\s+/g, ' ').trim();
    current = '';
    if (!part) return;
    if (/^(CONSTRAINT|CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY)\b/i.test(part)) return;
    names.push(part.split(/\s+/)[0].toLowerCase());
  };
  // `inString` protege virgulas dentro de literais como DEFAULT '[2,5,10]'.
  let inString = false;
  for (const ch of body) {
    if (ch === "'") inString = !inString;
    if (!inString) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { flush(); continue; }
    }
    current += ch;
  }
  flush();
  return names;
}

// ── Schema esperado: uniao das migrations ────────────────────────────────────
const expected = new Map();
const addColumn = (table, column) => {
  if (!expected.has(table)) expected.set(table, new Set());
  expected.get(table).add(column.toLowerCase());
};

const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql') && !file.includes('rollback'))
  .sort();

for (const file of migrationFiles) {
  const sql = stripComments(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  for (const [table, body] of extractTables(sql, 'CREATE TABLE IF NOT EXISTS\\s+([a-z_0-9]+)\\s*\\(')) {
    for (const column of columnNames(body)) addColumn(table, column);
  }
  const alterRe = /ALTER TABLE\s+([a-z_0-9]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_0-9]+)/gi;
  let alter;
  while ((alter = alterRe.exec(sql))) addColumn(alter[1], alter[2]);
}

// ── Schema declarado no demo server ──────────────────────────────────────────
const demoSource = fs.readFileSync(demoFile, 'utf8');
const declared = new Map();
for (const [table, body] of extractTables(stripComments(demoSource), 'CREATE TABLE\\s+([a-z_0-9]+)\\s*\\(')) {
  declared.set(table, new Set(columnNames(body)));
}

// ── Comparacao ───────────────────────────────────────────────────────────────
// Tabelas que o demo nao declara sao ignoradas: o demo cobre apenas o escopo do
// SISV (nao carrega leads, financeiro, comercial legado etc.).
const problems = [];
for (const [table, columns] of expected) {
  const demoColumns = declared.get(table);
  if (!demoColumns) continue;
  const missing = [...columns].filter((column) => !demoColumns.has(column));
  if (missing.length) problems.push(`  ${table}: ${missing.join(', ')}`);
}

if (problems.length) {
  console.error('Schema do sisv-demo-server.js esta defasado em relacao as migrations.');
  console.error('Colunas faltantes:');
  console.error(problems.join('\n'));
  console.error('\nRegenere o bloco da migration correspondente com:');
  console.error('  node scripts/pgmem-schema-gen.js migrations/<arquivo>.sql');
  process.exit(1);
}

console.log(`Schema do demo server cobre ${declared.size} tabelas — sem divergencia.`);
