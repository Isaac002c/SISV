'use client';

// =============================================================================
// Detalhe do processo (SISV) — abas: Visão geral, Andamento, Documentos,
// Observações e Histórico.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { Drawer, ConfirmDialog, EmptyState, SkeletonRows } from '../components/ui';
import * as api from '../lib/processesAPI';
import {
  createNote, createTask, deleteNote, listTaskTypes, taskAction, updateNote, updateTask,
} from '../lib/operationsAPI';
import { getChecklist } from '../lib/tenantConfigAPI';
import { uploadFile } from '../lib/uploadsAPI';
import { fmtDate, fmtDateTime, prazoInfo } from '../lib/format';
import DocumentsManager from './DocumentsManager';
import { Badge } from './ui';

const ACTION_LABELS = {
  created: 'Processo criado',
  stage_changed: 'Mudança de etapa',
  status_changed: 'Mudança de status',
  seller_changed: 'Redistribuição',
  department_changed: 'Troca de setor',
  document_added: 'Documento anexado',
  document_removed: 'Documento removido',
  document_archived: 'Documento arquivado',
  document_restored: 'Documento restaurado',
  document_category_changed: 'Categoria do documento',
  note_added: 'Observação',
  finalized: 'Finalização',
  reopened: 'Reabertura',
  task_created: 'Pendência criada',
  task_updated: 'Pendência atualizada',
  task_completed: 'Pendência concluída',
  task_cancelled: 'Pendência cancelada',
  task_reopened: 'Pendência reaberta',
  note_created: 'Nota interna criada',
  note_updated: 'Nota interna editada',
  note_archived: 'Nota interna arquivada',
};

