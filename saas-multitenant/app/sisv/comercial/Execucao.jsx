'use client';

// =============================================================================
// Execucao.jsx — ordens de serviço e execução (§23, §24, §25, §26, §28, §30, §33).
//
// Um drawer por ordem, com abas: Execução, Itens e processos, Custos,
// Obrigações e Finalização. A relação Pedido → Venda → Ordem → Processo aparece
// no cabeçalho, para que a origem de cada ordem fique explícita (§24).
//
// "Preparar pagamentos" é uma ação em dois passos e a tela deixa isso claro: a
// prévia é editável e nada é gravado antes do botão de confirmação.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listServiceOrders, getServiceOrder, changeServiceOrderStatus, assignServiceOrder,
  addServiceOrderProgress, addExecutionCost, updateExecutionCost, listSuppliers,
  previewObligations, confirmObligations, getFinalizationChecklist, finalizeServiceOrder,
  archiveServiceOrder, reopenServiceOrder, saveFiscalDocument, listTemplates, generateDocument,
} from '../../lib/commercialAPI';
import { getAssignees } from '../../lib/tenantConfigAPI';
import { fmtDate, fmtDateTime, prazoInfo } from '../../lib/format';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  money, useResourceList, useMeta, label, allowedTransitions, asOptions,
} from './shared';

export default function Execucao() {
  const meta = useMeta(useCallback(
    () => import('../../lib/commercialAPI').then((api) => api.getServiceOrderMeta()), []));
  const fetcher = useCallback((filters) => listServiceOrders(filters), []);
  const list = useResourceList(fetcher, {
    q: '', status: '', owner_id: '', priority: '', overdue: '', unassigned: '',
  });
  const [openId, setOpenId] = useState(null);
  const [message, setMessage] = useState(null);
  const [owners, setOwners] = useState([]);

  useEffect(() => {
    getAssignees().then((rows) => setOwners(rows || [])).catch(() => setOwners([]));
  }, []);

  // Handlers memoizados: o drawer os usa em dependências de efeito, e uma
  // função nova a cada render recarregaria a ordem a cada aviso exibido.
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const reloadList = useCallback(() => list.reload(), [list]);

  const columns = [
    { key: 'number', header: 'Ordem', render: (row) => <strong>{row.number}</strong> },
    { key: 'client_name', header: 'Cliente' },
    { key: 'sale_number', header: 'Venda', render: (row) => row.sale_number || '—' },
    { key: 'owner_name', header: 'Responsável',
      render: (row) => row.owner_name || <span className="sisv-muted">sem responsável</span> },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'due_date', header: 'Prazo',
      render: (row) => {
        const info = prazoInfo(row.due_date, ['concluida', 'arquivada', 'cancelada'].includes(row.status));
        return <span style={{ color: info.color, fontWeight: info.weight }}>{info.text}</span>;
      } },
    { key: 'process_count', header: 'Processos', align: 'right' },
    { key: 'cost_total', header: 'Custos', align: 'right', render: (row) => money(row.cost_total) },
  ];

  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Operação', 'Execução']}
        title="Execução"
        subtitle="Ordens de serviço liberadas, em execução, atrasadas e seus processos relacionados."
      />

      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}

      <FilterBar
        ariaLabel="Filtros de execução"
        fields={[
          { key: 'q', label: 'Buscar', placeholder: 'Ordem ou cliente' },
          { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
            options: asOptions(meta?.statuses || []) },
          { key: 'owner_id', label: 'Responsável', type: 'select', empty: 'Todos',
            options: owners.map((user) => ({ value: user.id, label: user.name })) },
          { key: 'priority', label: 'Prioridade', type: 'select', empty: 'Todas',
            options: asOptions(meta?.priorities || []) },
          { key: 'overdue', label: 'Atrasadas', type: 'select', empty: 'Todas',
            options: [{ value: 'true', label: 'Somente atrasadas' }] },
          { key: 'unassigned', label: 'Sem responsável', type: 'select', empty: 'Todas',
            options: [{ value: 'true', label: 'Somente sem responsável' }] },
        ]}
        values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
      />

      <DataTable
        caption="Ordens de serviço"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setOpenId(row.id)}
        emptyTitle="Nenhuma ordem de serviço"
        emptyDescription="Ordens aparecem aqui depois que uma venda confirmada gera a execução."
      />
      {list.pagination}

      {openId && (
        <ServiceOrderDrawer
          serviceOrderId={openId}
          meta={meta}
          owners={owners}
          onClose={closeDrawer}
          onChanged={reloadList}
          onMessage={setMessage}
        />
      )}
    </div>
  );
}

