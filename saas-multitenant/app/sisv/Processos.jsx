'use client';

// =============================================================================
// Processos (SISV) — fila operacional dos processos de CNH.
// Filtros combináveis resolvidos no backend, seleção múltipla para distribuição
// em lote, ordenação por coluna, exportação CSV e paginação.
// Detalhe e criação vivem em ProcessDrawer.jsx / CreateProcessModal.jsx.
// =============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Pagination, EmptyState, PageHead, SkeletonRows } from '../components/ui';
import * as api from '../lib/processesAPI';
import {
  advancedBatch, createView, deleteView, exportProcesses, listViews, updateView,
  getOperationSettings,
} from '../lib/operationsAPI';
import { getConfig, getAssignees } from '../lib/tenantConfigAPI';
import { fmtDate, prazoInfo, daysSince } from '../lib/format';
import { Badge, Chip } from './ui';
import CreateProcessModal from './CreateProcessModal';
import ProcessDrawer from './ProcessDrawer';

const PAGE_SIZE = 15;

export default function Processos({ initialFilters = {} }) {
  const [config, setConfig] = useState({ stages: [], statuses: [], serviceTypes: [], departments: [] });
  const [assignees, setAssignees] = useState([]);
  const [user, setUser] = useState(null);

  const [filters, setFilters] = useState({
    q: '', stage: '', status: '', seller_id: '', department_id: '',
    tenant_service_type_id: '', pending: '', finalized: '', stale_days: '',
    overdue: '', due_soon: '', ...initialFilters,
  });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ by: 'last_moved_at', dir: 'desc' });
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState({ seller_id: '', department_id: '' });
  const [bulkExtra, setBulkExtra] = useState({ stage: '', status: '', due_date: '', note: '', task_title: '', task_priority: 'normal' });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savedViews, setSavedViews] = useState([]);
  const [operationSettings, setOperationSettings] = useState({ stale_after_days: 7, due_soon_days: 7, aging_bands: [2, 5, 10] });
  const searchDebounce = useRef(null);
  const loadSeq = useRef(0);
  const searchParams = useSearchParams();

  const byCode = (list, code) => list.find((x) => x.code === code);

  // URL e a fonte compartilhavel dos filtros. Somente chaves autorizadas entram
  // no estado; o backend repete a validacao antes de montar SQL.
  useEffect(() => {
    const pre = searchParams.get('pre');
    const client = searchParams.get('client');
    const base = { q: '', stage: '', status: '', seller_id: '', department_id: '', tenant_service_type_id: '', pending: '', finalized: '', stale_days: '', aging: '', overdue: '', due_today: '', due_soon: '', missing_documents: '', client_id: '' };
    const map = {
      andamento: { finalized: 'false' },
      finalizados: { finalized: 'true' },
      pendencia: { pending: 'true' },
      'sem-responsavel': { seller_id: 'none' },
      'sem-mov': { stale_days: '7' },
      vencidos: { overdue: 'true' },
      vencendo: { due_soon: 'true' },
    };
    const direct = {};
    Object.keys(base).forEach((key) => {
      if (searchParams.has(key)) direct[key] = searchParams.get(key);
    });
    if (client) direct.client_id = client;
    if (map[pre]) Object.assign(direct, map[pre]);
    if (Object.keys(direct).length) {
      setPage(Math.max(1, Number(searchParams.get('page')) || 1));
      setFilters({ ...base, ...direct });
    }
    const processId = searchParams.get('process');
    if (processId) setDetailId(processId);
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    ['q', 'stage', 'status', 'seller_id', 'department_id', 'tenant_service_type_id', 'pending', 'finalized', 'stale_days', 'aging', 'overdue', 'due_today', 'due_soon', 'missing_documents', 'client_id', 'page', 'sort_by', 'sort_dir'].forEach((key) => params.delete(key));
    Object.entries(filters).forEach(([key, value]) => { if (value !== '' && value !== null && value !== undefined) params.set(key, value); });
    if (page > 1) params.set('page', String(page));
    if (sort.by !== 'last_moved_at') params.set('sort_by', sort.by);
    if (sort.dir !== 'desc') params.set('sort_dir', sort.dir);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
  }, [filters, page, sort]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setDetailId(params.get('process'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    try { setUser(JSON.parse(localStorage.getItem('user') || 'null')); } catch { /* noop */ }
    (async () => {
      try {
        const [cfg, users, views, settings] = await Promise.all([
          getConfig(), getAssignees(), listViews('processos'), getOperationSettings(),
        ]);
        setConfig(cfg || { stages: [], statuses: [], serviceTypes: [], departments: [] });
        setAssignees(users || []);
        setSavedViews(views || []);
        setOperationSettings(settings || { stale_after_days: 7, due_soon_days: 7, aging_bands: [2, 5, 10] });
      } catch (e) { setError(e.message); }
    })();
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true); setError(null);
    try {
      const res = await api.listProcesses({ ...filters, sort_by: sort.by, sort_dir: sort.dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      if (seq !== loadSeq.current) return; // resposta obsoleta: ignora
      setRows(res.rows); setTotal(res.total);
    } catch (e) { if (seq === loadSeq.current) setError(e.message); }
    finally { if (seq === loadSeq.current) setLoading(false); }
  }, [filters, page, sort]);

  useEffect(() => { load(); }, [load]);
  // Limpa a seleção quando muda filtro/página/ordenação (a lista muda).
  useEffect(() => { setSelected(new Set()); }, [filters, page, sort]);

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleSelectAll = () => setSelected((prev) => {
    if (rows.every((r) => prev.has(r.id))) return new Set();
    return new Set(rows.map((r) => r.id));
  });
  const applyBulk = async () => {
    if (bulkBusy) return; // anti duplo-envio
    const changes = {};
    const parts = [];
    if (bulk.seller_id !== '') { changes.seller_id = bulk.seller_id === 'none' ? null : bulk.seller_id; parts.push(bulk.seller_id === 'none' ? 'sem responsável' : `responsável "${assignees.find((u) => u.id === bulk.seller_id)?.name || ''}"`); }
    if (bulk.department_id !== '') { changes.department_id = bulk.department_id === 'none' ? null : bulk.department_id; parts.push(bulk.department_id === 'none' ? 'sem setor' : `setor "${config.departments.find((d) => d.id === bulk.department_id)?.name || ''}"`); }
    if (bulkExtra.stage) { changes.stage = bulkExtra.stage; parts.push('alterar etapa'); }
    if (bulkExtra.status) { changes.status = bulkExtra.status; parts.push('alterar status'); }
    if (bulkExtra.due_date) { changes.due_date = bulkExtra.due_date; parts.push('alterar prazo'); }
    const body = {
      changes,
      note: bulkExtra.note.trim() || undefined,
      task: bulkExtra.task_title.trim() ? { title: bulkExtra.task_title.trim(), priority: bulkExtra.task_priority } : undefined,
    };
    if (body.note) parts.push('adicionar nota');
    if (body.task) parts.push('criar pendência');
    if (Object.keys(changes).length === 0 && !body.note && !body.task) { setError('Escolha ao menos uma ação para o lote.'); return; }
    if (!confirm(`Aplicar ${parts.join(' e ')} a ${selected.size} processo(s)?`)) return;
    setBulkBusy(true); setError(null);
    try {
      const res = isAdmin
        ? await advancedBatch([...selected], body)
        : await api.batchAssign([...selected], changes);
      setSelected(new Set()); setBulk({ seller_id: '', department_id: '' });
      setBulkExtra({ stage: '', status: '', due_date: '', note: '', task_title: '', task_priority: 'normal' });
      await load();
      if (res?.skipped) setError(null);
    } catch (e) { setError(e.message); }
    finally { setBulkBusy(false); }
  };

  const isAdmin = user?.role === 'admin' || user?.role === 'manager';
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setFilter = (k, v) => { setPage(1); setFilters((f) => ({ ...f, [k]: v })); };
  const onSearch = (e) => {
    const v = e.target.value;
    setFilters((f) => ({ ...f, q: v }));
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { setPage(1); load(); }, 350);
  };
  const clearFilters = () => {
    setPage(1);
    setFilters({ q: '', stage: '', status: '', seller_id: '', department_id: '', tenant_service_type_id: '', pending: '', finalized: '', stale_days: '', aging: '', overdue: '', due_today: '', due_soon: '', missing_documents: '', client_id: '' });
  };

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => k !== 'q' && v).length;

  // Rótulos legíveis dos filtros aplicados (para os chips com remoção individual).
  const chipLabel = {
    stage: () => `Etapa: ${config.stages.find((s) => s.code === filters.stage)?.label || filters.stage}`,
    status: () => `Status: ${config.statuses.find((s) => s.code === filters.status)?.label || filters.status}`,
    seller_id: () => (filters.seller_id === 'none' ? 'Sem responsável' : `Responsável: ${assignees.find((u) => u.id === filters.seller_id)?.name || '—'}`),
    department_id: () => (filters.department_id === 'none' ? 'Sem setor' : `Setor: ${config.departments.find((d) => d.id === filters.department_id)?.name || '—'}`),
    tenant_service_type_id: () => `Serviço: ${config.serviceTypes.find((s) => s.id === filters.tenant_service_type_id)?.label || '—'}`,
    pending: () => 'Com pendência',
    finalized: () => (filters.finalized === 'true' ? 'Finalizados' : 'Em andamento'),
    overdue: () => 'Prazo vencido',
    due_soon: () => `Vence em ${operationSettings.due_soon_days || 7} dias`,
    due_today: () => 'Vence hoje',
    missing_documents: () => 'Documentos faltantes',
    stale_days: () => `Sem movimentação (${operationSettings.stale_after_days || 7}d+)`,
    aging: () => `Aging: ${filters.aging.replaceAll('_', ' ')}`,
    client_id: () => 'Cliente específico',
  };
  const appliedChips = Object.entries(filters)
    .filter(([k, v]) => k !== 'q' && v)
    .map(([k]) => ({ key: k, label: chipLabel[k] ? chipLabel[k]() : k }));
  const bands = Array.isArray(operationSettings.aging_bands) && operationSettings.aging_bands.length === 3
    ? operationSettings.aging_bands.map(Number)
    : [2, 5, 10];
  const agingChips = [
    [`ate_${bands[0]}`, `Aging até ${bands[0]}d`],
    [`${bands[0] + 1}_a_${bands[1]}`, `${bands[0] + 1}–${bands[1]}d`],
    [`${bands[1] + 1}_a_${bands[2]}`, `${bands[1] + 1}–${bands[2]}d`],
    [`acima_${bands[2]}`, `${bands[2]}d+`],
  ];

  // Ordenação por coluna (backend). Alterna asc/desc ao clicar no mesmo campo.
  const toggleSort = (field) => {
    setPage(1);
    setSort((s) => ({ by: field, dir: s.by === field && s.dir === 'asc' ? 'desc' : 'asc' }));
  };
  const sortArrow = (field) => (sort.by === field ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  // Exporta a visão filtrada atual para CSV (até 200 processos).
  const exportCSV = async () => {
    setExporting(true);
    try {
      await exportProcesses({
        ids: selected.size ? [...selected] : undefined,
        filters,
        sort_by: sort.by,
        sort_dir: sort.dir,
      });
    } catch (e) { setError(e.message); }
    finally { setExporting(false); }
  };

  const saveCurrentView = async () => {
    const name = window.prompt('Nome da visualização:');
    if (!name?.trim()) return;
    try {
      await createView({
        name: name.trim(),
        view_type: 'processos',
        filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')),
        sort_config: { by: sort.by, dir: sort.dir },
        is_favorite: true,
      });
      setSavedViews(await listViews('processos'));
    } catch (e) { setError(e.message); }
  };

  const applyView = (view) => {
    setPage(1);
    setFilters((current) => ({ ...Object.fromEntries(Object.keys(current).map((key) => [key, ''])), ...(view.filters || {}) }));
    if (view.sort_config?.by) setSort({ by: view.sort_config.by, dir: view.sort_config.dir || 'desc' });
  };

  const removeView = async (view) => {
    if (!view.owned || !confirm(`Excluir a visualização "${view.name}"?`)) return;
    try { await deleteView(view.id); setSavedViews(await listViews('processos')); }
    catch (e) { setError(e.message); }
  };

  const manageView = async (view, action) => {
    if (!view.owned) return;
    try {
      if (action === 'rename') {
        const name = window.prompt('Novo nome da visualização:', view.name);
        if (!name?.trim() || name.trim() === view.name) return;
        await updateView(view.id, { name: name.trim() });
      } else if (action === 'default') {
        await updateView(view.id, { is_default: !view.is_default });
      } else if (action === 'share' && isAdmin) {
        await updateView(view.id, { shared_tenant: !view.shared_tenant });
      }
      setSavedViews(await listViews('processos'));
    } catch (e) { setError(e.message); }
  };

  const openDetail = (id) => {
    const params = new URLSearchParams(window.location.search);
    params.set('process', id);
    window.history.pushState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
    setDetailId(id);
  };
  const closeDetail = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('process');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
    setDetailId(null);
  };

  return (
    <div className="clients-page">
      <PageHead
        title="Processos"
        subtitle="Fila operacional dos processos de CNH"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={exportCSV} disabled={exporting || total === 0}>{exporting ? 'Exportando...' : 'Exportar CSV'}</button>
            <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Novo Processo</button>
          </div>
        }
      />

      {error && (
        <div className="error-message" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="btn-close">✕</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <button className="btn-secondary" onClick={saveCurrentView}>Salvar visualização</button>
        {savedViews.map((view) => (
          <span key={view.id} style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 999, overflow: 'hidden' }}>
            <button onClick={() => applyView(view)} style={{ border: 0, background: view.is_default ? '#f0fdf4' : '#fff', padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>{view.name}</button>
            {view.owned && (
              <>
                <button aria-label={`${view.is_default ? 'Remover padrão de' : 'Definir como padrão'} ${view.name}`} title="Visualização padrão" onClick={() => manageView(view, 'default')} style={viewActionStyle}>{view.is_default ? '★' : '☆'}</button>
                <button aria-label={`Renomear ${view.name}`} title="Renomear" onClick={() => manageView(view, 'rename')} style={viewActionStyle}>✎</button>
                {isAdmin && <button aria-label={`${view.shared_tenant ? 'Parar de compartilhar' : 'Compartilhar'} ${view.name}`} title="Compartilhar com o tenant" onClick={() => manageView(view, 'share')} style={viewActionStyle}>{view.shared_tenant ? '↗' : '⇧'}</button>}
                <button aria-label={`Excluir ${view.name}`} title="Excluir" onClick={() => removeView(view)} style={{ ...viewActionStyle, color: '#b91c1c' }}>×</button>
              </>
            )}
          </span>
        ))}
      </div>

      {/* Filtros — selects viram painel recolhível no mobile */}
      <div className="clients-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="clients-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input className="clients-search-input" placeholder="Buscar por cliente, CPF, número ou protocolo..." value={filters.q} onChange={onSearch} />
        </div>
        <button className="proc-filters-toggle btn-secondary" onClick={() => setFiltersOpen((v) => !v)}>
          Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {filtersOpen ? '▲' : '▾'}
        </button>
        <div className={`proc-filter-selects${filtersOpen ? ' open' : ''}`}>
          <select className="clients-filter-select" value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}>
            <option value="">Todas as etapas</option>
            {config.stages.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
          </select>
          <select className="clients-filter-select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">Todos os status</option>
            {config.statuses.map((s) => <option key={s.id} value={s.code}>{s.label}</option>)}
          </select>
          <select className="clients-filter-select" value={filters.seller_id} onChange={(e) => setFilter('seller_id', e.target.value)}>
            <option value="">Todos os responsáveis</option>
            <option value="none">Sem responsável</option>
            {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {config.departments.length > 0 && (
            <select className="clients-filter-select" value={filters.department_id} onChange={(e) => setFilter('department_id', e.target.value)}>
              <option value="">Todos os setores</option>
              <option value="none">Sem setor</option>
              {config.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          <select className="clients-filter-select" value={filters.tenant_service_type_id} onChange={(e) => setFilter('tenant_service_type_id', e.target.value)}>
            <option value="">Todos os serviços</option>
            {config.serviceTypes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {/* Chips rápidos */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 14px' }}>
        <Chip active={filters.finalized === 'false'} onClick={() => setFilter('finalized', filters.finalized === 'false' ? '' : 'false')}>Em andamento</Chip>
        <Chip active={filters.finalized === 'true'} onClick={() => setFilter('finalized', filters.finalized === 'true' ? '' : 'true')}>Finalizados</Chip>
        <Chip active={filters.pending === 'true'} onClick={() => setFilter('pending', filters.pending === 'true' ? '' : 'true')}>Com pendência</Chip>
        <Chip active={filters.overdue === 'true'} onClick={() => setFilter('overdue', filters.overdue === 'true' ? '' : 'true')}>Prazo vencido</Chip>
        <Chip
          active={filters.due_soon === String(operationSettings.due_soon_days || 7)}
          onClick={() => setFilter('due_soon', filters.due_soon === String(operationSettings.due_soon_days || 7) ? '' : String(operationSettings.due_soon_days || 7))}
        >Vence em {operationSettings.due_soon_days || 7} dias</Chip>
        <Chip active={filters.seller_id === 'none'} onClick={() => setFilter('seller_id', filters.seller_id === 'none' ? '' : 'none')}>Sem responsável</Chip>
        <Chip
          active={filters.stale_days === String(operationSettings.stale_after_days || 7)}
          onClick={() => setFilter('stale_days', filters.stale_days === String(operationSettings.stale_after_days || 7) ? '' : String(operationSettings.stale_after_days || 7))}
        >Sem movimentação ({operationSettings.stale_after_days || 7}d+)</Chip>
        {agingChips.map(([code, label]) => (
          <Chip key={code} active={filters.aging === code} onClick={() => setFilter('aging', filters.aging === code ? '' : code)}>{label}</Chip>
        ))}
      </div>

      {/* Filtros aplicados: chips com remoção individual (nunca filtro invisível) */}
      {activeFilterCount > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 14px' }}>
          <span style={{ fontSize: 12.5, color: '#64748b', fontWeight: 600 }}>{activeFilterCount} filtro(s) ativo(s):</span>
          {appliedChips.map((c) => (
            <button key={c.key} onClick={() => setFilter(c.key, '')} title="Remover filtro" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
              fontSize: 12, fontWeight: 600, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#334155', cursor: 'pointer',
            }}>{c.label} <span style={{ fontWeight: 800 }}>✕</span></button>
          ))}
          <button className="btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={clearFilters}>Limpar tudo</button>
        </div>
      )}

      {/* Barra de distribuição em lote */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10 }}>
          <strong style={{ fontSize: 13.5, color: '#166534' }}>{selected.size} selecionado(s)</strong>
          <span style={{ color: '#64748b', fontSize: 13 }}>Distribuir para:</span>
          <select className="clients-filter-select" value={bulk.seller_id} onChange={(e) => setBulk((b) => ({ ...b, seller_id: e.target.value }))}>
            <option value="">Responsável…</option>
            <option value="none">Sem responsável</option>
            {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {config.departments.length > 0 && (
            <select className="clients-filter-select" value={bulk.department_id} onChange={(e) => setBulk((b) => ({ ...b, department_id: e.target.value }))}>
              <option value="">Setor…</option>
              <option value="none">Sem setor</option>
              {config.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {isAdmin && (
            <details style={{ flexBasis: '100%' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: '#166534' }}>Mais ações em lote</summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                <select aria-label="Etapa em lote" className="clients-filter-select" value={bulkExtra.stage} onChange={(e) => setBulkExtra((b) => ({ ...b, stage: e.target.value }))}>
                  <option value="">Manter etapa</option>
                  {config.stages.map((item) => <option key={item.id} value={item.code}>{item.label}</option>)}
                </select>
                <select aria-label="Status em lote" className="clients-filter-select" value={bulkExtra.status} onChange={(e) => setBulkExtra((b) => ({ ...b, status: e.target.value }))}>
                  <option value="">Manter status</option>
                  {config.statuses.map((item) => <option key={item.id} value={item.code}>{item.label}</option>)}
                </select>
                <input aria-label="Prazo em lote" type="date" value={bulkExtra.due_date} onChange={(e) => setBulkExtra((b) => ({ ...b, due_date: e.target.value }))} />
                <input aria-label="Nota em lote" placeholder="Observação comum…" value={bulkExtra.note} onChange={(e) => setBulkExtra((b) => ({ ...b, note: e.target.value }))} />
                <input aria-label="Pendência em lote" placeholder="Título da pendência…" value={bulkExtra.task_title} onChange={(e) => setBulkExtra((b) => ({ ...b, task_title: e.target.value }))} />
                {bulkExtra.task_title && (
                  <select aria-label="Prioridade da pendência em lote" value={bulkExtra.task_priority} onChange={(e) => setBulkExtra((b) => ({ ...b, task_priority: e.target.value }))}>
                    <option value="baixa">Baixa</option><option value="normal">Normal</option>
                    <option value="alta">Alta</option><option value="critica">Crítica</option>
                  </select>
                )}
              </div>
            </details>
          )}
          <button className="btn-primary" disabled={bulkBusy} onClick={applyBulk}>{bulkBusy ? 'Aplicando...' : 'Aplicar'}</button>
          <button className="btn-secondary" onClick={() => setSelected(new Set())}>Limpar seleção</button>
        </div>
      )}

      {/* Tabela (vira cards no mobile via .sisv-proc-table) */}
      <div className="clients-table-wrap">
        <table className="data-table sisv-proc-table">
          <thead>
            <tr>
              <th style={{ width: 34 }}><input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAll} aria-label="Selecionar todos" /></th>
              <th onClick={() => toggleSort('client_name')} style={{ cursor: 'pointer' }}>Cliente{sortArrow('client_name')}</th>
              <th>Número / Protocolo</th><th>Serviço</th>
              <th onClick={() => toggleSort('stage')} style={{ cursor: 'pointer' }}>Etapa{sortArrow('stage')}</th>
              <th onClick={() => toggleSort('status')} style={{ cursor: 'pointer' }}>Status{sortArrow('status')}</th>
              <th>Responsável</th><th>Setor</th>
              <th onClick={() => toggleSort('due_date')} style={{ cursor: 'pointer' }}>Prazo{sortArrow('due_date')}</th>
              <th onClick={() => toggleSort('last_moved_at')} style={{ cursor: 'pointer' }}>Últ. movimentação{sortArrow('last_moved_at')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="10"><SkeletonRows rows={6} /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan="10"><EmptyState title="Nenhum processo encontrado" description="Ajuste os filtros ou cadastre um novo processo." /></td></tr>
            ) : rows.map((p) => {
              const stale = !p.finalized_at && (p.aging_days ?? daysSince(p.last_moved_at || p.updated_at)) >= 7;
              return (
                <tr key={p.id} className="clickable-row" onClick={() => openDetail(p.id)}>
                  <td className="proc-select" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} aria-label={`Selecionar ${p.fine_number || p.client_name}`} />
                  </td>
                  <td className="proc-cliente"><strong style={{ color: '#0f172a' }}>{p.client_name || '—'}</strong>
                    {p.client_cpf && <div style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>{p.client_cpf}</div>}
                  </td>
                  <td data-label="Número">
                    <div style={{ fontWeight: 600 }}>{p.fine_number || '—'}</div>
                    {p.protocol_number && <div style={{ fontSize: 12, color: '#94a3b8' }}>Prot. {p.protocol_number}</div>}
                  </td>
                  <td data-label="Serviço" style={{ color: '#475569' }}>{p.service_type_label || '—'}</td>
                  <td data-label="Etapa"><Badge label={byCode(config.stages, p.stage)?.label || p.stage} color={byCode(config.stages, p.stage)?.color} /></td>
                  <td data-label="Status"><Badge label={byCode(config.statuses, p.status)?.label || p.status} color={byCode(config.statuses, p.status)?.color} /></td>
                  <td data-label="Responsável" style={{ color: p.seller_name ? '#475569' : '#f59e0b', fontWeight: p.seller_name ? 400 : 600 }}>{p.seller_name || 'Sem responsável'}</td>
                  <td data-label="Setor" style={{ color: '#475569' }}>{p.department_name || '—'}</td>
                  <td data-label="Prazo" style={{ whiteSpace: 'nowrap' }}>
                    {(() => { const pr = prazoInfo(p.due_date, p.finalized_at); return (
                      <span style={{ color: pr.color, fontWeight: pr.weight }}>
                        {pr.text}{pr.tag && <span style={{ fontSize: 11, marginLeft: 4 }}>({pr.tag})</span>}
                      </span>
                    ); })()}
                  </td>
                  <td data-label="Movimentação" style={{ whiteSpace: 'nowrap', color: stale ? '#ef4444' : '#475569', fontWeight: stale ? 600 : 400 }}>
                    {fmtDate(p.last_moved_at || p.updated_at)}{stale && ' ⚠'}
                    {!p.finalized_at && <div style={{ fontSize: 10.5, color: p.aging_days > 10 ? '#dc2626' : '#64748b' }}>{p.aging_days ?? daysSince(p.last_moved_at || p.updated_at)} dia(s) parado</div>}
                    {p.finalized_at && <span style={{ fontSize: 11, color: '#16a34a', marginLeft: 6 }}>Finalizado</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pages={pages} total={total} onPage={setPage} />

      {showCreate && (
        <CreateProcessModal
          config={config} assignees={assignees} currentUserId={user?.id}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {detailId && (
        <ProcessDrawer
          id={detailId} config={config} assignees={assignees} isAdmin={isAdmin}
          onClose={closeDetail}
          onChanged={load}
        />
      )}
    </div>
  );
}

const viewActionStyle = {
  border: 0,
  borderLeft: '1px solid #e2e8f0',
  background: '#fff',
  color: '#64748b',
  minWidth: 26,
  cursor: 'pointer',
};
