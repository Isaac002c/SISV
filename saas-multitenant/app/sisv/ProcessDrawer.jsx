'use client';

// =============================================================================
// Detalhe do processo (SISV) — abas: Visão geral, Andamento, Documentos,
// Observações e Histórico.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { Drawer, ConfirmDialog, EmptyState, SkeletonRows } from '../components/ui';
import * as api from '../lib/processesAPI';
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
    ['docs', 'Documentos'], ['notes', 'Observações'], ['history', 'Histórico'],
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
                fontSize: 13.5, fontWeight: 600, color: tab === k ? '#15803d' : '#94a3b8',
                borderBottom: `2px solid ${tab === k ? '#15803d' : 'transparent'}`, marginBottom: -1,
              }}>{l}</button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab data={data} config={config} byCode={byCode} act={act} busy={busy} />}
          {tab === 'flow' && (
            <FlowTab data={data} config={config} assignees={assignees} isAdmin={isAdmin} busy={busy}
              act={act} setConfirm={setConfirm} />
          )}
          {tab === 'docs' && <DocsTab data={data} config={config} isAdmin={isAdmin} act={act} busy={busy} />}
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
    });
    setEditing(true);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    await act(() => api.updateProcess(data.id, {
      fine_number: form.fine_number, protocol_number: form.protocol_number,
      tenant_service_type_id: form.tenant_service_type_id || null,
      opened_at: form.opened_at || null, due_date: form.due_date || null,
    }));
    setEditing(false);
  };

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
    </div>
  );
}

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

function NotesTab({ data, act, busy }) {
  const [note, setNote] = useState('');
  const submit = async () => {
    if (!note.trim()) return;
    await act(() => api.addNote(data.id, note.trim()));
    setNote('');
  };
  return (
    <div>
      <div className="form-group">
        <label>Nova observação</label>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Registrar uma observação no processo..." />
      </div>
      <button className="btn-primary" disabled={busy || !note.trim()} onClick={submit} style={{ marginBottom: 16 }}>Adicionar observação</button>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, color: '#334155', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, minHeight: 60 }}>
        {data.notes || 'Sem observações registradas.'}
      </div>
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
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#15803d', marginTop: 6, flexShrink: 0 }} />
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

