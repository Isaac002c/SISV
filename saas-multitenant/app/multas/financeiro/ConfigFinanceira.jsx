'use client';

import { useState, useEffect } from 'react';
import {
  getFinancialSettings, updateFinancialSettings,
  getCategories, createCategory, updateCategory, setCategoryActive, deleteCategory,
  PAYMENT_METHODS,
} from '../../lib/financialAPI';
import { isAdmin, AccessDenied, Spinner, Feedback } from './financeShared';

export default function ConfigFinanceira() {
  const [tab, setTab] = useState('empresa');
  if (!isAdmin()) return <AccessDenied />;
  return (
    <div className="clients-page">
      <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>Configurações Financeiras</h2>
      <div className="settings-tabs" style={{ marginBottom: 16 }}>
        <button className={`settings-tab ${tab === 'empresa' ? 'active' : ''}`} onClick={() => setTab('empresa')}>Empresa & Recibo</button>
        <button className={`settings-tab ${tab === 'categorias' ? 'active' : ''}`} onClick={() => setTab('categorias')}>Categorias</button>
      </div>
      {tab === 'empresa' ? <EmpresaSettings /> : <CategoriesSettings />}
    </div>
  );
}

function EmpresaSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await getFinancialSettings();
        setData(d);
        setForm({
          razao_social: d.razao_social || '', document: d.document || '', address: d.address || '',
          phone: d.phone || '', email: d.email || '', logo_url: d.logo_url || '',
          receipt_prefix: d.receipt_prefix || 'SISV',
          next_receipt_number: String(d.next_receipt_number || 1),
          enabled_payment_methods: d.enabled_payment_methods || PAYMENT_METHODS.map((m) => m.value),
        });
      } catch (e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <Spinner label="Carregando configurações..." />;
  if (!form) return <div className="error-message">{error || 'Erro ao carregar'}</div>;

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const toggleMethod = (m) => setForm((p) => ({
    ...p,
    enabled_payment_methods: p.enabled_payment_methods.includes(m)
      ? p.enabled_payment_methods.filter((x) => x !== m)
      : [...p.enabled_payment_methods, m],
  }));

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      setSaving(true);
      const payload = {
        ...form,
        next_receipt_number: parseInt(form.next_receipt_number, 10),
      };
      const updated = await updateFinancialSettings(payload);
      setData((d) => ({ ...d, ...updated }));
      setFeedback({ type: 'success', message: 'Configurações salvas.' });
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} style={{ maxWidth: 620 }}>
      <Feedback {...(feedback || {})} onClose={() => setFeedback(null)} />
      {error && <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>}

      <h3 style={{ fontSize: 13, fontWeight: 700, color: '#64748b', margin: '4px 0 10px' }}>IDENTIDADE (RECIBOS)</h3>
      <div className="modal-form">
        <div className="form-group">
          <label>Razão social / Nome</label>
          <input type="text" value={form.razao_social} onChange={set('razao_social')} placeholder="Deixe vazio para usar o nome do sistema" />
        </div>
        <div className="form-row">
          <div className="form-group"><label>CPF/CNPJ</label><input type="text" value={form.document} onChange={set('document')} /></div>
          <div className="form-group"><label>Telefone</label><input type="text" value={form.phone} onChange={set('phone')} /></div>
        </div>
        <div className="form-group"><label>Endereço</label><input type="text" value={form.address} onChange={set('address')} /></div>
        <div className="form-row">
          <div className="form-group"><label>E-mail</label><input type="email" value={form.email} onChange={set('email')} /></div>
          <div className="form-group"><label>URL do logo</label><input type="text" value={form.logo_url} onChange={set('logo_url')} placeholder="/logos/minha-logo.png" /></div>
        </div>
      </div>

      <h3 style={{ fontSize: 13, fontWeight: 700, color: '#64748b', margin: '18px 0 10px' }}>NUMERAÇÃO DO RECIBO</h3>
      <div className="modal-form">
        <div className="form-row">
          <div className="form-group">
            <label>Prefixo</label>
            <input type="text" value={form.receipt_prefix} onChange={set('receipt_prefix')} maxLength={20} placeholder="SISV" />
          </div>
          <div className="form-group">
            <label>Próximo número</label>
            <input type="number" min="1" value={form.next_receipt_number} onChange={set('next_receipt_number')} />
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8' }}>
          Já existem recibos até o número {data?.max_receipt_number ?? 0}. O próximo número deve ser maior que este.
          Exemplo do formato: <strong>{(form.receipt_prefix || 'SISV')}-{String(form.next_receipt_number || 1).padStart(6, '0')}</strong>
        </p>
      </div>

      <h3 style={{ fontSize: 13, fontWeight: 700, color: '#64748b', margin: '18px 0 10px' }}>FORMAS DE PAGAMENTO HABILITADAS</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        {PAYMENT_METHODS.map((m) => (
          <label key={m.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" checked={form.enabled_payment_methods.includes(m.value)} onChange={() => toggleMethod(m.value)} style={{ width: 'auto' }} />
            {m.label}
          </label>
        ))}
      </div>

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar configurações'}</button>
      </div>
    </form>
  );
}

