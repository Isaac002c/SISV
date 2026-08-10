'use client';

// =============================================================================
// Detalhe do Cliente (SISV) — concentra dados cadastrais, observações, processos
// vinculados (com situação/responsável) e documentos do cliente. Substitui, para
// o tenant SISV, a tela legada de despachantes (contratos/serviços/financeiro),
// que não faz parte do escopo da Sinal Verde.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Drawer, EmptyState, SkeletonRows } from '../components/ui';
import { listProcesses } from '../lib/processesAPI';
import {
  getDocumentsByClient, createDocument, archiveDocument, restoreDocument, removeDocument,
  viewDocument, downloadDocument,
} from '../lib/documentsAPI';
import { uploadFile } from '../lib/uploadsAPI';
import DocumentsManager from './DocumentsManager';
import { fmtDate } from '../lib/format';
import { getClientFields } from '../lib/clientsAPI';

const CLIENT_CATEGORY_LABELS = {
  standard: 'STANDARD', fidelidade: 'FIDELIDADE', empresarial: 'EMPRESARIAL',
  parceiro: 'PARCEIRO', agencia: 'AGÊNCIA',
};
const CONTACT_LABELS = { whatsapp: 'WHATSAPP', telefone: 'TELEFONE', email: 'E-MAIL', sms: 'SMS' };
const ORIGIN_LABELS = {
  carteira: 'Carteira', indicacao: 'Indicação', balcao: 'Balcão',
  midia_online: 'Mídia on-line', outros: 'Outros',
};


function Badge({ label, color }) {
  const c = color || '#64748b';
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: `${c}1a`, color: c }}>{label || '—'}</span>;
}

