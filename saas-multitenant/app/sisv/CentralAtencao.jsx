'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EmptyState, SkeletonRows } from '../components/ui';
import { getAttention } from '../lib/operationsAPI';

export default function CentralAtencao() {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { getAttention().then(setData).catch((err) => setError(err.message)); }, []);
  if (!data && !error) return <SkeletonRows rows={7} />;
  if (!data) return <EmptyState title="Central indisponível" description={error} />;
  return (
    <div className="clients-page">
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>Central de Atenção</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Situações reais que exigem ação da equipe.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(215px,1fr))', gap: 12 }}>
        {data.cards.map((card) => (
          <button
            key={card.key}
            onClick={() => router.push(card.href)}
            className={`sisv-attention-card ${attentionTone(card)}`}
          >
            <div className="sisv-attention-value">{card.count}</div>
            <div className="sisv-attention-label">{card.label}</div>
            <div className="sisv-attention-hint">{card.count ? 'Abrir fila filtrada →' : 'Nenhum registro'}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, marginTop: 22 }}>
        <Grouping title="Parados por responsável" rows={data.staleBySeller} />
        <Grouping title="Parados por setor" rows={data.staleByDepartment} />
      </div>
    </div>
  );
}

function Grouping({ title, rows }) {
  return (
    <section className="sisv-attention-group">
      <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>{title}</h3>
      {!rows?.length ? <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sem processos parados.</span> : rows.map((row) => (
        <div key={row.seller_id || row.department_id || row.label}>
          <span>{row.label}</span><strong>{row.count}</strong>
        </div>
      ))}
    </section>
  );
}

function attentionTone(card) {
  if (!card.count) return 'is-neutral';
  if (['process_overdue', 'task_overdue', 'task_critical'].includes(card.key)) return 'is-critical';
  return 'is-attention';
}