function CategoriesSettings() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'entrada', description: '' });
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { setLoading(true); setRows(await getCategories()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError('Informe o nome da categoria.');
    try {
      setSaving(true);
      if (editing) await updateCategory(editing.id, form);
      else await createCategory(form);
      setForm({ name: '', type: 'entrada', description: '' });
      setEditing(null);
      setFeedback({ type: 'success', message: editing ? 'Categoria atualizada.' : 'Categoria criada.' });
      load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const startEdit = (c) => { setEditing(c); setForm({ name: c.name, type: c.type, description: c.description || '' }); };
  const cancelEdit = () => { setEditing(null); setForm({ name: '', type: 'entrada', description: '' }); };

  const toggle = async (c) => {
    try { await setCategoryActive(c.id, !c.active); load(); }
    catch (err) { setError(err.message); }
  };
  const remove = async (c) => {
    if (!confirm(`Excluir a categoria "${c.name}"?`)) return;
    try { await deleteCategory(c.id); setFeedback({ type: 'success', message: 'Categoria excluída.' }); load(); }
    catch (err) { setError(err.message); } // 409 se houver lançamentos vinculados
  };

  if (loading) return <Spinner label="Carregando categorias..." />;

  return (
    <div style={{ maxWidth: 720 }}>
      <Feedback {...(feedback || {})} onClose={() => setFeedback(null)} />
      {error && <div className="error-message" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}><span>{error}</span><button onClick={() => setError(null)} className="btn-close">✕</button></div>}

      <form onSubmit={submit} style={{ background: '#f8fafc', padding: 12, borderRadius: 10, marginBottom: 16 }}>
        <div className="form-row">
          <div className="form-group"><label>Nome *</label><input type="text" value={form.name} onChange={set('name')} placeholder="Nome da categoria" /></div>
          <div className="form-group"><label>Tipo *</label>
            <select value={form.type} onChange={set('type')}><option value="entrada">Entrada</option><option value="saida">Saída</option></select>
          </div>
        </div>
        <div className="form-group"><label>Descrição</label><input type="text" value={form.description} onChange={set('description')} /></div>
        <div className="form-actions" style={{ marginTop: 4 }}>
          {editing && <button type="button" className="btn-secondary" onClick={cancelEdit}>Cancelar edição</button>}
          <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Salvando...' : editing ? 'Salvar categoria' : 'Adicionar categoria'}</button>
        </div>
      </form>

      <div className="clients-table-wrap">
        <table className="data-table">
          <thead><tr><th>Nome</th><th>Tipo</th><th>Status</th><th style={{ width: 160 }}>Ações</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                <td><strong style={{ color: '#0f172a' }}>{c.name}</strong>{c.description && <span style={{ display: 'block', fontSize: 12, color: '#94a3b8' }}>{c.description}</span>}</td>
                <td><span style={{ color: c.type === 'entrada' ? '#15803d' : '#b91c1c', fontWeight: 600 }}>{c.type === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
                <td><span className={`client-status-badge ${c.active ? 'fechado' : 'negociacao'}`}>{c.active ? 'Ativa' : 'Inativa'}</span></td>
                <td>
                  <div className="actions-cell">
                    <button className="btn-icon" title="Editar" onClick={() => startEdit(c)}>✎</button>
                    <button className="btn-icon" title={c.active ? 'Inativar' : 'Ativar'} onClick={() => toggle(c)}>{c.active ? '⏸' : '▶'}</button>
                    <button className="btn-icon danger" title="Excluir" onClick={() => remove(c)}>🗑</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
