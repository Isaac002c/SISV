'use client';

import { useEffect, useState } from 'react';
import { EmptyState, SkeletonRows } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { getAudit, getQuality } from '../lib/operationsAPI';

export function AuditoriaSISV() {
  const [rows, setRows] = useState(null);
  const [filters, setFilters] = useState({
    action: '', entity: '', user_id: '', process_id: '',
    client_id: '', department_id: '', date_from: '', date_to: '',
  });
  const [error, setError] = useState('');
  const load = () => getAudit({
    ...filters,
    date_to: filters.date_to ? `${filters.date_to}T23:59:59.999` : '',
  }).then((result) => setRows(result.rows)).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="clients-page">
      <div className="clients-toolbar" aria-label="Filtros da auditoria" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Filtrar ação" placeholder="Ação exata" value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })} />
        <input aria-label="Filtrar entidade" placeholder="Entidade" value={filters.entity} onChange={(event) => setFilters({ ...filters, entity: event.target.value })} />
        <input aria-label="Filtrar usuário" placeholder="ID do usuário" value={filters.user_id} onChange={(event) => setFilters({ ...filters, user_id: event.target.value })} />
        <input aria-label="Filtrar processo" placeholder="ID do processo" value={filters.process_id} onChange={(event) => setFilters({ ...filters, process_id: event.target.value })} />
        <input aria-label="Filtrar cliente" placeholder="ID do cliente" value={filters.client_id} onChange={(event) => setFilters({ ...filters, client_id: event.target.value })} />
        <input aria-label="Filtrar setor" placeholder="ID do setor" value={filters.department_id} onChange={(event) => setFilters({ ...filters, department_id: event.target.value })} />
        <label className="form-group" style={{ margin: 0 }}>De<input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} /></label>
        <label className="form-group" style={{ margin: 0 }}>Até<input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} /></label>
        <button className="btn-primary" onClick={load}>Filtrar</button>
      </div>
      {error && <div className="error-message">{error}</div>}
      {!rows ? <SkeletonRows rows={8} /> : !rows.length ? <EmptyState title="Nenhum evento encontrado" /> : (
        <div className="data-table-container"><table className="data-table">
          <thead><tr><th>Data</th><th>Usuário</th><th>Entidade</th><th>Ação</th><th>Detalhes</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.source}-${row.id}`}>
            <td>{fmtDateTime(row.created_at)}</td><td>{row.user_name || 'Sistema'}</td>
            <td>{row.entity_name || row.entity || '—'}</td><td>{row.action}</td>
            <td style={{ maxWidth: 360, whiteSpace: 'normal' }}>{safeDetails(row.details)}</td>
          </tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

export function QualidadeSISV() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { getQuality().then(setData).catch((err) => setError(err.message)); }, []);
  if (!data && !error) return <SkeletonRows rows={8} />;
  if (!data) return <EmptyState title="Não foi possível verificar os dados" description={error} />;
  return (
    <div className="clients-page">
      <div style={{ padding: 15, border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 10, marginBottom: 16 }}>
        <strong>{data.total} inconsistência(s)</strong>
        <div style={{ fontSize: 12.5, color: '#92400e', marginTop: 4 }}>Nenhum dado é corrigido silenciosamente. Abra o registro para revisar.</div>
      </div>
      {!data.rows.length ? <EmptyState title="Dados consistentes" description="Nenhuma inconsistência identificável foi encontrada." /> : (
        <div className="data-table-container"><table className="data-table">
          <thead><tr><th>Tipo</th><th>Registro</th><th>Problema</th><th>Ação</th></tr></thead>
          <tbody>{data.rows.map((row) => <tr key={`${row.entity_id}-${row.issue}`}>
            <td>{row.entity_type}</td><td>{row.reference || row.entity_id}</td><td>{row.message}</td>
            <td><a href={qualityHref(row)}>Abrir</a></td>
          </tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

function qualityHref(row) {
  if (row.entity_type === 'cliente') return `/dashboard?module=multas&tab=clients&client=${row.entity_id}`;
  if (row.entity_type === 'processo') return `/dashboard?module=multas&tab=processos&process=${row.entity_id}`;
  if (row.related_process_id) return `/dashboard?module=multas&tab=processos&process=${row.related_process_id}`;
  return '/dashboard?module=multas&tab=meu-trabalho';
}

function safeDetails(details) {
  if (!details) return '—';
  const blocked = new Set(['password', 'password_hash', 'token', 'secret', 'content']);
  const source = typeof details === 'object' ? details : {};
  const safe = Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key.toLowerCase())));
  return Object.entries(safe).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ') || '—';
}
