'use client';

// =============================================================================
// Dashboard operacional (SISV) — visão consolidada dos processos de CNH.
// KPIs clicáveis abrem a fila já filtrada. Distribuições por etapa, status,
// responsável e setor. Sem indicadores financeiros/comerciais (fora do escopo).
// Dados reais do backend (/api/processes/dashboard) — nada mockado.
// =============================================================================

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MetricCard, ChartCard, EmptyState, SkeletonRows } from '../components/ui';
import { getProcessDashboard } from '../lib/processesAPI';
import { getClients } from '../lib/clientsAPI';
import { fmtDate } from '../lib/format';


export default function DashboardSISV() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [clientCount, setClientCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setError(null);
        const [dash, clients] = await Promise.all([getProcessDashboard(), getClients().catch(() => [])]);
        setData(dash);
        setClientCount(Array.isArray(clients) ? clients.length : null);
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const goFila = (pre) => router.push(`/dashboard?module=multas&tab=processos${pre ? `&pre=${pre}` : ''}`);

  if (loading) return <div style={{ padding: 24 }}><SkeletonRows rows={3} height={90} /></div>;
  if (error) return <div className="error-message" style={{ margin: 24 }}>{error}</div>;

  const t = data?.totals || {};

  return (
    <div style={{ padding: '4px 2px 24px' }}>
      <div className="nx-page-head" style={{ marginBottom: 16 }}>
        <div><h2>Painel operacional</h2><p>Visão consolidada dos processos de CNH</p></div>
      </div>

      {/* KPIs clicáveis */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 22 }}>
        <MetricCard title="Clientes" value={clientCount ?? '—'} onClick={() => router.push('/dashboard?module=multas&tab=clients')} />
        <MetricCard title="Processos" value={t.total ?? 0} onClick={() => goFila('')} />
        <MetricCard title="Em andamento" value={t.in_progress ?? 0} onClick={() => goFila('andamento')} />
        <MetricCard title="Finalizados" value={t.finalized ?? 0} onClick={() => goFila('finalizados')} />
        <MetricCard title="Com pendência" value={t.pending ?? 0} onClick={() => goFila('pendencia')} tooltip="Processos com status marcado como pendência" />
        <MetricCard title="Prazos vencidos" value={t.overdue ?? 0} onClick={() => goFila('vencidos')} tooltip="Processos em aberto com prazo já vencido" />
        <MetricCard title="Vence em 7 dias" value={t.due_soon ?? 0} onClick={() => goFila('vencendo')} tooltip="Processos em aberto com prazo nos próximos 7 dias" />
        <MetricCard title="Sem responsável" value={t.unassigned ?? 0} onClick={() => goFila('sem-responsavel')} />
        <MetricCard title="Sem movimentação (7d+)" value={t.stale ?? 0} onClick={() => goFila('sem-mov')} tooltip="Processos em aberto sem movimentação há 7 dias ou mais" />
      </div>

      {/* Distribuições */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>
        <ChartCard title="Por etapa" empty={!data?.byStage?.length}>
          <DistList rows={data?.byStage} total={t.total} onClick={() => goFila('')} />
        </ChartCard>
        <ChartCard title="Por status" empty={!data?.byStatus?.length}>
          <DistList rows={data?.byStatus} total={t.total} onClick={() => goFila('')} />
        </ChartCard>
        <ChartCard title="Por responsável (em aberto)" empty={!data?.bySeller?.length}>
          <DistList rows={(data?.bySeller || []).map((r) => ({ label: r.seller_name || 'Sem responsável', count: r.count }))} onClick={() => goFila('andamento')} />
        </ChartCard>
        {(data?.byDepartment?.length > 0) && (
          <ChartCard title="Por setor (em aberto)">
            <DistList rows={(data.byDepartment).map((r) => ({ label: r.department_name || 'Sem setor', count: r.count, color: r.color }))} onClick={() => goFila('andamento')} />
          </ChartCard>
        )}
      </div>

      {/* Movimentações recentes */}
      <ChartCard title="Movimentações recentes" wide empty={!data?.recent?.length}>
        {(data?.recent || []).length === 0 ? (
          <EmptyState small title="Sem movimentações" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {data.recent.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13.5, color: '#0f172a' }}>{r.client_name || '—'}</strong>
                  <span style={{ fontSize: 12.5, color: '#94a3b8' }}>{r.fine_number ? ` · ${r.fine_number}` : ''}</span>
                </div>
                <div style={{ fontSize: 12.5, color: '#64748b', whiteSpace: 'nowrap' }}>
                  {r.seller_name || 'Sem responsável'} · {fmtDate(r.last_moved_at || r.updated_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </ChartCard>
    </div>
  );
}

function DistList({ rows, total, onClick }) {
  const list = rows || [];
  if (list.length === 0) return <EmptyState small title="Sem dados" />;
  const max = Math.max(...list.map((r) => Number(r.count) || 0), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      {list.map((r, i) => {
        const count = Number(r.count) || 0;
        const c = r.color || '#15803d';
        return (
          <div key={i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
              <span style={{ color: '#475569' }}>{r.label}</span>
              <strong style={{ color: '#0f172a' }}>{count}{total ? ` · ${Math.round((count / total) * 100)}%` : ''}</strong>
            </div>
            <div style={{ height: 6, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(count / max) * 100}%`, background: c, borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