export default function ProcessDrawer({ id, config, assignees, isAdmin, onClose, onChanged }) {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind }
  const [busy, setBusy] = useState(false);

  const byCode = (list, code) => list.find((x) => x.code === code);

  const reload = useCallback(async () => {
    try { setLoading(true); setData(await api.getProcess(id)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (fn) => {
    try { setBusy(true); setErr(null); await fn(); await reload(); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const title = data ? (data.client_name || 'Processo') : 'Processo';
  const subtitle = data ? [data.fine_number && `Nº ${data.fine_number}`, data.protocol_number && `Prot. ${data.protocol_number}`].filter(Boolean).join(' · ') : '';

  const tabs = [
    ['overview', 'Visão geral'], ['flow', 'Andamento'],
    ['tasks', 'Pendências'], ['docs', 'Documentos'], ['notes', 'Notas internas'], ['history', 'Histórico'],
  ];

  return (
    <Drawer open title={title} subtitle={subtitle} onClose={onClose}
      headerExtra={data?.finalized_at ? <Badge label="Finalizado" color="#16a34a" /> : null}>
      {loading ? <SkeletonRows rows={6} /> : !data ? <EmptyState title="Não encontrado" /> : (
        <>
          {err && <div className="error-message" style={{ marginBottom: 12, fontSize: 13 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e2e8f0', marginBottom: 16, flexWrap: 'wrap' }}>
            {tabs.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer',
                fontSize: 13.5, fontWeight: 600, color: tab === k ? 'var(--primary)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === k ? 'var(--primary)' : 'transparent'}`, marginBottom: -1,
              }}>{l}</button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab data={data} config={config} byCode={byCode} act={act} busy={busy} />}
          {tab === 'flow' && (
            <FlowTab data={data} config={config} assignees={assignees} isAdmin={isAdmin} busy={busy}
              act={act} setConfirm={setConfirm} />
          )}
          {tab === 'docs' && <DocsTab data={data} config={config} isAdmin={isAdmin} act={act} busy={busy} />}
          {tab === 'tasks' && <TasksTab data={data} config={config} assignees={assignees} isAdmin={isAdmin} act={act} busy={busy} />}
          {tab === 'notes' && <NotesTab data={data} act={act} busy={busy} />}
          {tab === 'history' && <HistoryTab data={data} />}

          <ConfirmDialog
            open={!!confirm} busy={busy}
            title={confirm?.title} message={confirm?.message}
            confirmLabel={confirm?.confirmLabel} danger={confirm?.danger}
            requireReason={confirm?.requireReason}
            onClose={() => setConfirm(null)}
            onConfirm={async (reason) => { await confirm.onConfirm(reason); setConfirm(null); }}
          />
        </>
      )}
    </Drawer>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#94a3b8', fontSize: 13 }}>{label}</span>
      <span style={{ color: '#0f172a', fontSize: 13.5, fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function OverviewTab({ data, config, byCode, act, busy }) {
  const toInput = (v) => (v ? String(v).substring(0, 10) : '');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const startEdit = () => {
    setForm({
      fine_number: data.fine_number || '', protocol_number: data.protocol_number || '',
      tenant_service_type_id: data.tenant_service_type_id || '',
      opened_at: toInput(data.infraction_date), due_date: toInput(data.due_date),
      custom_data: data.custom_data || {},
    });
    setEditing(true);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    await act(() => api.updateProcess(data.id, {
      fine_number: form.fine_number, protocol_number: form.protocol_number,
      tenant_service_type_id: form.tenant_service_type_id || null,
      opened_at: form.opened_at || null, due_date: form.due_date || null,
      custom_data: form.custom_data || {},
    }));
    setEditing(false);
  };

  const selectedService = config.serviceTypes.find((item) => item.id === (editing ? form.tenant_service_type_id : data.tenant_service_type_id));
  const customFields = Array.isArray(selectedService?.custom_fields) ? selectedService.custom_fields.filter((field) => field.active !== false) : [];

  if (editing) {
    return (
      <div>
        <div className="form-group"><label>Nº do processo</label><input value={form.fine_number} onChange={set('fine_number')} /></div>
        <div className="form-group"><label>Protocolo</label><input value={form.protocol_number} onChange={set('protocol_number')} /></div>
        <div className="form-group"><label>Tipo de serviço</label>
          <select value={form.tenant_service_type_id} onChange={set('tenant_service_type_id')}>
            <option value="">—</option>
            {config.serviceTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Data de abertura</label><input type="date" value={form.opened_at} onChange={set('opened_at')} /></div>
          <div className="form-group"><label>Prazo</label><input type="date" value={form.due_date} onChange={set('due_date')} /></div>
        </div>
        {customFields.length > 0 && <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
          <strong style={{ fontSize: 13 }}>Campos complementares</strong>
          {customFields.sort((a, b) => (a.order || 0) - (b.order || 0)).map((field) => (
            <CustomFieldInput key={field.key} field={field} value={form.custom_data?.[field.key]} onChange={(value) => setForm((current) => ({ ...current, custom_data: { ...(current.custom_data || {}), [field.key]: value } }))} />
          ))}
        </div>}
        <div className="form-actions">
          <button className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>Cancelar</button>
          <button className="btn-primary" onClick={save} disabled={busy}>Salvar dados</button>
        </div>
      </div>
    );
  }

  const pr = prazoInfo(data.due_date, data.finalized_at);
  return (
    <div>
      {!data.finalized_at && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="btn-secondary" style={{ padding: '4px 12px', fontSize: 12.5 }} onClick={startEdit}>Editar dados</button>
        </div>
      )}
      <Row label="Cliente">{data.client_name || '—'}</Row>
      <Row label="CPF / CNH">{[data.client_cpf, data.client_cnh].filter(Boolean).join(' · ') || '—'}</Row>
      <Row label="Telefone">{data.client_phone || '—'}</Row>
      <Row label="Tipo de serviço">{data.service_type_label || '—'}</Row>
      <Row label="Nº do processo">{data.fine_number || '—'}</Row>
      <Row label="Protocolo">{data.protocol_number || '—'}</Row>
      <Row label="Etapa"><Badge label={byCode(config.stages, data.stage)?.label || data.stage} color={byCode(config.stages, data.stage)?.color} /></Row>
      <Row label="Status"><Badge label={byCode(config.statuses, data.status)?.label || data.status} color={byCode(config.statuses, data.status)?.color} /></Row>
      <Row label="Responsável">{data.seller_name || 'Sem responsável'}</Row>
      <Row label="Setor">{data.department_name || '—'}</Row>
      <Row label="Aberto em">{fmtDate(data.infraction_date) !== '—' ? fmtDate(data.infraction_date) : fmtDate(data.created_at)}</Row>
      <Row label="Prazo"><span style={{ color: pr.color, fontWeight: pr.weight }}>{pr.text}{pr.tag ? ` (${pr.tag})` : ''}</span></Row>
      <Row label="Última movimentação">{fmtDate(data.last_moved_at || data.updated_at)}</Row>
      {data.finalized_at && <Row label="Finalizado em">{fmtDate(data.finalized_at)}</Row>}
      {customFields.map((field) => <Row key={field.key} label={field.name}>{formatCustomValue(data.custom_data?.[field.key])}</Row>)}
    </div>
  );
}

function CustomFieldInput({ field, value, onChange }) {
  if (field.type === 'booleano') {
    return <label className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /> {field.name}{field.required ? ' *' : ''}</label>;
  }
  if (field.type === 'selecao') {
    return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><select required={field.required} value={value ?? ''} onChange={(event) => onChange(event.target.value)}><option value="">—</option>{(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}</select></div>;
  }
  if (field.type === 'texto_longo') {
    return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><textarea required={field.required} rows={3} value={value ?? ''} onChange={(event) => onChange(event.target.value)} /></div>;
  }
  return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><input required={field.required} type={field.type === 'numero' ? 'number' : field.type === 'data' ? 'date' : 'text'} value={value ?? ''} onChange={(event) => onChange(field.type === 'numero' ? event.target.valueAsNumber : event.target.value)} /></div>;
}

const formatCustomValue = (value) => value === true ? 'Sim' : value === false ? 'Não' : (value ?? '—');

function FlowTab({ data, config, assignees, isAdmin, busy, act, setConfirm }) {
  const [stage, setStage] = useState(data.stage);
  const [status, setStatus] = useState(data.status);
  const [seller, setSeller] = useState(data.seller_id || '');
  const [dept, setDept] = useState(data.department_id || '');
  const finalized = !!data.finalized_at;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {finalized && (
        <div style={{ padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13, color: '#166534' }}>
          Processo finalizado em {fmtDate(data.finalized_at)}. {isAdmin ? 'Você pode reabri-lo abaixo.' : 'Somente o gestor pode reabrir.'}
        </div>
      )}
      <FlowAction label="Etapa" onSave={() => act(() => api.moveStage(data.id, stage))} busy={busy} disabled={stage === data.stage || finalized}>
        <select value={stage} onChange={(e) => setStage(e.target.value)} disabled={finalized}>
          {config.stages.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
        </select>
      </FlowAction>
      <FlowAction label="Status" onSave={() => act(() => api.changeStatus(data.id, status))} busy={busy} disabled={status === data.status || finalized}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={finalized}>
          {config.statuses.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
        </select>
      </FlowAction>
      <FlowAction label="Responsável (redistribuir)" onSave={() => act(() => api.changeSeller(data.id, seller || null))} busy={busy} disabled={(seller || '') === (data.seller_id || '') || finalized}>
        <select value={seller} onChange={(e) => setSeller(e.target.value)} disabled={finalized}>
          <option value="">Sem responsável</option>
          {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </FlowAction>
      {config.departments.length > 0 && (
        <FlowAction label="Setor" onSave={() => act(() => api.changeDepartment(data.id, dept || null))} busy={busy} disabled={(dept || '') === (data.department_id || '') || finalized}>
          <select value={dept} onChange={(e) => setDept(e.target.value)} disabled={finalized}>
            <option value="">Sem setor</option>
            {config.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </FlowAction>
      )}

      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 14, display: 'flex', gap: 8 }}>
        {!finalized ? (
          <button className="btn-primary" disabled={busy} onClick={() => setConfirm({
            title: 'Finalizar processo', message: 'Confirmar a finalização deste processo? Ele continuará disponível para consulta.',
            confirmLabel: 'Finalizar',
            onConfirm: () => act(() => api.finalizeProcess(data.id, {
              stage: config.stages.find((s) => s.is_final)?.code,
              status: config.statuses.find((s) => s.code === 'FINALIZADO')?.code,
            })),
          })}>Finalizar processo</button>
        ) : isAdmin ? (
          <button className="btn-secondary" disabled={busy} onClick={() => setConfirm({
            title: 'Reabrir processo', message: 'Reabrir este processo finalizado?', confirmLabel: 'Reabrir',
            onConfirm: () => act(() => api.reopenProcess(data.id, {})),
          })}>Reabrir processo</button>
        ) : null}
      </div>
    </div>
  );
}

function FlowAction({ label, children, onSave, busy, disabled }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>{children}</div>
        <button className="btn-secondary" onClick={onSave} disabled={busy || disabled} style={{ whiteSpace: 'nowrap' }}>Salvar</button>
      </div>
    </div>
  );
}

function DocsTab({ data, config, isAdmin, act, busy }) {
  const upload = async (file, meta) => {
    const up = await uploadFile(file);
    await act(() => api.addDocument(data.id, {
      name: up.originalName || up.filename, file_url: up.url, file_type: up.mimeType, file_size: up.size,
      stored_name: up.filename, original_name: up.originalName, category_id: meta.category_id, notes: meta.notes,
    }));
  };
  return (
    <div>
      <DocChecklist serviceTypeId={data.tenant_service_type_id} documents={data.documents || []} />
      <DocumentsManager
        docs={data.documents || []}
        categories={config.documentCategories || []}
        canRemove={isAdmin}
        busy={busy}
        onUpload={upload}
        onView={(d) => api.viewDocument(data.id, d.id).catch(() => {})}
        onDownload={(d) => api.downloadDocument(data.id, d.id, d.name).catch(() => {})}
        onArchive={(d) => act(() => api.archiveDocument(data.id, d.id))}
        onRestore={(d) => act(() => api.restoreDocument(data.id, d.id))}
        onRemove={(d) => { if (confirm('Remover este documento? Ele fica arquivado no histórico.')) act(() => api.removeDocument(data.id, d.id)); }}
      />
    </div>
  );
}

// Checklist documental (orienta a equipe): compara categorias exigidas pelo tipo
// de serviço com os documentos anexados. Não bloqueia o fluxo.
function DocChecklist({ serviceTypeId, documents }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!serviceTypeId) { setItems([]); return () => {}; }
    getChecklist(serviceTypeId).then((r) => { if (alive) setItems(r || []); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [serviceTypeId]);
  if (!items || items.length === 0) return null;
  const haveCat = new Set(documents.filter((d) => d.status !== 'removido' && d.category_id).map((d) => d.category_id));
  return (
    <div style={{ marginBottom: 14, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 8 }}>Checklist documental</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it) => {
          const ok = haveCat.has(it.category_id);
          return (
            <div key={it.category_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ color: ok ? '#16a34a' : '#f59e0b', fontWeight: 700, width: 16 }}>{ok ? '✓' : '○'}</span>
              <span style={{ color: '#334155' }}>{it.category_name}</span>
              {it.required && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#ef4444', textTransform: 'uppercase' }}>obrigatório</span>}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: ok ? '#16a34a' : '#f59e0b', fontWeight: 600 }}>{ok ? 'recebido' : 'pendente'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TasksTab({ data, config, assignees, isAdmin, act, busy }) {
  const [types, setTypes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [filters, setFilters] = useState({ status: 'ativas', priority: '' });
  const [form, setForm] = useState({ title: '', description: '', task_type_id: '', priority: 'normal', assignee_id: data.seller_id || '', department_id: data.department_id || '', due_at: '' });
  useEffect(() => { listTaskTypes().then(setTypes).catch(() => setTypes([])); }, []);
  const submit = async (event) => {
    event.preventDefault();
    const payload = {
      ...form,
      task_type_id: form.task_type_id || null,
      assignee_id: form.assignee_id || null,
      department_id: form.department_id || null,
      due_at: form.due_at || null,
    };
    await act(() => editingId
      ? updateTask(editingId, payload)
      : createTask({ fine_id: data.id, ...payload }));
    setForm({ title: '', description: '', task_type_id: '', priority: 'normal', assignee_id: data.seller_id || '', department_id: data.department_id || '', due_at: '' });
    setEditingId(null);
    setShowForm(false);
  };
  const edit = (task) => {
    setEditingId(task.id);
    setForm({
      title: task.title || '',
      description: task.description || '',
      task_type_id: task.task_type_id || '',
      priority: task.priority || 'normal',
      assignee_id: task.assignee_id || '',
      department_id: task.department_id || '',
      due_at: task.due_at ? new Date(task.due_at).toISOString().slice(0, 16) : '',
    });
    setShowForm(true);
  };
  const transition = (task, action) => {
    if (action === 'complete') {
      const note = window.prompt('Resultado/observação da conclusão:');
      if (!note) return;
      return act(() => taskAction(task.id, action, { result: 'Concluída', completion_note: note }));
    }
    return act(() => taskAction(task.id, action));
  };
  const allTasks = data.tasks || [];
  const tasks = allTasks.filter((task) => {
    const closed = ['concluida', 'cancelada'].includes(task.status);
    if (filters.status === 'ativas' && closed) return false;
    if (filters.status === 'concluidas' && task.status !== 'concluida') return false;
    if (filters.status === 'canceladas' && task.status !== 'cancelada') return false;
    if (filters.status === 'atrasadas' && !task.overdue) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    return true;
  });
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <strong style={{ fontSize: 13.5 }}>{allTasks.filter((task) => !['concluida', 'cancelada'].includes(task.status)).length} pendência(s) ativa(s)</strong>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select aria-label="Filtrar situação das pendências" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="ativas">Ativas</option><option value="todas">Todas</option>
            <option value="atrasadas">Atrasadas</option><option value="concluidas">Concluídas</option>
            <option value="canceladas">Canceladas</option>
          </select>
          <select aria-label="Filtrar prioridade das pendências" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}>
            <option value="">Todas as prioridades</option><option value="baixa">Baixa</option>
            <option value="normal">Normal</option><option value="alta">Alta</option><option value="critica">Crítica</option>
          </select>
          <button className="btn-primary" onClick={() => {
            setEditingId(null);
            setForm({ title: '', description: '', task_type_id: '', priority: 'normal', assignee_id: data.seller_id || '', department_id: data.department_id || '', due_at: '' });
            setShowForm((value) => !value);
          }}>+ Nova pendência</button>
        </div>
      </div>
      {showForm && <form onSubmit={submit} style={{ padding: 12, border: '1px solid #d1fae5', background: '#f0fdf4', borderRadius: 10, marginBottom: 14 }}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{editingId ? 'Editar pendência' : 'Nova pendência'}</strong>
        <div className="form-group"><label htmlFor="task-title">Título *</label><input id="task-title" autoFocus required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
        <div className="form-group"><label htmlFor="task-description">Descrição</label><textarea id="task-description" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
        <div className="form-row">
          <div className="form-group"><label>Tipo</label><select value={form.task_type_id} onChange={(event) => setForm({ ...form, task_type_id: event.target.value })}><option value="">Outro</option>{types.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select></div>
          <div className="form-group"><label>Prioridade</label><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="baixa">Baixa</option><option value="normal">Normal</option><option value="alta">Alta</option><option value="critica">Crítica</option></select></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Responsável</label><select value={form.assignee_id} onChange={(event) => setForm({ ...form, assignee_id: event.target.value })}><option value="">Sem responsável</option>{assignees.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></div>
          <div className="form-group"><label>Setor</label><select value={form.department_id} onChange={(event) => setForm({ ...form, department_id: event.target.value })}><option value="">Sem setor</option>{config.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
        </div>
        <div className="form-group"><label>Prazo</label><input type="datetime-local" value={form.due_at} onChange={(event) => setForm({ ...form, due_at: event.target.value })} /></div>
        <div className="form-actions"><button type="button" className="btn-secondary" onClick={() => { setShowForm(false); setEditingId(null); }}>Cancelar</button><button className="btn-primary" disabled={busy}>{editingId ? 'Salvar alterações' : 'Criar pendência'}</button></div>
      </form>}
      {!tasks.length ? <EmptyState small title="Nenhuma pendência neste filtro" description="Ajuste os filtros ou crie uma atividade vinculada ao processo." /> : tasks.map((task) => {
        const closed = ['concluida', 'cancelada'].includes(task.status);
        return <article key={task.id} aria-label={task.title} style={{ padding: 11, border: `1px solid ${task.overdue ? '#fecaca' : '#e2e8f0'}`, borderRadius: 9, marginBottom: 8, background: task.overdue ? '#fff7f7' : '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div><strong style={{ fontSize: 13.5 }}>{task.title}</strong><div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>{[task.task_type_label, task.assignee_name, task.department_name].filter(Boolean).join(' · ')}</div></div>
            <Badge label={task.priority} color={task.priority === 'critica' ? '#dc2626' : task.priority === 'alta' ? '#d97706' : '#64748b'} />
          </div>
          {task.due_at && <div style={{ fontSize: 11.5, color: task.overdue ? '#dc2626' : '#64748b', marginTop: 6 }}>Prazo: {fmtDateTime(task.due_at)}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {!closed && task.status === 'aberta' && <button className="btn-secondary" disabled={busy} onClick={() => transition(task, 'start')}>Iniciar</button>}
            {!closed && <button className="btn-primary" disabled={busy} onClick={() => transition(task, 'complete')}>Concluir</button>}
            {!closed && <button className="btn-secondary" disabled={busy} onClick={() => transition(task, 'wait')}>Aguardar terceiro</button>}
            <button className="btn-secondary" disabled={busy} onClick={() => edit(task)}>Editar</button>
            {!closed && <button className="btn-secondary" disabled={busy} onClick={() => transition(task, 'cancel')}>Cancelar</button>}
            {closed && isAdmin && <button className="btn-secondary" disabled={busy} onClick={() => transition(task, 'reopen')}>Reabrir</button>}
          </div>
          {task.completion_note && <div style={{ padding: 8, background: '#f8fafc', marginTop: 8, fontSize: 12 }}>{task.completion_note}</div>}
        </article>;
      })}
    </div>
  );
}

function NotesTab({ data, act, busy }) {
  const [note, setNote] = useState('');
  const submit = async () => {
    if (!note.trim()) return;
    await act(() => createNote(data.id, { content: note.trim() }));
    setNote('');
  };
  const notes = data.internal_notes || [];
  const edit = (item) => {
    const content = window.prompt('Editar nota interna:', item.content);
    if (!content?.trim() || content.trim() === item.content) return;
    act(() => updateNote(item.id, { content: content.trim() }));
  };
  const archive = (item) => {
    if (!window.confirm('Arquivar esta nota? O registro permanecerá na auditoria.')) return;
    act(() => deleteNote(item.id));
  };
  return (
    <div>
      <div className="form-group">
        <label htmlFor="internal-note">Nova nota interna</label>
        <textarea id="internal-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Use @nome para mencionar um usuário..." />
      </div>
      <button className="btn-primary" disabled={busy || !note.trim()} onClick={submit} style={{ marginBottom: 16 }}>Adicionar nota</button>
      {data.notes && <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, color: '#64748b', background: '#f8fafc', padding: 10, borderRadius: 8, marginBottom: 12 }}><strong>Observações legadas</strong><br />{data.notes}</div>}
      {!notes.length ? <EmptyState small title="Sem notas internas" /> : notes.map((item) => (
        <article key={item.id} style={{ borderBottom: '1px solid #e2e8f0', padding: '10px 0' }}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, color: '#334155' }}>{item.content}</div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 5 }}>{item.author_name || 'Usuário inativo'} · {fmtDateTime(item.created_at)}{item.edited_at ? ' · editada' : ''}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn-secondary" disabled={busy} onClick={() => edit(item)}>Editar</button>
            <button className="btn-secondary" disabled={busy} onClick={() => archive(item)}>Arquivar</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function HistoryTab({ data }) {
  const logs = data.logs || [];
  if (logs.length === 0) return <EmptyState small title="Sem histórico" description="As movimentações aparecerão aqui." />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {logs.map((l) => (
        <div key={l.id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary-bright)', marginTop: 6, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0f172a' }}>{ACTION_LABELS[l.action] || l.action}</div>
            {(l.old_value || l.new_value) && (
              <div style={{ fontSize: 12.5, color: '#64748b' }}>
                {l.old_value ? `${l.old_value} → ` : ''}{l.new_value || ''}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>{fmtDateTime(l.created_at)}{l.user_name ? ` · ${l.user_name}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
