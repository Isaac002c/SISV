const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const {
  ALLOWED_MIMES, ALLOWED_EXTENSIONS, MAX_SIZE,
  safeExtension, sanitizeDisplayName, validateStoredFile,
} = require('../services/fileValidation');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', req.tenantId || 'default');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Nome físico NÃO previsível: UUID + extensão segura da allowlist.
    const ext = safeExtension(file.originalname);
    cb(null, crypto.randomUUID() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    // Primeira barreira: extensão na allowlist + MIME declarado coerente.
    const ext = safeExtension(file.originalname);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Extensão não permitida. Use PDF, JPG, PNG ou WEBP.'));
    }
    if (!ALLOWED_MIMES.includes(String(file.mimetype).toLowerCase())) {
      return cb(new Error('Tipo de arquivo não permitido. Use PDF, JPG, PNG ou WEBP.'));
    }
    cb(null, true);
  },
});

// POST /api/upload
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
  }

  // Segunda barreira: valida a ASSINATURA (magic bytes) do conteúdo já gravado.
  // Não confia no Content-Type do navegador. Se inválido, remove o arquivo.
  const check = validateStoredFile(req.file.path, req.file.originalname, req.file.mimetype, req.file.size);
  if (!check.ok) {
    try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
    return res.status(400).json({ success: false, error: check.error });
  }

  const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
  const fileUrl = `${baseUrl}/uploads/${req.tenantId}/${req.file.filename}`;

  res.json({
    success: true,
    data: {
      url:          fileUrl,
      filename:     req.file.filename,      // storedName (UUID.ext) — para download controlado
      originalName: sanitizeDisplayName(req.file.originalname),
      mimeType:     req.file.mimetype,
      size:         req.file.size,
    },
  });
});

// Tratamento de erros do multer
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'Arquivo muito grande. Tamanho máximo: 10MB.' });
  }
  return res.status(400).json({ success: false, error: (err && err.message) || 'Erro no upload' });
});

module.exports = router;
