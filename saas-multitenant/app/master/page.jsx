'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getOverview, getTenants, getTenantUsers, createTenant, setTenantStatus, updateTenant, deleteTenant, createTenantUser, resetUserPassword, updateTenantUser, deleteTenantUser } from '../lib/masterAPI';
import { APP_BRAND } from '../lib/brand';

const fmtDate = (v) => { if (!v) return '—'; const [y, m, d] = String(v).substring(0, 10).split('-'); return (y && m && d) ? `${d}/${m}/${y}` : '—'; };
const fmtDateTime = (v) => { if (!v) return 'nunca'; const dt = new Date(v); return isNaN(dt) ? '—' : dt.toLocaleString('pt-BR'); };
const slugify = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const EMPTY = { name: '', slug: '', email: '', adminName: '', adminEmail: '', adminPassword: '', status: 'ativo' };
const WINE = '#2563eb';

function Stat({ label, value, color }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, borderTop: `3px solid ${color}`, padding: '16px 18px', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', letterSpacing: '.5px', textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function MasterPanel() {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [overview, setOverview] = useState(null);
  const [tenants, setTenants]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm]         = useState(EMPTY);
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState(null);
  const [createdInfo, setCreatedInfo] = useState(null);

  const [usersDrawer, setUsersDrawer] = useState(null);  // { tenant, users }
  const [resetInfo, setResetInfo]     = useState(null);  // { email, temp_password }
  const [addAdmin, setAddAdmin]       = useState({ name: '', email: '', password: '' });
  const [addingAdmin, setAddingAdmin] = useState(false);

  // Editar empresa
  const [editTenant, setEditTenant] = useState(null);   // tenant em edição
  const [editForm, setEditForm]     = useState({ name: '', slug: '', email: '', status: 'ativo' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError]   = useState(null);

  // Apagar empresa (exige digitar o nome)
  const [delTenant, setDelTenant]   = useState(null);   // tenant a apagar
  const [delText, setDelText]       = useState('');
  const [deleting, setDeleting]     = useState(false);

  // Editar usuário (dentro do drawer)
  const [editUser, setEditUser]     = useState(null);   // usuário em edição
  const [editUserForm, setEditUserForm] = useState({ name: '', email: '', role: 'seller' });
  const [savingUser, setSavingUser] = useState(false);
  const [editUserError, setEditUserError] = useState(null);

  useEffect(() => {
    let u = {};
    try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch {}
    const tok = localStorage.getItem('auth-token') || localStorage.getItem('token');
    if (!tok || u?.role !== 'super_admin') { router.replace('/login'); return; }
    setAuthorized(true);
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    try {
      setLoading(true); setError(null);
      const [ov, ts] = await Promise.all([getOverview().catch(() => null), getTenants().catch(() => [])]);
      setOverview(ov); setTenants(ts || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const logout = () => {
    ['user', 'tenant', 'token', 'auth-token', 'tenantId'].forEach(k => localStorage.removeItem(k));
    router.push('/login');
  };

  const openCreate = () => { setForm(EMPTY); setFormError(null); setCreatedInfo(null); setShowCreate(true); };
  const submitCreate = async (e) => {
    e.preventDefault(); setFormError(null);
    if (!form.name.trim()) { setFormError('Nome da empresa é obrigatório.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.adminEmail)) { setFormError('E-mail do admin inválido.'); return; }
    if (!form.adminPassword || form.adminPassword.length < 6) { setFormError('Senha do admin deve ter ao menos 6 caracteres.'); return; }
    try {
      setSaving(true);
      const r = await createTenant({ ...form, slug: form.slug || slugify(form.name) });
      setShowCreate(false);
      setCreatedInfo(r); // { tenant, admin } — sem senha
      load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  };

  const toggleStatus = async (t) => {
    const next = t.status === 'ativo' ? 'inativo' : 'ativo';
    if (!confirm(`${next === 'inativo' ? 'INATIVAR' : 'ATIVAR'} a empresa "${t.name}"?` + (next === 'inativo' ? ' Os usuários dela NÃO conseguirão logar.' : ''))) return;
    try { await setTenantStatus(t.id, next); load(); if (usersDrawer?.tenant?.id === t.id) openUsers(t); } catch (e) { setError(e.message); }
  };

  const openUsers = async (t) => {
    try { setResetInfo(null); setAddAdmin({ name: '', email: '', password: '' }); const d = await getTenantUsers(t.id); setUsersDrawer(d); }
    catch (e) { setError(e.message); }
  };
  const doReset = async (u) => {
    if (!confirm(`Resetar a senha de ${u.email}? Será gerada uma senha temporária (exibida uma vez).`)) return;
    try { const r = await resetUserPassword(u.id); setResetInfo(r); } catch (e) { setError(e.message); }
  };
  const submitAddAdmin = async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addAdmin.email) || addAdmin.password.length < 6) { setError('E-mail/senha inválidos para novo admin.'); return; }
    try {
      setAddingAdmin(true);
      await createTenantUser(usersDrawer.tenant.id, { ...addAdmin, role: 'admin' });
      const d = await getTenantUsers(usersDrawer.tenant.id);
      setUsersDrawer(d); setAddAdmin({ name: '', email: '', password: '' });
    } catch (e) { setError(e.message); } finally { setAddingAdmin(false); }
  };

  const refreshDrawerUsers = async () => {
    if (!usersDrawer?.tenant?.id) return;
    try { const d = await getTenantUsers(usersDrawer.tenant.id); setUsersDrawer(d); } catch (e) { setError(e.message); }
  };

  // Editar empresa
  const openEditTenant = (t) => { setEditError(null); setEditForm({ name: t.name || '', slug: t.slug || '', email: t.email || '', status: t.status || 'ativo' }); setEditTenant(t); };
  const submitEditTenant = async (e) => {
    e.preventDefault(); setEditError(null);
    if (!editForm.name.trim()) { setEditError('Nome da empresa é obrigatório.'); return; }
    try {
      setSavingEdit(true);
      await updateTenant(editTenant.id, { name: editForm.name.trim(), slug: editForm.slug || slugify(editForm.name), email: editForm.email || null, status: editForm.status });
      setEditTenant(null); load();
    } catch (err) { setEditError(err.message); } finally { setSavingEdit(false); }
  };

  // Apagar empresa (somente inativa; exige digitar o nome exato)
  const openDelTenant = (t) => { setDelText(''); setDelTenant(t); };
  const confirmDelTenant = async () => {
    if (!delTenant || delText.trim() !== delTenant.name) return;
    try {
      setDeleting(true);
      await deleteTenant(delTenant.id);
      setDelTenant(null); setDelText(''); load();
    } catch (e) { setError(e.message); setDelTenant(null); } finally { setDeleting(false); }
  };

  // Editar / apagar usuário (dentro do drawer)
  const openEditUser = (u) => { setEditUserError(null); setEditUserForm({ name: u.name || '', email: u.email || '', role: u.role === 'admin' ? 'admin' : 'seller' }); setEditUser(u); };
  const submitEditUser = async (e) => {
    e.preventDefault(); setEditUserError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editUserForm.email)) { setEditUserError('E-mail inválido.'); return; }
    try {
      setSavingUser(true);
      await updateTenantUser(editUser.id, { name: editUserForm.name.trim(), email: editUserForm.email, role: editUserForm.role });
      setEditUser(null); await refreshDrawerUsers();
    } catch (err) { setEditUserError(err.message); } finally { setSavingUser(false); }
  };
  const doDeleteUser = async (u) => {
    if (!confirm(`Apagar o usuário ${u.email}?\n\nOs registros criados por ele serão mantidos (sem autor). Esta ação não pode ser desfeita.`)) return;
    try { await deleteTenantUser(u.id); await refreshDrawerUsers(); } catch (e) { setError(e.message); }
  };

  if (!authorized) return null;

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      {/* Topo institucional Chronostek (master) */}
      <header style={{ background: 'linear-gradient(160deg,#0a0f1e,#0d1428)', color: '#fff', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: WINE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>N</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{APP_BRAND.name} · Painel Master</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Gestão do SaaS — multi-tenant</div>
          </div>
        </div>
        <button onClick={logout} style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Sair</button>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
        {error && (
          <div className="error-message" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span>{error}</span><button className="btn-close" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {createdInfo && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 14, color: '#166534' }}>
            ✅ Empresa <strong>{createdInfo.tenant?.name}</strong> (slug <code>{createdInfo.tenant?.slug}</code>) criada com admin <strong>{createdInfo.admin?.email}</strong>. O admin já pode logar normalmente.
            <button className="btn-close" style={{ float: 'right', color: '#166534' }} onClick={() => setCreatedInfo(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0', gap: 14 }}>
            <div className="loading-spinner" style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: WINE }} />
            <p style={{ color: '#94a3b8', fontSize: 14 }}>Carregando painel...</p>
          </div>
        ) : (
          <>
            {/* Overview */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
              <Stat label="Empresas (tenants)" value={overview?.total_tenants} color={WINE} />
              <Stat label="Ativas"   value={overview?.active_tenants}   color="#15803d" />
              <Stat label="Inativas" value={overview?.inactive_tenants} color="#94a3b8" />
              <Stat label="Usuários" value={overview?.total_users}      color="#3b82f6" />
            </div>

            {/* Tenants */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', margin: 0 }}>Empresas</h2>
              <button className="btn-primary" onClick={openCreate}>+ Nova empresa</button>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
              <table className="data-table" style={{ border: 'none', borderRadius: 0 }}>
                <thead>
                  <tr><th>Empresa</th><th>Slug</th><th>Status</th><th>Usuários</th><th>Criada em</th><th>Último acesso</th><th style={{ width: 260 }}>Ações</th></tr>
                </thead>
                <tbody>
                  {tenants.length === 0 ? (
                    <tr><td colSpan="7"><div style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Nenhuma empresa cadastrada.</div></td></tr>
                  ) : tenants.map(t => (
                    <tr key={t.id}>
                      <td><strong style={{ color: '#0f172a' }}>{t.name}</strong></td>
                      <td style={{ color: '#475569', fontFamily: 'monospace', fontSize: 13 }}>{t.slug || '—'}</td>
                      <td><span className={`client-status-badge ${t.status === 'inativo' ? 'negociacao' : 'fechado'}`}>{t.status === 'inativo' ? 'Inativa' : 'Ativa'}</span></td>
                      <td style={{ color: '#475569' }}>{t.users_count ?? 0}</td>
                      <td style={{ color: '#475569' }}>{fmtDate(t.created_at)}</td>
                      <td style={{ color: '#64748b', fontSize: 13 }}>{fmtDateTime(t.last_login)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => openUsers(t)}>Usuários</button>
                          <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => openEditTenant(t)}>Editar</button>
                          <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: 12, color: t.status === 'ativo' ? '#b45309' : '#15803d', borderColor: t.status === 'ativo' ? '#fde68a' : '#bbf7d0' }} onClick={() => toggleStatus(t)}>
                            {t.status === 'ativo' ? 'Inativar' : 'Ativar'}
                          </button>
                          <button
                            className="btn-secondary"
                            disabled={t.status !== 'inativo'}
                            title={t.status !== 'inativo' ? 'Inative a empresa antes de apagar' : 'Apagar empresa permanentemente'}
                            style={{ padding: '5px 10px', fontSize: 12, color: t.status === 'inativo' ? '#b91c1c' : '#cbd5e1', borderColor: t.status === 'inativo' ? '#fecaca' : '#e2e8f0', cursor: t.status === 'inativo' ? 'pointer' : 'not-allowed' }}
                            onClick={() => openDelTenant(t)}
                          >
                            Apagar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Modal: nova empresa + admin */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Nova Empresa (Tenant)</h2>
                <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Cria a empresa e o usuário administrador dela.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)} className="btn-close">✕</button>
            </div>
            {formError && <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>{formError}</div>}
            <form onSubmit={submitCreate} className="modal-form">
              <div className="form-row">
                <div className="form-group"><label>Nome da empresa *</label><input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value, slug: p.slug || slugify(e.target.value) }))} required /></div>
                <div className="form-group"><label>Slug</label><input value={form.slug} onChange={e => setForm(p => ({ ...p, slug: slugify(e.target.value) }))} placeholder="auto a partir do nome" /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>E-mail da empresa</label><input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="contato@empresa.com" /></div>
                <div className="form-group"><label>Status</label>
                  <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                    <option value="ativo">Ativa</option><option value="inativo">Inativa</option>
                  </select>
                </div>
              </div>
              <div style={{ borderTop: '1px solid #f1f5f9', margin: '4px 0 10px', paddingTop: 10, fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>USUÁRIO ADMIN</div>
              <div className="form-group"><label>Nome do admin</label><input value={form.adminName} onChange={e => setForm(p => ({ ...p, adminName: e.target.value }))} placeholder="Nome do responsável" /></div>
              <div className="form-row">
                <div className="form-group"><label>E-mail do admin *</label><input type="email" value={form.adminEmail} onChange={e => setForm(p => ({ ...p, adminEmail: e.target.value }))} required /></div>
                <div className="form-group"><label>Senha inicial *</label><input type="text" value={form.adminPassword} onChange={e => setForm(p => ({ ...p, adminPassword: e.target.value }))} placeholder="mín. 6 caracteres" required /></div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Criando...' : 'Criar empresa + admin'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Drawer: usuários do tenant */}
      {usersDrawer && (
        <div className="modal-overlay" onClick={() => setUsersDrawer(null)}>
          <div className="modal-content" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Usuários — {usersDrawer.tenant?.name}</h2>
              <button type="button" onClick={() => setUsersDrawer(null)} className="btn-close">✕</button>
            </div>

            {resetInfo && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13, color: '#92400e' }}>
                Senha temporária de <strong>{resetInfo.email}</strong>: <code style={{ fontSize: 14 }}>{resetInfo.temp_password}</code><br />
                Anote e repasse — será exibida apenas uma vez. Recomende a troca no primeiro acesso.
              </div>
            )}

            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
              <table className="data-table" style={{ border: 'none', borderRadius: 0 }}>
                <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Último acesso</th><th style={{ width: 210 }}>Ações</th></tr></thead>
                <tbody>
                  {(usersDrawer.users || []).length === 0 ? (
                    <tr><td colSpan="5"><div style={{ padding: 18, textAlign: 'center', color: '#94a3b8' }}>Sem usuários.</div></td></tr>
                  ) : usersDrawer.users.map(u => (
                    <tr key={u.id}>
                      <td>{u.name || '—'}</td>
                      <td style={{ color: '#475569' }}>{u.email}</td>
                      <td><span className="client-status-badge fechado">{u.role}</span></td>
                      <td style={{ color: '#64748b', fontSize: 12 }}>{fmtDateTime(u.last_login)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => openEditUser(u)}>Editar</button>
                          <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => doReset(u)}>Resetar senha</button>
                          <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11, color: '#b91c1c', borderColor: '#fecaca' }} onClick={() => doDeleteUser(u)}>Apagar</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form onSubmit={submitAddAdmin} style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>ADICIONAR ADMIN</div>
              <div className="form-row">
                <div className="form-group"><label>Nome</label><input value={addAdmin.name} onChange={e => setAddAdmin(p => ({ ...p, name: e.target.value }))} /></div>
                <div className="form-group"><label>E-mail *</label><input type="email" value={addAdmin.email} onChange={e => setAddAdmin(p => ({ ...p, email: e.target.value }))} required /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Senha *</label><input type="text" value={addAdmin.password} onChange={e => setAddAdmin(p => ({ ...p, password: e.target.value }))} placeholder="mín. 6" required /></div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button type="submit" className="btn-primary" disabled={addingAdmin} style={{ width: '100%' }}>{addingAdmin ? 'Adicionando...' : 'Adicionar admin'}</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: editar empresa */}
      {editTenant && (
        <div className="modal-overlay" onClick={() => setEditTenant(null)}>
          <div className="modal-content" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Editar Empresa</h2>
              <button type="button" onClick={() => setEditTenant(null)} className="btn-close">✕</button>
            </div>
            {editError && <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>{editError}</div>}
            <form onSubmit={submitEditTenant} className="modal-form">
              <div className="form-row">
                <div className="form-group"><label>Nome da empresa *</label><input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} required /></div>
                <div className="form-group"><label>Slug</label><input value={editForm.slug} onChange={e => setEditForm(p => ({ ...p, slug: slugify(e.target.value) }))} placeholder="identificador-da-empresa" /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>E-mail da empresa</label><input type="email" value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))} placeholder="contato@empresa.com" /></div>
                <div className="form-group"><label>Status</label>
                  <select value={editForm.status} onChange={e => setEditForm(p => ({ ...p, status: e.target.value }))}>
                    <option value="ativo">Ativa</option><option value="inativo">Inativa</option>
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: -2, marginBottom: 8 }}>Alterar o slug muda a identidade da empresa — faça apenas se souber o efeito.</div>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditTenant(null)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={savingEdit}>{savingEdit ? 'Salvando...' : 'Salvar alterações'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: apagar empresa (confirmação por digitação do nome) */}
      {delTenant && (
        <div className="modal-overlay" onClick={() => !deleting && setDelTenant(null)}>
          <div className="modal-content" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#b91c1c' }}>Apagar empresa</h2>
              <button type="button" onClick={() => !deleting && setDelTenant(null)} className="btn-close">✕</button>
            </div>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: '#991b1b' }}>
              Esta ação é <strong>permanente e irreversível</strong>. Todos os dados de <strong>{delTenant.name}</strong> (usuários, clientes, multas, leads, documentos) serão apagados.
            </div>
            <div className="form-group">
              <label style={{ fontSize: 13 }}>Para confirmar, digite o nome exato da empresa: <strong>{delTenant.name}</strong></label>
              <input value={delText} onChange={e => setDelText(e.target.value)} placeholder={delTenant.name} autoFocus />
            </div>
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={() => setDelTenant(null)} disabled={deleting}>Cancelar</button>
              <button
                type="button"
                className="btn-primary"
                disabled={deleting || delText.trim() !== delTenant.name}
                style={{ background: '#b91c1c', borderColor: '#b91c1c', opacity: (deleting || delText.trim() !== delTenant.name) ? 0.5 : 1 }}
                onClick={confirmDelTenant}
              >
                {deleting ? 'Apagando...' : 'Apagar definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: editar usuário */}
      {editUser && (
        <div className="modal-overlay" onClick={() => setEditUser(null)}>
          <div className="modal-content" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>Editar Usuário</h2>
              <button type="button" onClick={() => setEditUser(null)} className="btn-close">✕</button>
            </div>
            {editUserError && <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>{editUserError}</div>}
            <form onSubmit={submitEditUser} className="modal-form">
              <div className="form-group"><label>Nome</label><input value={editUserForm.name} onChange={e => setEditUserForm(p => ({ ...p, name: e.target.value }))} /></div>
              <div className="form-row">
                <div className="form-group"><label>E-mail *</label><input type="email" value={editUserForm.email} onChange={e => setEditUserForm(p => ({ ...p, email: e.target.value }))} required /></div>
                <div className="form-group"><label>Papel</label>
                  <select value={editUserForm.role} onChange={e => setEditUserForm(p => ({ ...p, role: e.target.value }))}>
                    <option value="admin">admin</option><option value="seller">seller</option>
                  </select>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: -4, marginBottom: 8 }}>Para alterar a senha, use “Resetar senha”.</div>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditUser(null)}>Cancelar</button>
                <button type="submit" className="btn-primary" disabled={savingUser}>{savingUser ? 'Salvando...' : 'Salvar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
