'use client';

// =============================================================================
// Relatorios.jsx — relatórios comerciais e operacionais (§37).
//
// A lista de relatórios vem do backend (não é fixa no frontend). Cada relatório
// aceita período, é exibido em tabela, pode ser impresso e exportado em CSV —
// a exportação passa pelo serviço seguro do servidor (proteção contra CSV
// injection) e exige a permissão de exportação.
// =============================================================================

import { useEffect, useState } from 'react';
import { listReports, getReport, exportReport } from '../../lib/commercialAPI';
import { DataTable, Notice, SectionHeader, money, label } from './shared';

const isMoneyColumn = (key) => /valor|total|custo|margem|base|previsto|recebido|pendente|pago|ticket/i.test(key);
const isDateColumn = (key) => /data|_em|vencimento|criado|emitida|momento/i.test(key);

export default function Relatorios() {
  const [reports, setReports] = useState([]);
  const [type, setType] = useState('');
  const [period, setPeriod] = useState({ date_from: '', date_to: '' });
  const [state, setState] = useState({ rows: [], loading: false, error: '', label: '' });

  useEffect(() => {
    listReports().then((rows) => {
      setReports(rows || []);
      if (rows && rows.length) setType(rows[0].key);
    }).catch(() => setReports([]));
  }, []);

  const run = async () => {
    if (!type) return;
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const result = await getReport(type, period);
      setState({ rows: result.rows, loading: false, error: '', label: result.label, period: result.period });
    } catch (error) {
      setState({ rows: [], loading: false, error: error.message, label: '' });
    }
  };

  const columns = state.rows.length
    ? Object.keys(state.rows[0]).map((key) => ({
      key,
      header: label(key),
      align: isMoneyColumn(key) ? 'right' : undefined,
      render: (row) => {
        const value = row[key];
        if (value === null || value === undefined) return '—';
        if (isMoneyColumn(key) && !Number.isNaN(Number(value))) return money(value);
        if (isDateColumn(key) && String(value).length >= 10) {
          return new Date(value).toLocaleDateString('pt-BR');
        }
        if (typeof value === 'boolean') return value ? 'sim' : 'não';
        return String(value);
      },
    }))
    : [];

  return (
    <div className="sisv-page sisv-report-page">
      <SectionHeader
        breadcrumb={['Gestão', 'Relatórios']}
        title="Relatórios"
        subtitle="Comercial, financeiro operacional e execução, por período."
      />

      <div className="sisv-filterbar" role="search" aria-label="Parâmetros do relatório">
        <div className="sisv-filter-field">
          <label htmlFor="rep-type">Relatório</label>
          <select id="rep-type" value={type} onChange={(event) => setType(event.target.value)}>
            {reports.map((report) => (
              <option key={report.key} value={report.key}>{report.label}</option>
            ))}
          </select>
        </div>
        <div className="sisv-filter-field">
          <label htmlFor="rep-from">De</label>
          <input id="rep-from" type="date" value={period.date_from}
            onChange={(event) => setPeriod({ ...period, date_from: event.target.value })} />
        </div>
        <div className="sisv-filter-field">
          <label htmlFor="rep-to">Até</label>
          <input id="rep-to" type="date" value={period.date_to}
            onChange={(event) => setPeriod({ ...period, date_to: event.target.value })} />
        </div>
        <button type="button" className="btn-primary" onClick={run} disabled={!type}>
          Gerar relatório
        </button>
        {state.rows.length > 0 && (
          <>
            <button type="button" className="btn-secondary" onClick={() => window.print()}>
              Imprimir
            </button>
            <button type="button" className="btn-secondary"
              onClick={() => exportReport(type, period)}>
              Exportar CSV
            </button>
          </>
        )}
      </div>

      {state.error && <Notice tone="error">{state.error}</Notice>}

      {state.label && (
        <div className="sisv-report-header">
          <h3>{state.label}</h3>
          <dl>
            <div><dt>Período</dt>
              <dd>{state.period?.from} a {state.period?.to}</dd></div>
            <div><dt>Registros</dt><dd>{state.rows.length}</dd></div>
          </dl>
        </div>
      )}

      <DataTable
        caption={state.label || 'Relatório'}
        columns={columns} rows={state.rows} loading={state.loading}
        emptyTitle={state.label ? 'Sem registros no período' : 'Selecione um relatório'}
        emptyDescription={state.label
          ? 'Ajuste o período e gere novamente.'
          : 'Escolha o relatório e o período e clique em “Gerar relatório”.'}
      />
    </div>
  );
}
