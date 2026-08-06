'use client';

// =============================================================================
// BackOffice.jsx — filas operacionais do back office (§16, §17).
//
// Não é um dashboard: cada fila abre a lista real e traz a AÇÃO correspondente
// (validar pedido, conferir pagamento, confirmar venda, liberar ordem…).
// A decisão de validação exige justificativa em devolução, pendência de
// informação e rejeição — o botão fica desabilitado até o motivo ser preenchido.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Drawer } from '../../components/ui';
import {
  getQueues, getQueue, getOrder, validateOrder, claimOrder, decidePayment,
  previewSale, confirmSale, createServiceOrder, changeServiceOrderStatus,
} from '../../lib/commercialAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import {
  DataTable, Field, Notice, SectionHeader, StatusBadge, money, label,
} from './shared';

const CHECKLIST_ITEMS = [
  ['cliente', 'Cliente'],
  ['documentos', 'Documentos'],
  ['itens', 'Itens'],
  ['precos', 'Preços'],
  ['descontos', 'Descontos'],
  ['forma_pagamento', 'Forma de pagamento'],
  ['comprovante', 'Comprovante'],
  ['fornecedor', 'Fornecedor'],
  ['comissao', 'Comissão'],
  ['dados_obrigatorios', 'Dados obrigatórios'],
];

export default function BackOffice() {
  const router = useRouter();
  const [summary, setSummary] = useState(null);
  const [active, setActive] = useState('pedidos_validacao');
  const [queue, setQueue] = useState({ rows: [], total: 0, loading: true, error: '' });
  const [message, setMessage] = useState(null);
  const [panel, setPanel] = useState(null);

  const loadSummary = useCallback(async () => {
    try { setSummary(await getQueues()); } catch (error) { setMessage({ tone: 'error', text: error.message }); }
  }, []);

  const loadQueue = useCallback(async (key) => {
    setQueue((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const result = await getQueue(key, { limit: 50 });
      setQueue({ rows: result.rows, total: result.total, loading: false, error: '', label: result.label });
    } catch (error) {
      setQueue({ rows: [], total: 0, loading: false, error: error.message });
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadQueue(active); }, [active, loadQueue]);

  const refresh = useCallback(() => { loadSummary(); loadQueue(active); },
    [loadSummary, loadQueue, active]);

  // Handlers memoizados: os painéis os usam em dependências de efeito, e uma
  // função nova a cada render dispararia recargas (e reassumir o pedido) à toa.
  const closePanel = useCallback(() => setPanel(null), []);
  const handleDone = useCallback((text) => {
    setPanel(null);
    setMessage({ tone: 'success', text });
    refresh();
  }, [refresh]);
  const handleError = useCallback((text) => setMessage({ tone: 'error', text }), []);

  const columnsByQueue = {
    pagamentos_conferencia: [
      { key: 'client_name', header: 'Cliente' },
      { key: 'order_number', header: 'Pedido', render: (row) => row.order_number || '—' },
      { key: 'amount', header: 'Valor', align: 'right', render: (row) => money(row.amount) },
      { key: 'payment_method', header: 'Forma', render: (row) => label(row.payment_method) },
      { key: 'proof_url', header: 'Comprovante',
        render: (row) => (row.proof_url ? 'anexado' : <span className="sisv-muted">sem anexo</span>) },
      { key: 'since', header: 'Informado em', render: (row) => fmtDateTime(row.since) },
      { key: 'actions', header: 'Ação', align: 'right',
        render: (row) => (
          <button type="button" className="btn-primary"
            onClick={(event) => { event.stopPropagation(); setPanel({ type: 'payment', row }); }}>
            Conferir
          </button>
        ) },
    ],
    notas_pendentes: [
      { key: 'sale_number', header: 'Venda' },
      { key: 'client_name', header: 'Cliente' },
      { key: 'total', header: 'Valor', align: 'right', render: (row) => money(row.total) },
      { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
      { key: 'since', header: 'Desde', render: (row) => fmtDate(row.since) },
      { key: 'actions', header: 'Ação', align: 'right',
        render: () => (
          <button type="button" className="btn-secondary"
            onClick={(event) => {
              event.stopPropagation();
              router.push('/dashboard?module=multas&tab=fiscal');
            }}>
            Registrar nota
          </button>
        ) },
    ],
  };

  const defaultColumns = [
    { key: 'number', header: 'Número', render: (row) => <strong>{row.number}</strong> },
    { key: 'client_name', header: 'Cliente' },
    { key: 'owner_name', header: 'Responsável', render: (row) => row.owner_name || '—' },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'total', header: 'Valor', align: 'right',
      render: (row) => (row.total != null ? money(row.total) : '—') },
    { key: 'since', header: 'Desde', render: (row) => fmtDateTime(row.since) },
    { key: 'actions', header: 'Ação', align: 'right',
      render: (row) => <QueueAction queueKey={active} row={row} onOpen={setPanel} /> },
  ];

  const columns = columnsByQueue[active] || defaultColumns;

  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Back Office', 'Filas']}
        title="Back Office"
        subtitle="Conferência, validação documental e financeira, confirmação da venda e preparação da execução."
        actions={<button type="button" className="btn-secondary" onClick={refresh}>Atualizar</button>}
      />

      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}

      <div className="sisv-queue-grid">
        {summary && Object.values(summary).map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`sisv-queue-card${active === entry.key ? ' is-active' : ''}`}
            aria-pressed={active === entry.key}
            onClick={() => setActive(entry.key)}
          >
            <span className="sisv-queue-count">{entry.total}</span>
            <span className="sisv-queue-label">{entry.label}</span>
          </button>
        ))}
      </div>

      <h3 className="sisv-queue-title">
        {queue.label || 'Fila'} <span className="sisv-muted">({queue.total})</span>
      </h3>

      <DataTable
        caption={`Fila: ${queue.label || active}`}
        columns={columns}
        rows={queue.rows}
        loading={queue.loading}
        error={queue.error}
        onRetry={() => loadQueue(active)}
        emptyTitle="Fila vazia"
        emptyDescription="Nada pendente nesta fila no momento."
      />

      {panel?.type === 'order' && (
        <OrderValidationPanel
          orderId={panel.row.id}
          onClose={closePanel}
          onDone={handleDone}
          onError={handleError}
        />
      )}
      {panel?.type === 'payment' && (
        <PaymentValidationPanel
          payment={panel.row}
          onClose={closePanel}
          onDone={handleDone}
          onError={handleError}
        />
      )}
      {panel?.type === 'sale' && (
        <SaleConfirmationPanel
          orderId={panel.row.id}
          onClose={closePanel}
          onDone={handleDone}
          onError={handleError}
        />
      )}
      {panel?.type === 'service_order' && (
        <ServiceOrderPanel
          sale={panel.row}
          onClose={closePanel}
          onDone={handleDone}
          onError={handleError}
        />
      )}
      {panel?.type === 'release' && (
        <ReleasePanel
          serviceOrder={panel.row}
          onClose={closePanel}
          onDone={handleDone}
          onError={handleError}
        />
      )}
    </div>
  );
}

