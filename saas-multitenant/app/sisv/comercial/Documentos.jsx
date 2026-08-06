'use client';

// =============================================================================
// Documentos.jsx — templates (§13), documentos gerados/anexados (§13, §31) e
// contratos operacionais (§14).
//
// O editor de template aceita apenas TEXTO com variáveis {{autorizadas}}; a
// lista de variáveis vem do backend e o corpo é validado no servidor. HTML,
// script e expressões são recusados — a tela avisa antes de tentar salvar.
//
// Contrato aqui é controle operacional: gerar, anexar, registrar assinatura
// manual, substituir e cancelar. Não há assinatura eletrônica nesta rodada.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, ConfirmDialog } from '../../components/ui';
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, getTemplateFields,
  listCommercialDocs, getCommercialDoc, updateCommercialDoc, deleteCommercialDoc, attachDocument,
  listContracts, createContract, updateContract, replaceContract, deleteContract,
  listOrders, listSales, listServiceOrders,
} from '../../lib/commercialAPI';
import { getClients } from '../../lib/clientsAPI';
import { uploadFile } from '../../lib/uploadsAPI';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { canUserAccessCommercialEntity } from '../../lib/brand';
import {
  DataTable, Field, FilterBar, FormRow, Notice, SectionHeader, StatusBadge, Tabs,
  useResourceList, label, asOptions,
} from './shared';

const DOC_TYPES = ['ordem_servico', 'recibo', 'contrato', 'formulario', 'termo', 'protocolo', 'personalizado'];

const LINK_TARGETS = [
  { value: 'order', label: 'Pedido', defaultStage: 'pedido' },
  { value: 'sale', label: 'Venda', defaultStage: 'venda' },
  { value: 'service_order', label: 'Ordem de serviço', defaultStage: 'execucao' },
  { value: 'client', label: 'Cliente', defaultStage: 'atendimento' },
];

const readCurrentUser = () => {
  if (typeof window === 'undefined') return null;
  try { return JSON.parse(localStorage.getItem('user') || 'null'); }
  catch { return null; }
};

const allowedLinkTargets = (user) => LINK_TARGETS
  .filter((target) => canUserAccessCommercialEntity(user, target.value));

export default function Documentos({ initialTab = 'documentos' }) {
  const [tab, setTab] = useState(initialTab);
  const [message, setMessage] = useState(null);
  return (
    <div className="sisv-page">
      <SectionHeader
        breadcrumb={['Atendimento', 'Documentos e contratos']}
        title="Documentos comerciais"
        subtitle="Templates, documentos gerados ou anexados e controle operacional de contratos."
      />
      {message && <Notice tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Notice>}
      <Tabs
        ariaLabel="Seções de documentos"
        tabs={[
          { key: 'documentos', label: 'Documentos' },
          { key: 'contratos', label: 'Contratos' },
          { key: 'templates', label: 'Templates' },
        ]}
        active={tab} onChange={setTab}
      />
      {tab === 'documentos' && <DocumentsList onMessage={setMessage} />}
      {tab === 'contratos' && <ContractsList onMessage={setMessage} />}
      {tab === 'templates' && <TemplatesList onMessage={setMessage} />}
    </div>
  );
}

// ── Documentos ───────────────────────────────────────────────────────────────

