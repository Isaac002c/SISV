'use client';

// =============================================================================
// Financeiro.jsx — financeiro OPERACIONAL (não é contabilidade):
//   Recebimentos  — contas a receber e pagamentos do cliente (§18, §19, §20)
//   Vendas        — vendas confirmadas (§21)
//   Pagamentos    — contas a pagar operacionais (§27)
//   Comissões     — comissões confirmadas por ação explícita (§29)
//
// Cada aba é uma tela completa com filtro, tabela e ação. Nenhuma delas registra
// nada sozinha: aprovar, pagar e confirmar são sempre cliques do usuário.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listReceivables, getReceivable, createReceivable, listCustomerPayments, registerPayment,
  decidePayment, reversePayment, issueReceipt, listSales, getSale, changeSaleStatus,
  listPayables, changePayableStatus, createPayable, listCommissions, changeCommissionStatus,
  listSuppliers,
} from '../../lib/commercialAPI';
import { getClients } from '../../lib/clientsAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  money, useResourceList, label, asOptions,
} from './shared';

const TABS = [
  { key: 'recebimentos', label: 'Recebimentos' },
  { key: 'pagamentos_cliente', label: 'Pagamentos do cliente' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'pagamentos', label: 'Contas a pagar' },
  { key: 'comissoes', label: 'Comissões' },
];

export default function Financeiro({ initialTab = 'recebimentos' }) {
  const [tab, setTab] = useState(initialTab);
  const [message, setMessage] = useState(null);

  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Financeiro operacional']}
        title="Financeiro operacional"
        subtitle="Controle dos valores de pedidos, vendas, fornecedores e comissões. Não substitui a contabilidade."
      />
      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      <Tabs ariaLabel="Áreas do financeiro operacional" tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'recebimentos' && <Receivables onMessage={setMessage} />}
      {tab === 'pagamentos_cliente' && <CustomerPayments onMessage={setMessage} />}
      {tab === 'vendas' && <Sales onMessage={setMessage} />}
      {tab === 'pagamentos' && <Payables onMessage={setMessage} />}
      {tab === 'comissoes' && <Commissions onMessage={setMessage} />}
    </div>
  );
}

// ── Recebíveis ───────────────────────────────────────────────────────────────

function Receivables({ onMessage }) {
  const fetcher = useCallback((filters) => listReceivables(filters), []);
  const list = useResourceList(fetcher, { q: '', status: '', overdue: '', due_from: '', due_to: '' });
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  // Memoizados: o drawer usa estas funções em dependências de efeito.
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const reloadList = useCallback(() => list.reload(), [list]);

  const columns = [
    { key: 'description', header: 'Descrição',
      render: (row) => (
        <div>
          <strong>{row.description}</strong>
          <div className="sisv-cell-sub">{row.client_name}</div>
        </div>
      ) },
    { key: 'order_number', header: 'Pedido', render: (row) => row.order_number || '—' },
    { key: 'total_amount', header: 'Previsto', align: 'right', render: (row) => money(row.total_amount) },
    { key: 'received_amount', header: 'Recebido', align: 'right', render: (row) => money(row.received_amount) },
    { key: 'pending_amount', header: 'Pendente', align: 'right',
      render: (row) => <strong>{money(row.pending_amount)}</strong> },
    { key: 'due_date', header: 'Vencimento', render: (row) => (row.due_date ? fmtDate(row.due_date) : '—') },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
  ];

  return (
    <>
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de recebimentos"
          fields={[
            { key: 'q', label: 'Buscar', placeholder: 'Descrição, cliente ou pedido' },
            { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
              options: asOptions(['pendente', 'parcial', 'recebido', 'vencido', 'cancelado', 'estornado']) },
            { key: 'overdue', label: 'Vencidos', type: 'select', empty: 'Todos',
              options: [{ value: 'true', label: 'Somente vencidos' }] },
            { key: 'due_from', label: 'Vence de', type: 'date' },
            { key: 'due_to', label: 'Vence até', type: 'date' },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Novo recebível</button>
      </div>

      <DataTable
        caption="Contas a receber operacionais"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setOpenId(row.id)}
        emptyTitle="Nenhum recebível"
        emptyDescription="Recebíveis são criados a partir do pedido, na etapa de valores."
      />
      {list.pagination}

      {creating && (
        <NewReceivableDrawer
          onClose={() => setCreating(false)}
          onDone={(text) => { setCreating(false); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })}
        />
      )}
      {openId && (
        <ReceivableDrawer
          receivableId={openId}
          onClose={closeDrawer}
          onChanged={reloadList}
          onMessage={onMessage}
        />
      )}
    </>
  );
}