/** Cada fila tem uma ação própria — nenhuma linha fica sem o que fazer (§16). */
function QueueAction({ queueKey, row, onOpen }) {
  const map = {
    pedidos_validacao: ['Validar', 'order'],
    documentos_pendentes: ['Abrir pedido', 'order'],
    pedidos_inconsistentes: ['Abrir pedido', 'order'],
    pedidos_prontos_venda: ['Confirmar venda', 'sale'],
    vendas_sem_ordem: ['Gerar ordem', 'service_order'],
    execucao_liberacao: ['Liberar', 'release'],
    finalizacoes_pendentes: ['Finalizar', 'release'],
    prontos_arquivamento: ['Arquivar', 'release'],
  };
  const entry = map[queueKey];
  if (!entry) return null;
  const [text, type] = entry;
  return (
    <button type="button" className="btn-primary"
      onClick={(event) => { event.stopPropagation(); onOpen({ type, row }); }}>
      {text}
    </button>
  );
}

// ── Validação do pedido (§17) ────────────────────────────────────────────────

function OrderValidationPanel({ orderId, onClose, onDone, onError }) {
  const [order, setOrder] = useState(null);
  const [decision, setDecision] = useState('aprovado');
  const [reason, setReason] = useState('');
  const [checklist, setChecklist] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        let data = await getOrder(orderId);
        // Assumir o pedido para conferência altera a situação e incrementa a
        // versão. Sem recarregar depois disso, a decisão iria com a versão
        // antiga e o servidor recusaria com 409 sem que houvesse conflito real.
        if (data.status === 'enviado_validacao') {
          try {
            await claimOrder(orderId);
            data = await getOrder(orderId);
          } catch { /* outro usuário já assumiu; segue com o estado atual */ }
        }
        if (active) setOrder(data);
      } catch (error) {
        if (!active) return;
        onError(error.message);
        onClose();
      }
    })();
    return () => { active = false; };
  }, [orderId, onClose, onError]);

  const needsReason = decision !== 'aprovado';
  const canDecide = !needsReason || reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    try {
      await validateOrder(orderId, { decision, reason, checklist, row_version: order.row_version });
      onDone(`Pedido ${label(decision)}.`);
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      title={order ? `Validar pedido ${order.number}` : 'Validar pedido'}
      subtitle={order?.client_name}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary" disabled={!canDecide || busy} onClick={submit}>
            {busy ? 'Registrando…' : 'Registrar decisão'}
          </button>
        </>
      )}
    >
      {!order ? <p className="sisv-muted">Carregando…</p> : (
        <>
          <dl className="sisv-datalist">
            <div><dt>Cliente</dt><dd>{order.client_name}</dd></div>
            <div><dt>Total</dt><dd><strong>{money(order.total)}</strong></dd></div>
            <div><dt>Desconto</dt><dd>{money(order.discount)}</dd></div>
            <div><dt>Itens</dt><dd>{order.items.length}</dd></div>
            <div><dt>Documentos</dt><dd>{order.documents.length}</dd></div>
            <div><dt>Recebíveis</dt><dd>{order.receivables.length}</dd></div>
          </dl>

          <section className="sisv-drawer-section" aria-label="Conferência">
            <h3>Conferência</h3>
            <div className="sisv-checkgrid">
              {CHECKLIST_ITEMS.map(([key, text]) => (
                <Field key={key} id={`chk-${key}`} label={text} type="checkbox"
                  value={checklist[key] || false}
                  // Atualização funcional: marcar duas caixas em sequência rápida
                  // com o valor do closure faria a segunda sobrescrever a
                  // primeira, perdendo um item da conferência.
                  onChange={(value) => setChecklist((previous) => ({ ...previous, [key]: value }))} />
              ))}
            </div>
          </section>

          <Field id="val-decision" label="Decisão" type="select" value={decision}
            onChange={(value) => setDecision(value)}
            options={[
              { value: 'aprovado', label: 'Aprovar' },
              { value: 'devolvido', label: 'Devolver para correção' },
              { value: 'aguardando_informacao', label: 'Aguardando informação' },
              { value: 'rejeitado', label: 'Rejeitar' },
            ]} />
          <Field id="val-reason" label="Justificativa" type="textarea" value={reason}
            onChange={setReason} required={needsReason}
            hint={needsReason
              ? 'Obrigatória para devolução, pendência de informação e rejeição.'
              : 'Opcional na aprovação.'}
            error={needsReason && reason.length > 0 && reason.trim().length < 3
              ? 'Informe pelo menos 3 caracteres.' : undefined} />
        </>
      )}
    </Drawer>
  );
}

