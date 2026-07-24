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
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const deb = useRef(null);

  useEffect(() => { getClients().then((d) => setClients(d || [])).catch(() => {}); }, []);
  const onClientSearch = (e) => {
    const v = e.target.value; setClientSearch(v);
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      try { setClients(v.length >= 2 ? await searchClients(v) : await getClients()); } catch { /* noop */ }
    }, 300);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

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
      <div className="modal-content" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div><h2 style={{ fontSize: 18, fontWeight: 700 }}>Novo Processo</h2>
            <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Vincule um cliente e defina a situação inicial</p></div>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        {err && <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>{err}</div>}
        <form onSubmit={submit} className="modal-form">
          <div className="form-group">
            <label>Cliente *</label>
            <input placeholder="Buscar cliente por nome/CPF..." value={clientSearch} onChange={onClientSearch} style={{ marginBottom: 6 }} />
            <select value={form.client_id} onChange={set('client_id')} required>
              <option value="">Selecione o cliente</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.cpf ? ` — ${c.cpf}` : ''}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Tipo de serviço</label>
              <select value={form.tenant_service_type_id} onChange={set('tenant_service_type_id')}>
                <option value="">—</option>
                {config.serviceTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Nº do processo</label>
              <input value={form.fine_number} onChange={set('fine_number')} placeholder="Interno / do cliente" />
            </div>
          </div>
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
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Criar processo'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Drawer de detalhe ─────────────────────────────────────────────────────────
