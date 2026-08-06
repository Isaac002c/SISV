// =============================================================================
// pdfService.js — Geração do PDF do recibo no próprio sistema (sem serviço externo).
//
// Usa PDFKit (fontes padrão Helvetica, encoding WinAnsi → acentos pt-BR OK).
// Formato A4, layout limpo, pronto para impressão. Valores no padrão brasileiro
// (R$ e por extenso), datas DD/MM/AAAA.
//
// require('pdfkit') é feito de forma preguiçosa: se a lib não estiver instalada,
// a rota captura o erro e responde 503 (mesmo padrão do envio de e-mail/SMTP),
// sem derrubar o restante do sistema.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { formatBRL, formatDateBR, valorPorExtenso } = require('./calc');
const { PAYMENT_METHOD_LABELS } = require('./constants');

const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#cbd5e1',
  accent: '#3B1F6A',
  lilac: '#A56FFF',
  copper: '#FF6A3D',
};

// Tenta resolver a logo (quando for um arquivo local acessível) para embutir.
function resolveLogoPath(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  if (/^https?:\/\//i.test(logoUrl)) return null;       // não busca remoto
  const clean = logoUrl.replace(/^\/+/, '');
  const candidates = [
    path.join(__dirname, '../../../public', clean),     // saas-multitenant/public
    path.join(__dirname, '../../uploads', clean),        // backend/uploads
    path.join(__dirname, '../../', clean),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

function methodLabel(m) {
  return PAYMENT_METHOD_LABELS[m] || m || '—';
}

// Gera o PDF do recibo e resolve com um Buffer.
function buildReceiptPdf(receipt, branding = {}) {
  // eslint-disable-next-line global-require
  const PDFDocument = require('pdfkit');

  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  const canceled = receipt.status === 'cancelado';

  // ── Cabeçalho: logo + identidade do emissor ────────────────────────────────
  const logoPath = resolveLogoPath(branding.logo_url);
  let headerTextX = left;
  if (logoPath) {
    try { doc.image(logoPath, left, doc.y, { fit: [90, 60] }); headerTextX = left + 104; } catch (_) { /* ignore */ }
  }
  const headerTop = doc.y;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(16)
    .text(branding.name || 'SISV', headerTextX, headerTop, { width: pageWidth - (headerTextX - left) });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
  if (branding.document) doc.text(`CNPJ/CPF: ${branding.document}`, headerTextX);
  if (branding.address)  doc.text(branding.address, headerTextX, doc.y, { width: pageWidth - (headerTextX - left) });
  const contato = [branding.phone, branding.email].filter(Boolean).join('  ·  ');
  if (contato) doc.text(contato, headerTextX);

  doc.moveDown(1.2);
  const yLine = Math.max(doc.y, headerTop + 64);
  doc.moveTo(left, yLine).lineTo(left + pageWidth, yLine).lineWidth(1).strokeColor(COLORS.line).stroke();
  doc.y = yLine + 16;

  // ── Título + número + data ──────────────────────────────────────────────────
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(20)
    .text('RECIBO', left, doc.y, { continued: false });
  const titleY = doc.y - 24;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.accent)
    .text(`Nº ${receipt.full_number}`, left, titleY, { width: pageWidth, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted)
    .text(`Emitido em ${formatDateBR(receipt.issue_date)}`, left, doc.y, { width: pageWidth, align: 'right' });

  if (canceled) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#b91c1c')
      .text('*** RECIBO CANCELADO ***', left, doc.y, { width: pageWidth, align: 'center' });
    if (receipt.cancel_reason) {
      doc.font('Helvetica').fontSize(9).fillColor('#b91c1c')
        .text(`Motivo: ${receipt.cancel_reason}`, { width: pageWidth, align: 'center' });
    }
  }

  doc.moveDown(1);

  // ── Valor em destaque ───────────────────────────────────────────────────────
  const boxY = doc.y;
  doc.roundedRect(left, boxY, pageWidth, 46, 6).fillAndStroke('#f1f5f9', COLORS.line);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('VALOR RECEBIDO', left + 14, boxY + 8);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(18)
    .text(formatBRL(receipt.amount), left + 14, boxY + 20);
  doc.y = boxY + 58;

  // ── Corpo declaratório ──────────────────────────────────────────────────────
  const extenso = valorPorExtenso(receipt.amount);
  const cliente = receipt.client_name || '—';
  const docCli = receipt.client_document ? `, inscrito(a) no CPF/CNPJ sob o nº ${receipt.client_document},` : '';
  const servico = receipt.service_description ? ` referente a ${receipt.service_description}` : '';
  const processo = receipt.fine_number ? ` (processo nº ${receipt.fine_number})` : '';

  doc.font('Helvetica').fontSize(11).fillColor(COLORS.ink).text(
    `Recebemos de ${cliente}${docCli} a importância de ${formatBRL(receipt.amount)} ` +
    `(${extenso})${servico}${processo}, na forma de pagamento: ${methodLabel(receipt.payment_method)}.`,
    left, doc.y, { width: pageWidth, align: 'justify', lineGap: 3 }
  );

  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted).text(
    'Para maior clareza, firmamos o presente recibo dando plena e geral quitação do valor acima especificado.',
    { width: pageWidth, align: 'justify', lineGap: 2 }
  );

  if (receipt.notes) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.accent).text('Observações');
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink).text(receipt.notes, { width: pageWidth });
  }

  // ── Assinatura ──────────────────────────────────────────────────────────────
  doc.moveDown(3);
  const sigY = doc.y;
  const sigWidth = 280;
  const sigX = left + (pageWidth - sigWidth) / 2;
  doc.moveTo(sigX, sigY).lineTo(sigX + sigWidth, sigY).lineWidth(1).strokeColor(COLORS.ink).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.ink)
    .text(branding.name || 'SISV', sigX, sigY + 6, { width: sigWidth, align: 'center' });
  if (branding.document) {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
      .text(branding.document, sigX, doc.y, { width: sigWidth, align: 'center' });
  }
  if (receipt.created_by_name) {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
      .text(`Responsável: ${receipt.created_by_name}`, sigX, doc.y, { width: sigWidth, align: 'center' });
  }

  // ── Rodapé: assinatura padrão do produto ────────────────────────────────────
  // A identidade do emissor (tenant) já aparece no cabeçalho e no bloco de assinatura.
  // Atribuição do produto e da tecnologia, sem competir com o emissor.
  const footerY = doc.page.height - doc.page.margins.bottom + 8;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
    .text('Gerado pelo SISV · Uma solução TELUN', left, footerY, { width: pageWidth, align: 'center' });

  doc.end();
  return done;
}

module.exports = { buildReceiptPdf, resolveLogoPath };
