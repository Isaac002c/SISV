'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  globalSearch, listAlerts, readAlert, readAllAlerts, refreshDeadlineAlerts,
} from '../lib/operationsAPI';
import { fmtDateTime } from '../lib/format';

export default function OperationalHeaderTools({ enabled }) {
  const router = useRouter();
  const timer = useRef(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [alerts, setAlerts] = useState({ rows: [], unread: 0 });
  const [alertsOpen, setAlertsOpen] = useState(false);

  const loadAlerts = async () => {
    try { setAlerts(await listAlerts({ limit: 20 })); } catch { /* cabeçalho não quebra a página */ }
  };
  useEffect(() => {
    if (!enabled) return;
    refreshDeadlineAlerts().catch(() => {}).finally(loadAlerts);
  }, [enabled]);

  const search = (value) => {
    setQuery(value);
    clearTimeout(timer.current);
    if (value.trim().length < 2) { setResults([]); setSearchOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const found = await globalSearch(value.trim());
        setResults(found || []);
        setSearchOpen(true);
      } catch { setResults([]); }
    }, 300);
  };
  const go = (href) => {
    setSearchOpen(false); setAlertsOpen(false);
    router.push(href);
  };
  const openAlert = async (alert) => {
    if (alert.unread) await readAlert(alert.id).catch(() => {});
    if (alert.internal_link) go(alert.internal_link);
    await loadAlerts();
  };
  if (!enabled) return null;
  return (
    <>
      <div className="op-header-search" style={{ position: 'relative' }}>
        <input
          aria-label="Busca global"
          placeholder="Buscar cliente, CPF, processo..."
          value={query}
          onChange={(event) => search(event.target.value)}
          onFocus={() => results.length && setSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearchOpen(false);
            if (event.key === 'Enter' && results[0]) go(results[0].href);
          }}
          style={{ width: 260, height: 34 }}
        />
        {searchOpen && (
          <div aria-label="Resultados da busca" style={popoverStyle}>
            {!results.length ? <div style={emptyStyle}>Nenhum resultado</div> : results.map((item) => (
              <button key={`${item.type}-${item.id}`} onClick={() => go(item.href)} style={itemStyle}>
                <span className="op-result-type">{item.type}</span>
                <strong className="op-result-title">{item.title}</strong>
                <span className="op-result-subtitle">{item.subtitle}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <button
          aria-label={`${alerts.unread} alertas não lidos`}
          aria-expanded={alertsOpen}
          onClick={() => setAlertsOpen((value) => !value)}
          className="op-alert-trigger"
        >
          🔔
          {alerts.unread > 0 && <span className="op-alert-count">{alerts.unread}</span>}
        </button>
        {alertsOpen && (
          <div style={{ ...popoverStyle, width: 360, right: 0, left: 'auto' }}>
            <div className="op-popover-head">
              <strong style={{ fontSize: 13 }}>Alertas internos</strong>
              <button onClick={() => readAllAlerts().then(loadAlerts)}>Marcar todos como lidos</button>
            </div>
            {!alerts.rows.length ? <div style={emptyStyle}>Nenhum alerta</div> : alerts.rows.map((alert) => (
              <button key={alert.id} onClick={() => openAlert(alert)} style={{ ...itemStyle, background: alert.unread ? 'var(--primary-soft)' : 'var(--surface)' }}>
                <strong style={{ fontSize: 12.5 }}>{alert.title}</strong>
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{alert.message}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{fmtDateTime(alert.created_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const popoverStyle = {
  position: 'absolute', zIndex: 1000, top: 40, left: 0, width: 320, maxHeight: 420, overflowY: 'auto',
  border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
};
const itemStyle = {
  width: '100%', border: 0, borderBottom: '1px solid var(--border)', padding: '10px 12px', background: 'var(--surface)',
  display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', cursor: 'pointer',
};
const emptyStyle = { padding: 16, fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center' };
