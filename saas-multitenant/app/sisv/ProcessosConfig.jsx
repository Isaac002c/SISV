'use client';

// =============================================================================
// Configurações do sistema (SISV) — catálogos por tenant: etapas, status, tipos
// de serviço e setores. Somente ADMIN/GESTOR. Tudo persiste no banco isolado por
// tenant (/api/config). Reutiliza um editor genérico de catálogo.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { PageHead, EmptyState, SkeletonRows } from '../components/ui';
import { departments, stages, statuses, serviceTypes, documentCategories, getChecklist, setChecklist } from '../lib/tenantConfigAPI';
import { getOperationSettings, updateOperationSettings } from '../lib/operationsAPI';

const COLORS = ['#A56FFF', '#FF6A3D', '#FFD8A6', '#3B1F6A', '#0ea5e9', '#16a34a', '#ef4444', '#64748b'];

export default function ProcessosConfig() {
  const [tab, setTab] = useState('stages');
  const tabs = [
    ['stages', 'Etapas', stages, { flag: 'is_final', flagLabel: 'Encerra o processo' }],
    ['statuses', 'Status', statuses, { flag: 'is_pending', flagLabel: 'Conta como pendência' }],
    ['services', 'Tipos de serviço', serviceTypes, {}],
    ['departments', 'Setores', departments, { nameOnly: true }],
    ['doccats', 'Categorias de documento', documentCategories, { nameOnly: true }],
    ['checklist', 'Checklist por serviço', null, {}],
    ['operations', 'Regras operacionais', null, {}],
  ];
  const current = tabs.find((t) => t[0] === tab);

  return (
    <div className="clients-page">
      <PageHead title="Configurações do sistema" subtitle="Defina etapas, status, tipos de serviço, setores e documentos da operação" />
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e2e8f0', marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '9px 14px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600, color: tab === k ? 'var(--primary)' : 'var(--text-muted)',
            borderBottom: `2px solid ${tab === k ? 'var(--primary)' : 'transparent'}`, marginBottom: -1,
          }}>{l}</button>
        ))}
      </div>
      {tab === 'checklist' ? <ChecklistConfig />
        : tab === 'operations' ? <OperationSettings />
          : tab === 'services' ? <><CatalogEditor key={tab} api={current[2]} options={current[3]} labelSingular={current[1]} /><ServiceTemplateEditor /></>
            : <CatalogEditor key={tab} api={current[2]} options={current[3]} labelSingular={current[1]} />}
    </div>
  );
}

