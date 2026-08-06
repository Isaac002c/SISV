'use strict';
// =============================================================================
// Dados de provisionamento do tenant SISV (Sinal Verde / TELUN).
//
// Fonte única da identidade + catálogos CNH iniciais. Reutilizado pelo seed real
// (seed_sisv.js) e pelo servidor de demonstração. Os catálogos são CONFIGURÁVEIS
// em runtime (telas de configuração) — estes são apenas os valores iniciais,
// coerentes com o fluxo descrito no escopo.
// =============================================================================

const SISV_SLUG = 'sisv';

// Identidade apresentada ao usuário. Sem logo fabricada: identidade por tema
// (brand_color) até os arquivos definitivos da Sinal Verde/TELUN chegarem.
const SISV_IDENTITY = {
  name: 'SISV',
  slug: SISV_SLUG,
  tagline: 'Sistema Integrado da Sinal Verde',
  developer: 'TELUN',
  brand_color: '#A56FFF',        // TELUN — Lilás Elétrico
  brand_color_dark: '#3B1F6A',   // TELUN — Violeta Profundo
  logo_url: null,
  status: 'ativo',
};

// Módulos habilitados para a Sinal Verde (fora daqui = bloqueado por API e UI).
const SISV_MODULES = ['dashboard', 'clientes', 'processos', 'documentos', 'historico', 'usuarios', 'config'];

// Etapas de tramitação (onde o processo está no fluxo). is_final encerra.
const SISV_STAGES = [
  { code: 'ENTRADA',     label: 'Entrada',     color: '#64748b', sort_order: 1, is_final: false },
  { code: 'ELABORACAO',  label: 'Elaboração',  color: '#A56FFF', sort_order: 2, is_final: false },
  { code: 'DEFESA',      label: 'Defesa',      color: '#3B1F6A', sort_order: 3, is_final: false },
  { code: 'JULGAMENTO',  label: 'Julgamento',  color: '#FF6A3D', sort_order: 4, is_final: false },
  { code: 'FINALIZADO',  label: 'Finalizado',  color: '#16a34a', sort_order: 5, is_final: true },
];

// Status operacionais (situação dentro/fora da etapa). is_pending marca pendência.
const SISV_STATUSES = [
  { code: 'PENDENTE',              label: 'Pendente',              color: '#f59e0b', sort_order: 1, is_pending: true },
  { code: 'EM_ANALISE',           label: 'Em análise',            color: '#0ea5e9', sort_order: 2, is_pending: false },
  { code: 'AGUARDANDO_DOCUMENTO', label: 'Aguardando documento',  color: '#ef4444', sort_order: 3, is_pending: true },
  { code: 'PROTOCOLADO',          label: 'Protocolado',           color: '#3B1F6A', sort_order: 4, is_pending: false },
  { code: 'REDISTRIBUIDO',        label: 'Redistribuído',         color: '#14b8a6', sort_order: 5, is_pending: false },
  { code: 'DEFERIDO',             label: 'Deferido',              color: '#16a34a', sort_order: 6, is_pending: false },
  { code: 'INDEFERIDO',           label: 'Indeferido',            color: '#991b1b', sort_order: 7, is_pending: false },
  { code: 'FINALIZADO',           label: 'Finalizado',            color: '#475569', sort_order: 8, is_pending: false },
];

// Tipos de serviço de CNH.
const SISV_SERVICE_TYPES = [
  { code: 'REABILITACAO',       label: 'Reabilitação de CNH (CRCI)', color: '#16a34a', sort_order: 1 },
  { code: 'RENOVACAO',          label: 'Renovação de CNH',           color: '#0ea5e9', sort_order: 2 },
  { code: 'PRIMEIRA_HAB',       label: 'Primeira Habilitação',       color: '#3B1F6A', sort_order: 3 },
  { code: 'ADICAO_CATEGORIA',   label: 'Adição de Categoria',        color: '#A56FFF', sort_order: 4 },
  { code: 'MUDANCA_CATEGORIA',  label: 'Mudança de Categoria',       color: '#FF6A3D', sort_order: 5 },
  { code: 'RECURSO_SUSPENSAO',  label: 'Recurso de Suspensão',       color: '#f59e0b', sort_order: 6 },
  { code: 'RECURSO_CASSACAO',   label: 'Recurso de Cassação',        color: '#ef4444', sort_order: 7 },
  { code: 'DEFESA_AUTUACAO',    label: 'Defesa de Autuação',         color: '#eab308', sort_order: 8 },
  { code: 'SEGUNDA_VIA',        label: 'Segunda Via',                color: '#64748b', sort_order: 9 },
  { code: 'OUTROS',             label: 'Outros',                     color: '#94a3b8', sort_order: 10 },
];

