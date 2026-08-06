'use client';

// =============================================================================
// ui.jsx — Componentes reutilizáveis do design system SISV / TELUN.
// Consomem tokens semânticos centralizados em globals.css. Sem dependências.
// =============================================================================

import { useEffect, useState } from 'react';

// ── MetricCard: valor + comparação com período anterior ─────────────────────
// direction: 'up' = crescer é bom | 'down' = crescer é ruim | 'neutral'
export function MetricCard({ title, value, change, direction = 'up', subtitle, tooltip, onClick }) {
  let deltaClass = 'nx-kpi-delta--neutral';
  let arrow = '→';
  if (change !== null && change !== undefined && change !== 0 && direction !== 'neutral') {
    const growing = change > 0;
    arrow = growing ? '↑' : '↓';
    const good = direction === 'up' ? growing : !growing;
    deltaClass = good ? 'nx-kpi-delta--pos' : 'nx-kpi-delta--neg';
  }
  const clickable = typeof onClick === 'function';
  return (
    <div
      className={`nx-kpi${clickable ? ' nx-kpi--clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={tooltip}
    >
      <div className="nx-kpi-title">{title}</div>
      <div className="nx-kpi-value">{value}</div>
      {change !== undefined && change !== null && (
        <span className={`nx-kpi-delta ${deltaClass}`} aria-label={`Variação de ${change}% vs período anterior`}>
          {arrow} {Math.abs(change)}%
        </span>
      )}
      {change === null && <span className="nx-kpi-delta nx-kpi-delta--neutral">novo</span>}
      {subtitle && <div className="nx-kpi-sub">{subtitle}</div>}
    </div>
  );
}

// ── ChartCard: título + corpo com loading/vazio ──────────────────────────────
export function ChartCard({ title, subtitle, wide = false, loading = false, empty = false, emptyText = 'Sem dados neste período.', children }) {
  return (
    <section className={`nx-chart-card${wide ? ' nx-chart-card--wide' : ''}`} aria-label={title}>
      <h3 className="nx-chart-title">{title}</h3>
      {subtitle && <p className="nx-chart-sub">{subtitle}</p>}
      <div className="nx-chart-body">
        {loading ? <Skeleton height="100%" /> : empty ? (
          <EmptyState small title="Sem dados" description={emptyText} />
        ) : children}
      </div>
    </section>
  );
}

// ── Segmented control (presets de período etc.) ──────────────────────────────
export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div className="nx-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Estados ──────────────────────────────────────────────────────────────────
export function EmptyState({ title = 'Nada por aqui', description, actionLabel, onAction, small = false, icon = null }) {
  return (
    <div className="nx-empty" style={small ? { padding: '20px 12px' } : undefined}>
      {icon || (
        <svg className="nx-empty-origin" width={small ? 28 : 40} height={small ? 28 : 40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 4l7 7M3 20l7-7M21 4l-7 7M21 20l-7-7" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      )}
      <h4>{title}</h4>
      {description && <p>{description}</p>}
      {actionLabel && onAction && (
        <button className="btn-primary" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

export function ErrorState({ message = 'Não foi possível carregar os dados.', onRetry }) {
  return (
    <div className="nx-error" role="alert">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p>{message}</p>
      {onRetry && <button className="btn-secondary" onClick={onRetry}>Tentar novamente</button>}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 16, style }) {
  return <div className="nx-skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 4, height = 44 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} height={height} />)}
    </div>
  );
}

// ── Drawer (detalhe lateral) ─────────────────────────────────────────────────
export function Drawer({ open, title, subtitle, onClose, footer, children, headerExtra }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="nx-drawer-overlay" onClick={onClose}>
      <aside className="nx-drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="nx-drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="nx-drawer-title">{title}</div>
            {subtitle && <div className="nx-drawer-sub">{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {headerExtra}
            <button className="btn-close" onClick={onClose} aria-label="Fechar painel">✕</button>
          </div>
        </div>
        <div className="nx-drawer-body">{children}</div>
        {footer && <div className="nx-drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}

// ── ConfirmDialog: confirmação com motivo opcionalmente obrigatório ──────────
export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirmar', cancelLabel = 'Voltar',
  danger = false, requireReason = false, reasonLabel = 'Motivo',
  onConfirm, onClose, busy = false,
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!open) return null;
  const canConfirm = !requireReason || reason.trim().length >= 3;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2 style={{ fontSize: 16, fontWeight: 800 }}>{title}</h2>
          <button type="button" onClick={onClose} className="btn-close" aria-label="Fechar">✕</button>
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--nx-ink-2)', marginBottom: 14, lineHeight: 1.5 }}>{message}</p>
        {requireReason && (
          <div className="form-group">
            <label>{reasonLabel} <span className="nx-required">*</span></label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Descreva o motivo (mín. 3 caracteres)" />
            {!canConfirm && reason.length > 0 && <div className="nx-field-error">Informe pelo menos 3 caracteres.</div>}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            style={danger ? { background: 'var(--nx-red)', borderColor: 'var(--nx-red)', color: '#fff' } : undefined}
            disabled={!canConfirm || busy}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? 'Processando...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagination ───────────────────────────────────────────────────────────────
export function Pagination({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) return null;
  return (
    <nav style={{ display: 'flex', justifyContent: 'center', gap: 12, alignItems: 'center', marginTop: 16 }} aria-label="Paginação">
      <button className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Anterior</button>
      <span style={{ color: 'var(--nx-gray)', fontSize: 13 }}>Página {page} de {pages}{total != null ? ` · ${total} registros` : ''}</span>
      <button className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima →</button>
    </nav>
  );
}

// ── FormSection: agrupamento lógico de campos ────────────────────────────────
export function FormSection({ title, children }) {
  return (
    <div className="nx-form-section">
      <div className="nx-form-section-title">{title}</div>
      {children}
    </div>
  );
}

// ── PageHead: título + ações da página ───────────────────────────────────────
export function PageHead({ title, subtitle, actions }) {
  return (
    <div className="nx-page-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="nx-page-actions">{actions}</div>}
    </div>
  );
}