export default function ClienteDetalhe({ client, config, onClose, onEdit }) {
  const router = useRouter();
  const [tab, setTab] = useState('dados');
  const [processes, setProcesses] = useState([]);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [docBusy, setDocBusy] = useState(false);
  const [fieldDefinitions, setFieldDefinitions] = useState([]);

  const isAdmin = (() => {
    try { const u = JSON.parse(localStorage.getItem('user') || 'null'); return u?.role === 'admin' || u?.role === 'manager'; }
    catch { return false; }
  })();

  const byCode = (list, code) => (list || []).find((x) => x.code === code);

  const load = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [procRes, docList, definitions] = await Promise.all([
        listProcesses({ client_id: client.id, limit: 100 }),
        getDocumentsByClient(client.id).catch(() => []),
        getClientFields().catch(() => []),
      ]);
      setProcesses(procRes.rows || []);
      setDocs(Array.isArray(docList) ? docList : []);
      setFieldDefinitions(definitions || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [client.id]);
  useEffect(() => { load(); }, [load]);

  const openFila = () => router.push(`/dashboard?module=multas&tab=processos&client=${client.id}`);

  const uploadDoc = async (file, meta) => {
    const up = await uploadFile(file);
    await createDocument({
      client_id: client.id, file_url: up.url, file_name: up.originalName || up.filename,
      file_type: up.mimeType, file_size: up.size, stored_name: up.filename, original_name: up.originalName,
      category: 'cliente', category_id: meta.category_id, description: meta.notes,
    });
    await load();
  };
  const docAction = async (fn) => {
    setDocBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); }
    finally { setDocBusy(false); }
  };

  const openCount = processes.filter((p) => !p.finalized_at).length;
  const tabs = [['dados', 'Dados'], ['processos', `Processos (${processes.length})`], ['docs', `Documentos (${docs.length})`]];

  return (
    <Drawer open title={client.name} subtitle={client.cpf ? `CPF ${client.cpf}` : (client.cnh ? `CNH ${client.cnh}` : '')}
      onClose={onClose}
      headerExtra={<button className="btn-secondary" style={{ padding: '5px 12px', fontSize: 12.5 }} onClick={() => onEdit(client)}>Editar</button>}>

      {error && <div className="error-message" style={{ marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e2e8f0', marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
            color: tab === k ? 'var(--primary)' : 'var(--text-muted)', borderBottom: `2px solid ${tab === k ? 'var(--primary)' : 'transparent'}`, marginBottom: -1,
          }}>{l}</button>
        ))}
      </div>

      {tab === 'dados' && (
        <div>
          <Row label="Código do cliente">{client.client_code || '—'}</Row>
          <Row label="Nome">{client.name}</Row>
          <Row label="Tipo de cliente">{client.client_type?.toUpperCase() || '—'}</Row>
          <Row label="Categoria do cliente">{CLIENT_CATEGORY_LABELS[client.category] || '—'}</Row>
          <Row label="CPF / CNPJ">{client.cpf || '—'}</Row>
          <Row label="RG">{client.rg || '—'}</Row>
          <Row label="CNH">{client.cnh || '—'}</Row>
          <Row label="Categoria da CNH">{client.cnh_category || '—'}</Row>
          <Row label="Data da 1ª habilitação">{fmtDate(client.first_cnh)}</Row>
          <Row label="Data de nascimento">{fmtDate(client.birth_date)}</Row>
          <Row label="Telefone">{client.phone || '—'}</Row>
          <Row label="Nº WhatsApp">{client.whatsapp || '—'}</Row>
          <Row label="E-mail">{client.email || '—'}</Row>
          <Row label="Contato preferencial">{CONTACT_LABELS[client.contact_preference] || '—'}</Row>
          <Row label="Origem do cliente">{ORIGIN_LABELS[client.origin] || '—'}</Row>
          {client.client_type === 'pj' && <Row label="Responsável (PJ)">{client.responsible_name || '—'}</Row>}
          <Row label="Endereço">{client.address || '—'}</Row>
          <Row label="Dados adicionais">{client.additional_info || '—'}</Row>
          <PortalAccessRow label="Acesso DETRAN" access={client.portal_access?.detran} />
          <PortalAccessRow label="Acesso GOV" access={client.portal_access?.gov} />
          <PortalAccessRow label="Outros acessos" access={client.portal_access?.outros} />
          {fieldDefinitions.filter((field) => field.storage_kind === 'custom').map((field) => (
            <Row key={field.id} label={field.label}>
              {String(client.additional_data?.[field.field_key] ?? '—')}
            </Row>
          ))}
          <Row label="Situação dos processos">{processes.length === 0 ? 'Nenhum processo' : `${openCount} em aberto de ${processes.length}`}</Row>
          <Row label="Cadastrado em">{fmtDate(client.created_at)}</Row>
          {client.notes && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b', marginBottom: 5 }}>Observações</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, color: '#334155', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>{client.notes}</div>
            </div>
          )}
        </div>
      )}

      {tab === 'processos' && (
        loading ? <SkeletonRows rows={4} /> : processes.length === 0 ? (
          <EmptyState small title="Sem processos" description="Este cliente ainda não possui processos." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn-secondary" style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: 12.5 }} onClick={openFila}>Ver na fila de processos →</button>
            {processes.map((p) => (
              <div key={p.id} onClick={openFila} style={{ padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13.5, color: '#0f172a' }}>{p.fine_number || 'Processo'}{p.service_type_label ? ` · ${p.service_type_label}` : ''}</strong>
                  {p.finalized_at && <Badge label="Finalizado" color="#16a34a" />}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <Badge label={byCode(config?.stages, p.stage)?.label || p.stage} color={byCode(config?.stages, p.stage)?.color} />
                  <Badge label={byCode(config?.statuses, p.status)?.label || p.status} color={byCode(config?.statuses, p.status)?.color} />
                  <span style={{ fontSize: 12, color: p.seller_name ? '#64748b' : '#f59e0b' }}>{p.seller_name || 'Sem responsável'}</span>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'docs' && (
        loading ? <SkeletonRows rows={3} /> : (
          <DocumentsManager
            docs={docs}
            categories={config?.documentCategories || []}
            canRemove={isAdmin}
            busy={docBusy}
            nameOf={(d) => d.file_name || 'Documento'}
            onUpload={uploadDoc}
            onView={(d) => viewDocument(d.id).catch(() => {})}
            onDownload={(d) => downloadDocument(d.id, d.file_name).catch(() => {})}
            onArchive={(d) => docAction(() => archiveDocument(d.id))}
            onRestore={(d) => docAction(() => restoreDocument(d.id))}
            onRemove={(d) => { if (confirm('Remover este documento? Ele fica arquivado no histórico.')) docAction(() => removeDocument(d.id)); }}
          />
        )
      )}
    </Drawer>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#94a3b8', fontSize: 13 }}>{label}</span>
      <span style={{ color: '#0f172a', fontSize: 13.5, fontWeight: 500, textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function PortalAccessRow({ label, access }) {
  const [showPassword, setShowPassword] = useState(false);
  const hasPassword = Boolean(access?.password || access?.has_password);
  const empty = !access?.login && !access?.label && !hasPassword;
  return (
    <Row label={label}>
      {empty ? '—' : (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
          {access?.label && <span>{access.label} ·</span>}
          {access?.login && <span>{access.login}</span>}
          {access?.password ? (
            <>
              <span>· {showPassword ? access.password : '••••••••'}</span>
              <button type="button" onClick={() => setShowPassword((value) => !value)}
                style={{ border: 0, background: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0, fontSize: 12 }}>
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </>
          ) : hasPassword ? <span>· senha cadastrada</span> : null}
        </span>
      )}
    </Row>
  );
}