// ── Validação de pagamento (§20) ─────────────────────────────────────────────

function PaymentValidationPanel({ payment, onClose, onDone, onError }) {
  const [decision, setDecision] = useState('aprovado');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const needsReason = decision === 'rejeitado';
  const canDecide = !needsReason || reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await decidePayment(payment.id, { decision, reason });
      setResult(outcome);
      if (decision !== 'aprovado' || !outcome.sale_ready) {
        onDone(`Pagamento ${label(decision)}.`);
      }
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      title="Conferir pagamento"
      subtitle={`${payment.client_name} · ${money(payment.amount)}`}
      onClose={onClose}
      footer={!result && (
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary" disabled={!canDecide || busy} onClick={submit}>
            {busy ? 'Registrando…' : 'Registrar decisão'}
          </button>
        </>
      )}
    >
      <dl className="sisv-datalist">
        <div><dt>Cliente</dt><dd>{payment.client_name}</dd></div>
        <div><dt>Pedido</dt><dd>{payment.order_number || '—'}</dd></div>
        <div><dt>Valor informado</dt><dd><strong>{money(payment.amount)}</strong></dd></div>
        <div><dt>Forma</dt><dd>{label(payment.payment_method)}</dd></div>
        <div><dt>Data</dt><dd>{fmtDate(payment.paid_at)}</dd></div>
        <div><dt>Comprovante</dt>
          <dd>{payment.proof_url
            ? <a href={payment.proof_url} target="_blank" rel="noreferrer">Abrir comprovante</a>
            : <span className="sisv-muted">não anexado</span>}</dd></div>
      </dl>

      {result ? (
        <Notice tone="success">
          Pagamento aprovado e recebível atualizado.
          {result.sale_ready
            ? ' O pedido está liberado para a ação “Confirmar venda” — a venda não é criada automaticamente.'
            : ''}
        </Notice>
      ) : (
        <>
          <Notice tone="info">
            Anexar comprovante não aprova o pagamento. A aprovação abaixo é o que atualiza o recebível.
          </Notice>
          <Field id="pay-decision" label="Decisão" type="select" value={decision}
            onChange={setDecision}
            options={[
              { value: 'aprovado', label: 'Aprovar' },
              { value: 'em_validacao', label: 'Solicitar correção (manter em validação)' },
              { value: 'rejeitado', label: 'Rejeitar' },
            ]} />
          <Field id="pay-reason" label="Observação" type="textarea" value={reason}
            onChange={setReason} required={needsReason}
            hint={needsReason ? 'Obrigatória na rejeição.' : 'Opcional.'} />
        </>
      )}
    </Drawer>
  );
}

