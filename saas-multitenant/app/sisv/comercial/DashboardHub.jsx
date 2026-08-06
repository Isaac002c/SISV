'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Drawer, EmptyState, SkeletonRows } from '../../components/ui';
import { getDashboardV2 } from '../../lib/operationsAPI';
import { getExecutiveDashboard, getQueue } from '../../lib/commercialAPI';
import { fmtDateTime } from '../../lib/format';
import { DataTable, Notice, SectionHeader, StatusBadge, label, money } from './shared';

export default function DashboardHub() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { setUser(JSON.parse(localStorage.getItem('user') || '{}')); }
    catch { setUser({}); }
    finally { setReady(true); }
  }, []);
  if (!ready) return <SkeletonRows rows={4} height={86} />;
  return user?.role === 'admin' ? <AdminDashboard /> : <UserWelcome user={user} />;
}

const PROFILE_LABELS = {
  admin_full: 'Administrador', sales: 'Vendas', sales_backoffice_l1: 'Vendas / Back Office Nível 1',
  backoffice_l1: 'Back Office Nível 1', backoffice_l2: 'Back Office Nível 2',
  finance: 'Financeiro', custom: 'Acesso personalizado',
  front_office: 'Vendas', sales_backoffice: 'Vendas / Back Office Nível 1',
  back_office: 'Back Office Nível 1', operator: 'Operação', viewer: 'Consulta',
};

function UserWelcome({ user = {} }) {
  const name = user.name || user.username || 'Usuário';
  const firstName = name.trim().split(/\s+/)[0];
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const profile = PROFILE_LABELS[user.access_profile] || PROFILE_LABELS[user.role] || 'Equipe SISV';
  const today = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  }).format(new Date());

  return (
    <div className="sisv-page sisv-user-welcome">
      <section className="sisv-user-welcome-card" aria-labelledby="welcome-title">
        <div className="sisv-user-welcome-avatar" aria-hidden="true">{initials || 'S'}</div>
        <div className="sisv-user-welcome-copy">
          <span className="sisv-user-welcome-kicker">Bem-vindo(a),</span>
          <h2 id="welcome-title">{firstName}!</h2>
          <span className="sisv-user-profile">{profile}</span>
          <p>Seu ambiente de trabalho está pronto. Escolha uma opção no menu lateral para começar.</p>
        </div>
      </section>
      <div className="sisv-user-welcome-note">
        <span aria-hidden="true">✦</span>
        <div><strong>Bom trabalho!</strong><small>{today}</small></div>
      </div>
    </div>
  );
}

