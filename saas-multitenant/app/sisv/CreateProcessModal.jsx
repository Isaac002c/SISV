'use client';

// =============================================================================
// Modal de criação de processo de CNH (SISV).
// =============================================================================

import { useState, useEffect, useRef } from 'react';
import * as api from '../lib/processesAPI';
import { getClients, searchClients } from '../lib/clientsAPI';

export default function CreateProcessModal({ config, assignees, currentUserId, onClose, onCreated }) {
  const [clients, setClients] = useState([]);
  const [clientSearch, setClientSearch] = useState('');
  const [form, setForm] = useState({
    client_id: '', tenant_service_type_id: '', fine_number: '', protocol_number: '',
    stage: config.stages[0]?.code || '', status: config.statuses[0]?.code || '',
    seller_id: currentUserId || '', department_id: '', opened_at: '', due_date: '', notes: '',
    custom_data: {}, create_suggested_tasks: false,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const deb = useRef(null);

  useEffect(() => { getClients().then((d) => setClients(d || [])).catch(() => {}); }, []);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const onClientSearch = (e) => {
    const v = e.target.value; setClientSearch(v);
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      try { setClients(v.length >= 2 ? await searchClients(v) : await getClients()); } catch { /* noop */ }
    }, 300);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const selectedTemplate = config.serviceTypes.find((item) => item.id === form.tenant_service_type_id);
  const customFields = Array.isArray(selectedTemplate?.custom_fields) ? selectedTemplate.custom_fields.filter((field) => field.active !== false) : [];
  const selectTemplate = (event) => {
    const id = event.target.value;
    const template = config.serviceTypes.find((item) => item.id === id);
    if (!template) { setForm((current) => ({ ...current, tenant_service_type_id: id, custom_data: {}, create_suggested_tasks: false })); return; }
    const base = form.opened_at || new Date().toISOString().slice(0, 10);
    let due = form.due_date;
    if (Number.isInteger(Number(template.default_due_days))) {
      const date = new Date(`${base}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Number(template.default_due_days));
      due = date.toISOString().slice(0, 10);
    }
    const defaults = Object.fromEntries((template.custom_fields || []).filter((field) => field.default_value !== null && field.default_value !== undefined).map((field) => [field.key, field.default_value]));
    setForm((current) => ({
      ...current,
      tenant_service_type_id: id,
      stage: template.initial_stage || current.stage,
      status: template.initial_status || current.status,
      department_id: template.initial_department_id || current.department_id,
      due_date: due,
      custom_data: defaults,
      create_suggested_tasks: false,
    }));
  };

  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (!form.client_id) { setErr('Selecione o cliente.'); return; }
    try {
      setSaving(true);
      await api.createProcess({ ...form, seller_id: form.seller_id || null, department_id: form.department_id || null, tenant_service_type_id: form.tenant_service_type_id || null });
      onCreated();
    } catch (e2) { setErr(e2.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="new-process-title">
        <div className="modal-header">
          <div><h2 id="new-process-title" style={{ fontSize: 18, fontWeight: 700 }}>Novo Processo</h2>
            <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Vincule um cliente e defina a situação inicial</p></div>
          <button className="btn-close" onClick={onClose} aria-label="Fechar cadastro de processo">✕</button>
        </div>
        {err && <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>{err}</div>}
        <form onSubmit={submit} className="modal-form">
          <div className="form-group">
            <label>Cliente *</label>
            <input autoFocus aria-label="Buscar cliente" placeholder="Buscar cliente por nome/CPF..." value={clientSearch} onChange={onClientSearch} style={{ marginBottom: 6 }} />
            <select value={form.client_id} onChange={set('client_id')} required>
              <option value="">Selecione o cliente</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.cpf ? ` — ${c.cpf}` : ''}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Tipo de serviço</label>
              <select value={form.tenant_service_type_id} onChange={selectTemplate}>
                <option value="">—</option>
                {config.serviceTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Nº do processo</label>
              <input value={form.fine_number} onChange={set('fine_number')} placeholder="Interno / do cliente" />
            </div>
          </div>
          {selectedTemplate?.description && <div style={{ padding: 9, borderRadius: 8, background: '#f0fdf4', color: '#166534', fontSize: 12.5 }}>{selectedTemplate.description}</div>}
          <div className="form-row">
            <div className="form-group"><label>Protocolo</label>
              <input value={form.protocol_number} onChange={set('protocol_number')} placeholder="Quando existir" />
            </div>
            <div className="form-group"><label>Data de abertura</label>
              <input type="date" value={form.opened_at} onChange={set('opened_at')} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Prazo</label>
              <input type="date" value={form.due_date} onChange={set('due_date')} />
            </div>
            <div className="form-group" />
          </div>
          <div className="form-row">
            <div className="form-group"><label>Etapa inicial</label>
              <select value={form.stage} onChange={set('stage')}>
                {config.stages.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Status inicial</label>
              <select value={form.status} onChange={set('status')}>
                {config.statuses.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Responsável</label>
              <select value={form.seller_id} onChange={set('seller_id')}>
                <option value="">Sem responsável</option>
                {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Setor</label>
              <select value={form.department_id} onChange={set('department_id')}>
                <option value="">Sem setor</option>
                {config.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group"><label>Observações iniciais</label>
            <textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Informações relevantes..." />
          </div>
          {customFields.length > 0 && <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 9, padding: 12 }}>
            <legend style={{ fontSize: 12.5, fontWeight: 700 }}>Campos complementares</legend>
            {customFields.sort((a, b) => (a.order || 0) - (b.order || 0)).map((field) => (
              <TemplateField key={field.key} field={field} value={form.custom_data[field.key]} onChange={(value) => setForm((current) => ({ ...current, custom_data: { ...current.custom_data, [field.key]: value } }))} />
            ))}
          </fieldset>}
          {Array.isArray(selectedTemplate?.suggested_tasks) && selectedTemplate.suggested_tasks.length > 0 && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10, border: '1px solid #bfdbfe', borderRadius: 8, background: '#eff6ff', fontSize: 13 }}>
              <input type="checkbox" checked={form.create_suggested_tasks} onChange={(event) => setForm((current) => ({ ...current, create_suggested_tasks: event.target.checked }))} />
              <span><strong>Criar {selectedTemplate.suggested_tasks.length} pendência(s) sugerida(s)</strong><br /><span style={{ color: '#64748b' }}>A criação só ocorrerá após esta confirmação.</span></span>
            </label>
          )}
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Criar processo'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TemplateField({ field, value, onChange }) {
  if (field.type === 'booleano') return <label className="form-group" style={{ display: 'flex', flexDirection: 'row', gap: 8 }}><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{field.name}</label>;
  if (field.type === 'selecao') return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><select required={field.required} value={value ?? ''} onChange={(event) => onChange(event.target.value)}><option value="">—</option>{(field.options || []).map((option) => <option key={option}>{option}</option>)}</select></div>;
  if (field.type === 'texto_longo') return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><textarea required={field.required} rows={3} value={value ?? ''} onChange={(event) => onChange(event.target.value)} /></div>;
  return <div className="form-group"><label>{field.name}{field.required ? ' *' : ''}</label><input required={field.required} type={field.type === 'numero' ? 'number' : field.type === 'data' ? 'date' : 'text'} value={value ?? ''} onChange={(event) => onChange(field.type === 'numero' ? event.target.valueAsNumber : event.target.value)} /></div>;
}

// ── Drawer de detalhe ─────────────────────────────────────────────────────────
