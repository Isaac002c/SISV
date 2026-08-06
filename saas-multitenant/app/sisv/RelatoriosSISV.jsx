'use client';

import { useState } from 'react';
import { EmptyState, SkeletonRows } from '../components/ui';
import { getReport, exportReport } from '../lib/operationsAPI';

const reports = [
  ['processos-periodo', 'Processos por período'],
  ['processos-etapa', 'Processos por etapa'],
  ['processos-status', 'Processos por status'],
  ['processos-responsavel', 'Processos por responsável'],
  ['processos-setor', 'Processos por setor'],
  ['processos-servico', 'Processos por tipo de serviço'],
  ['prazos-vencidos', 'Prazos vencidos'],
  ['documentos-pendentes', 'Documentos pendentes'],
  ['pendencias', 'Pendências'],
  ['produtividade', 'Produtividade por usuário'],
  ['tempo-conclusao', 'Tempo médio de conclusão'],
];

export default function RelatoriosSISV() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [type, setType] = useState('processos-periodo');
  const [filters, setFilters] = useState({ date_from: monthAgo, date_to: today });
  const [result, setResult] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    try {
      setLoading(true);
      setError('');
      setResult(await getReport(type, filters));
      setGeneratedAt(new Date());
    }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };
  const columns = result?.rows?.[0] ? Object.keys(result.rows[0]) : [];
  const reportLabel = reports.find(([value]) => value === type)?.[1] || 'Relatório operacional';
  return (
    <div className="clients-page sisv-report">
      <header className="sisv-report-header">
        <div>
          <span className="sisv-report-product">SISV</span>
          <strong>{reportLabel}</strong>
          <small>Sinal Verde</small>
        </div>
        <dl>
          <div><dt>Período</dt><dd>{formatDate(filters.date_from)} a {formatDate(filters.date_to)}</dd></div>
          {generatedAt && <div><dt>Gerado em</dt><dd>{generatedAt.toLocaleString('pt-BR')}</dd></div>}
        </dl>
      </header>
      <div className="clients-toolbar" style={{ flexWrap: 'wrap', gap: 9 }}>
        <label className="form-group" style={{ margin: 0, minWidth: 250 }}>Relatório
          <select value={type} onChange={(event) => { setType(event.target.value); setResult(null); }}>
            {reports.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="form-group" style={{ margin: 0 }}>De
          <input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} />
        </label>
        <label className="form-group" style={{ margin: 0 }}>Até
          <input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} />
        </label>
        <button className="btn-primary" onClick={run}>Gerar relatório</button>
        <button className="btn-secondary" disabled={!result?.rows?.length} onClick={() => exportReport(type, filters).catch((err) => setError(err.message))}>Exportar CSV</button>
        <button className="btn-secondary" disabled={!result?.rows?.length} onClick={() => window.print()}>Imprimir</button>
      </div>
      {error && <div className="error-message" role="alert">{error}</div>}
      {loading ? <SkeletonRows rows={8} /> : !result ? <EmptyState title="Selecione e gere um relatório" /> : !result.rows.length ? <EmptyState title="Nenhum dado no período" /> : (
        <div className="data-table-container" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>{columns.map((column) => <th key={column}>{column.replaceAll('_', ' ')}</th>)}</tr></thead>
            <tbody>{result.rows.map((row, index) => (
              <tr key={row.id || index}>{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <footer className="sisv-report-footer">Gerado pelo SISV · Uma solução TELUN</footer>
    </div>
  );
}

const formatDate = (value) => {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
};

const formatCell = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(value))) return new Date(value).toLocaleString('pt-BR');
  return String(value);
};
