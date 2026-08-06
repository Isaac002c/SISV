'use client';

// =============================================================================
// Cliente360.jsx — visão 360 do cliente (§34).
//
// Carregamento SOB DEMANDA: o cabeçalho traz só os totais consolidados; cada
// aba busca a sua própria lista paginada quando é aberta. Nada é carregado de
// uma vez — é isso que o §34 pede e o que mantém a tela rápida em cliente com
// histórico grande.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { getClientOverview, getClientTab } from '../../lib/commercialAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { DataTable, Notice, StatusBadge, Tabs, money, label } from './shared';

const TAB_LABELS = {
  pedidos: 'Pedidos', vendas: 'Vendas', recebimentos: 'Recebimentos', ordens: 'Ordens',
  processos: 'Processos', documentos: 'Documentos', contratos: 'Contratos',
  notas: 'Notas fiscais', historico: 'Histórico',
};

const COLUMNS = {
  pedidos: [
    { key: 'number', header: 'Número', render: (row) => <strong>{row.number}</strong> },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'total', header: 'Valor', align: 'right', render: (row) => money(row.total) },
    { key: 'owner_name', header: 'Responsável', render: (row) => row.owner_name || '—' },
    { key: 'created_at', header: 'Criado em', render: (row) => fmtDate(row.created_at) },
  ],
  vendas: [
    { key: 'number', header: 'Número', render: (row) => <strong>{row.number}</strong> },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'net_amount', header: 'Valor líquido', align: 'right', render: (row) => money(row.net_amount) },
    { key: 'confirmed_at', header: 'Confirmada em', render: (row) => fmtDate(row.confirmed_at) },
  ],
  recebimentos: [
    { key: 'description', header: 'Descrição' },
    { key: 'total_amount', header: 'Previsto', align: 'right', render: (row) => money(row.total_amount) },
    { key: 'received_amount', header: 'Recebido', align: 'right', render: (row) => money(row.received_amount) },
    { key: 'pending_amount', header: 'Pendente', align: 'right',
      render: (row) => <strong>{money(row.pending_amount)}</strong> },
    { key: 'due_date', header: 'Vencimento', render: (row) => (row.due_date ? fmtDate(row.due_date) : '—') },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
  ],
  ordens: [
    { key: 'number', header: 'Ordem', render: (row) => <strong>{row.number}</strong> },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'owner_name', header: 'Responsável', render: (row) => row.owner_name || '—' },
    { key: 'due_date', header: 'Prazo', render: (row) => (row.due_date ? fmtDate(row.due_date) : '—') },
    { key: 'finished_at', header: 'Concluída em', render: (row) => (row.finished_at ? fmtDate(row.finished_at) : '—') },
  ],
  processos: [
    { key: 'fine_number', header: 'Processo' },
    { key: 'stage', header: 'Etapa', render: (row) => label(row.stage) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'due_date', header: 'Prazo', render: (row) => (row.due_date ? fmtDate(row.due_date) : '—') },
  ],
  documentos: [
    { key: 'title', header: 'Documento' },
    { key: 'doc_type', header: 'Tipo', render: (row) => <StatusBadge value={row.doc_type} /> },
    { key: 'stage', header: 'Etapa', render: (row) => label(row.stage) },
    { key: 'created_at', header: 'Data', render: (row) => fmtDate(row.created_at) },
  ],
  contratos: [
    { key: 'number', header: 'Número' },
    { key: 'title', header: 'Título' },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'signed_at', header: 'Assinado em', render: (row) => (row.signed_at ? fmtDate(row.signed_at) : '—') },
  ],
  notas: [
    { key: 'number', header: 'Número', render: (row) => row.number || '—' },
    { key: 'sale_number', header: 'Venda', render: (row) => row.sale_number || '—' },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'issued_at', header: 'Emissão', render: (row) => (row.issued_at ? fmtDate(row.issued_at) : '—') },
    { key: 'amount', header: 'Valor', align: 'right', render: (row) => money(row.amount) },
  ],
  historico: [
    { key: 'created_at', header: 'Quando', render: (row) => fmtDateTime(row.created_at) },
    { key: 'entity_type', header: 'Entidade', render: (row) => label(row.entity_type) },
    { key: 'action', header: 'Ação', render: (row) => label(row.action) },
    { key: 'to_status', header: 'Para', render: (row) => (row.to_status ? <StatusBadge value={row.to_status} /> : '—') },
    { key: 'user_name', header: 'Usuário', render: (row) => row.user_name || '—' },
    { key: 'reason', header: 'Justificativa', render: (row) => row.reason || '—' },
  ],
};

