'use client';

// =============================================================================
// Catalogo.jsx — catálogo comercial de serviços e produtos (§7) e tabelas de
// preço (§8), em duas abas da mesma tela de cadastros.
//
// Preço de venda e custo são campos SEPARADOS; custo pode ficar em branco
// ("ainda não conhecido"). A margem é derivada e exibida, nunca digitada.
//
// Alterar uma tabela de preço não mexe em pedido já lançado: o aviso na tela
// diz isso explicitamente, porque é a dúvida natural de quem edita preço.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listCatalog, createCatalogItem, updateCatalogItem, deleteCatalogItem, getCatalogItem,
  listPriceTables, getPriceTable, createPriceTable, updatePriceTable, deletePriceTable,
  setPriceTableItems, duplicatePriceTable,
} from '../../lib/commercialAPI';
import { serviceTypes as serviceTypeCatalog } from '../../lib/tenantConfigAPI';
import {
  getClientFields, createClientField, updateClientField,
  getServiceClientFields, setServiceClientFields,
} from '../../lib/clientsAPI';
import { fmtDate } from '../../lib/format';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  money, useResourceList, label,
} from './shared';

const EMPTY_ITEM = {
  code: '', name: '', description: '', item_type: 'servico', category: '', unit: 'un',
  default_price: '', default_cost: '', estimated_duration_days: '', tenant_service_type_id: '',
  requires_process: false, requires_invoice: false, active: true,
};

