'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, Pagination, SkeletonRows } from '../components/ui';
import { getAudit } from '../lib/operationsAPI';
import { fmtDateTime } from '../lib/format';
import { Notice, SectionHeader, label } from './comercial/shared';

const PAGE = 30;
const ACTION_LABELS = {
  created: 'Criado', criado: 'Criado', updated: 'Editado', atualizado: 'Editado',
  deleted: 'Excluído', excluido: 'Excluído', document_attached: 'Documento anexado',
  document_updated: 'Documento editado', document_deleted: 'Documento excluído',
  document_template_created: 'Template criado', document_template_updated: 'Template editado',
  document_template_deleted: 'Template excluído', contract_created: 'Contrato criado',
  contract_updated: 'Contrato editado', contract_deleted: 'Contrato excluído',
  catalog_item_created: 'Item de catálogo criado', catalog_item_updated: 'Item de catálogo editado',
  catalog_item_deleted: 'Item de catálogo excluído', price_table_created: 'Tabela de preço criada',
  price_table_updated: 'Tabela de preço editada', price_table_deleted: 'Tabela de preço excluída',
  supplier_created: 'Fornecedor criado', supplier_updated: 'Fornecedor editado',
  supplier_deleted: 'Fornecedor excluído', supplier_restored: 'Fornecedor restaurado',
  order_created: 'Pedido criado', order_updated: 'Pedido editado', order_deleted: 'Pedido excluído',
  user_created: 'Usuário criado', user_updated: 'Usuário editado', user_deleted: 'Usuário excluído',
  stage_changed: 'Etapa alterada', status_changed: 'Situação alterada', finalized: 'Finalizado',
  reopened: 'Reaberto', note_added: 'Observação adicionada', document_removed: 'Documento removido',
};

const actionLabel = (action) => ACTION_LABELS[action]
  || label(String(action || 'atividade').replace(/_(created|updated|deleted|cancelled)$/, ''));

function detailText(row) {
  const details = row.details || {};
  if (details.message) return details.message;
  if (details.field && (details.old_value || details.new_value)) {
    return `${label(details.field)}: ${details.old_value || '—'} → ${details.new_value || '—'}`;
  }
  if (details.reason) return `Motivo: ${details.reason}`;
  return '';
}

export default function HistoricoSISV() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError('');
      const result = await getAudit({ limit: 200 });
      setLogs(result.rows || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const entities = useMemo(() => [...new Set(logs.map((row) => row.entity).filter(Boolean))].sort(), [logs]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((row) => {
      if (entity && row.entity !== entity) return false;
      if (!term) return true;
      return `${actionLabel(row.action)} ${row.entity || ''} ${row.entity_name || ''} ${row.user_name || ''} ${detailText(row)}`
        .toLowerCase().includes(term);
    });
  }, [logs, search, entity]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const rows = filtered.slice((page - 1) * PAGE, page * PAGE);

  return (
    <div className="sisv-page sisv-history-page">
      <SectionHeader breadcrumb={['Administração', 'Histórico']} title="Histórico"
        subtitle="Registro consolidado das criações, edições, exclusões e movimentações do sistema." />
      <Notice tone="info">O histórico administrativo é permanente. Excluir um registro operacional não apaga sua trilha de auditoria.</Notice>

      <div className="sisv-history-toolbar" role="search" aria-label="Filtrar histórico">
        <div className="form-group sisv-field">
          <label htmlFor="history-search">Buscar</label>
          <input id="history-search" value={search} placeholder="Ação, registro ou usuário"
            onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        </div>
        <div className="form-group sisv-field">
          <label htmlFor="history-entity">Módulo</label>
          <select id="history-entity" value={entity}
            onChange={(event) => { setEntity(event.target.value); setPage(1); }}>
            <option value="">Todos</option>
            {entities.map((value) => <option key={value} value={value}>{label(value)}</option>)}
          </select>
        </div>
        <button type="button" className="btn-secondary" onClick={load}>Atualizar</button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {loading ? <SkeletonRows rows={8} /> : rows.length === 0 ? (
        <EmptyState title="Nenhuma atividade encontrada" description="Ajuste os filtros ou aguarde novas movimentações." />
      ) : (
        <>
          <div className="sisv-history-list">
            {rows.map((row) => (
              <article key={`${row.source}-${row.id}`} className="sisv-history-item">
                <span className={`sisv-history-mark${/deleted|exclu|cancel|remov/i.test(row.action) ? ' is-danger' : ''}`} />
                <div>
                  <div className="sisv-history-main">
                    <strong>{actionLabel(row.action)}</strong>
                    <time>{fmtDateTime(row.created_at)}</time>
                  </div>
                  <p>{label(row.entity)}{row.entity_name ? ` · ${row.entity_name}` : ''}</p>
                  {detailText(row) && <small>{detailText(row)}</small>}
                  <small>por {row.user_name || 'Sistema'}</small>
                </div>
              </article>
            ))}
          </div>
          <Pagination page={page} pages={pages} total={filtered.length} onPage={setPage} />
        </>
      )}
    </div>
  );
}
