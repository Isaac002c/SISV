'use client';

// =============================================================================
// Pedidos.jsx — atendimento / front office (§9, §10, §11, §12).
//
// A tela de consulta é a lista; o pedido em si abre num drawer com as etapas do
// §9 (Cliente → Itens → Valores → Documentos → Revisão → Envio), em vez de um
// formulário único gigante.
//
// As situações e as transições NÃO estão codificadas aqui: vêm de
// GET /api/orders/meta. Os botões de mudança de situação são construídos a
// partir do que o backend permite para a situação atual.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listOrders, getOrder, createOrder, updateOrder, addOrderItem,
  removeOrderItem, changeOrderStatus, exportOrders, listCatalog, listPriceTables,
  listSuppliers, listActivePartners, resolvePrice, listTemplates, generateDocument, createReceivable,
} from '../../lib/commercialAPI';
import { getClients, createClient } from '../../lib/clientsAPI';
import { getAssignees } from '../../lib/tenantConfigAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  money, useResourceList, useMeta, label, allowedTransitions, asOptions,
} from './shared';

const STEPS = [
  { key: 'cliente', label: '1. Cliente' },
  { key: 'itens', label: '2. Itens' },
  { key: 'valores', label: '3. Valores' },
  { key: 'documentos', label: '4. Documentos' },
  { key: 'revisao', label: '5. Revisão' },
  { key: 'envio', label: '6. Envio' },
];

export default function Pedidos() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const meta = useMeta(useCallback(() => import('../../lib/commercialAPI').then((api) => api.getOrderMeta()), []));

  const fetcher = useCallback((filters) => listOrders(filters), []);
  const list = useResourceList(fetcher, {
    q: '', status: '', client_id: '', owner_id: '', date_from: '', date_to: '',
    min_value: '', max_value: '', payment_status: '', has_sale: '',
  });

  const [openId, setOpenId] = useState(searchParams.get('pedido') || null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState(null);
  const [owners, setOwners] = useState([]);

  useEffect(() => {
    getAssignees().then((rows) => setOwners(rows || [])).catch(() => setOwners([]));
  }, []);

  // O pedido aberto vive na URL, então o link é compartilhável e o filtro fica
  // preservado ao voltar (§12).
  //
  // Estes handlers são memoizados de propósito: o drawer usa `onClose` numa
  // dependência de efeito, e uma função nova a cada render faria o pedido
  // recarregar a cada aviso exibido — descartando o formulário em edição.
  const openOrder = useCallback((id) => {
    setOpenId(id);
    const params = new URLSearchParams(window.location.search);
    params.set('pedido', id);
    router.replace(`/dashboard?${params.toString()}`, { scroll: false });
  }, [router]);

  const closeOrder = useCallback(() => {
    setOpenId(null);
    const params = new URLSearchParams(window.location.search);
    params.delete('pedido');
    router.replace(`/dashboard?${params.toString()}`, { scroll: false });
  }, [router]);

  const reloadList = useCallback(() => list.reload(), [list]);

  const columns = [
    { key: 'number', header: 'Número', render: (row) => <strong>{row.number}</strong> },
    { key: 'client_name', header: 'Cliente',
      render: (row) => (
        <div>
          {row.client_name}
          {row.client_cpf && <div className="sisv-cell-sub">{row.client_cpf}</div>}
        </div>
      ) },
    { key: 'contractor_name', header: 'Contratante',
      render: (row) => (
        <div>
          {row.contractor_name || row.client_name}
          <div className="sisv-cell-sub">
            {row.contractor_type === 'partner' ? 'Parceiro' : 'O pr\u00f3prio cliente'}
          </div>
        </div>
      ) },
    { key: 'owner_name', header: 'Responsável', render: (row) => row.owner_name || '—' },
    { key: 'created_at', header: 'Data', render: (row) => fmtDate(row.created_at) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'total', header: 'Valor', align: 'right', render: (row) => money(row.total) },
    { key: 'payment_status', header: 'Pagamento',
      render: (row) => (row.payment_status
        ? <StatusBadge value={row.payment_status} />
        : <span className="sisv-muted">sem recebível</span>) },
    { key: 'sale_number', header: 'Venda',
      render: (row) => (row.sale_number ? <strong>{row.sale_number}</strong> : '—') },
    { key: 'execution_status', header: 'Execução',
      render: (row) => (row.execution_status
        ? <StatusBadge value={row.execution_status} /> : '—') },
  ];

  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Atendimento', 'Pedidos']}
        title="Pedidos"
        subtitle="Solicitação comercial do cliente, antes da confirmação da venda."
        actions={(
          <>
            <button type="button" className="btn-secondary" onClick={() => exportOrders(list.filters)}>
              Exportar CSV
            </button>
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              Novo pedido
            </button>
          </>
        )}
      />

      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}

      <FilterBar
        ariaLabel="Filtros de pedidos"
        fields={[
          { key: 'q', label: 'Buscar', placeholder: 'Número, cliente ou CPF' },
          { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
            options: asOptions(meta?.statuses || []) },
          { key: 'owner_id', label: 'Responsável', type: 'select', empty: 'Todos',
            options: owners.map((user) => ({ value: user.id, label: user.name })) },
          { key: 'date_from', label: 'De', type: 'date' },
          { key: 'date_to', label: 'Até', type: 'date' },
          { key: 'min_value', label: 'Valor mínimo', type: 'number' },
          { key: 'max_value', label: 'Valor máximo', type: 'number' },
          { key: 'payment_status', label: 'Pagamento', type: 'select', empty: 'Todos',
            options: asOptions(['pendente', 'parcial', 'recebido', 'vencido']) },
          { key: 'has_sale', label: 'Venda', type: 'select', empty: 'Todos',
            options: [{ value: 'true', label: 'Com venda' }, { value: 'false', label: 'Sem venda' }] },
        ]}
        values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
      />

      <DataTable
        caption="Consulta de pedidos"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => openOrder(row.id)}
        emptyTitle="Nenhum pedido encontrado"
        emptyDescription="Inicie um atendimento para registrar o primeiro pedido."
      />
      {list.pagination}

      {creating && (
        <NewOrderDrawer
          owners={owners}
          onClose={() => setCreating(false)}
          onCreated={(order) => {
            setCreating(false);
            list.reload();
            openOrder(order.id);
          }}
          onError={(text) => setMessage({ tone: 'error', text })}
        />
      )}

      {openId && (
        <OrderDrawer
          orderId={openId}
          meta={meta}
          owners={owners}
          onClose={closeOrder}
          onChanged={reloadList}
          onMessage={setMessage}
        />
      )}
    </div>
  );
}

