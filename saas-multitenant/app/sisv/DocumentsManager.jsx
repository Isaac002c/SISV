'use client';

// =============================================================================
// DocumentsManager (SISV) — gestão de documentos reutilizável (processo e
// cliente). Upload com categoria + observação, filtro por categoria, busca por
// nome, metadados (quem/quando), download/visualização controlados pelo backend,
// arquivar/restaurar/remover conforme permissão. Layout em cards (mobile-friendly)
// com estados claros. Não cria arquitetura paralela: o pai injeta os handlers.
// =============================================================================

import { useState, useRef, useMemo } from 'react';
import { EmptyState } from '../components/ui';
import { fmtDateTime, fmtSize } from '../lib/format';


function CatBadge({ name, color }) {
  if (!name) return null;
  const c = color || '#64748b';
  return <span style={{ padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: `${c}1a`, color: c }}>{name}</span>;
}

export default function DocumentsManager({
  docs = [], categories = [], canRemove = false, busy = false,
  onUpload, onView, onDownload, onArchive, onRestore, onRemove,
  nameOf = (d) => d.name || d.file_name || 'Documento',
}) {
  const [category_id, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setUploading(true);
    try {
      await onUpload(file, { category_id: category_id || null, notes: notes || null });
      setNotes(''); setCategory('');
    } catch (e2) { setError(e2.message || 'Falha no upload.'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (filterCat && String(d.category_id || '') !== filterCat) return false;
      if (q && !nameOf(d).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [docs, search, filterCat, nameOf]);

  return (
    <div>
      {/* Upload */}
      <div style={{ padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {categories.length > 0 && (
            <select className="clients-filter-select" value={category_id} onChange={(e) => setCategory(e.target.value)} style={{ minWidth: 150 }}>
              <option value="">Categoria (opcional)</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <input ref={fileRef} type="file" onChange={onFile} disabled={uploading} style={{ fontSize: 13, flex: 1, minWidth: 160 }} />
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observação do documento (opcional)" style={{ width: '100%', marginTop: 8, fontSize: 13 }} />
        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>PDF, JPG, PNG ou WEBP · até 10MB</div>
        {uploading && <div style={{ fontSize: 13, color: '#0ea5e9', marginTop: 6 }}>Enviando documento...</div>}
        {error && <div className="error-message" style={{ marginTop: 8, fontSize: 13 }}>{error}</div>}
      </div>

      {/* Filtros da lista */}
      {docs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome..." style={{ flex: 1, minWidth: 140, fontSize: 13 }} />
          {categories.length > 0 && (
            <select className="clients-filter-select" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
              <option value="">Todas as categorias</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Lista em cards (funciona em desktop e mobile) */}
      {filtered.length === 0 ? (
        <EmptyState small title={docs.length === 0 ? 'Sem documentos' : 'Nenhum documento encontrado'}
          description={docs.length === 0 ? 'Anexe o primeiro documento acima.' : 'Ajuste a busca ou o filtro de categoria.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((d) => {
            const removed = d.status === 'removido';
            const archived = d.status === 'arquivado';
            return (
              <div key={d.id} style={{
                border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px',
                background: removed ? '#fef2f2' : archived ? '#f8fafc' : '#fff', opacity: removed ? 0.7 : 1,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13.5, color: '#0f172a', wordBreak: 'break-word' }}>{nameOf(d)}</strong>
                      <CatBadge name={d.category_name} color={d.category_color} />
                      {archived && <span style={{ fontSize: 11, color: '#64748b' }}>· arquivado</span>}
                      {removed && <span style={{ fontSize: 11, color: '#ef4444' }}>· removido</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>
                      {fmtDateTime(d.uploaded_at || d.created_at)}
                      {d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}
                      {d.file_size ? ` · ${fmtSize(d.file_size)}` : ''}
                    </div>
                    {(d.notes || d.description) && <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>{d.notes || d.description}</div>}
                  </div>
                  {/* Ações (área de toque adequada) */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    {!removed && (
                      <>
                        <button className="btn-secondary" style={btnSm} disabled={busy} onClick={() => onView?.(d)} title="Visualizar">Ver</button>
                        <button className="btn-secondary" style={btnSm} disabled={busy} onClick={() => onDownload?.(d)} title="Baixar">Baixar</button>
                        {archived
                          ? <button className="btn-secondary" style={btnSm} disabled={busy} onClick={() => onRestore?.(d)}>Restaurar</button>
                          : <button className="btn-secondary" style={btnSm} disabled={busy} onClick={() => onArchive?.(d)}>Arquivar</button>}
                        {canRemove && <button className="btn-icon danger" disabled={busy} onClick={() => onRemove?.(d)} title="Remover">✕</button>}
                      </>
                    )}
                    {removed && canRemove && <button className="btn-secondary" style={btnSm} disabled={busy} onClick={() => onRestore?.(d)}>Restaurar</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const btnSm = { padding: '4px 10px', fontSize: 12 };