export default function Catalogo() {
  const [tab, setTab] = useState('itens');
  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Cadastros', 'Serviços, produtos e preços']}
        title="Serviços, produtos e tabelas de preço"
        subtitle="Catálogo comercial e condições de venda praticadas pela operação."
      />
      <Tabs
        ariaLabel="Seções do catálogo"
        tabs={[
          { key: 'itens', label: 'Serviços e produtos' },
          { key: 'tabelas', label: 'Tabelas de preço' },
          { key: 'campos', label: 'Campos do cliente' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'itens' && <CatalogItems />}
      {tab === 'tabelas' && <PriceTables />}
      {tab === 'campos' && <ClientFields />}
    </div>
  );
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

function CatalogItems() {
  const fetcher = useCallback((filters) => listCatalog(filters), []);
  const list = useResourceList(fetcher, { q: '', item_type: '', active: 'true' });
  const [drawer, setDrawer] = useState(null);
  const [form, setForm] = useState(EMPTY_ITEM);
  const [serviceTypes, setServiceTypes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [fieldDefinitions, setFieldDefinitions] = useState([]);
  const [requiredFieldIds, setRequiredFieldIds] = useState([]);

  useEffect(() => {
    serviceTypeCatalog.list().then((rows) => setServiceTypes(rows || [])).catch(() => setServiceTypes([]));
    getClientFields().then((rows) => setFieldDefinitions(rows || [])).catch(() => setFieldDefinitions([]));
  }, []);

  const openCreate = () => { setForm(EMPTY_ITEM); setRequiredFieldIds([]); setDrawer({ mode: 'create' }); };

  const openEdit = async (row) => {
    try {
      const [detail, fieldContext] = await Promise.all([
        getCatalogItem(row.id),
        row.item_type === 'servico' ? getServiceClientFields(row.id) : Promise.resolve({ fields: [] }),
      ]);
      setForm({
        ...EMPTY_ITEM, ...detail,
        default_cost: detail.default_cost ?? '',
        estimated_duration_days: detail.estimated_duration_days ?? '',
        tenant_service_type_id: detail.tenant_service_type_id || '',
      });
      setRequiredFieldIds((fieldContext.fields || []).filter((field) => field.required).map((field) => field.id));
      setDrawer({ mode: 'edit', data: detail });
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        ...form,
        default_price: Number(form.default_price || 0),
        default_cost: form.default_cost === '' ? null : Number(form.default_cost),
        estimated_duration_days: form.estimated_duration_days === ''
          ? null : Number(form.estimated_duration_days),
        tenant_service_type_id: form.tenant_service_type_id || null,
      };
      const saved = drawer.mode === 'create'
        ? await createCatalogItem(payload)
        : await updateCatalogItem(drawer.data.id, { ...payload, row_version: drawer.data.row_version });
      await setServiceClientFields(saved.id, payload.item_type === 'servico'
        ? requiredFieldIds.map((field_definition_id) => ({ field_definition_id, required: true }))
        : []);
      setMessage({ tone: 'success', text: 'Item salvo.' });
      setDrawer(null);
      list.reload();
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    { key: 'code', header: 'Código' },
    { key: 'name', header: 'Nome',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          {row.category && <div className="sisv-cell-sub">{row.category}</div>}
        </div>
      ) },
    { key: 'item_type', header: 'Tipo', render: (row) => <StatusBadge value={row.item_type} /> },
    { key: 'default_price', header: 'Preço padrão', align: 'right',
      render: (row) => money(row.default_price) },
    { key: 'default_cost', header: 'Custo padrão', align: 'right',
      render: (row) => (row.default_cost === null ? <span className="sisv-muted">não definido</span> : money(row.default_cost)) },
    { key: 'margin', header: 'Margem', align: 'right',
      render: (row) => (row.estimated_margin_percent === null
        ? '—' : `${row.estimated_margin_percent}%`) },
    { key: 'active', header: 'Situação',
      render: (row) => <StatusBadge value={row.active ? 'ativa' : 'inativa'} /> },
    { key: 'actions', header: 'Ações', align: 'right', render: (row) => (
      <div className="sisv-row-actions">
        <button type="button" className="btn-secondary" onClick={(event) => {
          event.stopPropagation(); openEdit(row);
        }}>Editar</button>
        {row.active && <button type="button" className="btn-secondary" onClick={(event) => {
          event.stopPropagation(); setDeleting(row);
        }}>Excluir</button>}
      </div>
    ) },
  ];

  return (
    <>
      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros do catálogo"
          fields={[
            { key: 'q', label: 'Buscar', placeholder: 'Nome, código ou categoria' },
            { key: 'item_type', label: 'Tipo', type: 'select', empty: 'Todos',
              options: [{ value: 'servico', label: 'Serviço' }, { value: 'produto', label: 'Produto' }] },
            { key: 'active', label: 'Situação', type: 'select', empty: 'Todas',
              options: [{ value: 'true', label: 'Ativos' }, { value: 'false', label: 'Inativos' }] },
          ]}
          values={list.filters}
          onChange={list.setFilter}
          onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={openCreate}>Novo item</button>
      </div>

      <DataTable
        caption="Itens do catálogo comercial"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={openEdit}
        emptyTitle="Catálogo vazio"
        emptyDescription="Cadastre os serviços e produtos que a operação vende."
      />
      {list.pagination}

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.mode === 'create' ? 'Novo item do catálogo' : (drawer?.data?.name || 'Item')}
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
            <Field id="cat-code" label="Código" required autoFocus value={form.code}
              onChange={(value) => setForm({ ...form, code: value })} />
            <Field id="cat-type" label="Tipo" type="select" value={form.item_type}
              onChange={(value) => setForm({ ...form, item_type: value })}
              options={[{ value: 'servico', label: 'Serviço' }, { value: 'produto', label: 'Produto' }]} />
          </FormRow>
          <Field id="cat-name" label="Nome" required value={form.name}
            onChange={(value) => setForm({ ...form, name: value })} />
          <Field id="cat-desc" label="Descrição" type="textarea" value={form.description}
            onChange={(value) => setForm({ ...form, description: value })} />
          <FormRow columns={3}>
            <Field id="cat-cat" label="Categoria" value={form.category}
              onChange={(value) => setForm({ ...form, category: value })} />
            <Field id="cat-unit" label="Unidade" value={form.unit}
              onChange={(value) => setForm({ ...form, unit: value })} />
            <Field id="cat-days" label="Duração prevista (dias)" type="number" min="0"
              value={form.estimated_duration_days}
              onChange={(value) => setForm({ ...form, estimated_duration_days: value })} />
          </FormRow>
          <FormRow>
            <Field id="cat-price" label="Preço padrão" type="number" step="0.01" min="0" required
              value={form.default_price}
              onChange={(value) => setForm({ ...form, default_price: value })} />
            <Field id="cat-cost" label="Custo padrão" type="number" step="0.01" min="0"
              value={form.default_cost}
              onChange={(value) => setForm({ ...form, default_cost: value })}
              hint="Pode ficar em branco quando o custo ainda não é conhecido." />
          </FormRow>
          {form.default_price && form.default_cost !== '' && Number(form.default_price) > 0 && (
            <Notice tone="info">
              Margem estimada:{' '}
              {(((Number(form.default_price) - Number(form.default_cost)) / Number(form.default_price)) * 100).toFixed(2)}%
            </Notice>
          )}
          <Field id="cat-service" label="Tipo de processo relacionado" type="select"
            value={form.tenant_service_type_id}
            onChange={(value) => setForm({ ...form, tenant_service_type_id: value })}
            options={[{ value: '', label: 'Nenhum' },
              ...serviceTypes.map((type) => ({ value: type.id, label: type.label }))]}
            hint="Define o template operacional usado quando o item gera processo." />
          {form.item_type === 'servico' && (
            <section className="sisv-drawer-section" aria-label="Campos obrigatórios do cliente">
              <h3>Dados obrigatórios do cliente</h3>
              <p className="sisv-muted">
                Selecione os dados que o backend exigirá antes de enviar ou confirmar um pedido deste serviço.
              </p>
              {fieldDefinitions.length === 0 ? (
                <p className="sisv-muted">Nenhum campo ativo. Cadastre campos na aba “Campos do cliente”.</p>
              ) : fieldDefinitions.map((field) => (
                <Field key={field.id} id={`service-field-${field.id}`} type="checkbox" label={field.label}
                  value={requiredFieldIds.includes(field.id)}
                  onChange={(checked) => setRequiredFieldIds(checked
                    ? [...requiredFieldIds, field.id]
                    : requiredFieldIds.filter((id) => id !== field.id))} />
              ))}
            </section>
          )}
          <Field id="cat-proc" label="Exige processo com tramitação detalhada" type="checkbox"
            value={form.requires_process}
            onChange={(value) => setForm({ ...form, requires_process: value })} />
          <Field id="cat-nf" label="Exige nota fiscal" type="checkbox" value={form.requires_invoice}
            onChange={(value) => setForm({ ...form, requires_invoice: value })} />
          <Field id="cat-active" label="Item ativo" type="checkbox" value={form.active}
            onChange={(value) => setForm({ ...form, active: value })} />
        </form>
      </Drawer>
      <ConfirmDialog open={Boolean(deleting)} title="Excluir item do catálogo"
        message={`"${deleting?.name}" sairá da rotina. Pedidos antigos manterão os valores já registrados.`}
        confirmLabel="Excluir item" danger requireReason reasonLabel="Motivo da exclusão"
        onConfirm={async (reason) => {
          try {
            await deleteCatalogItem(deleting.id, reason);
            setMessage({ tone: 'success', text: 'Item excluído.' }); list.reload();
          } catch (error) { setMessage({ tone: 'error', text: error.message }); }
          setDeleting(null);
        }} onClose={() => setDeleting(null)} />
    </>
  );
}

// ── Tabelas de preço ─────────────────────────────────────────────────────────

function ClientFields() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(null);
  const [saving, setSaving] = useState(false);
  const EMPTY_FIELD = { field_key: '', label: '', field_type: 'text', sort_order: 0, active: true };
  const [form, setForm] = useState(EMPTY_FIELD);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await getClientFields()); }
    catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm(EMPTY_FIELD); setDrawer({ mode: 'create' }); };
  const openEdit = (row) => {
    setForm({
      field_key: row.field_key, label: row.label, field_type: row.field_type,
      sort_order: row.sort_order || 0, active: row.active,
    });
    setDrawer({ mode: 'edit', data: row });
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const payload = { ...form, sort_order: Number(form.sort_order || 0) };
      if (drawer.mode === 'create') await createClientField(payload);
      else await updateClientField(drawer.data.id, payload);
      setDrawer(null); await load();
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  };

  return (
    <>
      <Notice tone="info">
        Campos adicionais são opcionais no cadastro. Cada serviço decide quais serão exigidos na contratação;
        campos nativos preservam as colunas já existentes.
      </Notice>
      {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
      <div className="sisv-subheader"><span />
        <button type="button" className="btn-primary" onClick={openCreate}>Novo campo</button>
      </div>
      <DataTable caption="Campos disponíveis no cadastro do cliente" loading={loading} error=""
        rows={rows} onRowClick={openEdit} emptyTitle="Nenhum campo configurado"
        emptyDescription="Crie campos adicionais para vinculá-los aos serviços."
        columns={[
          { key: 'label', header: 'Nome apresentado', render: (row) => <strong>{row.label}</strong> },
          { key: 'field_key', header: 'Chave' },
          { key: 'field_type', header: 'Tipo', render: (row) => label(row.field_type) },
          { key: 'storage_kind', header: 'Origem', render: (row) => row.storage_kind === 'system' ? 'Nativo' : 'Adicional' },
          { key: 'service_count', header: 'Serviços que exigem', align: 'right' },
          { key: 'actions', header: 'Ações', align: 'right', render: (row) => (
            <button type="button" className="btn-secondary" onClick={(event) => {
              event.stopPropagation(); openEdit(row);
            }}>Editar</button>
          ) },
        ]} />
      <Drawer open={Boolean(drawer)} title={drawer?.mode === 'create' ? 'Novo campo do cliente' : form.label}
        onClose={() => setDrawer(null)} footer={<>
          <button type="button" className="btn-secondary" onClick={() => setDrawer(null)}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Salvando…' : 'Salvar campo'}
          </button>
        </>}>
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <Field id="cf-label" label="Nome apresentado" required autoFocus value={form.label}
            onChange={(value) => setForm({ ...form, label: value })} />
          <FormRow>
            <Field id="cf-key" label="Chave técnica" required value={form.field_key}
              disabled={drawer?.mode === 'edit'}
              onChange={(value) => setForm({ ...form, field_key: value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              hint="Use letras minúsculas, números e sublinhado. A chave é imutável." />
            <Field id="cf-type" label="Tipo" type="select" value={form.field_type}
              disabled={drawer?.data?.storage_kind === 'system'}
              onChange={(value) => setForm({ ...form, field_type: value })}
              options={['text', 'textarea', 'email', 'phone', 'date', 'number', 'boolean', 'document']
                .map((value) => ({ value, label: label(value) }))} />
          </FormRow>
          <Field id="cf-order" label="Ordem de exibição" type="number" value={form.sort_order}
            onChange={(value) => setForm({ ...form, sort_order: value })} />
          {drawer?.data?.storage_kind !== 'system' && (
            <Field id="cf-active" label="Campo ativo" type="checkbox" value={form.active}
              onChange={(value) => setForm({ ...form, active: value })} />
          )}
        </form>
      </Drawer>
    </>
  );
}

function PriceTables() {
  const fetcher = useCallback((filters) => listPriceTables(filters), []);
  const list = useResourceList(fetcher, { q: '', status: '' });
  const [drawer, setDrawer] = useState(null);
  const [message, setMessage] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const columns = [
    { key: 'name', header: 'Tabela',
      render: (row) => (
        <div>
          <strong>{row.name}</strong>
          {row.audience && <div className="sisv-cell-sub">{row.audience}</div>}
        </div>
      ) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'priority', header: 'Prioridade', align: 'right' },
    { key: 'validity', header: 'Vigência',
      render: (row) => `${row.starts_on ? fmtDate(row.starts_on) : 'sem início'} → ${row.ends_on ? fmtDate(row.ends_on) : 'sem fim'}` },
    { key: 'item_count', header: 'Itens', align: 'right' },
    { key: 'actions', header: 'Ações', align: 'right', render: (row) => (
      <div className="sisv-row-actions">
        <button type="button" className="btn-secondary" onClick={(event) => {
          event.stopPropagation(); setDrawer({ mode: 'edit', id: row.id });
        }}>Editar</button>
        {row.status !== 'inativa' && <button type="button" className="btn-secondary" onClick={(event) => {
          event.stopPropagation(); setDeleting(row);
        }}>Excluir</button>}
      </div>
    ) },
  ];

  return (
    <>
      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      <Notice tone="info">
        Alterar uma tabela não recalcula pedidos já lançados: cada item guarda o preço praticado no
        momento da inclusão. A exclusão retira a tabela da rotina sem apagar esse histórico.
      </Notice>

      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de tabelas de preço"
          fields={[
            { key: 'q', label: 'Buscar', placeholder: 'Nome da tabela' },
            { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
              options: [
                { value: 'rascunho', label: 'Rascunho' },
                { value: 'ativa', label: 'Ativa' },
                { value: 'inativa', label: 'Inativa' },
              ] },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={() => setDrawer({ mode: 'create' })}>
          Nova tabela
        </button>
      </div>

      <DataTable
        caption="Tabelas de preço"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload}
        onRowClick={(row) => setDrawer({ mode: 'edit', id: row.id })}
        emptyTitle="Nenhuma tabela de preço"
        emptyDescription="Sem tabela ativa, o pedido usa o preço padrão do catálogo."
      />
      {list.pagination}

      {drawer && (
        <PriceTableDrawer
          drawer={drawer}
          onClose={() => setDrawer(null)}
          onSaved={(text) => { setMessage({ tone: 'success', text }); setDrawer(null); list.reload(); }}
          onError={(text) => setMessage({ tone: 'error', text })}
        />
      )}
      <ConfirmDialog open={Boolean(deleting)} title="Excluir tabela de preço"
        message={`"${deleting?.name}" sairá da rotina. Pedidos já criados não serão alterados.`}
        confirmLabel="Excluir tabela" danger requireReason reasonLabel="Motivo da exclusão"
        onConfirm={async (reason) => {
          try {
            await deletePriceTable(deleting.id, reason);
            setMessage({ tone: 'success', text: 'Tabela excluída.' }); list.reload();
          } catch (error) { setMessage({ tone: 'error', text: error.message }); }
          setDeleting(null);
        }} onClose={() => setDeleting(null)} />
    </>
  );
}

function PriceTableDrawer({ drawer, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name: '', description: '', audience: '', starts_on: '', ends_on: '',
    priority: 0, status: 'rascunho',
  });
  const [detail, setDetail] = useState(null);
  const [items, setItems] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listCatalog({ active: 'true', limit: 200 }).then((result) => setCatalog(result.rows)).catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    if (drawer.mode !== 'edit') return;
    getPriceTable(drawer.id).then((data) => {
      setDetail(data);
      setForm({
        name: data.name || '', description: data.description || '', audience: data.audience || '',
        starts_on: data.starts_on ? String(data.starts_on).slice(0, 10) : '',
        ends_on: data.ends_on ? String(data.ends_on).slice(0, 10) : '',
        priority: data.priority || 0, status: data.status,
      });
      setItems((data.items || []).map((item) => ({
        catalog_item_id: item.catalog_item_id, name: item.name, code: item.code,
        price: item.price, cost: item.cost ?? '', max_discount_percent: item.max_discount_percent,
      })));
    }).catch((error) => onError(error.message));
  }, [drawer, onError]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        priority: Number(form.priority || 0),
        starts_on: form.starts_on || null,
        ends_on: form.ends_on || null,
      };
      let tableId = drawer.id;
      if (drawer.mode === 'create') {
        const created = await createPriceTable(payload);
        tableId = created.id;
      } else {
        await updatePriceTable(tableId, { ...payload, row_version: detail?.row_version });
      }
      await setPriceTableItems(tableId, items.map((item) => ({
        catalog_item_id: item.catalog_item_id,
        price: Number(item.price || 0),
        cost: item.cost === '' ? null : Number(item.cost),
        max_discount_percent: Number(item.max_discount_percent || 0),
      })));
      onSaved('Tabela de preço salva.');
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    const name = window.prompt('Nome da nova tabela:', `${form.name} (cópia)`);
    if (!name) return;
    try {
      await duplicatePriceTable(drawer.id, name);
      onSaved('Tabela duplicada. A original permanece inalterada.');
    } catch (error) {
      onError(error.message);
    }
  };

  const addItem = (catalogItemId) => {
    const item = catalog.find((entry) => entry.id === catalogItemId);
    if (!item || items.some((entry) => entry.catalog_item_id === catalogItemId)) return;
    setItems([...items, {
      catalog_item_id: item.id, name: item.name, code: item.code,
      price: item.default_price, cost: item.default_cost ?? '', max_discount_percent: 0,
    }]);
  };

  const patchItem = (id, key, value) =>
    setItems(items.map((item) => (item.catalog_item_id === id ? { ...item, [key]: value } : item)));

  return (
    <Drawer
      open
      title={drawer.mode === 'create' ? 'Nova tabela de preço' : (detail?.name || 'Tabela de preço')}
      onClose={onClose}
      headerExtra={drawer.mode === 'edit' && (
        <button type="button" className="btn-secondary" onClick={duplicate}>Duplicar</button>
      )}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Salvando…' : 'Salvar tabela'}
          </button>
        </>
      )}
    >
      <form onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Field id="pt-name" label="Nome" required autoFocus value={form.name}
          onChange={(value) => setForm({ ...form, name: value })} />
        <Field id="pt-desc" label="Descrição" type="textarea" rows={2} value={form.description}
          onChange={(value) => setForm({ ...form, description: value })} />
        <FormRow columns={3}>
          <Field id="pt-aud" label="Público ou contexto" value={form.audience}
            onChange={(value) => setForm({ ...form, audience: value })} />
          <Field id="pt-prio" label="Prioridade" type="number" min="0" value={form.priority}
            onChange={(value) => setForm({ ...form, priority: value })}
            hint="Maior prioridade vence quando há mais de uma tabela vigente." />
          <Field id="pt-status" label="Situação" type="select" value={form.status}
            onChange={(value) => setForm({ ...form, status: value })}
            options={[
              { value: 'rascunho', label: 'Rascunho' },
              { value: 'ativa', label: 'Ativa' },
              { value: 'inativa', label: 'Inativa' },
            ]} />
        </FormRow>
        <FormRow>
          <Field id="pt-start" label="Início da vigência" type="date" value={form.starts_on}
            onChange={(value) => setForm({ ...form, starts_on: value })} />
          <Field id="pt-end" label="Fim da vigência" type="date" value={form.ends_on}
            onChange={(value) => setForm({ ...form, ends_on: value })} />
        </FormRow>
      </form>

      <section className="sisv-drawer-section" aria-label="Itens e preços da tabela">
        <h3>Itens e preços</h3>
        <Field id="pt-add" label="Adicionar item do catálogo" type="select" value=""
          onChange={addItem}
          options={[{ value: '', label: 'Selecione um item…' },
            ...catalog
              .filter((item) => !items.some((entry) => entry.catalog_item_id === item.id))
              .map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))]} />

        {items.length === 0 ? (
          <p className="sisv-muted">Sem itens: o pedido usará o preço padrão do catálogo.</p>
        ) : (
          <div className="data-table-container sisv-table-wrap">
            <table className="data-table sisv-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Preço</th>
                  <th scope="col">Custo</th>
                  <th scope="col">Desc. máx. (%)</th>
                  <th scope="col">Ação</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.catalog_item_id}>
                    <td data-label="Item">{item.code} · {item.name}</td>
                    <td data-label="Preço">
                      <input type="number" step="0.01" min="0" value={item.price}
                        aria-label={`Preço de ${item.name}`}
                        onChange={(event) => patchItem(item.catalog_item_id, 'price', event.target.value)} />
                    </td>
                    <td data-label="Custo">
                      <input type="number" step="0.01" min="0" value={item.cost}
                        aria-label={`Custo de ${item.name}`}
                        onChange={(event) => patchItem(item.catalog_item_id, 'cost', event.target.value)} />
                    </td>
                    <td data-label="Desconto máximo">
                      <input type="number" step="0.01" min="0" max="100" value={item.max_discount_percent}
                        aria-label={`Desconto máximo de ${item.name}`}
                        onChange={(event) => patchItem(item.catalog_item_id, 'max_discount_percent', event.target.value)} />
                    </td>
                    <td data-label="Ação">
                      <button type="button" className="btn-secondary"
                        onClick={() => setItems(items.filter((entry) => entry.catalog_item_id !== item.catalog_item_id))}>
                        Remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail?.history?.length > 0 && (
        <section className="sisv-drawer-section" aria-label="Histórico da tabela">
          <h3>Histórico de alterações</h3>
          <ul className="sisv-timeline">
            {detail.history.map((event) => (
              <li key={event.id}>
                <strong>{label(event.action)}</strong>
                <span>{fmtDate(event.created_at)}{event.user_name ? ` · ${event.user_name}` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Drawer>
  );
}