function ServiceOrderDrawer({ serviceOrderId, meta, owners, onClose, onChanged, onMessage }) {
  const [serviceOrder, setServiceOrder] = useState(null);
  const [tab, setTab] = useState('execucao');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    try {
      setServiceOrder(await getServiceOrder(serviceOrderId));
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
      onClose();
    }
  }, [serviceOrderId, onClose, onMessage]);

  useEffect(() => { load(); }, [load]);

  /**
   * Devolve `true` só quando a ação foi aceita pelo servidor. Formulários usam
   * esse retorno para não fechar (e não descartar o que o usuário digitou)
   * quando a operação é recusada.
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

  const transitions = allowedTransitions(meta, serviceOrder?.status);
  const needsReason = (status) => ['cancelada', 'pausada', 'aguardando_terceiro'].includes(status);

  const applyStatus = (status, reason) =>
    act(() => changeServiceOrderStatus(serviceOrderId, {
      status, reason, row_version: serviceOrder.row_version,
    }), `Ordem movida para ${label(status)}.`);

  return (
    <Drawer
      open
      title={serviceOrder ? `Ordem ${serviceOrder.number}` : 'Ordem de serviço'}
      subtitle={serviceOrder
        ? `${serviceOrder.client_name} · ${label(serviceOrder.status)}`
        : undefined}
      onClose={onClose}
      headerExtra={serviceOrder && <StatusBadge value={serviceOrder.status} />}
      footer={serviceOrder && (
        <div className="sisv-drawer-actions">
          {transitions.map((status) => (
            <button key={status} type="button" disabled={busy}
              className={status === 'em_execucao' || status === 'concluida' ? 'btn-primary' : 'btn-secondary'}
              onClick={() => (needsReason(status)
                ? setConfirm({ status })
                : applyStatus(status))}>
              {label(status)}
            </button>
          ))}
        </div>
      )}
    >
      {!serviceOrder ? <p className="sisv-muted">Carregando ordem…</p> : (
        <>
          {/* Cadeia completa: deixa explícita a relação do §24. */}
          <p className="sisv-chain">
            Pedido <strong>{serviceOrder.order_number || '—'}</strong> → Venda{' '}
            <strong>{serviceOrder.sale_number || '—'}</strong> → Ordem{' '}
            <strong>{serviceOrder.number}</strong>
            {serviceOrder.items.some((item) => item.process_id) && ' → Processo'}
          </p>

          <Tabs
            ariaLabel="Seções da ordem"
            tabs={[
              { key: 'execucao', label: 'Execução' },
              { key: 'itens', label: 'Itens e processos', count: serviceOrder.items.length },
              { key: 'custos', label: 'Custos', count: serviceOrder.costs.length },
              { key: 'obrigacoes', label: 'Obrigações', count: serviceOrder.payables.length },
              { key: 'finalizacao', label: 'Finalização' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'execucao' && (
            <ExecutionTab serviceOrder={serviceOrder} owners={owners} onAct={act} busy={busy} />
          )}
          {tab === 'itens' && <ItemsTab serviceOrder={serviceOrder} />}
          {tab === 'custos' && <CostsTab serviceOrder={serviceOrder} onAct={act} />}
          {tab === 'obrigacoes' && (
            <ObligationsTab serviceOrder={serviceOrder} onAct={act} onMessage={onMessage} />
          )}
          {tab === 'finalizacao' && (
            <FinalizationTab serviceOrder={serviceOrder} onAct={act} onMessage={onMessage} />
          )}
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={`Mover para ${label(confirm?.status)}`}
        message="Esta mudança fica registrada no histórico da ordem."
        confirmLabel="Confirmar"
        danger={confirm?.status === 'cancelada'}
        requireReason
        reasonLabel="Motivo"
        busy={busy}
        onConfirm={(reason) => { applyStatus(confirm.status, reason); setConfirm(null); }}
        onClose={() => setConfirm(null)}
      />
    </Drawer>
  );
}

