'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, SkeletonRows } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';
import { getMyWork, taskAction } from '../lib/operationsAPI';
import { Badge } from './ui';

const sections = [
  ['overdueTasks', 'Pendências vencidas', '#dc2626'],
  ['todayTasks', 'Pendências para hoje', '#d97706'],
  ['nextTasks', 'Próximos 7 dias', '#2563eb'],
  ['openTasks', 'Pendências abertas', '#7c3aed'],
  ['processes', 'Processos sob responsabilidade', '#7B43CE'],
  ['staleProcesses', 'Processos sem movimentação', '#b45309'],
  ['waitingDocument', 'Aguardando documento', '#be123c'],
  ['recentlyCompleted', 'Concluídas recentemente', '#0f766e'],
];

export default function MeuTrabalho() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [active, setActive] = useState('overdueTasks');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    q: '', priority: '', deadline: '', type: '', stage: '',
    process_status: '', department: '', situation: '',
  });

  const load = async () => {
    try {
      setLoading(true);
      setData(await getMyWork());
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const act = async (task, action) => {
    let body = {};
    if (action === 'complete') {
      const note = window.prompt('Resultado/observação da conclusão:');
      if (!note) return;
      body = { completion_note: note, result: 'Concluída' };
    }
    try {
      setBusy(task.id);
      await taskAction(task.id, action, body);
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(null); }
  };

  const openProcess = (id) => router.push(`/dashboard?module=multas&tab=processos&process=${id}`);
  if (loading) return <SkeletonRows rows={8} />;
  if (!data) return <EmptyState title="Não foi possível carregar seu trabalho" description={error} />;
  const taskSection = active.toLowerCase().includes('task') || active === 'recentlyCompleted';
  const allItems = Object.entries(data)
    .filter(([, value]) => Array.isArray(value))
    .flatMap(([, value]) => value);
  const option = (value, label = value) => ({ value: String(value || ''), label: String(label || value || '') });
  const unique = (items) => [...new Map(items.filter((item) => item.value).map((item) => [item.value, item])).values()];
  const options = {
    types: unique(allItems.filter((item) => item.fine_id).map((item) => option(item.task_type_id, item.task_type_label))),
    stages: unique(allItems.map((item) => option(item.process_stage || item.stage))),
    statuses: unique(allItems.map((item) => option(item.fine_id ? item.process_status : item.status))),
    departments: unique(allItems.map((item) => option(item.department_id, item.department_name))),
    situations: unique(allItems.filter((item) => item.fine_id).map((item) => option(item.status))),
  };
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const inSevenDays = new Date(now.getTime() + 7 * 86400000);
  const rows = (data[active] || []).filter((item) => {
    const haystack = [item.title, item.fine_number, item.protocol_number, item.client_name]
      .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
    if (filters.q && !haystack.includes(filters.q.toLocaleLowerCase('pt-BR'))) return false;
    if (filters.priority && item.priority !== filters.priority) return false;
    if (filters.type && String(item.task_type_id || '') !== filters.type) return false;
    if (filters.stage && String(item.process_stage || item.stage || '') !== filters.stage) return false;
    if (filters.process_status && String(item.fine_id ? item.process_status : item.status || '') !== filters.process_status) return false;
    if (filters.department && String(item.department_id || '') !== filters.department) return false;
    if (filters.situation && (!item.fine_id || item.status !== filters.situation)) return false;
    if (filters.deadline) {
      const raw = item.due_at || item.due_date;
      if (!raw) return filters.deadline === 'sem_prazo';
      const date = new Date(raw);
      const dateKey = date.toISOString().slice(0, 10);
      if (filters.deadline === 'vencido' && !(date < now && dateKey !== today)) return false;
      if (filters.deadline === 'hoje' && dateKey !== today) return false;
      if (filters.deadline === 'proximos_7' && !(date > now && date <= inSevenDays)) return false;
      if (filters.deadline === 'sem_prazo') return false;
    }
    return true;
  });

  return (
    <div className="clients-page">
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0, color: '#0f172a' }}>Meu Trabalho</h2>
        <p style={{ margin: '5px 0 0', color: '#64748b', fontSize: 14 }}>
          {data.scope === 'tenant' ? 'Visão da equipe para gestão operacional.' : 'Prioridades relacionadas ao seu usuário.'}
        </p>
      </div>
      {error && <div className="error-message" role="alert">{error}<button aria-label="Fechar erro" onClick={() => setError('')}>×</button></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 18 }}>
        {sections.map(([key, label, color]) => (
          <button key={key} onClick={() => setActive(key)} aria-pressed={active === key} style={{
            textAlign: 'left', padding: 14, borderRadius: 10, cursor: 'pointer',
            border: `1px solid ${active === key ? color : '#e2e8f0'}`,
            background: active === key ? `${color}0d` : '#fff',
          }}>
            <div style={{ fontSize: 25, fontWeight: 800, color }}>{data.counts?.[key] || 0}</div>
            <div style={{ fontSize: 12.5, color: '#475569', fontWeight: 600 }}>{label}</div>
          </button>
        ))}
      </div>
      <div className="clients-toolbar" aria-label="Filtros de Meu Trabalho" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <input aria-label="Buscar em Meu Trabalho" placeholder="Processo, cliente ou pendência…" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
        <select aria-label="Filtrar prioridade" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}>
          <option value="">Todas as prioridades</option>
          <option value="baixa">Baixa</option><option value="normal">Normal</option>
          <option value="alta">Alta</option><option value="critica">Crítica</option>
        </select>
        <select aria-label="Filtrar prazo" value={filters.deadline} onChange={(event) => setFilters({ ...filters, deadline: event.target.value })}>
          <option value="">Todos os prazos</option><option value="vencido">Vencidos</option>
          <option value="hoje">Hoje</option><option value="proximos_7">Próximos 7 dias</option>
          <option value="sem_prazo">Sem prazo</option>
        </select>
        <FilterSelect label="Filtrar tipo" value={filters.type} onChange={(value) => setFilters({ ...filters, type: value })} options={options.types} empty="Todos os tipos" />
        <FilterSelect label="Filtrar etapa" value={filters.stage} onChange={(value) => setFilters({ ...filters, stage: value })} options={options.stages} empty="Todas as etapas" />
        <FilterSelect label="Filtrar status do processo" value={filters.process_status} onChange={(value) => setFilters({ ...filters, process_status: value })} options={options.statuses} empty="Todos os status" />
        <FilterSelect label="Filtrar setor" value={filters.department} onChange={(value) => setFilters({ ...filters, department: value })} options={options.departments} empty="Todos os setores" />
        <FilterSelect label="Filtrar situação" value={filters.situation} onChange={(value) => setFilters({ ...filters, situation: value })} options={options.situations} empty="Todas as situações" />
        {Object.values(filters).some(Boolean) && (
          <button className="btn-secondary" onClick={() => setFilters({ q: '', priority: '', deadline: '', type: '', stage: '', process_status: '', department: '', situation: '' })}>Limpar filtros</button>
        )}
      </div>
      <section aria-live="polite">
        <h3 style={{ fontSize: 15, color: '#334155' }}>{sections.find(([key]) => key === active)?.[1]} <span style={{ color: '#94a3b8', fontWeight: 500 }}>({rows.length})</span></h3>
        {rows.length === 0 ? <EmptyState small title="Nenhum item nesta fila" description="Tudo em dia por aqui." /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
                <button onClick={() => openProcess(item.fine_id || item.id)} style={{ flex: 1, minWidth: 0, border: 0, background: 'none', textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>{item.title || item.fine_number || item.client_name || 'Processo'}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
                    {[item.client_name, item.fine_number, item.assignee_name || item.seller_name, item.department_name].filter(Boolean).join(' · ')}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 3 }}>
                    {item.due_at ? `Prazo: ${fmtDateTime(item.due_at)}` : item.due_date ? `Prazo: ${fmtDate(item.due_date)}` : `Movimentação: ${fmtDate(item.last_moved_at || item.updated_at)}`}
                  </div>
                </button>
                {item.priority && <Badge label={item.priority} color={item.priority === 'critica' ? '#dc2626' : item.priority === 'alta' ? '#d97706' : '#64748b'} />}
                {taskSection && !['concluida', 'cancelada'].includes(item.status) && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {item.status === 'aberta' && <button className="btn-secondary" disabled={busy === item.id} onClick={() => act(item, 'start')}>Iniciar</button>}
                    <button className="btn-primary" disabled={busy === item.id} onClick={() => act(item, 'complete')}>Concluir</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, empty }) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{empty}</option>
      {options.map((item) => <option key={item.value} value={item.value}>{item.label.replaceAll('_', ' ')}</option>)}
    </select>
  );
}
