'use strict';

// =============================================================================
// pgmem-schema-gen.js — gera DDL compatível com pg-mem a partir das migrations
// REAIS do SISV, para manter o schema do sisv-demo-server.js sincronizado.
//
// Existe porque o demo server declara o schema à mão: quando uma migration nova
// adiciona tabelas/colunas e o demo não acompanha, o E2E quebra com "relation
// does not exist". Em vez de transcrever na mão, gere e cole o bloco.
//
// Uso:
//   node scripts/pgmem-schema-gen.js migrations/sisv_06_commercial_backoffice_execution.sql
//
// O que é descartado (pg-mem não suporta / o demo valida na aplicação):
//   REFERENCES, CHECK, índices parciais (WHERE) e funcionais (LOWER/COALESCE).
// O que é convertido: tenant_id UUID -> TEXT (o demo usa slug legível).
// =============================================================================
const fs = require('fs');

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

// Extrai blocos CREATE TABLE IF NOT EXISTS nome ( ... );
function extractTables(sql) {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+([a-z_0-9]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    out.push({ name, body: sql.slice(re.lastIndex, i - 1) });
  }
  return out;
}

// Divide a lista de colunas no nível superior de parênteses.
function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function convertColumn(part) {
  // Constraints de tabela nomeadas: descartadas (pg-mem não precisa e o demo
  // valida na aplicação). PRIMARY KEY/UNIQUE compostos são preservados.
  if (/^CONSTRAINT\b/i.test(part)) return null;
  if (/^CHECK\b/i.test(part)) return null;
  if (/^(PRIMARY KEY|UNIQUE)\s*\(/i.test(part)) return part;
  if (/^FOREIGN KEY\b/i.test(part)) return null;

  let col = part;
  // Remove REFERENCES ... [ON DELETE ...] [ON UPDATE ...]
  col = col.replace(/\s+REFERENCES\s+[a-z_0-9]+\s*(\([^)]*\))?(\s+ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION))?(\s+ON UPDATE (CASCADE|SET NULL|RESTRICT|NO ACTION))?/gi, '');
  // Remove CHECK (...) de coluna, respeitando parênteses aninhados.
  for (;;) {
    const idx = col.search(/\bCHECK\s*\(/i);
    if (idx === -1) break;
    let i = col.indexOf('(', idx);
    let depth = 1;
    i++;
    while (i < col.length && depth > 0) {
      if (col[i] === '(') depth++;
      else if (col[i] === ')') depth--;
      i++;
    }
    col = col.slice(0, idx) + col.slice(i);
  }
  const name = col.trim().split(/\s+/)[0];
  // O demo usa tenant_id TEXT (slug legível) em vez de UUID.
  if (name === 'tenant_id') col = col.replace(/^(\s*tenant_id)\s+UUID/i, '$1 TEXT');
  return col.replace(/\s+/g, ' ').trim();
}

// UNIQUE simples e não-parcial vira UNIQUE(...) inline; índices parciais e
// funcionais (LOWER(), WHERE) não existem em pg-mem e são ignorados no demo.
function extractSimpleUniques(sql, tableName) {
  const out = [];
  const re = new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS\\s+[a-z_0-9]+\\s+ON\\s+${tableName}\\s*\\(([^)]*)\\)\\s*;`, 'gi');
  let m;
  while ((m = re.exec(sql))) {
    const cols = m[1].trim();
    if (/lower\s*\(|coalesce\s*\(/i.test(cols)) continue;
    out.push(`UNIQUE(${cols.replace(/\s+/g, ' ')})`);
  }
  return out;
}

const files = process.argv.slice(2);
const lines = [];
for (const file of files) {
  const raw = stripComments(fs.readFileSync(file, 'utf8'));
  for (const { name, body } of extractTables(raw)) {
    const cols = splitTop(body).map(convertColumn).filter(Boolean);
    for (const u of extractSimpleUniques(raw, name)) cols.push(u);
    lines.push(`  CREATE TABLE ${name} (${cols.join(', ')});`);
  }
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS em tabelas criadas neste arquivo
  const alterRe = /ALTER TABLE\s+([a-z_0-9]+)\s+ADD COLUMN IF NOT EXISTS\s+([^;]+);/gi;
  let a;
  while ((a = alterRe.exec(raw))) {
    const table = a[1];
    const col = convertColumn(a[2]);
    if (!col) continue;
    const created = lines.findIndex((l) => l.includes(`CREATE TABLE ${table} (`));
    if (created === -1) continue; // coluna em tabela pré-existente: não aplicável ao demo
    if (lines[created].includes(` ${col.split(/\s+/)[0]} `)) continue;
    lines[created] = lines[created].replace(/\);$/, `, ${col});`);
  }
}
console.log(lines.join('\n'));