// Checklist documental: para cada tipo de serviço, escolhe categorias
// recomendadas/obrigatórias. Orienta a equipe na tela do processo.
function ChecklistConfig() {
  const [services, setServices] = useState([]);
  const [cats, setCats] = useState([]);
  const [svcId, setSvcId] = useState('');
  const [rows, setRows] = useState([]); // [{category_id, required, included}]
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([serviceTypes.list(), documentCategories.list()])
      .then(([s, c]) => { setServices(s || []); setCats(c || []); if (s?.[0]) setSvcId(s[0].id); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!svcId || cats.length === 0) return;
    setMsg(null);
    getChecklist(svcId).then((cfg) => {
      const map = new Map((cfg || []).map((x) => [x.category_id, x.required]));
      setRows(cats.map((c) => ({ category_id: c.id, name: c.name, included: map.has(c.id), required: !!map.get(c.id) })));
    }).catch((e) => setErr(e.message));
  }, [svcId, cats]);

  const toggle = (id, field) => setRows((rs) => rs.map((r) => {
    if (r.category_id !== id) return r;
    if (field === 'included') return { ...r, included: !r.included, required: !r.included ? r.required : false };
    return { ...r, required: !r.required, included: true };
  }));

  const save = async () => {
    setSaving(true); setErr(null); setMsg(null);
    try {
      await setChecklist(svcId, rows.filter((r) => r.included).map((r) => ({ category_id: r.category_id, required: r.required })));
      setMsg('Checklist salvo.');
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <SkeletonRows rows={4} />;
  if (services.length === 0) return <EmptyState small title="Sem tipos de serviço" description="Cadastre tipos de serviço primeiro." />;
  if (cats.length === 0) return <EmptyState small title="Sem categorias" description="Cadastre categorias de documento primeiro." />;

  return (
    <div style={{ maxWidth: 640 }}>
      {err && <div className="error-message" style={{ marginBottom: 12, fontSize: 13 }}>{err}</div>}
      <div className="form-group" style={{ maxWidth: 340 }}>
        <label>Tipo de serviço</label>
        <select value={svcId} onChange={(e) => setSvcId(e.target.value)}>
          {services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.category_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={r.included} onChange={() => toggle(r.category_id, 'included')} />
              {r.name}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: r.included ? '#475569' : '#cbd5e1', whiteSpace: 'nowrap' }}>
              <input type="checkbox" disabled={!r.included} checked={r.required} onChange={() => toggle(r.category_id, 'required')} />
              obrigatório
            </label>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Salvando...' : 'Salvar checklist'}</button>
        {msg && <span style={{ color: '#16a34a', fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

function ServiceTemplateEditor() {
  const [servicesList, setServicesList] = useState([]);
  const [catalogs, setCatalogs] = useState({ stages: [], statuses: [], departments: [] });
  const [id, setId] = useState('');
  const [form, setForm] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [items, stageList, statusList, departmentList] = await Promise.all([
      serviceTypes.list(true), stages.list(), statuses.list(), departments.list(),
    ]);
    setServicesList(items || []);
    setCatalogs({ stages: stageList || [], statuses: statusList || [], departments: departmentList || [] });
    const selected = items.find((item) => item.id === id) || items[0];
    if (selected) { setId(selected.id); setForm(toTemplateForm(selected)); }
  }, [id]);
  useEffect(() => { load().catch((err) => setError(err.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const select = (nextId) => {
    setId(nextId);
    setForm(toTemplateForm(servicesList.find((item) => item.id === nextId) || {}));
  };
  const save = async () => {
    try {
      setError(''); setMessage('');
      const suggested_tasks = form.tasks_text.split('\n').map((line) => line.trim()).filter(Boolean).map((title) => ({ title, priority: 'normal', due_days: null }));
      const custom_fields = form.fields_text.split('\n').map((line, index) => {
        const [name, type = 'texto_curto', required = '', options = ''] = line.split('|').map((part) => part.trim());
        return { name, key: slugKey(name), type, required: /^(sim|true|1)$/i.test(required), options: options ? options.split(',').map((item) => item.trim()).filter(Boolean) : [], order: index, active: true };
      }).filter((field) => field.name);
      await serviceTypes.update(id, {
        description: form.description || null,
        initial_stage: form.initial_stage || null,
        initial_status: form.initial_status || null,
        default_due_days: form.default_due_days === '' ? null : Number(form.default_due_days),
        initial_department_id: form.initial_department_id || null,
        suggested_tasks,
        custom_fields,
      });
      setMessage('Template operacional salvo.');
      await load();
    } catch (err) { setError(err.message); }
  };
  if (!servicesList.length) return null;
  return (
    <section style={{ maxWidth: 720, marginTop: 28, borderTop: '1px solid #e2e8f0', paddingTop: 20 }}>
      <h3 style={{ fontSize: 16 }}>Modelo operacional do serviço</h3>
      <p style={{ fontSize: 12.5, color: '#64748b' }}>Os valores são sugestões ajustáveis no cadastro do processo.</p>
      {error && <div className="error-message">{error}</div>}
      <div className="form-group"><label>Tipo de serviço</label><select value={id} onChange={(event) => select(event.target.value)}>{servicesList.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
      <div className="form-group"><label>Descrição</label><textarea rows={2} value={form.description || ''} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
      <div className="form-row">
        <div className="form-group"><label>Etapa inicial</label><select value={form.initial_stage || ''} onChange={(event) => setForm({ ...form, initial_stage: event.target.value })}><option value="">Sem sugestão</option>{catalogs.stages.map((item) => <option key={item.id} value={item.code}>{item.label}</option>)}</select></div>
        <div className="form-group"><label>Status inicial</label><select value={form.initial_status || ''} onChange={(event) => setForm({ ...form, initial_status: event.target.value })}><option value="">Sem sugestão</option>{catalogs.statuses.map((item) => <option key={item.id} value={item.code}>{item.label}</option>)}</select></div>
      </div>
      <div className="form-row">
        <div className="form-group"><label>Prazo padrão (dias)</label><input type="number" min="0" max="3650" value={form.default_due_days ?? ''} onChange={(event) => setForm({ ...form, default_due_days: event.target.value })} /></div>
        <div className="form-group"><label>Setor inicial</label><select value={form.initial_department_id || ''} onChange={(event) => setForm({ ...form, initial_department_id: event.target.value })}><option value="">Sem sugestão</option>{catalogs.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      </div>
      <div className="form-group"><label>Pendências sugeridas (uma por linha)</label><textarea rows={4} value={form.tasks_text || ''} onChange={(event) => setForm({ ...form, tasks_text: event.target.value })} /></div>
      <div className="form-group"><label>Campos complementares</label><textarea rows={4} value={form.fields_text || ''} onChange={(event) => setForm({ ...form, fields_text: event.target.value })} placeholder="Nome | texto_curto | sim&#10;Categoria | selecao | não | A,B,C" /><small>Tipos: texto_curto, texto_longo, numero, data, selecao, booleano.</small></div>
      <button className="btn-primary" onClick={save}>Salvar template</button>
      {message && <span style={{ marginLeft: 10, color: 'var(--success)', fontSize: 13 }}>{message}</span>}
    </section>
  );
}

const toTemplateForm = (item) => ({
  description: item.description || '',
  initial_stage: item.initial_stage || '',
  initial_status: item.initial_status || '',
  default_due_days: item.default_due_days ?? '',
  initial_department_id: item.initial_department_id || '',
  tasks_text: (item.suggested_tasks || []).map((task) => task.title).join('\n'),
  fields_text: (item.custom_fields || []).map((field) => `${field.name} | ${field.type} | ${field.required ? 'sim' : 'não'} | ${(field.options || []).join(',')}`).join('\n'),
});
const slugKey = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function OperationSettings() {
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { getOperationSettings().then(setForm).catch((err) => setError(err.message)); }, []);
  if (!form) return error ? <div className="error-message">{error}</div> : <SkeletonRows rows={4} />;
  const save = async () => {
    try {
      const data = await updateOperationSettings({
        stale_after_days: Number(form.stale_after_days),
        due_soon_days: Number(form.due_soon_days),
        aging_bands: String(form.aging_bands).split(',').map(Number),
        department_required: Boolean(form.department_required),
      });
      setForm({ ...data, aging_bands: data.aging_bands.join(',') });
      setMessage('Regras salvas.');
    } catch (err) { setError(err.message); }
  };
  return (
    <div style={{ maxWidth: 560 }}>
      {error && <div className="error-message">{error}</div>}
      <div className="form-group"><label>Considerar sem movimentação após (dias)</label><input type="number" min="1" max="365" value={form.stale_after_days} onChange={(event) => setForm({ ...form, stale_after_days: event.target.value })} /></div>
      <div className="form-group"><label>Janela de prazo próximo (dias)</label><input type="number" min="1" max="90" value={form.due_soon_days} onChange={(event) => setForm({ ...form, due_soon_days: event.target.value })} /></div>
      <div className="form-group"><label>Limites das faixas de aging</label><input value={Array.isArray(form.aging_bands) ? form.aging_bands.join(',') : form.aging_bands} onChange={(event) => setForm({ ...form, aging_bands: event.target.value })} placeholder="2,5,10" /></div>
      <label style={{ display: 'flex', gap: 8, margin: '12px 0' }}><input type="checkbox" checked={Boolean(form.department_required)} onChange={(event) => setForm({ ...form, department_required: event.target.checked })} />Setor obrigatório para a operação</label>
      <button className="btn-primary" onClick={save}>Salvar regras</button>{message && <span style={{ marginLeft: 10, color: 'var(--success)' }}>{message}</span>}
    </div>
  );
}

function CatalogEditor({ api, options = {}, labelSingular }) {
  const { flag, flagLabel, nameOnly } = options;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState({ label: '', color: COLORS[0], flag: false });

  const load = useCallback(async () => {
    try { setLoading(true); setErr(null); setItems(await api.list(true)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!draft.label.trim()) return;
    try {
      const body = nameOnly
        ? { name: draft.label.trim(), color: draft.color, sort_order: items.length + 1 }
        : { label: draft.label.trim(), color: draft.color, sort_order: items.length + 1, ...(flag ? { [flag]: draft.flag } : {}) };
      await api.create(body);
      setDraft({ label: '', color: COLORS[0], flag: false });
      load();
    } catch (e) { setErr(e.message); }
  };

  const save = async (item, patch) => {
    try { await api.update(item.id, patch); load(); }
    catch (e) { setErr(e.message); }
  };
  const remove = async (item) => {
    if (!confirm(`Remover "${item.label || item.name}"? Processos que usam este item mantêm o valor atual.`)) return;
    try { await api.remove(item.id); load(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      {err && <div className="error-message" style={{ marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* Novo item */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 16 }}>
        <input placeholder={`Novo(a) ${labelSingular.toLowerCase()}...`} value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} style={{ flex: 1, minWidth: 180 }} />
        <ColorPicker value={draft.color} onChange={(c) => setDraft((d) => ({ ...d, color: c }))} />
        {flag && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#475569', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={draft.flag} onChange={(e) => setDraft((d) => ({ ...d, flag: e.target.checked }))} />{flagLabel}
          </label>
        )}
        <button className="btn-primary" onClick={add} disabled={!draft.label.trim()}>Adicionar</button>
      </div>

      {loading ? <SkeletonRows rows={4} /> : items.length === 0 ? (
        <EmptyState small title={`Nenhum item`} description={`Adicione o primeiro ${labelSingular.toLowerCase()}.`} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it) => (
            <CatalogRow key={it.id} item={it} flag={flag} flagLabel={flagLabel} nameOnly={nameOnly}
              onSave={save} onRemove={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogRow({ item, flag, flagLabel, nameOnly, onSave, onRemove }) {
  const [label, setLabel] = useState(item.label || item.name || '');
  const dirty = label !== (item.label || item.name || '');
  const saveLabel = () => { if (dirty && label.trim()) onSave(item, nameOnly ? { name: label.trim() } : { label: label.trim() }); };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      border: '1px solid #e2e8f0', borderRadius: 8, background: item.active ? '#fff' : '#f8fafc', opacity: item.active ? 1 : 0.7,
    }}>
      <ColorPicker value={item.color || '#64748b'} onChange={(c) => onSave(item, { color: c })} compact />
      <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={saveLabel}
        style={{ flex: 1, border: '1px solid transparent', background: 'transparent', fontWeight: 600, fontSize: 14 }}
        onFocus={(e) => (e.target.style.border = '1px solid #cbd5e1')} />
      <code style={{ fontSize: 11, color: '#94a3b8' }}>{item.code || ''}</code>
      {flag && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }} title={flagLabel}>
          <input type="checkbox" checked={!!item[flag]} onChange={(e) => onSave(item, { [flag]: e.target.checked })} />{flagLabel}
        </label>
      )}
      <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onSave(item, { active: !item.active })}>
        {item.active ? 'Ativo' : 'Inativo'}
      </button>
      <button className="btn-icon danger" title="Remover" onClick={() => onRemove(item)}>✕</button>
    </div>
  );
}

function ColorPicker({ value, onChange, compact }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} title="Cor"
        style={{ width: compact ? 22 : 28, height: compact ? 22 : 28, borderRadius: 6, background: value, border: '2px solid #fff', boxShadow: '0 0 0 1px #cbd5e1', cursor: 'pointer' }} />
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 20, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: 8, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
          {COLORS.map((c) => (
            <button key={c} type="button" onClick={() => { onChange(c); setOpen(false); }}
              style={{ width: 22, height: 22, borderRadius: 5, background: c, border: value === c ? '2px solid #0f172a' : '2px solid #fff', boxShadow: '0 0 0 1px #cbd5e1', cursor: 'pointer' }} />
          ))}
        </div>
      )}
    </div>
  );
}
