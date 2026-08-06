'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  createUser,
  deactivateUser,
  deleteUser,
  getAccessOptions,
  getUsers,
  getUsersStats,
  getUserWorkload,
  updateUser,
} from '../lib/usersAPI';
import { departments as departmentsAPI } from '../lib/tenantConfigAPI';

const EMPTY_FORM = {
  name: '',
  username: '',
  phone: '',
  password: '',
  access_profile: 'sales',
  module_access: ['sales'],
  backoffice_level: 0,
  is_active: true,
  department_id: '',
};

const FALLBACK_PROFILES = {
  admin: 'admin',
  front_office: 'sales',
  sales_backoffice: 'sales_backoffice_l1',
  back_office: 'backoffice_l1',
};

function Icon({ name, size = 18 }) {
  const paths = {
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
    pause: <><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    alert: <><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const getProfileKey = (user) => user.access_profile || FALLBACK_PROFILES[user.role] || 'custom';

export default function MultasUsers() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [options, setOptions] = useState({ profiles: [], modules: [] });
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [deactivateDialog, setDeactivateDialog] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const [usersData, statsData, accessData, departmentData] = await Promise.all([
        getUsers(),
        getUsersStats(),
        getAccessOptions(),
        departmentsAPI.list(),
      ]);
      setUsers(usersData.data || []);
      setStats(statsData.data || null);
      setOptions(accessData.data || { profiles: [], modules: [] });
      setDepartments(departmentData || []);
    } catch (err) {
      setError(err.message || 'Não foi possível carregar os usuários.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (!showModal && !deactivateDialog && !deleteDialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (deleteDialog) setDeleteDialog(null);
      else if (deactivateDialog) setDeactivateDialog(null);
      else setShowModal(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showModal, deactivateDialog, deleteDialog]);

  const profileMap = useMemo(
    () => Object.fromEntries((options.profiles || []).map((profile) => [profile.key, profile])),
    [options.profiles]
  );
  const activeUsers = users.filter((user) => user.is_active);
  const adminCount = users.filter((user) => user.is_active && user.role === 'admin').length;
  const capacityBlocked = stats?.limit !== null && stats?.limit !== undefined && stats.active >= stats.limit;
  const overBy = stats?.over_limit ? Math.max(1, stats.active - stats.limit) : 0;

  const resetForm = () => setFormData({ ...EMPTY_FORM, module_access: [...EMPTY_FORM.module_access] });

  const openNewUserModal = () => {
    if (capacityBlocked) return;
    setError('');
    setEditingUser(null);
    resetForm();
    setShowModal(true);
  };

  const handleEdit = (user) => {
    setError('');
    const profileKey = getProfileKey(user);
    const profile = profileMap[profileKey];
    setEditingUser(user);
    setFormData({
      name: user.name || '',
      username: user.username || '',
      phone: user.phone || '',
      password: '',
      access_profile: profileKey,
      module_access: Array.isArray(user.module_access)
        ? user.module_access
        : (profile?.modules || []),
      backoffice_level: Number(user.backoffice_level ?? profile?.backofficeLevel ?? 0),
      is_active: user.is_active !== false,
      department_id: user.department_id || '',
    });
    setShowModal(true);
  };

  const selectProfile = (profile) => {
    setFormData((current) => ({
      ...current,
      access_profile: profile.key,
      module_access: profile.key === 'custom' ? current.module_access : [...profile.modules],
      backoffice_level: profile.key === 'custom' ? current.backoffice_level : profile.backofficeLevel,
    }));
  };

  const toggleModule = (moduleKey) => {
    setFormData((current) => {
      const selected = current.module_access.includes(moduleKey);
      const module_access = selected
        ? current.module_access.filter((key) => key !== moduleKey)
        : [...current.module_access, moduleKey];
      return {
        ...current,
        module_access,
        backoffice_level: module_access.includes('backoffice') ? current.backoffice_level : 0,
      };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      setSaving(true);
      setError('');
      const payload = {
        name: formData.name.trim(),
        username: formData.username.trim(),
        phone: formData.phone.trim() || null,
        access_profile: formData.access_profile,
        module_access: formData.module_access,
        backoffice_level: Number(formData.backoffice_level || 0),
        department_id: formData.department_id || null,
      };
      if (editingUser) {
        payload.is_active = formData.is_active;
        await updateUser(editingUser.id, payload);
      } else {
        await createUser({ ...payload, password: formData.password });
      }
      setShowModal(false);
      setEditingUser(null);
      resetForm();
      await loadData();
    } catch (err) {
      setError(err.message || 'Não foi possível salvar o usuário.');
    } finally {
      setSaving(false);
    }
  };

  const openDeactivateDialog = async (user) => {
    try {
      setError('');
      const response = await getUserWorkload(user.id);
      setDeactivateDialog({ user, workload: response.data, targetId: '', saving: false });
    } catch (err) {
      setError(err.message || 'Não foi possível consultar a carga do usuário.');
    }
  };

  const confirmDeactivate = async () => {
    if (!deactivateDialog) return;
    const { user, workload, targetId } = deactivateDialog;
    const hasWorkload = Number(workload?.counts?.processes || 0) + Number(workload?.counts?.tasks || 0) > 0;
    if (hasWorkload && !targetId) {
      setError('Escolha quem receberá a carga antes de desativar.');
      return;
    }
    try {
      setDeactivateDialog((current) => ({ ...current, saving: true }));
      setError('');
      await deactivateUser(user.id, targetId || null);
      setDeactivateDialog(null);
      await loadData();
    } catch (err) {
      setError(err.message || 'Não foi possível desativar o usuário.');
      setDeactivateDialog((current) => current ? ({ ...current, saving: false }) : null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteDialog) return;
    try {
      setDeleteDialog((current) => ({ ...current, saving: true }));
      setError('');
      await deleteUser(deleteDialog.user.id);
      setDeleteDialog(null);
      await loadData();
    } catch (err) {
      setError(err.message || 'Não foi possível excluir o usuário.');
      setDeleteDialog((current) => current ? ({ ...current, saving: false }) : null);
    }
  };

  const formatDate = (date) => date
    ? new Date(date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

  if (loading) {
    return (
      <div className="access-users-loading">
        <span className="loading-spinner" />
        <p>Carregando acessos...</p>
      </div>
    );
  }

  return (
    <div className="access-users-page">
      <section className="access-users-hero">
        <div>
          <span className="access-users-eyebrow"><Icon name="shield" size={15} /> Controle de acesso</span>
          <h2>Equipe, perfis e módulos</h2>
          <p>Defina o que cada pessoa pode acessar e mantenha a operação dentro do limite contratado.</p>
        </div>
        <button
          type="button"
          className="access-users-primary"
          onClick={openNewUserModal}
          disabled={capacityBlocked}
          title={capacityBlocked ? 'Desative um usuário ativo para liberar uma vaga.' : 'Adicionar usuário'}
        >
          <Icon name="plus" size={17} /> Novo usuário
        </button>
      </section>

      <section className="access-users-stats" aria-label="Resumo de licenças">
        <article className="access-stat-card access-stat-card-main">
          <span className="access-stat-icon"><Icon name="users" /></span>
          <div><strong>{stats?.active ?? 0}<small> / {stats?.limit ?? '∞'}</small></strong><span>Usuários ativos</span></div>
        </article>
        <article className="access-stat-card">
          <span className="access-stat-icon"><Icon name="briefcase" /></span>
          <div><strong>{stats?.remaining ?? '∞'}</strong><span>Vagas disponíveis</span></div>
        </article>
        <article className="access-stat-card">
          <span className="access-stat-icon"><Icon name="shield" /></span>
          <div><strong>{adminCount}</strong><span>Administradores</span></div>
        </article>
        <article className="access-stat-card">
          <span className="access-stat-icon"><Icon name="pause" /></span>
          <div><strong>{stats?.inactive ?? 0}</strong><span>Usuários inativos</span></div>
        </article>
      </section>

      {stats?.over_limit && (
        <div className="access-users-notice access-users-notice-warning">
          <Icon name="alert" />
          <div>
            <strong>Limite excedido em {overBy} usuário{overBy > 1 ? 's' : ''}</strong>
            <span>Há {stats.active} usuários ativos para {stats.limit} licenças. Desative {overBy} antes de criar ou reativar alguém.</span>
          </div>
        </div>
      )}

      {error && (
        <div className="access-users-notice access-users-notice-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Fechar mensagem"><Icon name="close" size={16} /></button>
        </div>
      )}

      <section className="access-users-panel">
        <div className="access-users-panel-header">
          <div><h3>Usuários do sistema</h3><p>{users.length} cadastro{users.length === 1 ? '' : 's'} no total</p></div>
          <span className="access-users-license-pill">Plano atual: {stats?.limit ?? 'ilimitado'} usuários</span>
        </div>

        <div className="access-users-table-wrap">
          <table className="access-users-table">
            <thead><tr><th>Colaborador</th><th>Perfil e módulos</th><th>Setor</th><th>Carga</th><th>Status</th><th>Criado em</th><th><span className="sr-only">Ações</span></th></tr></thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td colSpan="7" className="access-users-empty">Nenhum usuário cadastrado.</td></tr>
              ) : users.map((user) => {
                const profileKey = getProfileKey(user);
                const profile = profileMap[profileKey];
                const modules = Array.isArray(user.module_access) ? user.module_access : (profile?.modules || []);
                return (
                  <tr key={user.id} className={!user.is_active ? 'is-inactive' : ''}>
                    <td>
                      <div className="access-user-identity">
                        <span className="access-user-avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</span>
                        <div>
                          <strong>{user.name}</strong>
                          <span>@{user.username}</span>
                          {user.phone && <small>{user.phone}</small>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="access-user-access">
                        <strong>{profile?.label || 'Acesso legado'}</strong>
                        <div className="access-module-chips">
                          {modules.length ? modules.map((key) => (
                            <span key={key}>{options.modules.find((module) => module.key === key)?.label || key}</span>
                          )) : <span>Compatibilidade</span>}
                          {Number(user.backoffice_level || 0) > 0 && <span>Nível {user.backoffice_level}</span>}
                        </div>
                      </div>
                    </td>
                    <td>{user.department_name || <span className="access-muted">Sem setor</span>}</td>
                    <td><span className="access-workload"><strong>{user.process_count || 0}</strong> proc. <i /> <strong>{user.task_count || 0}</strong> pend.</span></td>
                    <td><span className={`access-status ${user.is_active ? 'active' : 'inactive'}`}><i />{user.is_active ? 'Ativo' : 'Inativo'}</span></td>
                    <td>{formatDate(user.created_at)}</td>
                    <td>
                      <div className="access-user-actions">
                        <button type="button" onClick={() => handleEdit(user)} title="Editar acesso" aria-label={`Editar ${user.name}`}><Icon name="edit" /></button>
                        {user.is_active && <button type="button" className="danger" onClick={() => openDeactivateDialog(user)} title="Desativar" aria-label={`Desativar ${user.name}`}><Icon name="pause" /></button>}
                        {!user.is_active && <button type="button" className="danger" onClick={() => setDeleteDialog({ user, saving: false })} title="Excluir" aria-label={`Excluir ${user.name}`}><Icon name="trash" /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {showModal && (
        <div className="access-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowModal(false); }}>
          <div className="access-modal" role="dialog" aria-modal="true" aria-labelledby="access-user-modal-title">
            <div className="access-modal-header">
              <div><span>{editingUser ? 'Gerenciar acesso' : 'Adicionar à equipe'}</span><h2 id="access-user-modal-title">{editingUser ? editingUser.name : 'Novo usuário'}</h2></div>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Fechar"><Icon name="close" /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="access-modal-body">
                <section className="access-form-section">
                  <div className="access-form-section-title"><span>1</span><div><strong>Dados do colaborador</strong><small>Informações usadas na identificação e no login.</small></div></div>
                  <div className="access-form-grid">
                    <label className="access-form-field access-form-wide"><span>Nome completo *</span><input autoFocus type="text" value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} required /></label>
                    <label className="access-form-field"><span>Usuário de acesso *</span><input type="text" placeholder="Nome.Sobrenome" autoCapitalize="none" spellCheck="false" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,79}" value={formData.username} onChange={(event) => setFormData({ ...formData, username: event.target.value })} required /><small>Use o formato Nome.Sobrenome.</small></label>
                    <label className="access-form-field"><span>Telefone</span><input type="tel" placeholder="(11) 99999-9999" value={formData.phone} onChange={(event) => setFormData({ ...formData, phone: event.target.value })} maxLength={30} /></label>
                    {!editingUser && <label className="access-form-field"><span>Senha provisória *</span><input type="password" value={formData.password} onChange={(event) => setFormData({ ...formData, password: event.target.value })} minLength={10} required /><small>Mínimo de 10 caracteres.</small></label>}
                    <label className="access-form-field"><span>Setor</span><select value={formData.department_id} onChange={(event) => setFormData({ ...formData, department_id: event.target.value })}><option value="">Sem setor</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
                  </div>
                </section>

                <section className="access-form-section">
                  <div className="access-form-section-title"><span>2</span><div><strong>Perfil de acesso</strong><small>Escolha um modelo pronto ou personalize os módulos.</small></div></div>
                  <div className="access-profile-grid">
                    {options.profiles.map((profile) => (
                      <button key={profile.key} type="button" className={formData.access_profile === profile.key ? 'selected' : ''} onClick={() => selectProfile(profile)}>
                        <span className="access-profile-radio" />
                        <strong>{profile.label}</strong>
                        <small>{profile.description}</small>
                      </button>
                    ))}
                  </div>

                  {formData.access_profile === 'custom' && (
                    <div className="access-custom-box">
                      <strong>Módulos liberados</strong>
                      <div className="access-module-options">
                        {options.modules.map((module) => (
                          <label key={module.key} className={formData.module_access.includes(module.key) ? 'selected' : ''}>
                            <input type="checkbox" checked={formData.module_access.includes(module.key)} onChange={() => toggleModule(module.key)} />
                            <span><strong>{module.label}</strong><small>{module.description}</small></span>
                          </label>
                        ))}
                      </div>
                      {formData.module_access.includes('backoffice') && (
                        <label className="access-level-field"><span>Nível de aprovação no Back Office</span><select value={formData.backoffice_level} onChange={(event) => setFormData({ ...formData, backoffice_level: Number(event.target.value) })}><option value={0}>Sem aprovação</option><option value={1}>Nível 1 — conferência</option><option value={2}>Nível 2 — aprovação final</option></select></label>
                      )}
                    </div>
                  )}
                </section>

                {editingUser && !editingUser.is_active && (
                  <section className="access-form-section access-reactivate-section">
                    <div><strong>Usuário inativo</strong><small>A reativação ocupa uma vaga do plano.</small></div>
                    <label className={capacityBlocked ? 'disabled' : ''}><input type="checkbox" checked={formData.is_active} disabled={capacityBlocked} onChange={(event) => setFormData({ ...formData, is_active: event.target.checked })} /> Reativar este usuário</label>
                  </section>
                )}
              </div>
              <div className="access-modal-footer"><button type="button" className="access-users-secondary" onClick={() => setShowModal(false)}>Cancelar</button><button type="submit" className="access-users-primary" disabled={saving || (formData.access_profile === 'custom' && formData.module_access.length === 0)}>{saving ? 'Salvando...' : (editingUser ? 'Salvar alterações' : 'Criar usuário')}</button></div>
            </form>
          </div>
        </div>
      )}

      {deactivateDialog && (
        <div className="access-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !deactivateDialog.saving) setDeactivateDialog(null); }}>
          <div className="access-modal access-modal-small" role="dialog" aria-modal="true" aria-labelledby="deactivate-title">
            <div className="access-modal-header"><div><span>Preservar histórico</span><h2 id="deactivate-title">Desativar {deactivateDialog.user.name}?</h2></div><button type="button" onClick={() => setDeactivateDialog(null)} aria-label="Fechar"><Icon name="close" /></button></div>
            <div className="access-modal-body">
              <div className="access-deactivate-summary"><Icon name="briefcase" size={22} /><div><strong>{deactivateDialog.workload?.counts?.processes || 0} processos e {deactivateDialog.workload?.counts?.tasks || 0} pendências</strong><span>O usuário perderá o acesso, mas todo o histórico será mantido.</span></div></div>
              {(Number(deactivateDialog.workload?.counts?.processes || 0) + Number(deactivateDialog.workload?.counts?.tasks || 0) > 0) && (
                <label className="access-form-field"><span>Redistribuir a carga para *</span><select value={deactivateDialog.targetId} onChange={(event) => setDeactivateDialog({ ...deactivateDialog, targetId: event.target.value })} required><option value="">Selecione um usuário ativo</option>{activeUsers.filter((user) => user.id !== deactivateDialog.user.id).map((user) => <option key={user.id} value={user.id}>{user.name} — @{user.username}</option>)}</select></label>
              )}
            </div>
            <div className="access-modal-footer"><button type="button" className="access-users-secondary" onClick={() => setDeactivateDialog(null)} disabled={deactivateDialog.saving}>Cancelar</button><button type="button" className="access-users-danger" onClick={confirmDeactivate} disabled={deactivateDialog.saving}>{deactivateDialog.saving ? 'Desativando...' : 'Confirmar desativação'}</button></div>
          </div>
        </div>
      )}

      {deleteDialog && (
        <div className="access-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteDialog.saving) setDeleteDialog(null); }}>
          <div className="access-modal access-modal-small" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
            <div className="access-modal-header"><div><span>Exclusão segura</span><h2 id="delete-user-title">Excluir {deleteDialog.user.name}?</h2></div><button type="button" onClick={() => setDeleteDialog(null)} aria-label="Fechar"><Icon name="close" /></button></div>
            <div className="access-modal-body">
              <div className="access-deactivate-summary"><Icon name="alert" size={22} /><div><strong>O acesso será removido da equipe</strong><span>O identificador @{deleteDialog.user.username} ficará livre para reutilização. Processos, tarefas e registros de auditoria permanecem preservados.</span></div></div>
            </div>
            <div className="access-modal-footer"><button type="button" className="access-users-secondary" onClick={() => setDeleteDialog(null)} disabled={deleteDialog.saving}>Cancelar</button><button type="button" className="access-users-danger" onClick={confirmDelete} disabled={deleteDialog.saving}>{deleteDialog.saving ? 'Excluindo...' : 'Excluir usuário'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