// ── Confirmação da venda (§22) ───────────────────────────────────────────────

function SaleConfirmationPanel({ orderId, onClose, onDone, onError }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    previewSale(orderId).then(setPreview).catch((error) => { onError(error.message); onClose(); });
  }, [orderId, onClose, onError]);

  const submit = async () => {
    setBusy(true);
    try {
      const sale = await confirmSale(orderId, {});
      onDone(`Venda ${sale.number} confirmada.`);
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      title="Confirmar venda"
      subtitle={preview ? `Pedido ${preview.order.number} · ${preview.order.client_name}` : undefined}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary"
            disabled={busy || !preview?.can_confirm} onClick={submit}>
            {busy ? 'Confirmando…' : 'Confirmar venda'}
          </button>
        </>
      )}
    >
      {!preview ? <p className="sisv-muted">Calculando prévia…</p> : (
        <>
          {preview.blockers.length > 0 && (
            <Notice tone="error">{preview.blockers.join(' ')}</Notice>
          )}

          <h3>Cliente e valores</h3>
          <dl className="sisv-datalist">
            <div><dt>Cliente atendido</dt><dd>{preview.order.client_name}</dd></div>
            <div><dt>Contratante</dt><dd>{preview.order.contractor_name || preview.order.client_name}</dd></div>
            <div><dt>Subtotal</dt><dd>{money(preview.order.subtotal)}</dd></div>
            <div><dt>Desconto</dt><dd>{money(preview.order.discount)}</dd></div>
            <div><dt>Total</dt><dd><strong>{money(preview.order.total)}</strong></dd></div>
            <div><dt>Recebido</dt><dd>{money(preview.financeiro.total_recebido)}</dd></div>
            <div><dt>Pendente</dt><dd>{money(preview.financeiro.total_pendente)}</dd></div>
            <div><dt>Custo estimado</dt><dd>{money(preview.custos.estimado)}</dd></div>
            <div><dt>Margem estimada</dt><dd>{money(preview.custos.margem_estimada)}</dd></div>
          </dl>
          {preview.order.contractor_type === 'partner' && (
            <Notice tone="info">
              Condições registradas: tabela {preview.order.applied_commercial_terms?.price_table_name || 'padrão'};
              {' '}prazo {preview.order.applied_commercial_terms?.payment_terms || 'não definido'};
              {' '}meio {preview.order.applied_commercial_terms?.payment_method || 'não definido'}.
            </Notice>
          )}

          <h3>Itens</h3>
          <ul className="sisv-list">
            {preview.items.map((item) => (
              <li key={item.id}>
                <span>{item.description}</span>
                <span>{Number(item.quantity)} × {money(item.unit_price)}</span>
                <strong>{money(item.total)}</strong>
              </li>
            ))}
          </ul>

          {preview.fornecedores.length > 0 && (
            <>
              <h3>Fornecedores e custos</h3>
              <ul className="sisv-list">
                {preview.fornecedores.map((entry, index) => (
                  <li key={`${entry.supplier_id}-${index}`}>
                    <span>{entry.supplier_name}</span>
                    <span>{entry.item_description}</span>
                    <strong>{money(entry.planned_cost)}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.comissoes_sugeridas.length > 0 && (
            <>
              <h3>Comissões sugeridas</h3>
              <ul className="sisv-list">
                {preview.comissoes_sugeridas.map((entry, index) => (
                  <li key={index}>
                    <span>{entry.beneficiary_name}</span>
                    <span>{entry.rate_type === 'percentual' ? `${entry.rate_value}%` : 'valor fixo'}</span>
                    <strong>{money(entry.amount)}</strong>
                  </li>
                ))}
              </ul>
              <Notice tone="info">
                Estas comissões são apenas uma sugestão de cálculo. Nada é registrado na confirmação
                da venda — elas só existem depois da ação “Preparar pagamentos”.
              </Notice>
            </>
          )}

          <h3>Destino operacional</h3>
          <p>{preview.destino_operacional.descricao}</p>

          {preview.documents.length > 0 && (
            <>
              <h3>Documentos</h3>
              <ul className="sisv-list">
                {preview.documents.map((document) => (
                  <li key={document.id}>
                    <span>{document.title}</span>
                    <StatusBadge value={document.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

// ── Geração da ordem de serviço ──────────────────────────────────────────────

function ServiceOrderPanel({ sale, onClose, onDone, onError }) {
  const [form, setForm] = useState({
    due_date: '', priority: 'normal', instructions: '', create_processes: true,
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const created = await createServiceOrder({ sale_id: sale.id, ...form, due_date: form.due_date || null });
      onDone(`Ordem ${created.number} criada${created.processes_created ? ` com ${created.processes_created} processo(s).` : '.'}`);
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      title="Gerar ordem de serviço"
      subtitle={`Venda ${sale.number} · ${sale.client_name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Gerando…' : 'Gerar ordem'}
          </button>
        </>
      )}
    >
      <Field id="so-due" label="Prazo" type="date" value={form.due_date}
        onChange={(value) => setForm({ ...form, due_date: value })} />
      <Field id="so-prio" label="Prioridade" type="select" value={form.priority}
        onChange={(value) => setForm({ ...form, priority: value })}
        options={[
          { value: 'baixa', label: 'Baixa' }, { value: 'normal', label: 'Normal' },
          { value: 'alta', label: 'Alta' }, { value: 'urgente', label: 'Urgente' },
        ]} />
      <Field id="so-proc" label="Criar processo para os itens que exigem tramitação" type="checkbox"
        value={form.create_processes}
        onChange={(value) => setForm({ ...form, create_processes: value })}
        hint="Serviços simples são executados na própria ordem, sem processo separado." />
      <Field id="so-inst" label="Instruções" type="textarea" value={form.instructions}
        onChange={(value) => setForm({ ...form, instructions: value })} />
    </Drawer>
  );
}

function ReleasePanel({ serviceOrder, onClose, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      await changeServiceOrderStatus(serviceOrder.id, { status: 'liberada' });
      onDone(`Ordem ${serviceOrder.number} liberada para execução.`);
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      title={`Ordem ${serviceOrder.number}`}
      subtitle={serviceOrder.client_name}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={release}>
            {busy ? 'Liberando…' : 'Liberar para execução'}
          </button>
        </>
      )}
    >
      <p>
        A liberação coloca a ordem na fila de execução. Concluir, finalizar e arquivar são feitos na
        tela de Execução, com o checklist de conclusão.
      </p>
      <dl className="sisv-datalist">
        <div><dt>Situação</dt><dd><StatusBadge value={serviceOrder.status} /></dd></div>
        <div><dt>Responsável</dt><dd>{serviceOrder.owner_name || '—'}</dd></div>
        <div><dt>Prazo</dt><dd>{serviceOrder.due_date ? fmtDate(serviceOrder.due_date) : '—'}</dd></div>
      </dl>
    </Drawer>
  );
}