// ── Criação rápida: cliente + tabela de preço ────────────────────────────────

function NewOrderDrawer({ owners, onClose, onCreated, onError }) {
  const [clients, setClients] = useState([]);
  const [priceTables, setPriceTables] = useState([]);
  const [partners, setPartners] = useState([]);
  const [form, setForm] = useState({
    client_id: '', price_table_id: '', origin_channel: 'balcao', owner_id: '', notes: '',
    contractor_type: 'client', contractor_partner_id: '',
  });
  const [newClient, setNewClient] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    getClients().then((rows) => setClients(rows || [])).catch(() => setClients([]));
    listPriceTables({ status: 'ativa', limit: 50 })
      .then((result) => setPriceTables(result.rows)).catch(() => setPriceTables([]));
    listActivePartners().then((rows) => setPartners(rows || [])).catch(() => setPartners([]));
  }, []);

  const filtered = clients.filter((client) => {
    if (!search) return true;
    const haystack = `${client.name} ${client.cpf || ''}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  }).slice(0, 8);
  const selectedClient = clients.find((client) => client.id === form.client_id);
  const selectedPartner = partners.find((partner) => partner.id === form.contractor_partner_id);

  const submit = async () => {
    if (!form.client_id) { onError('Selecione o cliente do pedido.'); return; }
    if (form.contractor_type === 'partner' && !form.contractor_partner_id) {
      onError('Selecione o parceiro contratante.'); return;
    }
    setSaving(true);
    try {
      const order = await createOrder({
        ...form,
        price_table_id: form.price_table_id || null,
        owner_id: form.owner_id || null,
      });
      onCreated(order);
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const saveClient = async () => {
    try {
      const created = await createClient(newClient);
      const row = created.data || created;
      setClients([row, ...clients]);
      setForm({ ...form, client_id: row.id });
      setSearch(row.name);
      setNewClient(null);
    } catch (error) {
      onError(error.message);
    }
  };

  return (
    <Drawer
      open
      title="Novo pedido"
      subtitle="Etapa 1 de 6 · Cliente"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={saving} onClick={submit}>
            {saving ? 'Criando…' : 'Criar pedido'}
          </button>
        </>
      )}
    >
      {newClient ? (
        <form onSubmit={(event) => { event.preventDefault(); saveClient(); }}>
          <h3 className="sisv-drawer-subtitle">Cadastrar cliente</h3>
          <Field id="nc-name" label="Nome" required autoFocus value={newClient.name}
            onChange={(value) => setNewClient({ ...newClient, name: value })} />
          <FormRow>
            <Field id="nc-cpf" label="CPF" value={newClient.cpf}
              onChange={(value) => setNewClient({ ...newClient, cpf: value })} />
            <Field id="nc-phone" label="Telefone" value={newClient.phone}
              onChange={(value) => setNewClient({ ...newClient, phone: value })} />
          </FormRow>
          <Field id="nc-email" label="E-mail" type="email" value={newClient.email}
            onChange={(value) => setNewClient({ ...newClient, email: value })} />
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setNewClient(null)}>Voltar</button>
            <button type="submit" className="btn-primary">Salvar cliente</button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="form-group sisv-field sisv-client-picker">
            <label htmlFor="no-client">Cliente *</label>
            {selectedClient ? (
              <div className="sisv-client-selected">
                <span>
                  <strong>{selectedClient.name}</strong>
                  {selectedClient.cpf && <small>{selectedClient.cpf}</small>}
                </span>
                <button type="button" className="btn-secondary" onClick={() => {
                  setForm({ ...form, client_id: '' }); setSearch('');
                }}>Trocar</button>
              </div>
            ) : (
              <>
                <input id="no-client" value={search} autoFocus placeholder="Digite nome ou CPF"
                  onChange={(event) => setSearch(event.target.value)} autoComplete="off" />
                <div className="sisv-client-results" role="listbox" aria-label="Clientes encontrados">
                  {filtered.map((client) => (
                    <button key={client.id} type="button" role="option" aria-selected="false"
                      onClick={() => {
                        setForm({ ...form, client_id: client.id }); setSearch(client.name);
                      }}>
                      <strong>{client.name}</strong>
                      <span>{client.cpf || client.phone || 'Sem documento informado'}</span>
                    </button>
                  ))}
                  {search && filtered.length === 0 && <p>Nenhum cliente encontrado.</p>}
                </div>
              </>
            )}
          </div>
          {!selectedClient && (
            <button type="button" className="btn-secondary"
              onClick={() => setNewClient({ name: search, cpf: '', phone: '', email: '' })}>
              Cadastrar novo cliente
            </button>
          )}

          <section className="sisv-drawer-section" aria-label="Identificação do contratante">
            <h3>Quem está contratando?</h3>
            <Field id="no-contractor" label="Contratante" type="select" value={form.contractor_type}
              onChange={(value) => setForm({
                ...form, contractor_type: value, contractor_partner_id: value === 'client' ? '' : form.contractor_partner_id,
              })}
              options={[{ value: 'client', label: 'O próprio cliente' }, { value: 'partner', label: 'Parceiro' }]} />
            {form.contractor_type === 'partner' && (
              <Field id="no-partner" label="Parceiro contratante" type="select" required
                value={form.contractor_partner_id}
                onChange={(value) => {
                  const partner = partners.find((row) => row.id === value);
                  setForm({ ...form, contractor_partner_id: value,
                    price_table_id: partner?.default_price_table_id || form.price_table_id });
                }}
                options={[{ value: '', label: 'Selecione um parceiro ativo…' },
                  ...partners.map((partner) => ({ value: partner.id, label: partner.legal_name }))]} />
            )}
            {selectedPartner && <CommercialTerms terms={selectedPartner} />}
          </section>

          <FormRow>
            <Field id="no-table" label="Tabela de preços" type="select" value={form.price_table_id}
              onChange={(value) => setForm({ ...form, price_table_id: value })}
              options={[{ value: '', label: 'Preço padrão do catálogo' },
                ...priceTables.map((table) => ({ value: table.id, label: table.name }))]} />
            <Field id="no-channel" label="Canal de origem" type="select" value={form.origin_channel}
              onChange={(value) => setForm({ ...form, origin_channel: value })}
              options={asOptions(['balcao', 'telefone', 'whatsapp', 'indicacao', 'site', 'parceiro', 'outro'])} />
          </FormRow>
          <Field id="no-owner" label="Responsável pelo atendimento" type="select" value={form.owner_id}
            onChange={(value) => setForm({ ...form, owner_id: value })}
            options={[{ value: '', label: 'Eu mesmo' },
              ...owners.map((user) => ({ value: user.id, label: user.name }))]} />
          <Field id="no-notes" label="Observações" type="textarea" value={form.notes}
            onChange={(value) => setForm({ ...form, notes: value })} />
        </form>
      )}
    </Drawer>
  );
}

// ── Drawer do pedido, com as etapas do atendimento ───────────────────────────

function OrderDrawer({ orderId, meta, owners, onClose, onChanged, onMessage }) {
  const [order, setOrder] = useState(null);
  const [step, setStep] = useState('itens');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  // O esqueleto só aparece na PRIMEIRA carga. Recarregar depois de uma ação não
  // pode desmontar o conteúdo: isso apagaria o formulário que o usuário está
  // preenchendo (ex.: corrigir um desconto recusado).
  const load = useCallback(async () => {
    try {
      setOrder(await getOrder(orderId));
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
      onClose();
    } finally {
      setLoading(false);
    }
  }, [orderId, onClose, onMessage]);

  useEffect(() => { load(); }, [load]);

  /**
   * Executa uma ação no pedido e devolve `true` só quando ela deu certo.
   * Quem chama usa esse retorno para decidir se fecha o formulário — em caso de
   * recusa do servidor (desconto acima do teto, por exemplo) o formulário
   * continua aberto com o que o usuário digitou, para ele corrigir.
   */
  const act = async (fn, successText) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
      if (successText) onMessage({ tone: 'success', text: successText });
      return true;
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const transitions = allowedTransitions(meta, order?.status);

  const applyStatus = (status, reason) =>
    act(() => changeOrderStatus(orderId, { status, reason, row_version: order.row_version }),
      status === 'cancelado' ? 'Pedido excluído.' : `Pedido movido para ${label(status)}.`);

  return (
    <Drawer
      open
      title={order ? `Pedido ${order.number}` : 'Pedido'}
      subtitle={order ? `${order.client_name} · ${label(order.status)}` : undefined}
      onClose={onClose}
      headerExtra={order && <StatusBadge value={order.status} />}
      footer={order && (
        <div className="sisv-drawer-actions">
          {transitions.map((status) => {
            const needsReason = status === 'cancelado';
            return (
              <button
                key={status}
                type="button"
                className={status === 'enviado_validacao' ? 'btn-primary' : 'btn-secondary'}
                disabled={busy}
                onClick={() => (needsReason
                  ? setConfirm({ status, title: 'Excluir pedido' })
                  : applyStatus(status))}
              >
                {status === 'enviado_validacao' ? 'Enviar para validação'
                  : (status === 'cancelado' ? 'Excluir' : label(status))}
              </button>
            );
          })}
        </div>
      )}
    >
      {loading || !order ? <p className="sisv-muted">Carregando pedido…</p> : (
        <>
          <Tabs
            ariaLabel="Etapas do atendimento"
            tabs={STEPS.map((entry) => ({ key: entry.key, label: entry.label }))}
            active={step}
            onChange={setStep}
          />

          {!order.can_edit && (
            <Notice tone="info">
              Pedido em “{label(order.status)}” não aceita edição de itens ou valores.
            </Notice>
          )}

          {step === 'cliente' && <StepClient order={order} owners={owners} onSave={act} />}
          {step === 'itens' && <StepItems order={order} onAct={act} />}
          {step === 'valores' && <StepValues order={order} onAct={act} />}
          {step === 'documentos' && <StepDocuments order={order} onAct={act} />}
          {step === 'revisao' && <StepReview order={order} />}
          {step === 'envio' && <StepSend order={order} transitions={transitions} onApply={applyStatus} busy={busy} />}
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || 'Confirmar'}
        message="O pedido sairá da rotina, mas esta ação ficará registrada no histórico administrativo."
        confirmLabel={confirm?.status === 'cancelado' ? 'Excluir pedido' : 'Confirmar'}
        danger
        requireReason
        reasonLabel={confirm?.status === 'cancelado' ? 'Motivo da exclusão' : 'Motivo'}
        busy={busy}
        onConfirm={async (reason) => {
          const status = confirm.status;
          const ok = await applyStatus(status, reason);
          setConfirm(null);
          if (ok && status === 'cancelado') onClose();
        }}
        onClose={() => setConfirm(null)}
      />
    </Drawer>
  );
}

function StepClient({ order, owners, onSave }) {
  const [partners, setPartners] = useState([]);
  const [form, setForm] = useState({
    owner_id: order.owner_id || '', origin_channel: order.origin_channel, notes: order.notes || '',
    contractor_type: order.contractor_type || 'client',
    contractor_partner_id: order.contractor_partner_id || '',
  });
  useEffect(() => { listActivePartners().then(setPartners).catch(() => setPartners([])); }, []);
  return (
    <section className="sisv-drawer-section" aria-label="Dados do cliente e atendimento">
      <dl className="sisv-datalist">
        <div><dt>Cliente atendido</dt><dd>{order.client_name}</dd></div>
        <div><dt>CPF / CNPJ</dt><dd>{order.client_cpf || '—'}</dd></div>
        <div><dt>Telefone</dt><dd>{order.client_phone || '—'}</dd></div>
        <div><dt>E-mail</dt><dd>{order.client_email || '—'}</dd></div>
        <div><dt>Tabela de preços</dt><dd>{order.price_table_name || 'Preço padrão do catálogo'}</dd></div>
        <div><dt>Contratante</dt><dd>{order.contractor_type === 'partner'
          ? (order.contractor_partner_name || 'Parceiro') : 'O próprio cliente'}</dd></div>
        <div><dt>Criado em</dt><dd>{fmtDateTime(order.created_at)}</dd></div>
      </dl>
      {order.contractor_type === 'partner' && <CommercialTerms terms={order.applied_commercial_terms || {}} snapshot />}

      {order.can_edit && (
        <form onSubmit={(event) => {
          event.preventDefault();
          onSave(() => updateOrder(order.id, { ...form, row_version: order.row_version }), 'Pedido atualizado.');
        }}>
          <FormRow>
            <Field id="oc-owner" label="Responsável" type="select" value={form.owner_id}
              onChange={(value) => setForm({ ...form, owner_id: value })}
              options={[{ value: '', label: 'Sem responsável' },
                ...owners.map((user) => ({ value: user.id, label: user.name }))]} />
            <Field id="oc-channel" label="Canal de origem" type="select" value={form.origin_channel}
              onChange={(value) => setForm({ ...form, origin_channel: value })}
              options={asOptions(['balcao', 'telefone', 'whatsapp', 'indicacao', 'site', 'parceiro', 'outro'])} />
          </FormRow>
          <FormRow>
            <Field id="oc-contractor" label="Contratante" type="select" value={form.contractor_type}
              onChange={(value) => setForm({ ...form, contractor_type: value,
                contractor_partner_id: value === 'client' ? '' : form.contractor_partner_id })}
              options={[{ value: 'client', label: 'O próprio cliente' }, { value: 'partner', label: 'Parceiro' }]} />
            {form.contractor_type === 'partner' && (
              <Field id="oc-partner" label="Parceiro ativo" type="select" required
                value={form.contractor_partner_id}
                onChange={(value) => setForm({ ...form, contractor_partner_id: value })}
                options={[{ value: '', label: 'Selecione…' },
                  ...partners.map((partner) => ({ value: partner.id, label: partner.legal_name }))]} />
            )}
          </FormRow>
          <Field id="oc-notes" label="Observações" type="textarea" value={form.notes}
            onChange={(value) => setForm({ ...form, notes: value })} />
          <div className="form-actions">
            <button type="submit" className="btn-primary">Salvar</button>
          </div>
        </form>
      )}
    </section>
  );
}

function StepItems({ order, onAct }) {
  const [catalog, setCatalog] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [adding, setAdding] = useState(null);

  useEffect(() => {
    listCatalog({ active: 'true', limit: 200 }).then((result) => setCatalog(result.rows)).catch(() => setCatalog([]));
    listSuppliers({ active: 'true', limit: 200 }).then((result) => setSuppliers(result.rows)).catch(() => setSuppliers([]));
  }, []);

  const startAdd = async (catalogItemId) => {
    if (!catalogItemId) return;
    try {
      const price = await resolvePrice({
        catalog_item_id: catalogItemId,
        price_table_id: order.price_table_id || undefined,
      });
      setAdding({
        catalog_item_id: catalogItemId,
        description: price.description,
        quantity: 1,
        unit_price: price.unit_price,
        unit_cost: price.unit_cost ?? '',
        discount: 0,
        surcharge: 0,
        supplier_id: '',
        notes: '',
        max_discount_percent: price.max_discount_percent,
        source: price.source,
        price_table_name: price.price_table_name,
      });
    } catch (error) {
      window.alert(error.message);
    }
  };

  const maxDiscount = adding
    ? Math.round(Number(adding.quantity) * Number(adding.unit_price) * (Number(adding.max_discount_percent) / 100) * 100) / 100
    : 0;

  return (
    <section className="sisv-drawer-section" aria-label="Itens do pedido">
      {order.can_edit && (
        <>
          <Field id="oi-add" label="Adicionar serviço ou produto" type="select" value=""
            onChange={startAdd}
            options={[{ value: '', label: 'Selecione um item do catálogo…' },
              ...catalog.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))]} />

          {adding && (
            <form className="sisv-inline-form" onSubmit={async (event) => {
              event.preventDefault();
              const ok = await onAct(() => addOrderItem(order.id, {
                ...adding,
                quantity: Number(adding.quantity),
                unit_price: Number(adding.unit_price),
                unit_cost: adding.unit_cost === '' ? null : Number(adding.unit_cost),
                discount: Number(adding.discount || 0),
                surcharge: Number(adding.surcharge || 0),
                supplier_id: adding.supplier_id || null,
              }), 'Item adicionado.');
              // Recusa do servidor mantém o formulário aberto para correção.
              if (ok) setAdding(null);
            }}>
              <Notice tone="info">
                Preço obtido de {adding.source === 'tabela' ? `“${adding.price_table_name}”` : 'catálogo (preço padrão)'}.
                Desconto máximo permitido: {money(maxDiscount)}.
              </Notice>
              <Field id="oi-desc" label="Descrição" required value={adding.description}
                onChange={(value) => setAdding({ ...adding, description: value })} />
              <FormRow columns={3}>
                <Field id="oi-qty" label="Quantidade" type="number" step="0.001" min="0.001"
                  value={adding.quantity}
                  onChange={(value) => setAdding({ ...adding, quantity: value })} />
                <Field id="oi-price" label="Preço unitário" type="number" step="0.01" min="0"
                  value={adding.unit_price}
                  onChange={(value) => setAdding({ ...adding, unit_price: value })} />
                <Field id="oi-cost" label="Custo estimado" type="number" step="0.01" min="0"
                  value={adding.unit_cost}
                  onChange={(value) => setAdding({ ...adding, unit_cost: value })}
                  hint="Opcional — pode ser informado depois." />
              </FormRow>
              <FormRow columns={3}>
                <Field id="oi-disc" label="Desconto" type="number" step="0.01" min="0"
                  value={adding.discount}
                  onChange={(value) => setAdding({ ...adding, discount: value })} />
                <Field id="oi-sur" label="Acréscimo" type="number" step="0.01" min="0"
                  value={adding.surcharge}
                  onChange={(value) => setAdding({ ...adding, surcharge: value })} />
                <Field id="oi-sup" label="Fornecedor sugerido" type="select" value={adding.supplier_id}
                  onChange={(value) => setAdding({ ...adding, supplier_id: value })}
                  options={[{ value: '', label: 'Nenhum' },
                    ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.legal_name }))]} />
              </FormRow>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setAdding(null)}>Cancelar</button>
                <button type="submit" className="btn-primary">Adicionar item</button>
              </div>
            </form>
          )}
        </>
      )}

      {order.items.length === 0 ? (
        <p className="sisv-muted">Nenhum item lançado.</p>
      ) : (
        <div className="data-table-container sisv-table-wrap">
          <table className="data-table sisv-table">
            <caption className="sisv-visually-hidden">Itens do pedido</caption>
            <thead>
              <tr>
                <th scope="col">Descrição</th>
                <th scope="col">Qtd</th>
                <th scope="col">Unitário</th>
                <th scope="col">Desconto</th>
                <th scope="col">Total</th>
                <th scope="col">Fornecedor</th>
                {order.can_edit && <th scope="col">Ação</th>}
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="Descrição">
                    {item.description}
                    {item.requires_process && <div className="sisv-cell-sub">gera processo</div>}
                  </td>
                  <td data-label="Qtd">{Number(item.quantity)}</td>
                  <td data-label="Unitário">{money(item.unit_price)}</td>
                  <td data-label="Desconto">{money(item.discount)}</td>
                  <td data-label="Total"><strong>{money(item.total)}</strong></td>
                  <td data-label="Fornecedor">{item.supplier_name || '—'}</td>
                  {order.can_edit && (
                    <td data-label="Ação">
                      <button type="button" className="btn-secondary"
                        onClick={() => onAct(() => removeOrderItem(order.id, item.id), 'Item removido.')}>
                        Remover
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StepValues({ order, onAct }) {
  const [receivable, setReceivable] = useState(null);
  return (
    <section className="sisv-drawer-section" aria-label="Valores do pedido">
      <dl className="sisv-datalist">
        <div><dt>Subtotal</dt><dd>{money(order.subtotal)}</dd></div>
        <div><dt>Desconto</dt><dd>{money(order.discount)}</dd></div>
        <div><dt>Acréscimo</dt><dd>{money(order.surcharge)}</dd></div>
        <div><dt>Total</dt><dd><strong>{money(order.total)}</strong></dd></div>
        <div><dt>Custo estimado</dt><dd>{money(order.estimated_cost)}</dd></div>
        <div><dt>Margem estimada</dt>
          <dd>{money(Number(order.total) - Number(order.estimated_cost))}</dd></div>
      </dl>

      <h3>Contas a receber</h3>
      {order.receivables.length === 0 ? (
        <p className="sisv-muted">Nenhum recebível criado para este pedido.</p>
      ) : (
        <ul className="sisv-list">
          {order.receivables.map((row) => (
            <li key={row.id}>
              <span>{row.description}</span>
              <span>{money(row.received_amount)} de {money(row.total_amount)}</span>
              <StatusBadge value={row.status} />
            </li>
          ))}
        </ul>
      )}

      {receivable ? (
        <form className="sisv-inline-form" onSubmit={async (event) => {
          event.preventDefault();
          const ok = await onAct(() => createReceivable({
            client_id: order.client_id,
            order_id: order.id,
            description: receivable.description,
            total_amount: Number(receivable.total_amount),
            due_date: receivable.due_date || null,
            payment_method: receivable.payment_method || null,
          }), 'Recebível criado.');
          if (ok) setReceivable(null);
        }}>
          <Field id="or-desc" label="Descrição" required value={receivable.description}
            onChange={(value) => setReceivable({ ...receivable, description: value })} />
          <FormRow columns={3}>
            <Field id="or-total" label="Valor total" type="number" step="0.01" min="0" required
              value={receivable.total_amount}
              onChange={(value) => setReceivable({ ...receivable, total_amount: value })} />
            <Field id="or-due" label="Vencimento" type="date" value={receivable.due_date}
              onChange={(value) => setReceivable({ ...receivable, due_date: value })} />
            <Field id="or-method" label="Forma de pagamento" type="select" value={receivable.payment_method}
              onChange={(value) => setReceivable({ ...receivable, payment_method: value })}
              options={asOptions(['pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia', 'outro'],
                { includeEmpty: 'Não definida' })} />
          </FormRow>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setReceivable(null)}>Cancelar</button>
            <button type="submit" className="btn-primary">Criar recebível</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn-secondary"
          onClick={() => setReceivable({
            description: `Serviços do pedido ${order.number}`,
            total_amount: order.total, due_date: '', payment_method: '',
          })}>
          Criar recebível
        </button>
      )}
    </section>
  );
}

function StepDocuments({ order, onAct }) {
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState('');

  useEffect(() => {
    listTemplates({ status: 'publicado', limit: 100 })
      .then((result) => setTemplates(result.rows)).catch(() => setTemplates([]));
  }, []);

  return (
    <section className="sisv-drawer-section" aria-label="Documentos do pedido">
      <FormRow>
        <Field id="od-template" label="Gerar documento a partir de template" type="select" value={selected}
          onChange={setSelected}
          options={[{ value: '', label: 'Selecione um template publicado…' },
            ...templates.map((template) => ({
              value: template.id, label: `${label(template.doc_type)} · ${template.name}`,
            }))]} />
        <div className="sisv-field-action">
          <button type="button" className="btn-primary" disabled={!selected}
            onClick={() => onAct(() => generateDocument({
              template_id: selected, entity_type: 'order', entity_id: order.id, stage: 'pedido',
            }), 'Documento gerado.')}>
            Gerar documento
          </button>
        </div>
      </FormRow>

      {templates.length === 0 && (
        <Notice tone="info">
          Nenhum template publicado. Cadastre em Cadastros → Templates de documento.
        </Notice>
      )}

      {order.documents.length === 0 ? (
        <p className="sisv-muted">Nenhum documento gerado para este pedido.</p>
      ) : (
        <ul className="sisv-list">
          {order.documents.map((document) => (
            <li key={document.id}>
              <span>{document.title}</span>
              <span>{label(document.doc_type)} · {fmtDate(document.created_at)}</span>
              <StatusBadge value={document.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StepReview({ order }) {
  return (
    <section className="sisv-drawer-section" aria-label="Revisão do pedido">
      <h3>Revisão antes do envio</h3>
      <ul className="sisv-checklist">
        <ChecklistLine ok={Boolean(order.client_id)} text={`Cliente atendido: ${order.client_name}`} />
        <ChecklistLine ok={order.contractor_type !== 'partner' || Boolean(order.contractor_partner_id)}
          text={`Contratante: ${order.contractor_type === 'partner'
            ? (order.contractor_partner_name || 'parceiro não selecionado') : 'o próprio cliente'}`} />
        <ChecklistLine ok={Boolean(order.client_field_validation?.valid)}
          text={order.client_field_validation?.valid
            ? 'Dados obrigatórios do cliente completos'
            : order.client_field_validation?.missing_service
              ? 'Inclua ao menos um serviço'
              : `Dados pendentes: ${(order.client_field_validation?.missing_fields || []).map((field) => field.label).join(', ') || 'verifique o cadastro'}`} />
        <ChecklistLine ok={order.items.length > 0}
          text={`Itens lançados (${order.items.length})`} />
        <ChecklistLine ok={Number(order.total) > 0} text={`Valor total: ${money(order.total)}`} />
        <ChecklistLine ok={Boolean(order.owner_id)} text="Responsável definido" />
        <ChecklistLine ok={order.documents.length > 0}
          text={`Documentos gerados (${order.documents.length})`} optional />
        <ChecklistLine ok={order.receivables.length > 0}
          text={`Recebíveis criados (${order.receivables.length})`} optional />
      </ul>
      {order.contractor_type === 'partner' && <CommercialTerms terms={order.applied_commercial_terms || {}} snapshot />}

      {order.validations?.length > 0 && (
        <>
          <h3>Decisões do back office</h3>
          <ul className="sisv-timeline">
            {order.validations.map((validation) => (
              <li key={validation.id}>
                <strong>{label(validation.decision)}</strong>
                <span>{fmtDateTime(validation.created_at)} · {validation.reviewed_by_name || 'sistema'}</span>
                {validation.reason && <p>{validation.reason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {order.history?.length > 0 && (
        <>
          <h3>Histórico</h3>
          <ul className="sisv-timeline">
            {order.history.map((event) => (
              <li key={event.id}>
                <strong>{label(event.action)}</strong>
                <span>{fmtDateTime(event.created_at)}{event.user_name ? ` · ${event.user_name}` : ''}</span>
                {event.reason && <p>{event.reason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CommercialTerms({ terms, snapshot = false }) {
  const discount = terms.discount_type
    ? (terms.discount_type === 'percentual'
      ? `${Number(terms.discount_value || 0)}%`
      : money(terms.discount_value))
    : 'Não definido';
  return (
    <div className="sisv-summary-box" aria-label="Condições comerciais aplicadas">
      <strong>{snapshot ? 'Condições registradas neste pedido' : 'Condições do parceiro'}</strong>
      <dl className="sisv-datalist">
        <div><dt>Tabela de preços</dt><dd>{terms.price_table_name || terms.default_price_table_name || 'Preço padrão'}</dd></div>
        <div><dt>Desconto de referência</dt><dd>{discount}</dd></div>
        <div><dt>Prazo</dt><dd>{terms.payment_terms || 'Não definido'}</dd></div>
        <div><dt>Meio de pagamento</dt><dd>{terms.payment_method || 'Não definido'}</dd></div>
        {terms.commercial_notes && <div><dt>Observações</dt><dd>{terms.commercial_notes}</dd></div>}
      </dl>
      {!snapshot && <small>Os itens só mudam de valor quando uma tabela de preços é aplicada.</small>}
    </div>
  );
}

function ChecklistLine({ ok, text, optional }) {
  return (
    <li className={ok ? 'is-ok' : (optional ? 'is-optional' : 'is-pending')}>
      <span aria-hidden="true">{ok ? '✓' : (optional ? '•' : '!')}</span>
      <span>{text}</span>
      <span className="sisv-visually-hidden">{ok ? 'concluído' : (optional ? 'opcional' : 'pendente')}</span>
    </li>
  );
}

function StepSend({ order, transitions, onApply, busy }) {
  const canSend = transitions.includes('enviado_validacao');
  return (
    <section className="sisv-drawer-section" aria-label="Envio para validação">
      <p>
        Ao enviar, o pedido entra na fila do back office para conferência de cliente, documentos,
        itens, preços, descontos, forma de pagamento e comprovante.
      </p>
      {canSend ? (
        <button type="button" className="btn-primary" disabled={busy}
          onClick={() => onApply('enviado_validacao')}>
          Enviar para validação
        </button>
      ) : (
        <Notice tone="info">
          Pedido em “{label(order.status)}” não pode ser enviado para validação agora.
        </Notice>
      )}
    </section>
  );
}
