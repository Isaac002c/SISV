'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getClients, createClient, updateClient, deleteClient, searchClients } from '../lib/clientsAPI';
import { getTenantModules } from '../lib/brand';
import { getConfig } from '../lib/tenantConfigAPI';
import ClienteDetalhe from '../sisv/ClienteDetalhe';

const toInputDate = (value) => (!value ? '' : value.substring(0, 10));

const normalizeDate = (v) => {
  if (!v) return '';
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  const digits = s.replace(/\D/g, '').slice(0, 8);
  if (digits.length === 8) return `${digits.slice(0,2)}/${digits.slice(2,4)}/${digits.slice(4)}`;
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0,2)}/${digits.slice(2)}`;
  return `${digits.slice(0,2)}/${digits.slice(2,4)}/${digits.slice(4)}`;
};

const isoToDisplay = (v) => {
  if (!v) return '';
  const s = v.substring(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  return s;
};

const displayToIso = (v) => {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mSep = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (mSep) return `${mSep[3]}-${mSep[2].padStart(2,'0')}-${mSep[1].padStart(2,'0')}`;
  const mRaw = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (mRaw) return `${mRaw[3]}-${mRaw[2]}-${mRaw[1]}`;
  return null;
};

const CLIENT_STATUS_OPTIONS = [
  { value: 'negociacao', label: 'Negociação' },
  { value: 'fechado',    label: 'Fechado' },
];

const STATUS_LABELS = {
  negociacao: 'Negociação',
  fechado:    'Fechado',
};

const EMPTY_FORM = {
  name: '', birth_date: '', cpf: '', cnh: '',
  first_cnh: '', phone: '', email: '', address: '',
  notes: '', status: 'negociacao',
};

// Exibe CPF como somente números na tabela
const formatCPF = (cpf) => {
  if (!cpf) return '—';
  return cpf.replace(/\D/g, '') || '—';
};

// Aplica máscara de telefone durante digitação
const maskPhone = (value) => {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};

const formatPhone = (phone) => phone || '—';


export default function MultasClients() {
  const router = useRouter();
  const [clients, setClients]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [showModal, setShowModal]     = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [searchTerm, setSearchTerm]   = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [formData, setFormData]       = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState(null);
  const searchDebounce                = useRef(null);

  // SISV: abre o detalhe do cliente num drawer próprio (com processos vinculados),
  // em vez da tela legada de despachantes. Detecta tenant restrito pelos módulos.
  const [detailClient, setDetailClient] = useState(null);
  const [sisvConfig, setSisvConfig]     = useState(null);
  const [restricted, setRestricted]     = useState(false);

  useEffect(() => { loadClients(); }, []);

  useEffect(() => {
    let tenant = null;
    try { tenant = JSON.parse(localStorage.getItem('tenant') || '{}'); } catch { tenant = null; }
    const modules = getTenantModules(tenant);
    const isRestricted = Array.isArray(modules) && modules.includes('processos');
    setRestricted(isRestricted);
    if (isRestricted) getConfig().then(setSisvConfig).catch(() => {});
  }, []);

  const openClient = (client) => {
    if (restricted) setDetailClient(client);
    else router.push(`/multas/clients/${client.id}`);
  };

  const loadClients = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getClients();
      setClients(data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    const term = e.target.value;
    setSearchTerm(term);
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      if (term.length >= 2) {
        try { setClients(await searchClients(term)); } catch {}
      } else if (term.length === 0) {
        loadClients();
      }
    }, 300);
  };

  const validateForm = () => {
    if (!formData.name.trim()) return 'Nome é obrigatório.';
    if (formData.cpf) {
      const digits = formData.cpf.replace(/\D/g, '');
      if (digits.length > 0 && digits.length !== 11) return 'CPF deve ter 11 dígitos.';
    }
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      return 'E-mail inválido.';
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);
    const validationError = validateForm();
    if (validationError) { setFormError(validationError); return; }
    try {
      setSaving(true);
      const payload = {
        ...formData,
        birth_date: displayToIso(formData.birth_date),
        first_cnh:  displayToIso(formData.first_cnh),
      };
      if (editingClient) {
        await updateClient(editingClient.id, payload);
      } else {
        await createClient(payload);
      }
      setShowModal(false);
      setEditingClient(null);
      setFormData(EMPTY_FORM);
      loadClients();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingClient(null);
    setFormData(EMPTY_FORM);
    setFormError(null);
  };

  const startEdit = (client) => {
    setDetailClient(null);
    setEditingClient(client);
    setFormData({
      name:       client.name       || '',
      birth_date: isoToDisplay(client.birth_date),
      cpf:        client.cpf        || '',
      cnh:        client.cnh        || '',
      first_cnh:  isoToDisplay(client.first_cnh),
      phone:      client.phone      || '',
      email:      client.email      || '',
      address:    client.address    || '',
      notes:      client.notes      || '',
      status:     client.status     || 'negociacao',
    });
    setShowModal(true);
  };

  const openEdit = (e, client) => {
    e.stopPropagation();
    startEdit(client);
  };

  const openNew = () => {
    setEditingClient(null);
    setFormData(EMPTY_FORM);
    setShowModal(true);
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Excluir este cliente? Esta ação não pode ser desfeita.')) return;
    try {
      await deleteClient(id);
      loadClients();
    } catch (err) {
      setError(err.message);
    }
  };

  const set = (field) => (e) => {
    let value = e.target.value;
    if (field === 'cpf')   value = value.replace(/\D/g, '').slice(0, 11);
    if (field === 'phone') value = maskPhone(value);
    if (field === 'birth_date' || field === 'first_cnh') value = normalizeDate(value);
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // Filtragem local por status
  const displayed = clients.filter(c => !filterStatus || c.status === filterStatus);

  const negociacaoCount = clients.filter(c => c.status === 'negociacao').length;
  const fechadoCount    = clients.filter(c => c.status === 'fechado').length;

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0', gap: 14 }}>
      <div className="loading-spinner" style={{ width: 32, height: 32, border: '3px solid #e2e8f0', borderTopColor: '#2563eb' }} />
      <p style={{ color: '#94a3b8', fontSize: 14 }}>Carregando clientes...</p>
    </div>
  );

  return (
    <div className="clients-page">

      {/* Topo: resumo rápido */}
      <div className="clients-summary">
        <div className="clients-summary-card all" onClick={() => setFilterStatus('')} style={{ cursor: 'pointer' }}>
          <span className="summary-number">{clients.length}</span>
          <span className="summary-label">Total de Clientes</span>
        </div>
        <div className="clients-summary-card nego" onClick={() => setFilterStatus('negociacao')} style={{ cursor: 'pointer' }}>
          <span className="summary-number">{negociacaoCount}</span>
          <span className="summary-label">Em Negociação</span>
        </div>
        <div className="clients-summary-card fechado" onClick={() => setFilterStatus('fechado')} style={{ cursor: 'pointer' }}>
          <span className="summary-number">{fechadoCount}</span>
          <span className="summary-label">Fechados</span>
        </div>
      </div>

      {error && (
        <div className="error-message" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <p style={{ margin: 0 }}>{error}</p>
          <button onClick={() => setError(null)} className="btn-close">✕</button>
        </div>
      )}

      {/* Barra de ações */}
      <div className="clients-toolbar">
        <div className="clients-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            placeholder="Buscar por nome, CPF ou CNH..."
            value={searchTerm}
            onChange={handleSearch}
            className="clients-search-input"
          />
        </div>
        <div className="clients-filters">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="clients-filter-select"
          >
            <option value="">Todos os status</option>
            {CLIENT_STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <button onClick={openNew} className="btn-primary clients-new-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Novo Cliente
        </button>
      </div>

      {/* Tabela */}
      <div className="clients-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF</th>
              <th>CNH</th>
              <th>Telefone</th>
              <th>E-mail</th>
              <th>Status</th>
              <th style={{ width: 80 }}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr>
                <td colSpan="7">
                  <div className="empty-state" style={{ padding: '40px 0' }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" style={{ marginBottom: 8 }}>
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                    <p style={{ color: '#94a3b8' }}>
                      {filterStatus ? `Nenhum cliente com status "${STATUS_LABELS[filterStatus]}"` : 'Nenhum cliente cadastrado'}
                    </p>
                  </div>
                </td>
              </tr>
            ) : displayed.map((client) => (
              <tr
                key={client.id}
                onClick={() => openClient(client)}
                className="clickable-row"
              >
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: 'rgba(37, 99, 235,0.1)', color: '#2563eb',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 700, flexShrink: 0,
                    }}>
                      {client.name?.charAt(0).toUpperCase()}
                    </div>
                    <strong style={{ color: '#0f172a' }}>{client.name}</strong>
                  </div>
                </td>
                <td style={{ color: '#475569', fontFamily: 'monospace', fontSize: 13 }}>{formatCPF(client.cpf)}</td>
                <td style={{ color: '#475569' }}>{client.cnh || '—'}</td>
                <td style={{ color: '#475569', whiteSpace: 'nowrap' }}>{formatPhone(client.phone)}</td>
                <td style={{ color: '#475569' }}>{client.email || '—'}</td>
                <td>
                  <span className={`client-status-badge ${client.status || 'negociacao'}`}>
                    {STATUS_LABELS[client.status] || 'Negociação'}
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="actions-cell">
                    <button onClick={(e) => openEdit(e, client)} className="btn-icon" title="Editar">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button onClick={(e) => handleDelete(e, client.id)} className="btn-icon danger" title="Excluir">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                  {editingClient ? 'Editar Cliente' : 'Novo Cliente'}
                </h2>
                <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                  {editingClient ? 'Atualize os dados do cliente' : 'Preencha os dados do novo cliente'}
                </p>
              </div>
              <button type="button" onClick={closeModal} className="btn-close">✕</button>
            </div>

            {formError && (
              <div className="error-message" style={{ margin: '0 0 12px', fontSize: 13 }}>
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="modal-form">
              {/* Nome */}
              <div className="form-group">
                <label>Nome completo *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={set('name')}
                  placeholder="Nome do cliente"
                  required
                />
              </div>

              {/* CPF + Nascimento */}
              <div className="form-row">
                <div className="form-group">
                  <label>CPF</label>
                  <input
                    type="text"
                    value={formData.cpf}
                    onChange={set('cpf')}
                    maxLength={11}
                    placeholder="00000000000"
                    inputMode="numeric"
                  />
                </div>
                <div className="form-group">
                  <label>Data de Nascimento</label>
                  <input type="text" value={formData.birth_date} onChange={set('birth_date')} placeholder="ex: 11092006 ou 11/09/2006" />
                </div>
              </div>

              {/* CNH + 1ª habilitação */}
              <div className="form-row">
                <div className="form-group">
                  <label>CNH</label>
                  <input
                    type="text"
                    value={formData.cnh}
                    onChange={set('cnh')}
                    placeholder="Número da CNH"
                  />
                </div>
                <div className="form-group">
                  <label>1ª Habilitação</label>
                  <input type="text" value={formData.first_cnh} onChange={set('first_cnh')} placeholder="ex: 11092006 ou 11/09/2006" />
                </div>
              </div>

              {/* Telefone + Email */}
              <div className="form-row">
                <div className="form-group">
                  <label>Telefone</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={set('phone')}
                    placeholder="(21) 99999-0000"
                  />
                </div>
                <div className="form-group">
                  <label>E-mail</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={set('email')}
                    placeholder="email@exemplo.com"
                  />
                </div>
              </div>

              {/* Endereço */}
              <div className="form-group">
                <label>Endereço</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={set('address')}
                  placeholder="Rua, número, bairro, cidade"
                />
              </div>

              {/* Status */}
              <div className="form-group">
                <label>Status *</label>
                <select value={formData.status} onChange={set('status')} required>
                  {CLIENT_STATUS_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Observações */}
              <div className="form-group">
                <label>Observações</label>
                <textarea
                  value={formData.notes}
                  onChange={set('notes')}
                  rows={3}
                  placeholder="Anotações adicionais sobre o cliente..."
                />
              </div>

              <div className="form-actions">
                <button type="button" onClick={closeModal} className="btn-secondary">
                  Cancelar
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : editingClient ? 'Salvar alterações' : 'Criar cliente'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SISV: detalhe do cliente (dados, processos vinculados, documentos) */}
      {detailClient && (
        <ClienteDetalhe
          client={detailClient}
          config={sisvConfig}
          onClose={() => setDetailClient(null)}
          onEdit={startEdit}
        />
      )}
    </div>
  );
}