function NewReceivableDrawer({ onClose, onDone, onError }) {
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState({
    client_id: '', description: '', total_amount: '', due_date: '', payment_method: '', notes: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => { getClients().then((rows) => setClients(rows || [])).catch(() => setClients([])); }, []);

  return (
    <Drawer
      open title="Novo recebível" onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await createReceivable({
                  ...form,
                  total_amount: Number(form.total_amount || 0),
                  due_date: form.due_date || null,
                  payment_method: form.payment_method || null,
                });
                onDone('Recebível criado.');
              } catch (error) { onError(error.message); } finally { setBusy(false); }
            }}>
            {busy ? 'Salvando…' : 'Criar recebível'}
          </button>
        </>
      )}
    >
      <Field id="nr-client" label="Cliente" type="select" required value={form.client_id}
        onChange={(value) => setForm({ ...form, client_id: value })}
        options={[{ value: '', label: 'Selecione…' },
          ...clients.map((client) => ({ value: client.id, label: client.name }))]} />
      <Field id="nr-desc" label="Descrição" required value={form.description}
        onChange={(value) => setForm({ ...form, description: value })} />
      <FormRow columns={3}>
        <Field id="nr-total" label="Valor total" type="number" step="0.01" min="0" required
          value={form.total_amount}
          onChange={(value) => setForm({ ...form, total_amount: value })} />
        <Field id="nr-due" label="Vencimento" type="date" value={form.due_date}
          onChange={(value) => setForm({ ...form, due_date: value })} />
        <Field id="nr-method" label="Forma de pagamento" type="select" value={form.payment_method}
          onChange={(value) => setForm({ ...form, payment_method: value })}
          options={asOptions(['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia', 'outro'],
            { includeEmpty: 'Não definida' })} />
      </FormRow>
      <Field id="nr-notes" label="Observações" type="textarea" value={form.notes}
        onChange={(value) => setForm({ ...form, notes: value })} />
    </Drawer>
  );
}