export default function Cliente360({ clientId }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('pedidos');
  const [page, setPage] = useState(1);
  const [tabState, setTabState] = useState({ rows: [], total: 0, loading: true, error: '' });

  useEffect(() => {
    getClientOverview(clientId).then(setOverview).catch((err) => setError(err.message));
  }, [clientId]);

  const loadTab = useCallback(async () => {
    setTabState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const result = await getClientTab(clientId, tab, { page, limit: 10 });
      setTabState({ rows: result.rows, total: result.total, loading: false, error: '' });
    } catch (err) {
      setTabState({ rows: [], total: 0, loading: false, error: err.message });
    }
  }, [clientId, tab, page]);

  useEffect(() => { loadTab(); }, [loadTab]);
  useEffect(() => { setPage(1); }, [tab]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!overview) return <p className="sisv-muted">Carregando visão do cliente…</p>;

  const totals = overview.totals;
  const pages = Math.max(1, Math.ceil(tabState.total / 10));

  return (
    <section className="sisv-360" aria-label="Visão 360 do cliente">
      <div className="sisv-exec-grid sisv-360-summary">
        <Summary value={totals.pedidos} caption="Pedidos" />
        <Summary value={totals.vendas} caption="Vendas" />
        <Summary value={money(totals.valor_vendido)} caption="Valor vendido" />
        <Summary value={money(totals.valor_em_aberto)} caption="Em aberto"
          tone={Number(totals.valor_em_aberto) > 0 ? 'warning' : undefined} />
        <Summary value={totals.ordens} caption="Ordens" />
        <Summary value={totals.processos} caption="Processos" />
        <Summary value={totals.pendencias} caption="Pendências"
          tone={Number(totals.pendencias) > 0 ? 'warning' : undefined} />
        <Summary value={totals.atendimentos_concluidos} caption="Atendimentos concluídos" />
      </div>

      <Tabs
        ariaLabel="Abas do cliente"
        tabs={(overview.tabs || Object.keys(TAB_LABELS)).map((key) => ({
          key, label: TAB_LABELS[key] || label(key),
        }))}
        active={tab}
        onChange={setTab}
      />

      <DataTable
        caption={`${TAB_LABELS[tab]} do cliente`}
        columns={COLUMNS[tab] || []}
        rows={tabState.rows}
        loading={tabState.loading}
        error={tabState.error}
        onRetry={loadTab}
        rowKey={(row) => row.id || `${row.created_at}-${row.action}`}
        emptyTitle={`Sem ${String(TAB_LABELS[tab]).toLowerCase()}`}
        emptyDescription="Nada registrado nesta aba para o cliente."
      />

      {pages > 1 && (
        <nav className="sisv-360-pagination" aria-label="Paginação da aba">
          <button type="button" className="btn-secondary" disabled={page <= 1}
            onClick={() => setPage(page - 1)}>← Anterior</button>
          <span>Página {page} de {pages} · {tabState.total} registros</span>
          <button type="button" className="btn-secondary" disabled={page >= pages}
            onClick={() => setPage(page + 1)}>Próxima →</button>
        </nav>
      )}
    </section>
  );
}

function Summary({ value, caption, tone }) {
  return (
    <div className={`sisv-exec-card${tone ? ` tone-${tone}` : ''}`}>
      <span className="sisv-exec-value">{value}</span>
      <span className="sisv-exec-label">{caption}</span>
    </div>
  );
}