// Setores/departamentos.
const SISV_DEPARTMENTS = [
  { name: 'Atendimento',   color: '#0ea5e9', sort_order: 1 },
  { name: 'Jurídico',      color: '#A56FFF', sort_order: 2 },
  { name: 'Protocolo',     color: '#FF6A3D', sort_order: 3 },
  { name: 'Administrativo', color: '#64748b', sort_order: 4 },
];

// Categorias/tipos de documento (configuráveis pelo tenant).
const SISV_DOCUMENT_CATEGORIES = [
  { name: 'Documento pessoal',      color: '#0ea5e9', sort_order: 1 },
  { name: 'CNH',                    color: '#16a34a', sort_order: 2 },
  { name: 'Procuração',             color: '#A56FFF', sort_order: 3 },
  { name: 'Comprovante',            color: '#14b8a6', sort_order: 4 },
  { name: 'Requerimento',           color: '#3B1F6A', sort_order: 5 },
  { name: 'Defesa',                 color: '#A56FFF', sort_order: 6 },
  { name: 'Recurso',                color: '#f59e0b', sort_order: 7 },
  { name: 'Protocolo',              color: '#eab308', sort_order: 8 },
  { name: 'Decisão',                color: '#ef4444', sort_order: 9 },
  { name: 'Documento complementar', color: '#64748b', sort_order: 10 },
  { name: 'Outros',                 color: '#94a3b8', sort_order: 11 },
];

// Usuários iniciais (até 4 ativos). Senhas NUNCA vêm daqui — o seed gera senha
// aleatória por usuário (ou usa env) e a imprime uma única vez.
const SISV_USERS = [
  { key: 'admin',     name: 'Gestor Sinal Verde',    email: 'gestor@sinalverde.com.br',    role: 'admin' },
  { key: 'operador1', name: 'Operador 1',            email: 'operador1@sinalverde.com.br', role: 'operator' },
  { key: 'operador2', name: 'Operador 2',            email: 'operador2@sinalverde.com.br', role: 'operator' },
  { key: 'operador3', name: 'Operador 3',            email: 'operador3@sinalverde.com.br', role: 'operator' },
];

// Insere os catálogos do tenant de forma idempotente (não duplica por code/name).
async function seedSisvCatalogs(pool, tenantId) {
  for (const s of SISV_STAGES) {
    await pool.query(
      `INSERT INTO process_stages (tenant_id, code, label, color, sort_order, is_final)
       SELECT $1,$2::text,$3,$4,$5::int,$6::boolean
       WHERE NOT EXISTS (SELECT 1 FROM process_stages WHERE tenant_id=$1 AND LOWER(code)=LOWER($2::text))`,
      [tenantId, s.code, s.label, s.color, s.sort_order, s.is_final]
    );
  }
  for (const s of SISV_STATUSES) {
    await pool.query(
      `INSERT INTO process_statuses (tenant_id, code, label, color, sort_order, is_pending)
       SELECT $1,$2::text,$3,$4,$5::int,$6::boolean
       WHERE NOT EXISTS (SELECT 1 FROM process_statuses WHERE tenant_id=$1 AND LOWER(code)=LOWER($2::text))`,
      [tenantId, s.code, s.label, s.color, s.sort_order, s.is_pending]
    );
  }
  for (const s of SISV_SERVICE_TYPES) {
    await pool.query(
      `INSERT INTO tenant_service_types (tenant_id, code, label, color, sort_order)
       SELECT $1,$2::text,$3,$4,$5::int
       WHERE NOT EXISTS (SELECT 1 FROM tenant_service_types WHERE tenant_id=$1 AND LOWER(code)=LOWER($2::text))`,
      [tenantId, s.code, s.label, s.color, s.sort_order]
    );
  }
  for (const d of SISV_DEPARTMENTS) {
    await pool.query(
      `INSERT INTO departments (tenant_id, name, color, sort_order)
       SELECT $1,$2::text,$3,$4::int
       WHERE NOT EXISTS (SELECT 1 FROM departments WHERE tenant_id=$1 AND LOWER(name)=LOWER($2::text))`,
      [tenantId, d.name, d.color, d.sort_order]
    );
  }
  for (const c of SISV_DOCUMENT_CATEGORIES) {
    await pool.query(
      `INSERT INTO document_categories (tenant_id, name, color, sort_order)
       SELECT $1,$2::text,$3,$4::int
       WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE tenant_id=$1 AND LOWER(name)=LOWER($2::text))`,
      [tenantId, c.name, c.color, c.sort_order]
    );
  }
}

module.exports = {
  SISV_SLUG,
  SISV_IDENTITY,
  SISV_MODULES,
  SISV_STAGES,
  SISV_STATUSES,
  SISV_SERVICE_TYPES,
  SISV_DEPARTMENTS,
  SISV_DOCUMENT_CATEGORIES,
  SISV_USERS,
  seedSisvCatalogs,
};