function ReceivableDrawer({ receivableId, onClose, onChanged, onMessage }) {
  const [receivable, setReceivable] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setReceivable(await getReceivable(receivableId)); }
    catch (error) { onMessage({ tone: 'error', text: error.message }); onClose(); }
  }, [receivableId, onClose, onMessage]);

  useEffect(() => { load(); }, [load]);

  /** Devolve `true` só em caso de sucesso, para o formulário não fechar em erro. */
  const act = async (fn, text) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
      if (text) onMessage({ tone: 'success', text });
      return true;
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
      return false;
    } finally { setBusy(false); }
  };

  return (
    <Drawer
      open
      title={receivable ? receivable.description : 'Recebível'}
      subtitle={receivable ? `${receivable.client_name} · ${label(receivable.status)}` : undefined}
      onClose={onClose}
    >
      {!receivable ? <p className="sisv-muted">Carregando…</p> : (
        <>
          <dl className="sisv-datalist">
            <div><dt>Valor previsto</dt><dd>{money(receivable.total_amount)}</dd></div>
            <div><dt>Valor recebido</dt><dd>{money(receivable.received_amount)}</dd></div>
            <div><dt>Valor pendente</dt><dd><strong>{money(receivable.pending_amount)}</strong></dd></div>
            <div><dt>Vencimento</dt><dd>{receivable.due_date ? fmtDate(receivable.due_date) : '—'}</dd></div>
            <div><dt>Pedido</dt><dd>{receivable.order_number || '—'}</dd></div>
            <div><dt>Venda</dt><dd>{receivable.sale_number || '—'}</dd></div>
          </dl>

          <h3>Informar pagamento</h3>
          <Notice tone="info">
            O pagamento entra como “informado”. Ele só altera o saldo depois de validado por um
            usuário autorizado.
          </Notice>
          {form ? (
            <form className="sisv-inline-form" onSubmit={async (event) => {
              event.preventDefault();
              const ok = await act(() => registerPayment({
                receivable_id: receivableId,
                amount: Number(form.amount),
                paid_at: form.paid_at || null,
                payment_method: form.payment_method,
                reference: form.reference,
                proof_url: form.proof_url,
              }), 'Pagamento informado.');
              if (ok) setForm(null);
            }}>
              <FormRow columns={3}>
                <Field id="pi-amount" label="Valor" type="number" step="0.01" min="0.01" required autoFocus
                  value={form.amount} onChange={(value) => setForm({ ...form, amount: value })} />
                <Field id="pi-date" label="Data" type="date" value={form.paid_at}
                  onChange={(value) => setForm({ ...form, paid_at: value })} />
                <Field id="pi-method" label="Forma" type="select" value={form.payment_method}
                  onChange={(value) => setForm({ ...form, payment_method: value })}
                  options={asOptions(['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia', 'outro'])} />
              </FormRow>
              <FormRow>
                <Field id="pi-ref" label="Referência" value={form.reference}
                  onChange={(value) => setForm({ ...form, reference: value })} />
                <Field id="pi-proof" label="Comprovante (URL)" value={form.proof_url}
                  onChange={(value) => setForm({ ...form, proof_url: value })} />
              </FormRow>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setForm(null)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={busy}>Informar pagamento</button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn-secondary"
              onClick={() => setForm({
                amount: receivable.pending_amount, paid_at: '', payment_method: 'pix',
                reference: '', proof_url: '',
              })}>
              Informar pagamento
            </button>
          )}

          <h3>Pagamentos deste recebível</h3>
          {receivable.payments.length === 0 ? (
            <p className="sisv-muted">Nenhum pagamento informado.</p>
          ) : (
            <ul className="sisv-list">
              {receivable.payments.map((payment) => (
                <li key={payment.id}>
                  <span>{money(payment.amount)} · {label(payment.payment_method)}</span>
                  <span>{fmtDate(payment.paid_at)}{payment.registered_by_name ? ` · ${payment.registered_by_name}` : ''}</span>
                  <StatusBadge value={payment.status} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Drawer>
  );
}

// ── Pagamentos do cliente (validação) ────────────────────────────────────────

function CustomerPayments({ onMessage }) {
  const fetcher = useCallback((filters) => listCustomerPayments(filters), []);
  const list = useResourceList(fetcher, { status: '', awaiting: '' });
  const [panel, setPanel] = useState(null);
  const [reversing, setReversing] = useState(null);

  const columns = [
    { key: 'client_name', header: 'Cliente' },
    { key: 'order_number', header: 'Pedido', render: (row) => row.order_number || '—' },
    { key: 'amount', header: 'Valor', align: 'right', render: (row) => money(row.amount) },
    { key: 'payment_method', header: 'Forma', render: (row) => label(row.payment_method) },
    { key: 'paid_at', header: 'Data', render: (row) => fmtDate(row.paid_at) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'actions', header: 'Ações', align: 'right',
      render: (row) => (
        <div className="sisv-row-actions">
          {['informado', 'em_validacao'].includes(row.status) && (
            <button type="button" className="btn-primary"
              onClick={(event) => { event.stopPropagation(); setPanel(row); }}>Validar</button>
          )}
          {row.status === 'aprovado' && (
            <>
              <button type="button" className="btn-secondary"
                onClick={async (event) => {
                  event.stopPropagation();
                  try {
                    await issueReceipt(row.id, {});
                    onMessage({ tone: 'success', text: 'Recibo operacional emitido (não é nota fiscal).' });
                  } catch (error) { onMessage({ tone: 'error', text: error.message }); }
                }}>Recibo</button>
              <button type="button" className="btn-secondary"
                onClick={(event) => { event.stopPropagation(); setReversing(row); }}>Estornar</button>
            </>
          )}
        </div>
      ) },
  ];

  return (
    <>
      <FilterBar
        ariaLabel="Filtros de pagamentos do cliente"
        fields={[
          { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
            options: asOptions(['informado', 'em_validacao', 'aprovado', 'rejeitado', 'estornado']) },
          { key: 'awaiting', label: 'Aguardando validação', type: 'select', empty: 'Todos',
            options: [{ value: 'true', label: 'Somente aguardando' }] },
        ]}
        values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
      />
      <DataTable
        caption="Pagamentos informados pelo cliente"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload}
        emptyTitle="Nenhum pagamento" emptyDescription="Pagamentos aparecem aqui assim que forem informados."
      />
      {list.pagination}

      {panel && (
        <Drawer
          open title="Validar pagamento"
          subtitle={`${panel.client_name} · ${money(panel.amount)}`}
          onClose={() => setPanel(null)}
        >
          <PaymentDecision payment={panel} onDone={(text) => {
            setPanel(null); onMessage({ tone: 'success', text }); list.reload();
          }} onError={(text) => onMessage({ tone: 'error', text })} />
        </Drawer>
      )}

      <ConfirmDialog
        open={Boolean(reversing)}
        title="Estornar pagamento"
        message={`O estorno recalcula o recebível e fica registrado no histórico. Valor: ${money(reversing?.amount)}.`}
        confirmLabel="Estornar" danger requireReason reasonLabel="Justificativa"
        onConfirm={async (reason) => {
          try {
            await reversePayment(reversing.id, reason);
            onMessage({ tone: 'success', text: 'Pagamento estornado.' });
            list.reload();
          } catch (error) { onMessage({ tone: 'error', text: error.message }); }
          setReversing(null);
        }}
        onClose={() => setReversing(null)}
      />
    </>
  );
}

function PaymentDecision({ payment, onDone, onError }) {
  const [decision, setDecision] = useState('aprovado');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const needsReason = decision === 'rejeitado';

  if (result) {
    return (
      <Notice tone="success">
        Pagamento aprovado e recebível atualizado.
        {result.sale_ready && ' A ação “Confirmar venda” foi liberada no Back Office — a venda não é criada sozinha.'}
      </Notice>
    );
  }

  return (
    <form onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true);
      try {
        const outcome = await decidePayment(payment.id, { decision, reason });
        if (decision === 'aprovado') setResult(outcome);
        else onDone(`Pagamento ${label(decision)}.`);
      } catch (error) { onError(error.message); } finally { setBusy(false); }
    }}>
      <dl className="sisv-datalist">
        <div><dt>Valor informado</dt><dd><strong>{money(payment.amount)}</strong></dd></div>
        <div><dt>Recebível</dt><dd>{payment.receivable_description}</dd></div>
        <div><dt>Total do recebível</dt><dd>{money(payment.receivable_total)}</dd></div>
        <div><dt>Já recebido</dt><dd>{money(payment.receivable_received)}</dd></div>
        <div><dt>Comprovante</dt>
          <dd>{payment.proof_url
            ? <a href={payment.proof_url} target="_blank" rel="noreferrer">Abrir</a>
            : <span className="sisv-muted">não anexado</span>}</dd></div>
      </dl>
      <Field id="cd-decision" label="Decisão" type="select" value={decision} onChange={setDecision}
        options={[
          { value: 'aprovado', label: 'Aprovar' },
          { value: 'em_validacao', label: 'Solicitar correção' },
          { value: 'rejeitado', label: 'Rejeitar' },
        ]} />
      <Field id="cd-reason" label="Observação" type="textarea" value={reason} onChange={setReason}
        required={needsReason} hint={needsReason ? 'Obrigatória na rejeição.' : 'Opcional.'} />
      <div className="form-actions">
        <button type="submit" className="btn-primary"
          disabled={busy || (needsReason && reason.trim().length < 3)}>
          {busy ? 'Registrando…' : 'Registrar decisão'}
        </button>
      </div>
    </form>
  );
}

// ── Vendas ───────────────────────────────────────────────────────────────────

function Sales({ onMessage }) {
  const fetcher = useCallback((filters) => listSales(filters), []);
  const list = useResourceList(fetcher, { q: '', status: '', without_service_order: '' });
  const [openId, setOpenId] = useState(null);
  const [cancelling, setCancelling] = useState(null);

  const columns = [
    { key: 'number', header: 'Venda', render: (row) => <strong>{row.number}</strong> },
    { key: 'client_name', header: 'Cliente' },
    { key: 'order_number', header: 'Pedido', render: (row) => row.order_number || '—' },
    { key: 'net_amount', header: 'Valor líquido', align: 'right', render: (row) => money(row.net_amount) },
    { key: 'estimated_margin', header: 'Margem', align: 'right', render: (row) => money(row.estimated_margin) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'service_order_number', header: 'Ordem',
      render: (row) => row.service_order_number || <span className="sisv-muted">sem ordem</span> },
    { key: 'confirmed_at', header: 'Confirmada em', render: (row) => fmtDate(row.confirmed_at) },
  ];

  return (
    <>
      <FilterBar
        ariaLabel="Filtros de vendas"
        fields={[
          { key: 'q', label: 'Buscar', placeholder: 'Número ou cliente' },
          { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
            options: asOptions(['pendente', 'confirmada', 'em_execucao', 'concluida', 'cancelada', 'estornada']) },
          { key: 'without_service_order', label: 'Sem ordem', type: 'select', empty: 'Todas',
            options: [{ value: 'true', label: 'Somente sem ordem' }] },
        ]}
        values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
      />
      <DataTable
        caption="Vendas confirmadas"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setOpenId(row.id)}
        emptyTitle="Nenhuma venda"
        emptyDescription="Vendas nascem da confirmação explícita de um pedido validado."
      />
      {list.pagination}

      {openId && (
        <SaleDrawer saleId={openId} onClose={() => setOpenId(null)}
          onCancel={(sale) => setCancelling(sale)} onMessage={onMessage} />
      )}

      <ConfirmDialog
        open={Boolean(cancelling)}
        title="Cancelar venda"
        message="A venda cancelada permanece consultável, com o motivo registrado no histórico."
        confirmLabel="Cancelar venda" danger requireReason reasonLabel="Motivo"
        onConfirm={async (reason) => {
          try {
            await changeSaleStatus(cancelling.id, {
              status: 'cancelada', reason, row_version: cancelling.row_version,
            });
            onMessage({ tone: 'success', text: 'Venda cancelada.' });
            list.reload();
            setOpenId(null);
          } catch (error) { onMessage({ tone: 'error', text: error.message }); }
          setCancelling(null);
        }}
        onClose={() => setCancelling(null)}
      />
    </>
  );
}

function SaleDrawer({ saleId, onClose, onCancel, onMessage }) {
  const [sale, setSale] = useState(null);
  useEffect(() => {
    getSale(saleId).then(setSale).catch((error) => {
      onMessage({ tone: 'error', text: error.message }); onClose();
    });
  }, [saleId, onClose, onMessage]);

  return (
    <Drawer
      open title={sale ? `Venda ${sale.number}` : 'Venda'}
      subtitle={sale ? `${sale.client_name} · ${label(sale.status)}` : undefined}
      onClose={onClose}
      footer={sale && !['cancelada', 'estornada'].includes(sale.status) && (
        <button type="button" className="btn-secondary" onClick={() => onCancel(sale)}>
          Cancelar venda
        </button>
      )}
    >
      {!sale ? <p className="sisv-muted">Carregando…</p> : (
        <>
          <dl className="sisv-datalist">
            <div><dt>Pedido de origem</dt><dd>{sale.order_number || '—'}</dd></div>
            <div><dt>Valor bruto</dt><dd>{money(sale.gross_amount)}</dd></div>
            <div><dt>Descontos</dt><dd>{money(sale.discount_amount)}</dd></div>
            <div><dt>Valor líquido</dt><dd><strong>{money(sale.net_amount)}</strong></dd></div>
            <div><dt>Custo estimado</dt><dd>{money(sale.estimated_cost)}</dd></div>
            <div><dt>Margem estimada</dt><dd>{money(sale.estimated_margin)}</dd></div>
            <div><dt>Responsável</dt><dd>{sale.owner_name || '—'}</dd></div>
            <div><dt>Parceiro</dt><dd>{sale.partner_name || '—'}</dd></div>
            <div><dt>Ordem de serviço</dt><dd>{sale.service_order_number || 'ainda não gerada'}</dd></div>
            <div><dt>Confirmada em</dt><dd>{fmtDateTime(sale.confirmed_at)}</dd></div>
          </dl>

          <h3>Itens</h3>
          <ul className="sisv-list">
            {sale.items.map((item) => (
              <li key={item.id}>
                <span>{item.description}</span>
                <span>{Number(item.quantity)} × {money(item.unit_price)}</span>
                <strong>{money(item.total)}</strong>
              </li>
            ))}
          </ul>

          {sale.commissions.length > 0 && (
            <>
              <h3>Comissões</h3>
              <ul className="sisv-list">
                {sale.commissions.map((commission) => (
                  <li key={commission.id}>
                    <span>{commission.beneficiary_name}</span>
                    <span>{money(commission.amount)}</span>
                    <StatusBadge value={commission.status} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {sale.fiscal_document && (
            <>
              <h3>Nota fiscal</h3>
              <dl className="sisv-datalist">
                <div><dt>Situação</dt><dd><StatusBadge value={sale.fiscal_document.status} /></dd></div>
                <div><dt>Número</dt><dd>{sale.fiscal_document.number || '—'}</dd></div>
                <div><dt>Emissão</dt><dd>{fmtDate(sale.fiscal_document.issued_at)}</dd></div>
              </dl>
            </>
          )}

          {sale.history?.length > 0 && (
            <>
              <h3>Histórico</h3>
              <ul className="sisv-timeline">
                {sale.history.map((event) => (
                  <li key={event.id}>
                    <strong>{label(event.action)}</strong>
                    <span>{fmtDateTime(event.created_at)}{event.user_name ? ` · ${event.user_name}` : ''}</span>
                    {event.reason && <p>{event.reason}</p>}
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

// ── Contas a pagar ───────────────────────────────────────────────────────────

function Payables({ onMessage }) {
  const fetcher = useCallback((filters) => listPayables(filters), []);
  const list = useResourceList(fetcher, { status: '', kind: '', overdue: '', open: '' });
  const [paying, setPaying] = useState(null);
  const [creating, setCreating] = useState(false);

  const columns = [
    { key: 'payee_name', header: 'Favorecido' },
    { key: 'kind', header: 'Tipo', render: (row) => <StatusBadge value={row.kind} /> },
    { key: 'description', header: 'Descrição' },
    { key: 'sale_number', header: 'Venda', render: (row) => row.sale_number || '—' },
    { key: 'amount', header: 'Valor', align: 'right', render: (row) => money(row.amount) },
    { key: 'due_date', header: 'Vencimento', render: (row) => (row.due_date ? fmtDate(row.due_date) : '—') },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'actions', header: 'Ações', align: 'right',
      render: (row) => (
        <div className="sisv-row-actions">
          {['previsto', 'aprovado', 'agendado', 'vencido'].includes(row.status) && (
            <button type="button" className="btn-primary"
              onClick={(event) => { event.stopPropagation(); setPaying(row); }}>Registrar pagamento</button>
          )}
        </div>
      ) },
  ];

  return (
    <>
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de contas a pagar"
          fields={[
            { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
              options: asOptions(['previsto', 'aprovado', 'agendado', 'pago', 'vencido', 'cancelado', 'estornado']) },
            { key: 'kind', label: 'Tipo', type: 'select', empty: 'Todos',
              options: asOptions(['fornecedor', 'prestador', 'parceiro', 'comissao', 'despesa']) },
            { key: 'overdue', label: 'Vencidas', type: 'select', empty: 'Todas',
              options: [{ value: 'true', label: 'Somente vencidas' }] },
            { key: 'open', label: 'Em aberto', type: 'select', empty: 'Todas',
              options: [{ value: 'true', label: 'Somente em aberto' }] },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>Nova obrigação</button>
      </div>

      <Notice tone="info">
        Registro operacional. Não há integração bancária: marcar como paga apenas registra data,
        forma e comprovante informados pelo usuário.
      </Notice>

      <DataTable
        caption="Contas a pagar operacionais"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload}
        emptyTitle="Nenhuma obrigação"
        emptyDescription="Obrigações são criadas pela ação guiada “Preparar pagamentos”, na execução."
      />
      {list.pagination}

      {paying && (
        <PayableDrawer payable={paying} onClose={() => setPaying(null)}
          onDone={(text) => { setPaying(null); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })} />
      )}
      {creating && (
        <NewPayableDrawer onClose={() => setCreating(false)}
          onDone={(text) => { setCreating(false); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })} />
      )}
    </>
  );
}

function PayableDrawer({ payable, onClose, onDone, onError }) {
  const [form, setForm] = useState({
    status: 'pago', paid_at: '', payment_method: payable.payment_method || 'pix',
    proof_url: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      open title="Registrar pagamento" subtitle={`${payable.payee_name} · ${money(payable.amount)}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Voltar</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await changePayableStatus(payable.id, {
                  ...form, paid_at: form.paid_at || null, row_version: payable.row_version,
                });
                onDone('Pagamento registrado.');
              } catch (error) { onError(error.message); } finally { setBusy(false); }
            }}>
            {busy ? 'Registrando…' : 'Registrar'}
          </button>
        </>
      )}
    >
      <Field id="pd-status" label="Situação" type="select" value={form.status}
        onChange={(value) => setForm({ ...form, status: value })}
        options={asOptions(['aprovado', 'agendado', 'pago', 'cancelado'])} />
      <FormRow>
        <Field id="pd-date" label="Data do pagamento" type="date" value={form.paid_at}
          onChange={(value) => setForm({ ...form, paid_at: value })} />
        <Field id="pd-method" label="Forma" type="select" value={form.payment_method}
          onChange={(value) => setForm({ ...form, payment_method: value })}
          options={asOptions(['pix', 'dinheiro', 'transferencia', 'boleto', 'outro'])} />
      </FormRow>
      <Field id="pd-proof" label="Comprovante (URL)" value={form.proof_url}
        onChange={(value) => setForm({ ...form, proof_url: value })} />
      <Field id="pd-notes" label="Observações" type="textarea" value={form.notes}
        onChange={(value) => setForm({ ...form, notes: value })} />
    </Drawer>
  );
}

function NewPayableDrawer({ onClose, onDone, onError }) {
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({
    kind: 'despesa', payee_supplier_id: '', description: '', amount: '', due_date: '', notes: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listSuppliers({ active: 'true', limit: 200 })
      .then((result) => setSuppliers(result.rows)).catch(() => setSuppliers([]));
  }, []);

  return (
    <Drawer
      open title="Nova obrigação" onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await createPayable({
                  ...form, amount: Number(form.amount || 0), due_date: form.due_date || null,
                });
                onDone('Obrigação criada.');
              } catch (error) { onError(error.message); } finally { setBusy(false); }
            }}>
            {busy ? 'Salvando…' : 'Criar obrigação'}
          </button>
        </>
      )}
    >
      <FormRow>
        <Field id="np-kind" label="Tipo" type="select" value={form.kind}
          onChange={(value) => setForm({ ...form, kind: value })}
          options={asOptions(['fornecedor', 'prestador', 'parceiro', 'comissao', 'despesa'])} />
        <Field id="np-payee" label="Favorecido" type="select" required value={form.payee_supplier_id}
          onChange={(value) => setForm({ ...form, payee_supplier_id: value })}
          options={[{ value: '', label: 'Selecione…' },
            ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.legal_name }))]} />
      </FormRow>
      <Field id="np-desc" label="Descrição" required value={form.description}
        onChange={(value) => setForm({ ...form, description: value })} />
      <FormRow>
        <Field id="np-amount" label="Valor" type="number" step="0.01" min="0.01" required
          value={form.amount} onChange={(value) => setForm({ ...form, amount: value })} />
        <Field id="np-due" label="Vencimento" type="date" value={form.due_date}
          onChange={(value) => setForm({ ...form, due_date: value })} />
      </FormRow>
      <Field id="np-notes" label="Observações" type="textarea" value={form.notes}
        onChange={(value) => setForm({ ...form, notes: value })} />
    </Drawer>
  );
}

// ── Comissões ────────────────────────────────────────────────────────────────

function Commissions({ onMessage }) {
  const fetcher = useCallback((filters) => listCommissions(filters), []);
  const list = useResourceList(fetcher, { status: '', open: '' });
  const [changing, setChanging] = useState(null);

  const columns = [
    { key: 'beneficiary_display', header: 'Beneficiário' },
    { key: 'sale_number', header: 'Venda', render: (row) => row.sale_number || '—' },
    { key: 'base_amount', header: 'Base', align: 'right', render: (row) => money(row.base_amount) },
    { key: 'rate', header: 'Regra', align: 'right',
      render: (row) => (row.rate_type === 'percentual' ? `${Number(row.rate_value)}%` : money(row.rate_value)) },
    { key: 'amount', header: 'Valor', align: 'right', render: (row) => <strong>{money(row.amount)}</strong> },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'expected_date', header: 'Previsto para',
      render: (row) => (row.expected_date ? fmtDate(row.expected_date) : '—') },
    { key: 'actions', header: 'Ações', align: 'right',
      render: (row) => (
        ['prevista', 'confirmada'].includes(row.status) ? (
          <button type="button" className="btn-secondary"
            onClick={(event) => { event.stopPropagation(); setChanging(row); }}>Cancelar</button>
        ) : null
      ) },
  ];

  return (
    <>
      <Notice tone="info">
        Comissões são calculadas como sugestão e só existem depois da confirmação na ação
        “Preparar pagamentos”. Nada é gerado em segundo plano.
      </Notice>
      <FilterBar
        ariaLabel="Filtros de comissões"
        fields={[
          { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
            options: asOptions(['prevista', 'confirmada', 'paga', 'cancelada', 'estornada']) },
          { key: 'open', label: 'Em aberto', type: 'select', empty: 'Todas',
            options: [{ value: 'true', label: 'Somente em aberto' }] },
        ]}
        values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
      />
      <DataTable
        caption="Comissões"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload}
        emptyTitle="Nenhuma comissão registrada"
        emptyDescription="Confirme obrigações na execução para registrar comissões."
      />
      {list.pagination}

      <ConfirmDialog
        open={Boolean(changing)}
        title="Cancelar comissão"
        message={`A comissão de ${money(changing?.amount)} para ${changing?.beneficiary_display} será cancelada e o motivo fica no histórico.`}
        confirmLabel="Cancelar comissão" danger requireReason reasonLabel="Motivo"
        onConfirm={async (reason) => {
          try {
            await changeCommissionStatus(changing.id, {
              status: 'cancelada', reason, row_version: changing.row_version,
            });
            onMessage({ tone: 'success', text: 'Comissão cancelada.' });
            list.reload();
          } catch (error) { onMessage({ tone: 'error', text: error.message }); }
          setChanging(null);
        }}
        onClose={() => setChanging(null)}
      />
    </>
  );
}
