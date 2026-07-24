'use client';

// =============================================================================
// Componentes visuais pequenos e compartilhados do SISV (badges e chips).
// =============================================================================

export function Badge({ label, color }) {
  const c = color || '#64748b';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: `${c}1a`, color: c, whiteSpace: 'nowrap',
    }}>{label || '—'}</span>
  );
}


export function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
      border: `1px solid ${active ? '#15803d' : '#e2e8f0'}`,
      background: active ? '#15803d' : '#fff', color: active ? '#fff' : '#475569',
    }}>{children}</button>
  );
}

// ── Modal de criação ──────────────────────────────────────────────────────────