function AdminDashboard() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [period, setPeriod] = useState({ date_from: monthAgo, date_to: today });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError('');
      const [operation, executive] = await Promise.all([
        getDashboardV2(period), getExecutiveDashboard(period),
      ]);
      setData({ operation, executive });
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <SkeletonRows rows={5} height={86} />;
  if (!data) return <EmptyState title="Dashboard indisponível" description={error} />;

  const ops = data.operation || {};
  const exec = data.executive || {};
  const overview = ops.overview || {};
  const commercial = exec.comercial || {};
  const receipts = exec.recebimentos || {};
  const execution = exec.operacao || {};
  const finalization = exec.finalizacao || {};
  const goProcesses = (params = '') => router.push(`/dashboard?module=multas&tab=processos${params ? `&${params}` : ''}`);

  const priorities = [
    { label: 'Pagamentos para validar', value: receipts.pagamentos_aguardando_validacao, queue: 'pagamentos_conferencia' },
    { label: 'Ordens aguardando execução', value: execution.aguardando_execucao, queue: 'execucao_liberacao' },
    { label: 'Ordens atrasadas', value: execution.atrasadas, tone: 'danger', onClick: () => router.push('/dashboard?module=multas&tab=execucao') },
    { label: 'Finalizações pendentes', value: finalization.aguardando_documentos, queue: 'finalizacoes_pendentes' },
  ];
  const flow = [
    ['Pedidos', commercial.pedidos_criados], ['Vendas', commercial.vendas_confirmadas],
    ['Em execução', execution.em_execucao], ['Concluídos', execution.concluidas],
  ];

  return (
    <div className="sisv-page sisv-admin-dashboard">
      <SectionHeader breadcrumb={['Início', 'Dashboard']} title="Dashboard administrativo"
        subtitle="O que precisa de atenção agora e o resultado dos últimos 30 dias." />
      <div className="sisv-admin-period">
        <label htmlFor="admin-from">De</label>
        <input id="admin-from" type="date" value={period.date_from}
          onChange={(event) => setPeriod({ ...period, date_from: event.target.value })} />
        <label htmlFor="admin-to">Até</label>
        <input id="admin-to" type="date" value={period.date_to}
          onChange={(event) => setPeriod({ ...period, date_to: event.target.value })} />
        <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
          {loading ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <section className="sisv-admin-kpis" aria-label="Indicadores principais">
        <Kpi label="Em andamento" value={overview.in_progress || 0} onClick={() => goProcesses('finalized=false')} />
        <Kpi label="Prazos vencidos" value={overview.overdue || 0} tone="danger" onClick={() => goProcesses('overdue=true')} />
        <Kpi label="Pendências abertas" value={overview.task_open || 0}
          onClick={() => router.push('/dashboard?module=multas&tab=meu-trabalho')} />
        <Kpi label="Recebido no período" value={money(receipts.valor_recebido)} tone="success" />
      </section>

      <div className="sisv-admin-layout">
        <section className="sisv-admin-card sisv-admin-priorities">
          <div className="sisv-admin-card-head"><h3>Prioridades de hoje</h3><span>clique para abrir</span></div>
          <div className="sisv-priority-list">
            {priorities.map((item) => (
              <button key={item.label} type="button" className={item.tone === 'danger' ? 'is-danger' : ''}
                onClick={item.queue ? () => setQueue(item.queue) : item.onClick}>
                <span>{item.label}</span><strong>{item.value || 0}</strong>
              </button>
            ))}
          </div>
        </section>

        <section className="sisv-admin-card">
          <div className="sisv-admin-card-head"><h3>Fluxo do período</h3></div>
          <div className="sisv-admin-flow">
            {flow.map(([name, value], index) => (
              <div key={name}><span>{index + 1}</span><strong>{value || 0}</strong><small>{name}</small></div>
            ))}
          </div>
        </section>

        <section className="sisv-admin-card">
          <div className="sisv-admin-card-head"><h3>Financeiro resumido</h3></div>
          <dl className="sisv-admin-finance">
            <div><dt>Previsto</dt><dd>{money(receipts.valor_previsto)}</dd></div>
            <div><dt>Recebido</dt><dd className="is-success">{money(receipts.valor_recebido)}</dd></div>
            <div><dt>Pendente</dt><dd>{money(receipts.valor_pendente)}</dd></div>
          </dl>
        </section>

        <section className="sisv-admin-card">
          <div className="sisv-admin-card-head"><h3>Carga da equipe</h3><span>ordens abertas</span></div>
          {(execution.carga_por_responsavel || []).length ? (
            <ul className="sisv-team-load">
              {execution.carga_por_responsavel.slice(0, 5).map((row) => (
                <li key={row.owner_id || row.owner_name}>
                  <span>{row.owner_name || 'Sem responsável'}</span>
                  <strong>{row.total || 0}</strong>
                  {Number(row.atrasadas) > 0 && <small>{row.atrasadas} atrasada(s)</small>}
                </li>
              ))}
            </ul>
          ) : <p className="sisv-muted">Nenhuma ordem em aberto.</p>}
        </section>
      </div>
      {queue && <QueueDrawer queueKey={queue} onClose={() => setQueue(null)} />}
    </div>
  );
}

function Kpi({ label: text, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return <Tag type={onClick ? 'button' : undefined} onClick={onClick}
    className={`sisv-admin-kpi${tone ? ` is-${tone}` : ''}${onClick ? ' is-clickable' : ''}`}>
    <strong>{value}</strong><span>{text}</span>
  </Tag>;
}

function QueueDrawer({ queueKey, onClose }) {
  const [state, setState] = useState({ rows: [], loading: true, error: '', title: '' });
  useEffect(() => {
    getQueue(queueKey, { limit: 50 }).then((result) => setState({
      rows: result.rows, loading: false, error: '', title: result.label,
    })).catch((error) => setState({ rows: [], loading: false, error: error.message, title: '' }));
  }, [queueKey]);
  const columns = [
    { key: 'number', header: 'Registro', render: (row) => <strong>{row.number || row.sale_number || row.id?.slice(0, 8)}</strong> },
    { key: 'client_name', header: 'Cliente', render: (row) => row.client_name || '—' },
    { key: 'status', header: 'Situação', render: (row) => row.status ? <StatusBadge value={row.status} /> : '—' },
    { key: 'total', header: 'Valor', align: 'right', render: (row) => row.total != null ? money(row.total) : '—' },
    { key: 'since', header: 'Desde', render: (row) => row.since ? fmtDateTime(row.since) : '—' },
  ];
  return <Drawer open title={state.title || label(queueKey)} onClose={onClose}>
    <DataTable caption={state.title} columns={columns} rows={state.rows} loading={state.loading}
      error={state.error} emptyTitle="Fila vazia" emptyDescription="Nada precisa de atenção aqui." />
  </Drawer>;
}
