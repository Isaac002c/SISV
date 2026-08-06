'use strict';

// Excel/LibreOffice interpretam celulas iniciadas por = + - @ como formulas.
// O apostrofo e o mecanismo de texto literal suportado por essas planilhas.
function sanitizeCsvValue(value) {
  if (value === null || value === undefined) return '';
  let text = String(value)
    .replace(/\u0000/g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\u2028\u2029]/g, ' ');
  if (/^[\t ]*[=+\-@]/.test(text)) text = `'${text}`;
  return text;
}

function csvCell(value, separator = ';') {
  const text = sanitizeCsvValue(value);
  // Sempre entre aspas: protege separador, aspas e espacos nas extremidades.
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows, columns, { separator = ';', bom = true } = {}) {
  const header = columns.map((column) => csvCell(column.label, separator)).join(separator);
  const lines = [header];
  for (const row of rows) {
    lines.push(columns.map((column) => {
      const value = typeof column.value === 'function' ? column.value(row) : row[column.value];
      return csvCell(value, separator);
    }).join(separator));
  }
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}`;
}

module.exports = { sanitizeCsvValue, csvCell, toCsv };

