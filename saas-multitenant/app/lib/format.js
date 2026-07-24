// =============================================================================
// format.js — Formatação compartilhada do SISV (datas, prazos, tamanhos).
// Fonte única: antes cada tela tinha sua própria cópia destes helpers, o que
// abria espaço para divergência (ex.: regra de prazo diferente entre telas).
// =============================================================================

// dd/mm/aaaa a partir de 'YYYY-MM-DD' ou ISO. Timezone-safe (fatia a string).
export const fmtDate = (v) => {
  if (!v) return '—';
  const [y, m, d] = String(v).substring(0, 10).split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : '—';
};

// dd/mm/aaaa hh:mm (local).
export const fmtDateTime = (v) => {
  if (!v) return '—';
  const dt = new Date(v);
  return isNaN(dt) ? '—' : dt.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

// 'YYYY-MM-DD' para <input type="date">.
export const toInputDate = (v) => (v ? String(v).substring(0, 10) : '');

// Dias inteiros decorridos desde uma data/hora.
export const daysSince = (v) => {
  if (!v) return null;
  return Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
};

// Tamanho de arquivo legível.
export const fmtSize = (b) => {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

// ── Prazo com urgência ───────────────────────────────────────────────────────
// Compara por DATA-STRING em UTC, igual à regra do backend (due_date < hoje),
// evitando divergência por fuso. Processo finalizado é neutro (não é "vencido").
// Retorna { text, color, weight, tag }.
export const prazoInfo = (due, finalized) => {
  if (!due) return { text: '—', color: '#94a3b8', weight: 400, tag: '' };
  const s = String(due).substring(0, 10);
  const [y, m, d] = s.split('-');
  const label = `${d}/${m}/${y}`;
  if (finalized) return { text: label, color: '#94a3b8', weight: 400, tag: '' };
  const todayStr = new Date().toISOString().slice(0, 10);
  if (s < todayStr) return { text: label, color: '#ef4444', weight: 700, tag: 'vencido' };
  if (s === todayStr) return { text: label, color: '#f59e0b', weight: 700, tag: 'hoje' };
  const diff = Math.round((Date.parse(s) - Date.parse(todayStr)) / 86400000);
  if (diff <= 7) return { text: label, color: '#f59e0b', weight: 600, tag: `${diff}d` };
  return { text: label, color: '#334155', weight: 400, tag: '' };
};

// Considera "parado" um processo em aberto sem movimentação há N dias.
export const isStale = (lastMovedAt, finalizedAt, days = 7) =>
  !finalizedAt && daysSince(lastMovedAt) >= days;