function DocumentsList({ onMessage }) {
  const fetcher = useCallback((filters) => listCommercialDocs(filters), []);
  const list = useResourceList(fetcher, { doc_type: '', stage: '' });
  const [openId, setOpenId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [attaching, setAttaching] = useState(false);

  const columns = [
    { key: 'title', header: 'Documento', render: (row) => <strong>{row.title}</strong> },
    { key: 'doc_type', header: 'Tipo', render: (row) => <StatusBadge value={row.doc_type} /> },
    { key: 'stage', header: 'Etapa', render: (row) => label(row.stage) },
    { key: 'template_name', header: 'Template',
      render: (row) => (row.template_name
        ? `${row.template_name} v${row.template_version}`
        : <span className="sisv-muted">anexado</span>) },
    { key: 'checksum', header: 'Checksum',
      render: (row) => (row.checksum
        ? <code className="sisv-checksum">{String(row.checksum).slice(0, 12)}</code> : '—') },
    { key: 'created_at', header: 'Gerado em', render: (row) => fmtDateTime(row.created_at) },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'actions', header: 'Ações', align: 'right',
      render: (row) => (
        row.status !== 'cancelado' ? (
          <button type="button" className="btn-secondary"
            onClick={(event) => { event.stopPropagation(); setDeleting(row); }}>Excluir</button>
        ) : null
      ) },
  ];

  return (
    <>
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de documentos"
          fields={[
            { key: 'doc_type', label: 'Tipo', type: 'select', empty: 'Todos',
              options: asOptions(DOC_TYPES) },
            { key: 'stage', label: 'Etapa', type: 'select', empty: 'Todas',
              options: asOptions(['atendimento', 'pedido', 'pagamento', 'venda', 'execucao', 'finalizacao']) },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-secondary" onClick={() => setAttaching(true)}>
          Anexar documento
        </button>
      </div>

      <DataTable
        caption="Documentos comerciais gerados e anexados"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setOpenId(row.id)}
        emptyTitle="Nenhum documento"
        emptyDescription="Documentos são gerados a partir dos templates publicados, no pedido ou na execução."
      />
      {list.pagination}

      {openId && <DocumentViewer documentId={openId} onClose={() => setOpenId(null)}
        onChanged={list.reload} onMessage={onMessage} />}
      {attaching && (
        <AttachDrawer onClose={() => setAttaching(false)}
          onDone={(text) => { setAttaching(false); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })} />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Excluir documento"
        message={`"${deleting?.title}" sairá da rotina, mas a exclusão continuará registrada no histórico administrativo.`}
        confirmLabel="Excluir documento" danger requireReason reasonLabel="Motivo da exclusão"
        onConfirm={async (reason) => {
          try {
            await deleteCommercialDoc(deleting.id, reason);
            onMessage({ tone: 'success', text: 'Documento excluído.' });
            list.reload();
          } catch (error) { onMessage({ tone: 'error', text: error.message }); }
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function DocumentViewer({ documentId, onClose, onChanged, onMessage }) {
  const [document, setDocument] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: '', doc_type: 'personalizado', stage: 'pedido' });
  useEffect(() => {
    getCommercialDoc(documentId).then((data) => {
      setDocument(data);
      setForm({ title: data.title, doc_type: data.doc_type, stage: data.stage });
    }).catch((error) => {
      onMessage({ tone: 'error', text: error.message }); onClose();
    });
  }, [documentId, onClose, onMessage]);

  return (
    <Drawer
      open title={document?.title || 'Documento'} onClose={onClose}
      headerExtra={document && !editing && (
        <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>Editar</button>
      )}
      footer={document && (editing ? (
        <>
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const updated = await updateCommercialDoc(documentId, form);
              setDocument({ ...document, ...updated });
              setEditing(false); onChanged();
              onMessage({ tone: 'success', text: 'Documento atualizado.' });
            } catch (error) { onMessage({ tone: 'error', text: error.message }); }
            finally { setBusy(false); }
          }}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </>
      ) : document.content ? (
        <button type="button" className="btn-secondary" onClick={() => window.print()}>Imprimir</button>
      ) : null)}
    >
      {!document ? <p className="sisv-muted">Carregando…</p> : (
        <>
          {editing && (
            <>
              <Field id="doc-title" label="Título" required value={form.title}
                onChange={(value) => setForm({ ...form, title: value })} />
              <FormRow>
                <Field id="doc-type" label="Tipo" type="select" value={form.doc_type}
                  onChange={(value) => setForm({ ...form, doc_type: value })} options={asOptions(DOC_TYPES)} />
                <Field id="doc-stage" label="Etapa" type="select" value={form.stage}
                  onChange={(value) => setForm({ ...form, stage: value })}
                  options={asOptions(['atendimento', 'pedido', 'pagamento', 'venda', 'execucao', 'finalizacao'])} />
              </FormRow>
            </>
          )}
          <dl className="sisv-datalist">
            <div><dt>Tipo</dt><dd><StatusBadge value={document.doc_type} /></dd></div>
            <div><dt>Etapa</dt><dd>{label(document.stage)}</dd></div>
            <div><dt>Template</dt>
              <dd>{document.template_name ? `${document.template_name} v${document.template_version}` : 'anexado'}</dd></div>
            <div><dt>Gerado por</dt><dd>{document.generated_by_name || '—'}</dd></div>
            <div><dt>Data</dt><dd>{fmtDateTime(document.created_at)}</dd></div>
            <div><dt>Checksum</dt>
              <dd>{document.checksum ? <code className="sisv-checksum">{document.checksum}</code> : '—'}</dd></div>
          </dl>
          {document.file_url && (
            <p><a href={document.file_url} target="_blank" rel="noreferrer">Abrir arquivo anexado</a></p>
          )}
          {document.content && (
            <>
              <h3>Conteúdo</h3>
              <pre className="sisv-document-body">{document.content}</pre>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

function AttachDrawer({ onClose, onDone, onError }) {
  const [currentUser] = useState(readCurrentUser);
  const targetOptions = useMemo(() => allowedLinkTargets(currentUser), [currentUser]);
  const [form, setForm] = useState(() => {
    const firstTarget = allowedLinkTargets(readCurrentUser())[0];
    return {
      entity_type: firstTarget?.value || '', entity_id: '', doc_type: 'personalizado', title: '',
      stage: firstTarget?.defaultStage || 'atendimento',
    };
  });
  const [records, setRecords] = useState([]);
  const [recordsBusy, setRecordsBusy] = useState(true);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setRecordsBusy(true);
    const source = {
      order: () => listOrders({ limit: 100 }),
      sale: () => listSales({ limit: 100 }),
      service_order: () => listServiceOrders({ limit: 100 }),
      client: () => getClients(),
    }[form.entity_type];
    if (!source) {
      setRecords([]);
      setRecordsBusy(false);
      return () => { active = false; };
    }
    source().then((result) => {
      if (!active) return;
      setRecords(Array.isArray(result) ? result : (result.rows || []));
    }).catch((error) => {
      if (active) { setRecords([]); onError(error.message); }
    }).finally(() => { if (active) setRecordsBusy(false); });
    return () => { active = false; };
  }, [form.entity_type]); // eslint-disable-line react-hooks/exhaustive-deps

  const recordLabel = (row) => {
    if (form.entity_type === 'client') return row.cpf ? `${row.name} · ${row.cpf}` : row.name;
    const number = row.number || row.sale_number || row.service_order_number || row.id?.slice(0, 8);
    return row.client_name ? `${number} · ${row.client_name}` : number;
  };

  return (
    <Drawer
      open title="Anexar documento" onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy || targetOptions.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                if (!form.entity_id) throw new Error('Selecione o registro relacionado.');
                if (!file) throw new Error('Selecione um arquivo para enviar.');
                const uploaded = await uploadFile(file);
                await attachDocument({ ...form, file_url: uploaded.url });
                onDone('Documento enviado e anexado.');
              }
              catch (error) { onError(error.message); } finally { setBusy(false); }
            }}>
            {busy ? 'Enviando…' : 'Enviar e anexar'}
          </button>
        </>
      )}
    >
      {targetOptions.length === 0 ? (
        <Notice tone="warning">Seu perfil não possui um módulo autorizado para vincular documentos.</Notice>
      ) : <FormRow>
        <Field id="at-entity" label="Vinculado a" type="select" value={form.entity_type}
          onChange={(value) => {
            const target = targetOptions.find((item) => item.value === value);
            setForm({ ...form, entity_type: value, entity_id: '', stage: target?.defaultStage || form.stage });
          }}
          options={targetOptions.map(({ value, label: targetLabel }) => ({ value, label: targetLabel }))} />
        <Field id="at-id" label="Registro" type="select" required value={form.entity_id}
          onChange={(value) => setForm({ ...form, entity_id: value })}
          options={[{ value: '', label: recordsBusy ? 'Carregando…' : 'Selecione…' },
            ...records.map((row) => ({ value: row.id, label: recordLabel(row) }))]} />
      </FormRow>}
      <Field id="at-title" label="Título" required value={form.title}
        onChange={(value) => setForm({ ...form, title: value })} />
      <FormRow>
        <Field id="at-type" label="Tipo" type="select" value={form.doc_type}
          onChange={(value) => setForm({ ...form, doc_type: value })}
          options={asOptions(DOC_TYPES)} />
        <Field id="at-stage" label="Etapa" type="select" value={form.stage}
          onChange={(value) => setForm({ ...form, stage: value })}
          options={asOptions(['atendimento', 'pedido', 'pagamento', 'venda', 'execucao', 'finalizacao'])} />
      </FormRow>
      <FileUploadField id="at-file" label="Arquivo" file={file} onChange={setFile} required />
    </Drawer>
  );
}

