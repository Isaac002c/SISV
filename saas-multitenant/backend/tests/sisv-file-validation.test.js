'use strict';
// =============================================================================
// SISV — Segurança de arquivos: validação por ASSINATURA (magic bytes), não só
// pelo Content-Type; allowlist de extensão; proteção contra path traversal.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fv = require('../services/fileValidation');
const storage = require('../services/fileStorage');

const tmp = (name, bytes) => {
  const p = path.join(os.tmpdir(), `sisv-${Date.now()}-${name}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
};

test('extensão fora da allowlist é rejeitada', () => {
  assert.ok(!fv.ALLOWED_EXTENSIONS.includes('.exe'));
  assert.ok(!fv.ALLOWED_EXTENSIONS.includes('.zip'));
  assert.deepEqual(fv.ALLOWED_EXTENSIONS.sort(), ['.jpeg', '.jpg', '.pdf', '.png', '.webp']);
});

test('PDF real (magic %PDF-) é aceito', () => {
  const p = tmp('real.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
  const r = fv.validateStoredFile(p, 'doc.pdf', 'application/pdf', 8);
  fs.unlinkSync(p);
  assert.equal(r.ok, true);
});

test('PNG renomeado para .pdf (tipo forjado) é rejeitado por magic bytes', () => {
  const p = tmp('fake.pdf', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
  const r = fv.validateStoredFile(p, 'fake.pdf', 'application/pdf', 8);
  fs.unlinkSync(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /conteúdo|corresponde/i);
});

test('MIME incoerente com a extensão é rejeitado', () => {
  const p = tmp('x.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = fv.validateStoredFile(p, 'x.png', 'application/pdf', 8); // png com mime pdf
  fs.unlinkSync(p);
  assert.equal(r.ok, false);
});

test('JPEG real é aceito; PNG real é aceito', () => {
  const jpg = tmp('a.jpg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = tmp('a.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(fv.validateStoredFile(jpg, 'a.jpg', 'image/jpeg', 8).ok, true);
  assert.equal(fv.validateStoredFile(png, 'a.png', 'image/png', 8).ok, true);
  fs.unlinkSync(jpg); fs.unlinkSync(png);
});

test('storage: nomes válidos vs path traversal', () => {
  assert.ok(storage.isValidStoredName('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.pdf'));
  assert.ok(!storage.isValidStoredName('../../etc/passwd'));
  assert.ok(!storage.isValidStoredName('..\\..\\win.ini'));
  assert.ok(!storage.isValidStoredName('normalname.pdf'));
  // resolvePath contém dentro da pasta do tenant
  assert.equal(storage.resolvePath('t', '../x.pdf').ok, false);
  assert.equal(storage.resolvePath('t', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.pdf').ok, true);
  // deriva stored_name de url legada
  assert.equal(storage.storedNameFromUrl('http://x/uploads/tenant-1/abc.pdf'), 'abc.pdf');
});
