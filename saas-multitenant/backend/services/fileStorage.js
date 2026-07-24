'use strict';
// =============================================================================
// fileStorage — abstração simples do armazenamento de arquivos (hoje: disco
// local em uploads/<tenantId>/<storedName>). Centraliza a resolução de caminho
// com proteção contra PATH TRAVERSAL e valida que o arquivo pertence ao tenant.
//
// Trocar por storage externo (S3/GCS) no futuro = reimplementar estas funções,
// sem tocar nas rotas. Não migra infraestrutura agora.
// =============================================================================
const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

// storedName válido: UUID + extensão minúscula (ex.: "a1b2...-....pdf"). Nunca
// aceita separadores de caminho, '..' ou nomes fora desse formato.
const STORED_NAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]{1,8}$/;

function isValidStoredName(name) {
  return typeof name === 'string' && STORED_NAME_RE.test(name);
}

// Resolve o caminho físico e garante que fica DENTRO da pasta do tenant.
// Retorna { ok, filePath } ou { ok:false, error }.
function resolvePath(tenantId, storedName) {
  if (!tenantId || !isValidStoredName(storedName)) {
    return { ok: false, error: 'Identificador de arquivo inválido.' };
  }
  const tenantDir = path.resolve(path.join(UPLOADS_ROOT, String(tenantId)));
  const filePath = path.resolve(path.join(tenantDir, storedName));
  // Contenção: o caminho resolvido tem que começar pela pasta do tenant.
  if (filePath !== tenantDir && !filePath.startsWith(tenantDir + path.sep)) {
    return { ok: false, error: 'Caminho inválido.' };
  }
  return { ok: true, filePath };
}

function exists(tenantId, storedName) {
  const r = resolvePath(tenantId, storedName);
  return r.ok && fs.existsSync(r.filePath);
}

// Deriva o storedName a partir de uma file_url legada (…/uploads/<tenant>/<name>).
function storedNameFromUrl(fileUrl) {
  if (!fileUrl) return null;
  const m = /\/uploads\/[^/]+\/([^/?#]+)$/.exec(String(fileUrl));
  return m ? m[1] : null;
}

module.exports = { UPLOADS_ROOT, isValidStoredName, resolvePath, exists, storedNameFromUrl };
