'use client';

// =============================================================================
// Fornecedores.jsx — cadastro de fornecedores, prestadores e parceiros (§5, §6).
//
// A exclusão é lógica: o cadastro sai da rotina, mas seus vínculos (custos,
// obrigações e comissões) e sua auditoria permanecem preservados.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listSuppliers, getSupplier, createSupplier, updateSupplier, setSupplierActive, exportSuppliers,
  listPriceTables,
} from '../../lib/commercialAPI';
import { fmtDateTime } from '../../lib/format';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  money, useResourceList, label,
} from './shared';

const KINDS = ['fornecedor', 'prestador', 'parceiro', 'indicador', 'correspondente', 'outro'];

const EMPTY = {
  kind: 'fornecedor', person_type: 'pj', legal_name: '', trade_name: '', document: '',
  state_registration: '', contact_name: '', phone: '', whatsapp: '', email: '', address: '',
  bank_details: '', pix_key: '', services_provided: '', commission_type: '', commission_value: '',
  payment_terms: '', default_price_table_id: '', discount_type: '', discount_value: '',
  payment_method: '', commercial_notes: '', notes: '',
};

export default function Fornecedores() {
  const fetcher = useCallback((filters) => listSuppliers(filters), []);
  const list = useResourceList(fetcher, { q: '', kind: '', active: 'true' });

  const [drawer, setDrawer] = useState(null); // { mode: 'create'|'edit', data, detail }
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [deactivate, setDeactivate] = useState(null);
  const [section, setSection] = useState('parceiros');
  const [priceTables, setPriceTables] = useState([]);

  useEffect(() => {
    list.setFilter('kind', 'parceiro');
    listPriceTables({ status: 'ativa', limit: 200 })
      .then((result) => setPriceTables(result.rows || [])).catch(() => setPriceTables([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setForm({ ...EMPTY, kind: section === 'parceiros' ? 'parceiro' : 'fornecedor' });
    setDrawer({ mode: 'create' });
  };

  const openEdit = async (row) => {
    setDrawer({ mode: 'edit', data: row, loading: true });
    try {
      const detail = await getSupplier(row.id);
      setForm({
        ...EMPTY, ...detail,
        commission_type: detail.commission_type || '',
        commission_value: detail.commission_value ?? '',
        default_price_table_id: detail.default_price_table_id || '',
        discount_type: detail.discount_type || '',
        discount_value: detail.discount_value ?? '',
      });
      setDrawer({ mode: 'edit', data: detail, detail });
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
      setDrawer(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        ...form,
        commission_value: form.commission_value === '' ? null : Number(form.commission_value),
        commission_type: form.commission_type || null,
        default_price_table_id: form.default_price_table_id || null,
        discount_type: form.discount_type || null,
        discount_value: form.discount_value === '' ? null : Number(form.discount_value),
      };
      if (drawer.mode === 'create') {
        await createSupplier(payload);
        setMessage({ tone: 'success', text: 'Fornecedor cadastrado.' });
      } else {
        await updateSupplier(drawer.data.id, { ...payload, row_version: drawer.data.row_version });
        setMessage({ tone: 'success', text: 'Fornecedor atualizado.' });
      }
      setDrawer(null);
      list.reload();
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const applyDeactivate = async (reason) => {
    try {
      await setSupplierActive(deactivate.id, !deactivate.active, reason);
      setMessage({
        tone: 'success',
        text: deactivate.active ? 'Fornecedor excluído.' : 'Fornecedor restaurado.',
      });
      setDeactivate(null);
      list.reload();
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
      setDeactivate(null);
    }
  };

  const columns = [
    { key: 'legal_name', header: 'Nome / Razão social',
      render: (row) => (
        <div>
          <strong>{row.legal_name}</strong>
          {row.trade_name && <div className="sisv-cell-sub">{row.trade_name}</div>}
        </div>
      ) },
    { key: 'kind', header: 'Classificação', render: (row) => <StatusBadge value={row.kind} /> },
    { key: 'document', header: 'CPF / CNPJ', render: (row) => row.document || '—' },
    { key: 'contact', header: 'Contato',
      render: (row) => [row.contact_name, row.phone || row.whatsapp].filter(Boolean).join(' · ') || '—' },
    { key: 'commission', header: 'Comissão', align: 'right',
      render: (row) => (row.commission_type
        ? (row.commission_type === 'percentual'
          ? `${Number(row.commission_value || 0)}%`
          : money(row.commission_value))
        : '—') },
    { key: 'active', header: 'Situação',
      render: (row) => <StatusBadge value={row.active ? 'ativa' : 'inativa'} /> },
    { key: 'actions', header: 'Ações', align: 'right',
      render: (row) => (
        <div className="sisv-row-actions">
          <button type="button" className="btn-secondary"
            onClick={(event) => { event.stopPropagation(); openEdit(row); }}>Editar</button>
          <button type="button" className="btn-secondary"
            onClick={(event) => { event.stopPropagation(); setDeactivate(row); }}>
            {row.active ? 'Excluir' : 'Restaurar'}
          </button>
        </div>
      ) },
  ];

  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Cadastros', 'Fornecedores e parceiros']}
        title="Fornecedores e parceiros"
        subtitle="Fornecedores, prestadores, parceiros, indicadores e correspondentes."
        actions={(
          <>
            <button type="button" className="btn-secondary" onClick={() => exportSuppliers()}>
              Exportar CSV
            </button>
            <button type="button" className="btn-primary" onClick={openCreate}>Novo cadastro</button>
          </>
        )}
      />

      {message && (
        <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>
      )}

      <Tabs ariaLabel="Cadastros comerciais relacionados"
        tabs={[{ key: 'parceiros', label: 'Parceiros' }, { key: 'outros', label: 'Fornecedores e prestadores' }]}
        active={section}
        onChange={(value) => {
          setSection(value);
          list.setFilter('kind', value === 'parceiros' ? 'parceiro' : '');
        }} />

      <FilterBar
        ariaLabel="Filtros de fornecedores"
        fields={[
          { key: 'q', label: 'Buscar', placeholder: 'Nome, documento ou e-mail' },
          { key: 'kind', label: 'Classificação', type: 'select', empty: 'Todas',
            options: KINDS.map((kind) => ({ value: kind, label: label(kind) })) },
          { key: 'active', label: 'Situação', type: 'select', empty: 'Todas',
            options: [{ value: 'true', label: 'Ativos' }, { value: 'false', label: 'Excluídos' }] },
        ]}
        values={list.filters}
        onChange={list.setFilter}
        onClear={list.clearFilters}
      />

      <DataTable
        caption="Fornecedores e parceiros cadastrados"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        onRowClick={openEdit}
        emptyTitle="Nenhum fornecedor encontrado"
        emptyDescription="Cadastre fornecedores, prestadores e parceiros para usá-los em pedidos e custos."
      />
      {list.pagination}

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.mode === 'create' ? 'Novo cadastro' : (drawer?.data?.legal_name || 'Fornecedor')}
        subtitle={drawer?.mode === 'edit' ? 'Edição de fornecedor, prestador ou parceiro' : undefined}
        onClose={() => setDrawer(null)}
        footer={(
          <>
            <button type="button" className="btn-secondary" onClick={() => setDrawer(null)}>Cancelar</button>
            <button type="button" className="btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </>
        )}
      >
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <FormRow>
            <Field id="sup-kind" label="Classificação" type="select" value={form.kind}
              onChange={(value) => setForm({ ...form, kind: value })}
              options={KINDS.map((kind) => ({ value: kind, label: label(kind) }))} />
            <Field id="sup-person" label="Tipo de pessoa" type="select" value={form.person_type}
              onChange={(value) => setForm({ ...form, person_type: value })}
              options={[{ value: 'pj', label: 'Pessoa jurídica' }, { value: 'pf', label: 'Pessoa física' }]} />
          </FormRow>
          <Field id="sup-name" label="Nome ou razão social" required autoFocus value={form.legal_name}
            onChange={(value) => setForm({ ...form, legal_name: value })} />
          <FormRow>
            <Field id="sup-trade" label="Nome fantasia" value={form.trade_name}
              onChange={(value) => setForm({ ...form, trade_name: value })} />
            <Field id="sup-doc" label="CPF ou CNPJ" value={form.document}
              onChange={(value) => setForm({ ...form, document: value })}
              hint="Somente números são armazenados." />
          </FormRow>
          <FormRow>
            <Field id="sup-ie" label="Inscrição estadual" value={form.state_registration}
              onChange={(value) => setForm({ ...form, state_registration: value })} />
            <Field id="sup-contact" label="Contato" value={form.contact_name}
              onChange={(value) => setForm({ ...form, contact_name: value })} />
          </FormRow>
          <FormRow columns={3}>
            <Field id="sup-phone" label="Telefone" value={form.phone}
              onChange={(value) => setForm({ ...form, phone: value })} />
            <Field id="sup-whats" label="WhatsApp" value={form.whatsapp}
              onChange={(value) => setForm({ ...form, whatsapp: value })} />
            <Field id="sup-email" label="E-mail" type="email" value={form.email}
              onChange={(value) => setForm({ ...form, email: value })} />
          </FormRow>
          <Field id="sup-address" label="Endereço" type="textarea" rows={2} value={form.address}
            onChange={(value) => setForm({ ...form, address: value })} />
          <FormRow>
            <Field id="sup-bank" label="Dados bancários" type="textarea" rows={2} value={form.bank_details}
              onChange={(value) => setForm({ ...form, bank_details: value })} />
            <Field id="sup-pix" label="Chave Pix" value={form.pix_key}
              onChange={(value) => setForm({ ...form, pix_key: value })} />
          </FormRow>
          <Field id="sup-services" label="Serviços fornecidos" type="textarea" rows={2}
            value={form.services_provided}
            onChange={(value) => setForm({ ...form, services_provided: value })} />
          {form.kind === 'parceiro' && (
            <section className="sisv-drawer-section" aria-label="Condições comerciais do parceiro">
              <h3>Condições comerciais</h3>
              <Notice tone="info">
                As condições são copiadas para o pedido. Descontos não alteram itens automaticamente;
                a tabela de preços selecionada é a fonte dos valores praticados.
              </Notice>
              <Field id="sup-price-table" label="Tabela de preços padrão" type="select"
                value={form.default_price_table_id}
                onChange={(value) => setForm({ ...form, default_price_table_id: value })}
                options={[{ value: '', label: 'Preço padrão do catálogo' },
                  ...priceTables.map((table) => ({ value: table.id, label: table.name }))]} />
              <FormRow columns={3}>
                <Field id="sup-discount-type" label="Tipo de desconto" type="select" value={form.discount_type}
                  onChange={(value) => setForm({ ...form, discount_type: value })}
                  options={[{ value: '', label: 'Sem desconto definido' },
                    { value: 'percentual', label: 'Percentual' }, { value: 'fixo', label: 'Valor fixo' }]} />
                <Field id="sup-discount-value" label="Valor do desconto" type="number" min="0" step="0.01"
                  value={form.discount_value}
                  onChange={(value) => setForm({ ...form, discount_value: value })} />
                <Field id="sup-payment-method" label="Meio de pagamento" value={form.payment_method}
                  onChange={(value) => setForm({ ...form, payment_method: value })} />
              </FormRow>
              <Field id="sup-commercial-notes" label="Observações comerciais" type="textarea"
                value={form.commercial_notes}
                onChange={(value) => setForm({ ...form, commercial_notes: value })} />
            </section>
          )}
          <FormRow columns={3}>
            <Field id="sup-ctype" label="Tipo de comissão" type="select" value={form.commission_type}
              onChange={(value) => setForm({ ...form, commission_type: value })}
              options={[
                { value: '', label: 'Sem comissão' },
                { value: 'percentual', label: 'Percentual' },
                { value: 'fixo', label: 'Valor fixo' },
              ]} />
            <Field id="sup-cvalue" label="Valor da comissão" type="number" step="0.01" min="0"
              value={form.commission_value}
              onChange={(value) => setForm({ ...form, commission_value: value })}
              hint="Sugestão de cálculo. A comissão só é registrada após confirmação." />
            <Field id="sup-terms" label="Forma de pagamento" value={form.payment_terms}
              onChange={(value) => setForm({ ...form, payment_terms: value })} />
          </FormRow>
          <Field id="sup-notes" label="Observações" type="textarea" value={form.notes}
            onChange={(value) => setForm({ ...form, notes: value })} />
        </form>

        {drawer?.detail && <SupplierUsage detail={drawer.detail} />}
      </Drawer>

      <ConfirmDialog
        open={Boolean(deactivate)}
        title={deactivate?.active ? 'Excluir fornecedor' : 'Restaurar fornecedor'}
        message={deactivate?.active
          ? `O cadastro de "${deactivate?.legal_name}" deixará de aparecer em novas seleções, mas permanece em vendas, pagamentos e auditoria já registrados.`
          : `Restaurar "${deactivate?.legal_name}" para uso em novos pedidos e custos.`}
        confirmLabel={deactivate?.active ? 'Excluir' : 'Restaurar'}
        danger={Boolean(deactivate?.active)}
        requireReason={Boolean(deactivate?.active)}
        reasonLabel="Motivo da exclusão"
        onConfirm={applyDeactivate}
        onClose={() => setDeactivate(null)}
      />
    </div>
  );
}

/** Vínculos do fornecedor: o que ele já movimentou na operação. */
function SupplierUsage({ detail }) {
  const usage = detail.usage || {};
  const totalPayables = (usage.payables || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalCommissions = (usage.commissions || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return (
    <section className="sisv-drawer-section" aria-label="Vínculos do fornecedor">
      <h3>Vínculos na operação</h3>
      <dl className="sisv-datalist">
        <div><dt>Custos de execução</dt>
          <dd>{usage.execution_costs?.total || 0} · {money(usage.execution_costs?.amount)}</dd></div>
        <div><dt>Obrigações</dt>
          <dd>{(usage.payables || []).reduce((sum, row) => sum + row.total, 0)} · {money(totalPayables)}</dd></div>
        <div><dt>Comissões</dt>
          <dd>{(usage.commissions || []).reduce((sum, row) => sum + row.total, 0)} · {money(totalCommissions)}</dd></div>
        <div><dt>Itens de pedido</dt><dd>{usage.order_items || 0}</dd></div>
        <div><dt>Pedidos como contratante</dt><dd>{usage.contracted_orders || 0}</dd></div>
      </dl>

      <h3>Histórico</h3>
      {(detail.history || []).length === 0 ? (
        <p className="sisv-muted">Nenhum evento registrado.</p>
      ) : (
        <ul className="sisv-timeline">
          {detail.history.map((event) => (
            <li key={event.id}>
              <strong>{label(event.action)}</strong>
              <span>{fmtDateTime(event.created_at)}{event.user_name ? ` · ${event.user_name}` : ''}</span>
              {event.reason && <p>{event.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