function ExecutionTab({ serviceOrder, owners, onAct, busy }) {
  const [assign, setAssign] = useState({
    owner_id: serviceOrder.owner_id || '', priority: serviceOrder.priority,
    due_date: serviceOrder.due_date ? String(serviceOrder.due_date).slice(0, 10) : '',
  });
  const [note, setNote] = useState('');

  return (
    <section className="sisv-drawer-section" aria-label="Execução da ordem">
      <dl className="sisv-datalist">
        <div><dt>Cliente</dt><dd>{serviceOrder.client_name}</dd></div>
        <div><dt>Valor da venda</dt><dd>{money(serviceOrder.sale_amount)}</dd></div>
        <div><dt>Custo estimado</dt><dd>{money(serviceOrder.estimated_cost)}</dd></div>
        <div><dt>Setor</dt><dd>{serviceOrder.department_name || '—'}</dd></div>
        <div><dt>Início</dt><dd>{serviceOrder.started_at ? fmtDateTime(serviceOrder.started_at) : '—'}</dd></div>
        <div><dt>Conclusão</dt><dd>{serviceOrder.finished_at ? fmtDateTime(serviceOrder.finished_at) : '—'}</dd></div>
      </dl>

      <h3>Responsável e prazo</h3>
      <form onSubmit={(event) => {
        event.preventDefault();
        onAct(() => assignServiceOrder(serviceOrder.id, {
          ...assign,
          owner_id: assign.owner_id || null,
          due_date: assign.due_date || null,
          row_version: serviceOrder.row_version,
        }), 'Atribuição atualizada.');
      }}>
        <FormRow columns={3}>
          <Field id="ex-owner" label="Responsável" type="select" value={assign.owner_id}
            onChange={(value) => setAssign({ ...assign, owner_id: value })}
            options={[{ value: '', label: 'Sem responsável' },
              ...owners.map((user) => ({ value: user.id, label: user.name }))]} />
          <Field id="ex-prio" label="Prioridade" type="select" value={assign.priority}
            onChange={(value) => setAssign({ ...assign, priority: value })}
            options={asOptions(['baixa', 'normal', 'alta', 'urgente'])} />
          <Field id="ex-due" label="Prazo" type="date" value={assign.due_date}
            onChange={(value) => setAssign({ ...assign, due_date: value })} />
        </FormRow>
        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={busy}>Salvar atribuição</button>
        </div>
      </form>

      <h3>Registrar andamento</h3>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!note.trim()) return;
        const ok = await onAct(
          () => addServiceOrderProgress(serviceOrder.id, note), 'Andamento registrado.');
        if (ok) setNote('');
      }}>
        <Field id="ex-note" label="Andamento" type="textarea" value={note} onChange={setNote}
          hint="Fica no histórico da ordem; não altera a situação." />
        <div className="form-actions">
          <button type="submit" className="btn-secondary" disabled={busy || !note.trim()}>
            Registrar andamento
          </button>
        </div>
      </form>

      {serviceOrder.history?.length > 0 && (
        <>
          <h3>Histórico</h3>
          <ul className="sisv-timeline">
            {serviceOrder.history.map((event) => (
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

function ItemsTab({ serviceOrder }) {
  return (
    <section className="sisv-drawer-section" aria-label="Itens e processos">
      <p className="sisv-muted">
        Itens que exigem tramitação detalhada têm um processo vinculado; os demais são executados
        na própria ordem.
      </p>
      <ul className="sisv-list">
        {serviceOrder.items.map((item) => (
          <li key={item.id}>
            <span>{item.description}</span>
            <span>
              {item.process_id
                ? `Processo ${item.process_number || ''} · ${label(item.process_stage)}`
                : 'sem processo separado'}
            </span>
            <StatusBadge value={item.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostsTab({ serviceOrder, onAct }) {
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    listSuppliers({ active: 'true', limit: 200 })
      .then((result) => setSuppliers(result.rows)).catch(() => setSuppliers([]));
  }, []);

  return (
    <section className="sisv-drawer-section" aria-label="Custos da execução">
      <p className="sisv-muted">
        O custo pode ficar em aberto na venda e ser informado depois, quando for conhecido.
      </p>

      {form ? (
        <form className="sisv-inline-form" onSubmit={async (event) => {
          event.preventDefault();
          const ok = await onAct(() => addExecutionCost(serviceOrder.id, {
            ...form,
            planned_cost: Number(form.planned_cost || 0),
            actual_cost: form.actual_cost === '' ? null : Number(form.actual_cost),
            incurred_on: form.incurred_on || null,
          }), 'Custo registrado.');
          if (ok) setForm(null);
        }}>
          <Field id="cost-sup" label="Fornecedor / prestador" type="select" required
            value={form.supplier_id}
            onChange={(value) => setForm({ ...form, supplier_id: value })}
            options={[{ value: '', label: 'Selecione…' },
              ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.legal_name }))]} />
          <Field id="cost-desc" label="Serviço prestado" required value={form.description}
            onChange={(value) => setForm({ ...form, description: value })} />
          <FormRow columns={3}>
            <Field id="cost-planned" label="Custo previsto" type="number" step="0.01" min="0"
              value={form.planned_cost}
              onChange={(value) => setForm({ ...form, planned_cost: value })} />
            <Field id="cost-actual" label="Custo real" type="number" step="0.01" min="0"
              value={form.actual_cost}
              onChange={(value) => setForm({ ...form, actual_cost: value })}
              hint="Deixe em branco se ainda não souber." />
            <Field id="cost-date" label="Data" type="date" value={form.incurred_on}
              onChange={(value) => setForm({ ...form, incurred_on: value })} />
          </FormRow>
          <Field id="cost-doc" label="Documento de referência" value={form.document_ref}
            onChange={(value) => setForm({ ...form, document_ref: value })} />
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setForm(null)}>Cancelar</button>
            <button type="submit" className="btn-primary">Registrar custo</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn-secondary"
          onClick={() => setForm({
            supplier_id: '', description: '', planned_cost: '', actual_cost: '',
            incurred_on: '', document_ref: '',
          })}>
          Registrar custo de fornecedor
        </button>
      )}

      {serviceOrder.costs.length === 0 ? (
        <p className="sisv-muted">Nenhum custo registrado.</p>
      ) : (
        <ul className="sisv-list">
          {serviceOrder.costs.map((cost) => (
            <li key={cost.id}>
              <span>{cost.supplier_name} · {cost.description}</span>
              <span>
                previsto {money(cost.planned_cost)}
                {cost.actual_cost === null
                  ? ' · real não informado'
                  : ` · real ${money(cost.actual_cost)}`}
              </span>
              <span className="sisv-list-actions">
                <StatusBadge value={cost.status} />
                {cost.actual_cost === null && (
                  <button type="button" className="btn-secondary"
                    onClick={() => setEditing({ id: cost.id, actual_cost: '' })}>
                    Informar custo real
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form className="sisv-inline-form" onSubmit={async (event) => {
          event.preventDefault();
          const ok = await onAct(() => updateExecutionCost(editing.id, {
            actual_cost: Number(editing.actual_cost), status: 'confirmado',
          }), 'Custo real informado.');
          if (ok) setEditing(null);
        }}>
          <Field id="cost-real" label="Custo real" type="number" step="0.01" min="0" required autoFocus
            value={editing.actual_cost}
            onChange={(value) => setEditing({ ...editing, actual_cost: value })} />
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
            <button type="submit" className="btn-primary">Salvar</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ── Ação guiada "Preparar pagamentos" (§28) ──────────────────────────────────

function ObligationsTab({ serviceOrder, onAct, onMessage }) {
  const [preview, setPreview] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  const prepare = async () => {
    setLoading(true);
    try {
      const data = await previewObligations(serviceOrder.sale_id);
      setPreview(data);
      setEntries([...data.custos, ...data.comissoes].map((entry, index) => ({ ...entry, _key: index })));
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const patch = (key, field, value) =>
    setEntries(entries.map((entry) => (entry._key === key ? { ...entry, [field]: value } : entry)));

  const total = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

  return (
    <section className="sisv-drawer-section" aria-label="Obrigações da venda">
      <h3>Obrigações registradas</h3>
      {serviceOrder.payables.length === 0 ? (
        <p className="sisv-muted">Nenhuma obrigação registrada para esta ordem.</p>
      ) : (
        <ul className="sisv-list">
          {serviceOrder.payables.map((payable) => (
            <li key={payable.id}>
              <span>{payable.payee_name} · {payable.description}</span>
              <span>{money(payable.amount)} · vence {payable.due_date ? fmtDate(payable.due_date) : '—'}</span>
              <StatusBadge value={payable.status} />
            </li>
          ))}
        </ul>
      )}

      <h3>Preparar pagamentos</h3>
      <Notice tone="info">
        Esta é uma ação guiada, não uma automação: a prévia abaixo é calculada a partir dos custos e
        das regras de comissão, e você pode ajustar ou remover cada linha. Nada é registrado até
        você confirmar.
      </Notice>

      {!preview ? (
        <button type="button" className="btn-secondary" disabled={loading || !serviceOrder.sale_id}
          onClick={prepare}>
          {loading ? 'Calculando…' : 'Preparar pagamentos'}
        </button>
      ) : entries.length === 0 ? (
        <p className="sisv-muted">
          Nada a preparar: os custos e comissões desta venda já viraram obrigações.
        </p>
      ) : (
        <>
          <div className="data-table-container sisv-table-wrap">
            <table className="data-table sisv-table">
              <caption className="sisv-visually-hidden">Prévia de obrigações</caption>
              <thead>
                <tr>
                  <th scope="col">Tipo</th>
                  <th scope="col">Favorecido</th>
                  <th scope="col">Descrição</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Vencimento</th>
                  <th scope="col">Ação</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry._key}>
                    <td data-label="Tipo"><StatusBadge value={entry.kind} /></td>
                    <td data-label="Favorecido">{entry.payee_name}</td>
                    <td data-label="Descrição">
                      {entry.description}
                      <div className="sisv-cell-sub">{entry.source}</div>
                    </td>
                    <td data-label="Valor">
                      <input type="number" step="0.01" min="0" value={entry.amount}
                        aria-label={`Valor de ${entry.description}`}
                        onChange={(event) => patch(entry._key, 'amount', event.target.value)} />
                    </td>
                    <td data-label="Vencimento">
                      <input type="date" value={entry.due_date ? String(entry.due_date).slice(0, 10) : ''}
                        aria-label={`Vencimento de ${entry.description}`}
                        onChange={(event) => patch(entry._key, 'due_date', event.target.value)} />
                    </td>
                    <td data-label="Ação">
                      <button type="button" className="btn-secondary"
                        onClick={() => setEntries(entries.filter((item) => item._key !== entry._key))}>
                        Remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sisv-total">Total a confirmar: <strong>{money(total)}</strong></p>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => { setPreview(null); setEntries([]); }}>
              Descartar prévia
            </button>
            <button type="button" className="btn-primary"
              onClick={() => onAct(
                // `_key` é só o identificador local da linha editável na prévia.
                () => confirmObligations(serviceOrder.sale_id, entries.map((entry) => {
                  const payload = { ...entry, amount: Number(entry.amount) };
                  delete payload._key;
                  return payload;
                })),
                'Obrigações confirmadas e registradas.'
              ).then(() => { setPreview(null); setEntries([]); })}>
              Confirmar {entries.length} obrigação(ões)
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Finalização, nota fiscal e arquivamento ──────────────────────────────────

function FinalizationTab({ serviceOrder, onAct, onMessage }) {
  const [checklist, setChecklist] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [fiscal, setFiscal] = useState({
    status: serviceOrder.fiscal_document?.status || 'pendente',
    number: serviceOrder.fiscal_document?.number || '',
    series: serviceOrder.fiscal_document?.series || '',
    access_key: serviceOrder.fiscal_document?.access_key || '',
    issued_at: serviceOrder.fiscal_document?.issued_at
      ? String(serviceOrder.fiscal_document.issued_at).slice(0, 10) : '',
    amount: serviceOrder.fiscal_document?.amount || '',
    issuer: serviceOrder.fiscal_document?.issuer || '',
    required: serviceOrder.fiscal_document?.required ?? true,
  });
  const [reopening, setReopening] = useState(false);

  const loadChecklist = useCallback(async () => {
    try {
      setChecklist(await getFinalizationChecklist(serviceOrder.id));
    } catch (error) {
      onMessage({ tone: 'error', text: error.message });
    }
  }, [serviceOrder.id, onMessage]);

  useEffect(() => { loadChecklist(); }, [loadChecklist]);
  useEffect(() => {
    listTemplates({ status: 'publicado', limit: 100 })
      .then((result) => setTemplates(result.rows)).catch(() => setTemplates([]));
  }, []);

  return (
    <section className="sisv-drawer-section" aria-label="Finalização">
      <h3>Documentos finais</h3>
      <FormRow>
        <Field id="fin-template" label="Gerar documento final" type="select" value={selectedTemplate}
          onChange={setSelectedTemplate}
          options={[{ value: '', label: 'Selecione um template publicado…' },
            ...templates.map((template) => ({
              value: template.id, label: `${label(template.doc_type)} · ${template.name}`,
            }))]} />
        <div className="sisv-field-action">
          <button type="button" className="btn-secondary" disabled={!selectedTemplate}
            onClick={() => onAct(() => generateDocument({
              template_id: selectedTemplate, entity_type: 'service_order',
              entity_id: serviceOrder.id, stage: 'finalizacao',
            }), 'Documento final registrado.').then(loadChecklist)}>
            Gerar
          </button>
        </div>
      </FormRow>
      {serviceOrder.documents.length > 0 && (
        <ul className="sisv-list">
          {serviceOrder.documents.map((document) => (
            <li key={document.id}>
              <span>{document.title}</span>
              <span>{label(document.stage)} · {fmtDate(document.created_at)}</span>
              <StatusBadge value={document.status} />
            </li>
          ))}
        </ul>
      )}

      <h3>Nota fiscal</h3>
      <Notice tone="info">
        Registro manual. O SISV não emite nota fiscal e não se comunica com SEFAZ, prefeitura,
        NFS-e ou NF-e.
      </Notice>
      <form onSubmit={(event) => {
        event.preventDefault();
        onAct(() => saveFiscalDocument({
          sale_id: serviceOrder.sale_id,
          ...fiscal,
          amount: fiscal.amount === '' ? null : Number(fiscal.amount),
          issued_at: fiscal.issued_at || null,
        }), 'Nota fiscal registrada.').then(loadChecklist);
      }}>
        <FormRow columns={3}>
          <Field id="nf-status" label="Situação" type="select" value={fiscal.status}
            onChange={(value) => setFiscal({ ...fiscal, status: value })}
            options={asOptions(['nao_aplicavel', 'pendente', 'solicitada', 'emitida', 'cancelada', 'substituida'])} />
          <Field id="nf-number" label="Número" value={fiscal.number}
            onChange={(value) => setFiscal({ ...fiscal, number: value })} />
          <Field id="nf-series" label="Série" value={fiscal.series}
            onChange={(value) => setFiscal({ ...fiscal, series: value })} />
        </FormRow>
        <FormRow columns={3}>
          <Field id="nf-date" label="Data de emissão" type="date" value={fiscal.issued_at}
            onChange={(value) => setFiscal({ ...fiscal, issued_at: value })} />
          <Field id="nf-amount" label="Valor" type="number" step="0.01" min="0" value={fiscal.amount}
            onChange={(value) => setFiscal({ ...fiscal, amount: value })} />
          <Field id="nf-issuer" label="Emissor" value={fiscal.issuer}
            onChange={(value) => setFiscal({ ...fiscal, issuer: value })} />
        </FormRow>
        <Field id="nf-key" label="Chave de acesso" value={fiscal.access_key}
          onChange={(value) => setFiscal({ ...fiscal, access_key: value })} />
        <Field id="nf-req" label="Nota fiscal obrigatória" type="checkbox" value={fiscal.required}
          onChange={(value) => setFiscal({ ...fiscal, required: value })} />
        <div className="form-actions">
          <button type="submit" className="btn-secondary" disabled={!serviceOrder.sale_id}>
            Salvar registro da nota
          </button>
        </div>
      </form>

      <h3>Checklist de conclusão</h3>
      {!checklist ? <p className="sisv-muted">Carregando checklist…</p> : (
        <>
          <ul className="sisv-checklist">
            {checklist.checks.map((check) => (
              <li key={check.key} className={check.ok ? 'is-ok' : (check.blocking ? 'is-pending' : 'is-optional')}>
                <span aria-hidden="true">{check.ok ? '✓' : (check.blocking ? '!' : '•')}</span>
                <span>
                  {check.label}
                  <span className="sisv-cell-sub">{check.detail}</span>
                </span>
                <span className="sisv-visually-hidden">
                  {check.ok ? 'atendido' : (check.blocking ? 'bloqueante' : 'alerta')}
                </span>
              </li>
            ))}
          </ul>

          {checklist.already_finalized ? (
            <>
              <Notice tone="success">
                Atendimento finalizado em {fmtDateTime(checklist.already_finalized.finalized_at)}.
                {checklist.already_finalized.status === 'arquivada' && ' Arquivado.'}
              </Notice>
              <div className="form-actions">
                {checklist.already_finalized.status !== 'arquivada' && (
                  <button type="button" className="btn-primary"
                    onClick={() => onAct(() => archiveServiceOrder(serviceOrder.id), 'Atendimento arquivado.')
                      .then(loadChecklist)}>
                    Arquivar atendimento
                  </button>
                )}
                <button type="button" className="btn-secondary" onClick={() => setReopening(true)}>
                  Reabrir
                </button>
              </div>
            </>
          ) : (
            <>
              {checklist.blockers.length > 0 && (
                <Notice tone="error">{checklist.blockers.join(' ')}</Notice>
              )}
              <button type="button" className="btn-primary" disabled={!checklist.can_finalize}
                onClick={() => onAct(() => finalizeServiceOrder(serviceOrder.id, {
                  checklist: Object.fromEntries(checklist.checks.map((check) => [check.key, check.ok])),
                }), 'Atendimento finalizado.').then(loadChecklist)}>
                Finalizar atendimento
              </button>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={reopening}
        title="Reabrir atendimento"
        message="A reabertura preserva todo o histórico e volta a ordem para execução."
        confirmLabel="Reabrir"
        requireReason
        reasonLabel="Justificativa"
        onConfirm={(reason) => {
          setReopening(false);
          onAct(() => reopenServiceOrder(serviceOrder.id, reason), 'Atendimento reaberto.')
            .then(loadChecklist);
        }}
        onClose={() => setReopening(false)}
      />
    </section>
  );
}