function FileUploadField({ id, label: text, file, onChange, required = false }) {
  return (
    <div className="form-group sisv-field sisv-file-field">
      <label htmlFor={id}>{text}{required ? ' *' : ''}</label>
      <label className="sisv-file-drop" htmlFor={id}>
        <input id={id} type="file" required={required} accept=".pdf,.jpg,.jpeg,.png,.webp"
          onChange={(event) => onChange(event.target.files?.[0] || null)} />
        <span className="sisv-file-drop-title">{file ? file.name : 'Selecionar arquivo'}</span>
        <span className="sisv-file-drop-hint">
          {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : 'PDF, JPG, PNG ou WEBP · máximo de 10 MB'}
        </span>
      </label>
    </div>
  );
}

// ── Contratos ────────────────────────────────────────────────────────────────

function ContractsList({ onMessage }) {
  const fetcher = useCallback((filters) => listContracts(filters), []);
  const list = useResourceList(fetcher, { q: '', status: '' });
  const [drawer, setDrawer] = useState(null);

  const columns = [
    { key: 'number', header: 'Número', render: (row) => <strong>{row.number}</strong> },
    { key: 'title', header: 'Título' },
    { key: 'client_name', header: 'Cliente' },
    { key: 'order_number', header: 'Pedido', render: (row) => row.order_number || '—' },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'signed_at', header: 'Assinado em',
      render: (row) => (row.signed_at ? fmtDate(row.signed_at) : '—') },
  ];

  return (
    <>
      <Notice tone="info">
        Controle operacional: o sistema registra o documento, a via assinada e a situação. Não há
        assinatura eletrônica nesta rodada.
      </Notice>
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de contratos"
          fields={[
            { key: 'q', label: 'Buscar', placeholder: 'Número, título ou cliente' },
            { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
              options: asOptions(['rascunho', 'gerado', 'enviado', 'assinado', 'recusado', 'cancelado', 'substituido']) },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={() => setDrawer({ mode: 'create' })}>
          Novo contrato
        </button>
      </div>
      <DataTable
        caption="Contratos operacionais"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setDrawer({ mode: 'edit', data: row })}
        emptyTitle="Nenhum contrato" emptyDescription="Registre contratos gerados ou externos."
      />
      {list.pagination}

      {drawer && (
        <ContractDrawer
          drawer={drawer} onClose={() => setDrawer(null)}
          onDone={(text) => { setDrawer(null); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })}
        />
      )}
    </>
  );
}

