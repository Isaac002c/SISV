'use client';

// =============================================================================
// shared.jsx — peças reutilizadas por todas as telas do SISV 2.0.
//
// §44 pede padronização: em vez de cada módulo reimplementar toolbar, tabela,
// paginação, estados vazios e formulários, tudo aqui é montado sobre os
// componentes já existentes (components/ui.jsx) e as classes do design system.
// Nenhum CSS isolado por módulo.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, ErrorState, Pagination, SkeletonRows } from '../../components/ui';
import { Badge } from '../ui';

// ── Formatação ───────────────────────────────────────────────────────────────

export const money = (value) =>
  Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Rótulo legível a partir de um código de situação (`aguardando_pagamento`). */
export const label = (value) =>
  String(value || '—').replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase());

// Cores SEMÂNTICAS por situação (§47): lilás só para ação principal/seleção,
// nunca para todos os status. Verde = concluído, âmbar = espera, vermelho =
// recusa/cancelamento, azul = informação, cobre = destaque operacional.
const STATUS_COLORS = {
  // neutros / rascunho
  rascunho: 'var(--text-muted)', previsto: 'var(--text-muted)', prevista: 'var(--text-muted)',
  pendente: 'var(--text-muted)', informado: 'var(--text-muted)', nao_aplicavel: 'var(--text-muted)',
  // espera / atenção
  aguardando_documentos: 'var(--warning)', aguardando_pagamento: 'var(--warning)',
  pagamento_parcial: 'var(--warning)', parcial: 'var(--warning)', em_validacao: 'var(--warning)',
  enviado_validacao: 'var(--warning)', aguardando_execucao: 'var(--warning)',
  aguardando_terceiro: 'var(--warning)', pausada: 'var(--warning)', solicitada: 'var(--warning)',
  agendado: 'var(--warning)', em_analise: 'var(--warning)',
  // informação / em andamento
  em_execucao: 'var(--information)', liberada: 'var(--information)', enviado: 'var(--information)',
  gerado: 'var(--information)', anexado: 'var(--information)', publicado: 'var(--information)',
  // sucesso
  aprovado: 'var(--success)', aprovada: 'var(--success)', confirmada: 'var(--success)',
  recebido: 'var(--success)', concluida: 'var(--success)', pago: 'var(--success)',
  paga: 'var(--success)', emitida: 'var(--success)', assinado: 'var(--success)',
  ativa: 'var(--success)', convertido: 'var(--success)',
  // perigo
  cancelado: 'var(--danger)', cancelada: 'var(--danger)', rejeitado: 'var(--danger)',
  recusado: 'var(--danger)', vencido: 'var(--danger)', estornado: 'var(--danger)',
  estornada: 'var(--danger)',
  // destaque operacional (cobre)
  arquivada: 'var(--accent)', substituido: 'var(--accent)', substituida: 'var(--accent)',
  reaberta: 'var(--accent)', devolvido: 'var(--accent)', inativa: 'var(--accent)',
};

export const statusColor = (value) => STATUS_COLORS[String(value)] || 'var(--text-secondary)';

/** Badge de situação: cor + TEXTO, para não depender só de cor (§49). */
export function StatusBadge({ value }) {
  if (!value) return <span aria-hidden="true">—</span>;
  return <Badge label={label(value)} color={statusColor(value)} />;
}

// ── Toolbar de filtros ───────────────────────────────────────────────────────

/**
 * Painel de filtros com labels acessíveis. Os campos são declarativos para que
 * toda tela filtre do mesmo jeito e o botão "Limpar" funcione sem código extra.
 */
