'use client';

// =============================================================================
// Componentes visuais pequenos e compartilhados do SISV (badges e chips).
// =============================================================================

export function Badge({ label, color }) {
  const c = color || 'var(--text-secondary)';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: `${c}1a`, color: c, whiteSpace: 'nowrap',
    }}>{label || '—'}</span>
  );
}


export function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`sisv-chip${active ? ' is-active' : ''}`}>
      {children}
    </button>
  );
}

// ── Modal de criação ──────────────────────────────────────────────────────────