function ContractDrawer({ drawer, onClose, onDone, onError }) {
  const isCreate = drawer.mode === 'create';
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(isCreate ? {
    client_id: '', title: '', status: 'rascunho', signed_at: '', signed_by_name: '',
    notes: '',
  } : {
    client_id: drawer.data.client_id, title: drawer.data.title, status: drawer.data.status,
    signed_at: drawer.data.signed_at ? String(drawer.data.signed_at).slice(0, 10) : '',
    signed_by_name: drawer.data.signed_by_name || '',
    notes: drawer.data.notes || '',
  });
  const [file, setFile] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isCreate) getClients().then((rows) => setClients(rows || [])).catch(() => setClients([]));
  }, [isCreate]);

  const submit = async () => {
    setBusy(true);
    try {
      const fileData = file ? await uploadFile(file) : null;
      const payload = {
        ...form, signed_at: form.signed_at || null,
        ...(fileData ? { file_url: fileData.url } : {}),
      };
      if (isCreate) {
        await createContract(payload);
        onDone('Contrato criado.');
      } else {
        await updateContract(drawer.data.id, {
          ...payload, row_version: drawer.data.row_version,
        });
        onDone('Contrato atualizado.');
      }
    } catch (error) { onError(error.message); } finally { setBusy(false); }
  };

  return (
    <Drawer
      open
      title={isCreate ? 'Novo contrato' : `Contrato ${drawer.data.number}`}
      onClose={onClose}
      headerExtra={!isCreate && (
        <div className="sisv-inline-actions">
          <button type="button" className="btn-secondary"
            onClick={async () => {
              const title = window.prompt('Título do contrato substituto:', drawer.data.title);
              if (!title) return;
              try {
                await replaceContract(drawer.data.id, { title });
                onDone('Contrato substituído. A via anterior foi preservada.');
              } catch (error) { onError(error.message); }
            }}>
            Substituir
          </button>
          <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>Excluir</button>
        </div>
      )}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </>
      )}
    >
      {isCreate && (
        <Field id="ct-client" label="Cliente" type="select" required value={form.client_id}
          onChange={(value) => setForm({ ...form, client_id: value })}
          options={[{ value: '', label: 'Selecione…' },
            ...clients.map((client) => ({ value: client.id, label: client.name }))]} />
      )}
      <Field id="ct-title" label="Título" required value={form.title}
        onChange={(value) => setForm({ ...form, title: value })} />
      <FormRow>
        <Field id="ct-status" label="Situação" type="select" value={form.status}
          onChange={(value) => setForm({ ...form, status: value })}
          options={asOptions(['rascunho', 'gerado', 'enviado', 'assinado', 'recusado', 'cancelado'])} />
        <Field id="ct-signed" label="Data da assinatura" type="date" value={form.signed_at}
          onChange={(value) => setForm({ ...form, signed_at: value })}
          hint="Obrigatória quando a situação for “assinado”." />
      </FormRow>
      <Field id="ct-signer" label="Assinado por" value={form.signed_by_name}
        onChange={(value) => setForm({ ...form, signed_by_name: value })} />
      {!isCreate && drawer.data.file_url && !file && (
        <p className="sisv-current-file"><a href={drawer.data.file_url} target="_blank" rel="noreferrer">
          Abrir arquivo atual
        </a></p>
      )}
      <FileUploadField id="ct-file" label={drawer.data?.file_url ? 'Substituir arquivo' : 'Arquivo da via assinada'}
        file={file} onChange={setFile} />
      <Field id="ct-notes" label="Observações" type="textarea" value={form.notes}
        onChange={(value) => setForm({ ...form, notes: value })}
        hint="Obrigatória em cancelamento e recusa." />
      <ConfirmDialog
        open={confirmDelete} title="Excluir contrato"
        message="O contrato sairá da rotina, mas continuará disponível no histórico administrativo."
        confirmLabel="Excluir contrato" danger requireReason reasonLabel="Motivo da exclusão"
        onConfirm={async (reason) => {
          try { await deleteContract(drawer.data.id, reason); onDone('Contrato excluído.'); }
          catch (error) { onError(error.message); }
          setConfirmDelete(false);
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </Drawer>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

function TemplatesList({ onMessage }) {
  const fetcher = useCallback((filters) => listTemplates(filters), []);
  const list = useResourceList(fetcher, { doc_type: '', status: '' });
  const [drawer, setDrawer] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const columns = [
    { key: 'name', header: 'Template', render: (row) => <strong>{row.name}</strong> },
    { key: 'doc_type', header: 'Tipo', render: (row) => <StatusBadge value={row.doc_type} /> },
    { key: 'version', header: 'Versão', align: 'right', render: (row) => `v${row.version}` },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge value={row.status} /> },
    { key: 'created_by_name', header: 'Criado por', render: (row) => row.created_by_name || '—' },
    { key: 'published_at', header: 'Publicado em',
      render: (row) => (row.published_at ? fmtDate(row.published_at) : '—') },
    { key: 'actions', header: 'Ações', align: 'right', render: (row) => (
      <button type="button" className="btn-secondary" onClick={(event) => {
        event.stopPropagation(); setDeleting(row);
      }}>Excluir</button>
    ) },
  ];

  return (
    <>
      <div className="sisv-subheader">
        <FilterBar
          ariaLabel="Filtros de templates"
          fields={[
            { key: 'doc_type', label: 'Tipo', type: 'select', empty: 'Todos', options: asOptions(DOC_TYPES) },
            { key: 'status', label: 'Situação', type: 'select', empty: 'Todas',
              options: asOptions(['rascunho', 'publicado', 'inativo']) },
          ]}
          values={list.filters} onChange={list.setFilter} onClear={list.clearFilters}
        />
        <button type="button" className="btn-primary" onClick={() => setDrawer({ mode: 'create' })}>
          Novo template
        </button>
      </div>
      <DataTable
        caption="Templates de documento"
        columns={columns} rows={list.rows} loading={list.loading} error={list.error}
        onRetry={list.reload} onRowClick={(row) => setDrawer({ mode: 'edit', id: row.id })}
        emptyTitle="Nenhum template"
        emptyDescription="Crie templates de contrato, recibo, ordem de serviço e formulários."
      />
      {list.pagination}

      {drawer && (
        <TemplateDrawer
          drawer={drawer} onClose={() => setDrawer(null)}
          onDone={(text) => { setDrawer(null); onMessage({ tone: 'success', text }); list.reload(); }}
          onError={(text) => onMessage({ tone: 'error', text })}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)} title="Excluir template"
        message={`"${deleting?.name}" sairá da lista, sem apagar documentos que já foram gerados.`}
        confirmLabel="Excluir template" danger requireReason reasonLabel="Motivo da exclusão"
        onConfirm={async (reason) => {
          try {
            await deleteTemplate(deleting.id, reason);
            onMessage({ tone: 'success', text: 'Template excluído.' }); list.reload();
          } catch (error) { onMessage({ tone: 'error', text: error.message }); }
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function TemplateDrawer({ drawer, onClose, onDone, onError }) {
  const isCreate = drawer.mode === 'create';
  const [fields, setFields] = useState({});
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ name: '', doc_type: 'contrato', body: '', status: 'rascunho' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTemplateFields().then((data) => setFields(data.available_fields || {})).catch(() => setFields({}));
  }, []);

  useEffect(() => {
    if (isCreate) return;
    getTemplate(drawer.id).then((data) => {
      setDetail(data);
      setForm({ name: data.name, doc_type: data.doc_type, body: data.body, status: data.status });
    }).catch((error) => onError(error.message));
  }, [drawer, isCreate, onError]);

  const published = detail?.status === 'publicado';

  const submit = async () => {
    setBusy(true);
    try {
      if (isCreate) {
        await createTemplate(form);
        onDone('Template criado como rascunho. Publique para poder gerar documentos.');
      } else {
        await updateTemplate(drawer.id, {
          name: form.name,
          body: published ? undefined : form.body,
          status: form.status,
          row_version: detail.row_version,
        });
        onDone('Template atualizado.');
      }
    } catch (error) { onError(error.message); } finally { setBusy(false); }
  };

  const insertField = (key) => {
    if (!key) return;
    setForm({ ...form, body: `${form.body}{{${key}}}` });
  };

  return (
    <Drawer
      open
      title={isCreate ? 'Novo template' : (detail?.name || 'Template')}
      subtitle={detail ? `v${detail.version} · ${label(detail.status)}` : undefined}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </>
      )}
    >
      <Notice tone="info">
        O corpo aceita apenas texto e variáveis autorizadas no formato
        {' '}<code>{'{{cliente.nome}}'}</code>. HTML, script e expressões são recusados pelo servidor.
      </Notice>

      <FormRow>
        <Field id="tp-name" label="Nome" required value={form.name}
          onChange={(value) => setForm({ ...form, name: value })}
          hint={isCreate ? 'Repetir um nome existente cria uma nova versão.' : undefined} />
        <Field id="tp-type" label="Tipo" type="select" value={form.doc_type} disabled={!isCreate}
          onChange={(value) => setForm({ ...form, doc_type: value })}
          options={asOptions(DOC_TYPES)} />
      </FormRow>

      {!isCreate && (
        <Field id="tp-status" label="Situação" type="select" value={form.status}
          onChange={(value) => setForm({ ...form, status: value })}
          options={asOptions(['rascunho', 'publicado', 'inativo'])}
          hint="Somente templates publicados podem gerar documentos." />
      )}

      {published && (
        <Notice tone="info">
          Template publicado: o corpo não pode ser alterado. Crie uma nova versão com o mesmo nome.
        </Notice>
      )}

      <Field id="tp-insert" label="Inserir variável" type="select" value=""
        onChange={insertField} disabled={published}
        options={[{ value: '', label: 'Selecione uma variável autorizada…' },
          ...Object.entries(fields).map(([key, description]) => ({
            value: key, label: `{{${key}}} — ${description}`,
          }))]} />

      <Field id="tp-body" label="Corpo do documento" type="textarea" rows={14} required
        value={form.body} disabled={published}
        onChange={(value) => setForm({ ...form, body: value })} />
    </Drawer>
  );
}