export function FilterBar({ fields, values, onChange, onClear, children, ariaLabel = 'Filtros' }) {
  const hasFilters = Object.entries(values).some(([, value]) => value !== '' && value != null);
  return (
    <div className="sisv-filterbar" role="search" aria-label={ariaLabel}>
      {fields.map((field) => {
        const id = `filtro-${field.key}`;
        if (field.type === 'select') {
          return (
            <div className="sisv-filter-field" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              <select id={id} value={values[field.key] ?? ''}
                onChange={(event) => onChange(field.key, event.target.value)}>
                <option value="">{field.empty || 'Todos'}</option>
                {(field.options || []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          );
        }
        return (
          <div className="sisv-filter-field" key={field.key}>
            <label htmlFor={id}>{field.label}</label>
            <input id={id} type={field.type || 'text'} placeholder={field.placeholder || ''}
              value={values[field.key] ?? ''}
              onChange={(event) => onChange(field.key, event.target.value)} />
          </div>
        );
      })}
      {children}
      {hasFilters && (
        <button type="button" className="btn-secondary sisv-filter-clear" onClick={onClear}>
          Limpar filtros
        </button>
      )}
    </div>
  );
}

// ── Tabela ───────────────────────────────────────────────────────────────────

/**
 * Tabela densa do padrão TELUN (§45). Em telas estreitas cada linha vira um
 * card com rótulo por célula (via `data-label`), em vez de exigir rolagem
 * horizontal — a regra vive no CSS (.sisv-table).
 */
export function DataTable({
  columns, rows, loading, error, onRetry, emptyTitle = 'Nenhum registro',
  emptyDescription, onRowClick, rowKey = (row) => row.id, caption,
}) {
  if (loading) return <SkeletonRows rows={6} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!rows.length) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  return (
    <div className="data-table-container sisv-table-wrap">
      <table className="data-table sisv-table">
        {caption && <caption className="sisv-visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col"
                style={column.align ? { textAlign: column.align } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'sisv-row-clickable' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick(row);
                }
              } : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} data-label={column.header}
                  style={column.align ? { textAlign: column.align } : undefined}>
                  {column.render ? column.render(row) : (row[column.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Cabeçalho de seção: breadcrumbs, contexto e ações ────────────────────────

/**
 * O TÍTULO da página vem do PageHeader (fonte única, §44) — repeti-lo aqui
 * criaria dois cabeçalhos idênticos na tela e dois headings com o mesmo texto
 * para o leitor de tela. Este componente acrescenta o que o PageHeader não tem:
 * trilha de navegação, contexto e ações da página.
 *
 * `title` continua sendo aceito e usado como rótulo acessível da região, sem
 * ser desenhado de novo.
 */
export function SectionHeader({ breadcrumb = [], title, subtitle, actions }) {
  return (
    <div className="sisv-section-head" role="region" aria-label={title}>
      {breadcrumb.length > 0 && (
        <nav aria-label="Trilha de navegação" className="sisv-breadcrumb">
          <ol>
            {breadcrumb.map((crumb, index) => (
              <li key={crumb}>
                {index > 0 && <span aria-hidden="true">/</span>}
                <span aria-current={index === breadcrumb.length - 1 ? 'page' : undefined}>{crumb}</span>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="sisv-section-head-row">
        {subtitle ? <p className="sisv-section-context">{subtitle}</p> : <span />}
        {actions && <div className="sisv-section-actions">{actions}</div>}
      </div>
    </div>
  );
}

// ── Abas horizontais ─────────────────────────────────────────────────────────

export function Tabs({ tabs, active, onChange, ariaLabel = 'Seções' }) {
  return (
    <div className="sisv-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          type="button"
          aria-selected={active === tab.key}
          className={active === tab.key ? 'is-active' : ''}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {typeof tab.count === 'number' && <span className="sisv-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Formulário ───────────────────────────────────────────────────────────────

/**
 * Campo de formulário com label VISÍVEL e erro associado por aria-describedby
 * (§46/§49). Aceita text, number, date, select, textarea e checkbox.
 */
export function Field({
  id, label: text, type = 'text', value, onChange, options, required, error,
  hint, placeholder, min, step, rows = 3, autoFocus, disabled,
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean).join(' ') || undefined;
  const common = {
    id, value: value ?? '', onChange: (event) => onChange(event.target.value),
    'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : undefined,
    required, placeholder, autoFocus, disabled,
  };
  return (
    <div className="form-group sisv-field">
      {type === 'checkbox' ? (
        // O label ENVOLVE o input, então não leva `htmlFor`: apontar para o
        // próprio input contido faz o navegador disparar o clique duas vezes e
        // a caixa volta ao estado original. O rótulo continua clicável.
        <label className="sisv-checkbox">
          <input id={id} type="checkbox" checked={Boolean(value)} disabled={disabled}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)} />
          <span>{text}</span>
        </label>
      ) : (
        <>
          {/* O indicador de obrigatório é desenhado por CSS (::after) em vez de
              texto: assim o rótulo continua sendo exatamente o nome do campo
              para leitores de tela e para automação, sem perder o asterisco. */}
          <label htmlFor={id} data-required={required ? 'true' : undefined}>{text}</label>
          {type === 'select' ? (
            <select {...common}>
              {(options || []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : type === 'textarea' ? (
            <textarea {...common} rows={rows} />
          ) : (
            <input {...common} type={type} min={min} step={step} />
          )}
        </>
      )}
      {hint && <div className="sisv-field-hint" id={`${id}-hint`}>{hint}</div>}
      {error && <div className="nx-field-error" id={`${id}-error`} role="alert">{error}</div>}
    </div>
  );
}

export function FormRow({ children, columns = 2 }) {
  return <div className="sisv-form-row" data-columns={columns}>{children}</div>;
}

// ── Mensagens ────────────────────────────────────────────────────────────────

export function Notice({ tone = 'info', children, onClose }) {
  return (
    <div className={`sisv-notice sisv-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onClose && <button type="button" onClick={onClose} aria-label="Fechar aviso">✕</button>}
    </div>
  );
}

// ── Hook de listagem ─────────────────────────────────────────────────────────

/**
 * Centraliza o ciclo carregar/paginar/filtrar de todas as listas comerciais.
 * `guard` evita que uma resposta atrasada sobrescreva uma busca mais recente.
 */
export function useResourceList(fetcher, initialFilters = {}, { pageSize = 20 } = {}) {
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ rows: [], total: 0, loading: true, error: '' });
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const result = await fetcher({ ...filters, page, limit: pageSize });
      if (current !== requestId.current) return;
      setState({ rows: result.rows, total: result.total, loading: false, error: '' });
    } catch (error) {
      if (current !== requestId.current) return;
      setState({ rows: [], total: 0, loading: false, error: error.message });
    }
  }, [fetcher, filters, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const setFilter = useCallback((key, value) => {
    setPage(1);
    setFilters((previous) => ({ ...previous, [key]: value }));
  }, []);
  const clearFilters = useCallback(() => { setPage(1); setFilters(initialFilters); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  const pages = Math.max(1, Math.ceil(state.total / pageSize));
  return {
    ...state, filters, setFilter, clearFilters, page, setPage, pages, reload: load,
    pagination: <Pagination page={page} pages={pages} total={state.total} onPage={setPage} />,
  };
}

/** Carrega os metadados do domínio (situações/transições) uma única vez. */
export function useMeta(fetcher) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    let active = true;
    fetcher().then((data) => { if (active) setMeta(data); }).catch(() => { if (active) setMeta(null); });
    return () => { active = false; };
  }, [fetcher]);
  return meta;
}

/** Converte uma lista de códigos do backend em opções de <select>. */
export const asOptions = (values = [], { includeEmpty } = {}) => [
  ...(includeEmpty ? [{ value: '', label: includeEmpty }] : []),
  ...values.map((value) => ({ value, label: label(value) })),
];

/** Opções de usuários/clientes carregadas sob demanda para os selects. */
export function useOptions(loader) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let active = true;
    loader().then((rows) => { if (active) setItems(rows || []); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [loader]);
  return items;
}

/** Confirmação com justificativa obrigatória, usada em cancelar/rejeitar/reabrir. */
export function useJustifiedAction() {
  const [pending, setPending] = useState(null);
  const ask = useCallback((config) => setPending(config), []);
  const close = useCallback(() => setPending(null), []);
  return { pending, ask, close };
}

/** Deriva as ações permitidas a partir das transições que o backend informou. */
export function allowedTransitions(meta, status) {
  if (!meta || !meta.transitions || !status) return [];
  return meta.transitions[status] || [];
}

export const useStableCallback = (fn, deps) => useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps

export const sumBy = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

export const useMemoOptions = (rows, valueKey, labelKey) => useMemo(
  () => rows.map((row) => ({ value: row[valueKey], label: row[labelKey] })),
  [rows, valueKey, labelKey]
);
