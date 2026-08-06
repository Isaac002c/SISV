'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChartCard, EmptyState, MetricCard, SkeletonRows } from '../components/ui';
import { getDashboardV2 } from '../lib/operationsAPI';

export default function DashboardV2() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [period, setPeriod] = useState({ date_from: monthAgo, date_to: today });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = async () => {
    try { setLoading(true); setError(''); setData(await getDashboardV2(period)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (params = '') => router.push(`/dashboard?module=multas&tab=processos${params ? `&${params}` : ''}`);
  if (loading && !data) return <SkeletonRows rows={6} height={86} />;
  if (!data) return <EmptyState title="Dashboard indisponível" description={error} />;
  const o = data.overview || {};
  const operation = data.operation || {};
  const productivity = data.productivity || {};
  return (
    <div className="clients-page">
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'end', flexWrap: 'wrap', marginBottom: 14 }}>
        <label className="form-group" style={{ margin: 0 }}>De<input type="date" value={period.date_from} onChange={(event) => setPeriod({ ...period, date_from: event.target.value })} /></label>
        <label className="form-group" style={{ margin: 0 }}>Até<input type="date" value={period.date_to} onChange={(event) => setPeriod({ ...period, date_to: event.target.value })} /></label>
        <button className="btn-primary" onClick={load} disabled={loading}>{loading ? 'Atualizando…' : 'Aplicar período'}</button>
      </div>
      {error && <div className="error-message">{error}</div>}
      <h3 style={sectionTitle}>Visão geral</h3>
      <div style={metricGrid}>
        <MetricCard title="Em andamento" value={o.in_progress || 0} onClick={() => go('finalized=false')} />
        <MetricCard title="Finalizados no período" value={o.finalized_period || 0} onClick={() => go('finalized=true')} />
        <MetricCard title="Prazos vencidos" value={o.overdue || 0} onClick={() => go('overdue=true')} />
        <MetricCard title="Prazos próximos" value={o.due_soon || 0} onClick={() => go(`due_soon=${data.settings?.due_soon_days || 7}`)} />
        <MetricCard title="Pendências abertas" value={o.task_open || 0} onClick={() => router.push('/dashboard?module=multas&tab=meu-trabalho')} />
        <MetricCard title="Pendências vencidas" value={o.task_overdue || 0} onClick={() => router.push('/dashboard?module=multas&tab=meu-trabalho')} />
        <MetricCard title="Documentos faltantes" value={o.missing_documents || 0} onClick={() => go('missing_documents=true')} />
      </div>
      <h3 style={sectionTitle}>Operação</h3>
      <div style={chartGrid}>
        <ChartCard title="Processos por etapa" empty={!operation.byStage?.length}><Dist rows={operation.byStage} onClick={(row) => go(`stage=${encodeURIComponent(row.code)}`)} /></ChartCard>
        <ChartCard title="Processos por status" empty={!operation.byStatus?.length}><Dist rows={operation.byStatus} onClick={(row) => go(`status=${encodeURIComponent(row.code)}`)} /></ChartCard>
        <ChartCard title="Processos por setor" empty={!operation.byDepartment?.length}><Dist rows={operation.byDepartment} onClick={(row) => go(`department_id=${row.id || 'none'}`)} /></ChartCard>
        <ChartCard title="Carga por responsável" empty={!operation.bySeller?.length}><Dist rows={operation.bySeller} onClick={(row) => go(`seller_id=${row.id || 'none'}`)} /></ChartCard>
        <ChartCard title="Por tipo de serviço" empty={!operation.byService?.length}><Dist rows={operation.byService} onClick={(row) => go(`tenant_service_type_id=${row.id}`)} /></ChartCard>
        <ChartCard title="Aging dos processos" empty={!Object.keys(operation.aging || {}).length}>
          <Dist
            rows={Object.entries(operation.aging || {}).map(([code, count]) => ({ code, label: code.replaceAll('_', ' '), count }))}
            onClick={(row) => go(`aging=${encodeURIComponent(row.code)}`)}
          />
        </ChartCard>
      </div>
      <h3 style={sectionTitle}>Produtividade</h3>
      <div style={metricGrid}>
        <MetricCard title="Movimentações no período" value={productivity.movements || 0} />
        <MetricCard title="Tempo médio de conclusão" value={`${Number(productivity.averageCompletionDays || 0).toFixed(1)} dias`} />
        <MetricCard title="Sem responsável" value={data.attention?.unassigned || 0} onClick={() => go('seller_id=none')} />
        <MetricCard title="Sem movimentação" value={data.attention?.stale || 0} onClick={() => go(`stale_days=${data.settings?.stale_after_days || 7}`)} />
        <MetricCard title="Pendências críticas" value={data.attention?.taskCritical || 0} onClick={() => router.push('/dashboard?module=multas&tab=meu-trabalho')} />
      </div>
      <div style={chartGrid}>
        <ChartCard title="Processos finalizados por usuário" empty={!productivity.finalizedByUser?.length}><Dist rows={productivity.finalizedByUser} /></ChartCard>
        <ChartCard title="Pendências concluídas por usuário" empty={!productivity.tasksCompletedByUser?.length}><Dist rows={productivity.tasksCompletedByUser} /></ChartCard>
        <ChartCard title="Carga atual" empty={!productivity.workload?.length}><Dist rows={(productivity.workload || []).map((row) => ({ label: row.label, count: Number(row.process_count) + Number(row.task_count) }))} /></ChartCard>
      </div>
    </div>
  );
}

function Dist({ rows = [], onClick }) {
  if (!rows.length) return <EmptyState small title="Sem dados" />;
  const max = Math.max(...rows.map((row) => Number(row.count) || 0), 1);
  const palette = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{rows.map((row, index) => {
    const count = Number(row.count) || 0;
    return <button key={row.id || row.code || row.label || index} onClick={() => onClick?.(row)} disabled={!onClick} style={{ border: 0, background: 'none', padding: 0, textAlign: 'left', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}><span>{row.label}</span><strong>{count}</strong></div>
      <div className="sisv-chart-track"><div className={`sisv-chart-bar sisv-chart-bar--${index % palette.length + 1}`} style={{ width: `${count / max * 100}%`, background: palette[index % palette.length] }} /></div>
    </button>;
  })}</div>;
}

const metricGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(175px,1fr))', gap: 12, marginBottom: 22 };
const chartGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(290px,1fr))', gap: 14, marginBottom: 22 };
const sectionTitle = { fontSize: 14, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-secondary)', margin: '18px 0 10px' };
