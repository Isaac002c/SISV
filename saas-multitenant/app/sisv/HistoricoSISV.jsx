'use client';

// =============================================================================
// Histórico (SISV) — registro consolidado das movimentações dos processos de CNH.
// Lê os logs reais do backend (/api/fines/logs/all), gerados automaticamente em
// cada ação (criação, etapa, status, redistribuição, setor, documento,
// observação, finalização, reabertura). Sem dados mockados.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { PageHead, EmptyState, SkeletonRows, Pagination } from '../components/ui';
import { getAllFineLogs } from '../lib/finesAPI';
import { fmtDateTime } from '../lib/format';

const PAGE = 40;

const ACTION_LABELS = {
  created: 'Processo criado', stage_changed: 'Mudança de etapa', status_changed: 'Mudança de status',
  seller_changed: 'Redistribuição', department_changed: 'Troca de setor', document_added: 'Documento anexado',
  document_removed: 'Documento removido', note_added: 'Observação', finalized: 'Finalização', reopened: 'Reabertura',
};
const ACTION_COLORS = {
  created: '#0ea5e9', stage_changed: '#8b5cf6', status_changed: '#f59e0b', seller_changed: '#14b8a6',
  department_changed: '#6366f1', document_added: '#16a34a', document_removed: '#ef4444', note_added: '#64748b',
  finalized: '#16a34a', reopened: '#f59e0b',
};


export default function HistoricoSISV() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [filterAction, setFilterAction] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const data = await getAllFineLogs(500, 0);
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = filterAction ? logs.filter((l) => l.action === filterAction) : logs;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageItems = filtered.slice((page - 1) * PAGE, page * PAGE);
  const actions = [...new Set(logs.map((l) => l.action))];

  return (
    <div className="clients-page">
      <PageHead title="Histórico" subtitle="Todas as movimentações dos processos — quem fez, quando e o quê" />

      {error && <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="clients-toolbar" style={{ marginBottom: 14 }}>
        <select className="clients-filter-select" value={filterAction} onChange={(e) => { setPage(1); setFilterAction(e.target.value); }}>
          <option value="">Todas as ações</option>
          {actions.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
        </select>
      </div>

      {loading ? <SkeletonRows rows={8} /> : filtered.length === 0 ? (
        <EmptyState title="Sem histórico" description="As movimentações dos processos aparecerão aqui." />
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {pageItems.map((l) => (
              <div key={l.id} style={{ display: 'flex', gap: 12, padding: '11px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: ACTION_COLORS[l.action] || '#94a3b8', marginTop: 6, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13.5, color: '#0f172a' }}>{ACTION_LABELS[l.action] || l.action}</strong>
                    <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{fmtDateTime(l.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 2 }}>
                    {l.client_name ? `${l.client_name}` : ''}{l.fine_number ? ` · ${l.fine_number}` : ''}
                    {(l.old_value || l.new_value) ? ` — ${l.old_value ? `${l.old_value} → ` : ''}${l.new_value || ''}` : ''}
                  </div>
                  {l.user_name && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 1 }}>por {l.user_name}</div>}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} pages={pages} total={filtered.length} onPage={setPage} />
        </>
      )}
    </div>
  );
}
