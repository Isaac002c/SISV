'use client';

// =============================================================================
// DashboardExecutivo.jsx — seções comerciais do dashboard (§36).
//
// Complementa o dashboard operacional já existente (DashboardV2) em vez de
// substituí-lo. Cada indicador é clicável e ABRE A FILA correspondente do back
// office, como pede o §36 — nenhum número é decorativo.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Drawer } from '../../components/ui';
import { getExecutiveDashboard, getQueue } from '../../lib/commercialAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { DataTable, Notice, StatusBadge, money, label } from './shared';

/**
 * Cada indicador aponta para a fila que o explica. `queue` nulo = indicador
 * puramente informativo (não existe fila equivalente).
 */
const SECTIONS = [
  {
    key: 'comercial',
    title: 'Comercial',
    metrics: [
      { key: 'pedidos_criados', label: 'Pedidos criados' },
      { key: 'pedidos_aprovados', label: 'Pedidos aprovados', queue: 'pedidos_prontos_venda' },
      { key: 'pedidos_cancelados', label: 'Pedidos cancelados' },
      { key: 'vendas_confirmadas', label: 'Vendas confirmadas', queue: 'vendas_sem_ordem' },
      { key: 'ticket_medio', label: 'Ticket médio', format: 'money' },
      { key: 'valor_vendido', label: 'Valor vendido', format: 'money' },
    ],
  },
  {
    key: 'recebimentos',
    title: 'Recebimentos',
    metrics: [
      { key: 'valor_previsto', label: 'Valor previsto', format: 'money' },
      { key: 'valor_recebido', label: 'Valor recebido', format: 'money' },
      { key: 'valor_pendente', label: 'Valor pendente', format: 'money' },
      { key: 'valor_vencido', label: 'Valor vencido', format: 'money', tone: 'danger' },
      { key: 'pagamentos_aguardando_validacao', label: 'Pagamentos aguardando validação',
        queue: 'pagamentos_conferencia', tone: 'warning' },
    ],
  },
  {
    key: 'operacao',
    title: 'Operação',
    metrics: [
      { key: 'aguardando_execucao', label: 'Ordens aguardando execução', queue: 'execucao_liberacao' },
      { key: 'em_execucao', label: 'Ordens em execução' },
      { key: 'concluidas', label: 'Ordens concluídas' },
      { key: 'atrasadas', label: 'Ordens atrasadas', tone: 'danger' },
    ],
  },
  {
    key: 'custos',
    title: 'Custos',
    metrics: [
      { key: 'custo_previsto', label: 'Custos previstos', format: 'money' },
      { key: 'custo_realizado', label: 'Custos realizados', format: 'money' },
      { key: 'pagamentos_pendentes', label: 'Pagamentos pendentes', format: 'money', tone: 'warning' },
      { key: 'comissoes_pendentes', label: 'Comissões pendentes', format: 'money', tone: 'warning' },
      { key: 'margem_estimada', label: 'Margem estimada', format: 'money' },
    ],
  },
  {
    key: 'finalizacao',
    title: 'Finalização',
    metrics: [
      { key: 'aguardando_documentos', label: 'Ordens aguardando finalização',
        queue: 'finalizacoes_pendentes' },
      { key: 'notas_pendentes', label: 'Notas fiscais pendentes', queue: 'notas_pendentes' },
      { key: 'prontos_arquivamento', label: 'Prontos para arquivamento',
        queue: 'prontos_arquivamento' },
    ],
  },
];

export default function DashboardExecutivo() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState({ date_from: '', date_to: '' });
  const [queue, setQueue] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await getExecutiveDashboard(period));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="sisv-muted">Carregando indicadores comerciais…</p>;

  return (
    <section className="sisv-exec" aria-label="Indicadores comerciais">
      <div className="sisv-exec-head">
        <h3>Visão comercial e financeira</h3>
        <div className="sisv-exec-period">
          <label htmlFor="exec-from">De</label>
          <input id="exec-from" type="date" value={period.date_from}
            onChange={(event) => setPeriod({ ...period, date_from: event.target.value })} />
          <label htmlFor="exec-to">Até</label>
          <input id="exec-to" type="date" value={period.date_to}
            onChange={(event) => setPeriod({ ...period, date_to: event.target.value })} />
        </div>
      </div>
      <p className="sisv-muted">
        Período de {fmtDate(data.period.from)} a {fmtDate(data.period.to)}. Clique num indicador com
        fila para abrir a lista correspondente.
      </p>

      {SECTIONS.map((section) => (
        <div key={section.key} className="sisv-exec-section">
          <h4>{section.title}</h4>
          <div className="sisv-exec-grid">
            {section.metrics.map((metric) => {
              const value = data[section.key]?.[metric.key];
              const display = metric.format === 'money' ? money(value) : (value ?? 0);
              const clickable = Boolean(metric.queue);
              return (
                <button
                  key={metric.key}
                  type="button"
                  className={`sisv-exec-card${clickable ? ' is-clickable' : ''}${metric.tone ? ` tone-${metric.tone}` : ''}`}
                  disabled={!clickable}
                  aria-label={clickable ? `${metric.label}: ${display}. Abrir fila.` : `${metric.label}: ${display}`}
                  onClick={clickable ? () => setQueue(metric.queue) : undefined}
                >
                  <span className="sisv-exec-value">{display}</span>
                  <span className="sisv-exec-label">{metric.label}</span>
                  {clickable && <span className="sisv-exec-hint">abrir fila</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {data.operacao?.carga_por_responsavel?.length > 0 && (
        <div className="sisv-exec-section">
          <h4>Carga por responsável</h4>
          <ul className="sisv-list">
            {data.operacao.carga_por_responsavel.map((row) => (
              <li key={row.owner_id}>
                <span>{row.owner_name}</span>
                <span>{row.total} ordem(ns) em aberto</span>
                {row.atrasadas > 0
                  ? <StatusBadge value="vencido" />
                  : <span className="sisv-muted">em dia</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {queue && <QueueDrawer queueKey={queue} onClose={() => setQueue(null)} />}
    </section>
  );
}

function QueueDrawer({ queueKey, onClose }) {
  const [state, setState] = useState({ rows: [], loading: true, error: '', label: '' });

  useEffect(() => {
    getQueue(queueKey, { limit: 50 })
      .then((result) => setState({
        rows: result.rows, total: result.total, loading: false, error: '', label: result.label,
      }))
      .catch((error) => setState({ rows: [], loading: false, error: error.message, label: '' }));
  }, [queueKey]);

  const columns = [
    { key: 'number', header: 'Registro',
      render: (row) => <strong>{row.number || row.sale_number || row.id?.slice(0, 8)}</strong> },
    { key: 'client_name', header: 'Cliente', render: (row) => row.client_name || '—' },
    { key: 'status', header: 'Situação',
      render: (row) => (row.status ? <StatusBadge value={row.status} /> : '—') },
    { key: 'total', header: 'Valor', align: 'right',
      render: (row) => (row.total != null ? money(row.total) : (row.amount != null ? money(row.amount) : '—')) },
    { key: 'since', header: 'Desde', render: (row) => (row.since ? fmtDateTime(row.since) : '—') },
  ];

  return (
    <Drawer open title={state.label || label(queueKey)} onClose={onClose}>
      <p className="sisv-muted">
        As ações desta fila ficam no Back Office, onde cada registro tem o fluxo completo.
      </p>
      <DataTable
        caption={`Fila ${state.label}`}
        columns={columns} rows={state.rows} loading={state.loading} error={state.error}
        emptyTitle="Fila vazia" emptyDescription="Nada pendente aqui."
      />
    </Drawer>
  );
}
