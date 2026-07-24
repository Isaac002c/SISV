'use client';

const pageInfo = {
  // Visão Geral
  home:       { title: 'Visão Geral',        subtitle: 'Resumo executivo da operação — clientes, processos, agenda e finanças.' },
  // Processos
  painel:     { title: 'Processos',          subtitle: 'Visão operacional: etapas, prazos e resultados dos processos.' },
  // Financeiro
  visao:        { title: 'Visão Financeira', subtitle: 'Indicadores, gráficos e desempenho financeiro por período.' },
  resumo:       { title: 'Visão Financeira', subtitle: 'Indicadores, gráficos e desempenho financeiro por período.' },
  caixa:        { title: 'Caixa',            subtitle: 'Movimento semanal de entradas e saídas.' },
  lancamentos:  { title: 'Lançamentos',      subtitle: 'Entradas e saídas financeiras — manuais e automáticas.' },
  faturamentos: { title: 'Faturamentos',     subtitle: 'Cobranças por processo ou serviço, pagamentos e saldos.' },
  pagamentos:   { title: 'Pagamentos',       subtitle: 'Todos os pagamentos registrados, parcelas e sinais.' },
  recibos:      { title: 'Recibos',          subtitle: 'Emissão, reemissão e histórico de recibos.' },
  config:       { title: 'Configurações Financeiras', subtitle: 'Identidade do recibo, numeração e formas de pagamento.' },
  // Operação (SISV / despachantes)
  dashboard:     { title: 'Dashboard',       subtitle: 'Visão geral de clientes, serviços, prazos e etapas.' },
  processos:     { title: 'Processos',       subtitle: 'Fila operacional dos processos de CNH.' },
  configuracoes: { title: 'Configurações',   subtitle: 'Etapas, status, tipos de serviço e setores da operação.' },
  users:         { title: 'Usuários',        subtitle: 'Gerencie usuários, cargos e permissões.' },
  clients:    { title: 'Clientes',           subtitle: 'Gerencie todos os clientes e seus processos.' },
  companies:  { title: 'Empresas',           subtitle: 'Pessoas jurídicas, frota e processos vinculados.' },
  leads:      { title: 'Leads',              subtitle: 'Lista e cadastro de leads captados.' },
  tarefas:    { title: 'Tarefas',            subtitle: 'Quadro kanban de acompanhamento operacional dos leads.' },
  approvals:  { title: 'Aprovações',         subtitle: 'Solicitações de exclusão aguardando aprovação.' },
  defesa:     { title: 'Defesa Prévia',      subtitle: 'Processos em fase de defesa prévia.' },
  instancia1: { title: '1ª Instância',       subtitle: 'Processos em primeira instância.' },
  instancia2: { title: '2ª Instância',       subtitle: 'Processos em segunda instância.' },
  calendario: { title: 'Prazos',             subtitle: 'Prazos dos processos por urgência.' },
  eventos:    { title: 'Agenda',             subtitle: 'Eventos e agendamentos da equipe.' },
  deferidos:  { title: 'Deferidos',          subtitle: 'Processos com resultado deferido — prova social.' },
  documents:  { title: 'Documentos',         subtitle: 'Gerencie documentos e arquivos dos processos.' },
  history:    { title: 'Histórico',          subtitle: 'Registro completo de atividades e alterações.' },
  // Leads
  overview:    { title: 'Overview',          subtitle: 'Visão geral de leads e desempenho.' },
  acquisition: { title: 'Aquisição',         subtitle: 'Gerenciamento e captação de novos leads.' },
  pipeline:    { title: 'Pipeline',          subtitle: 'Acompanhe o funil de vendas.' },
  leaderboard: { title: 'Ranking',           subtitle: 'Desempenho e ranking da equipe.' },
  performance: { title: 'Performance',       subtitle: 'Análise de performance e metas.' },
  export:      { title: 'Exportar',          subtitle: 'Exportação de dados e relatórios.' },
  reports:     { title: 'Relatórios',        subtitle: 'Relatórios detalhados de vendas.' },
  // Settings
  general:      { title: 'Configurações',    subtitle: 'Ajuste as configurações da conta e do sistema.' },
  team:         { title: 'Equipe',           subtitle: 'Gerencie usuários, cargos e permissões.' },
  integrations: { title: 'Integrações',      subtitle: 'Configure integrações com outros sistemas.' },
};

function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  );
}

export default function PageHeader({ currentTab, user, tenant, onLogout, onMobileMenuToggle }) {
  const info = pageInfo[currentTab] || { title: 'Dashboard', subtitle: '' };
  const role = user?.role;

  const getRoleBadge = () => {
    if (role === 'admin') {
      return { label: 'ADMIN', color: '#2563eb', bg: 'rgba(37, 99, 235,0.08)', border: 'rgba(37, 99, 235,0.2)' };
    }
    if (role === 'manager') {
      return { label: 'GESTOR', color: '#2563eb', bg: 'rgba(37, 99, 235,0.08)', border: 'rgba(37, 99, 235,0.2)' };
    }
    if (role === 'operator') {
      return { label: 'OPERADOR', color: '#15803d', bg: 'rgba(21,128,61,0.08)', border: 'rgba(21,128,61,0.2)' };
    }
    return { label: 'CONSULTOR', color: '#475569', bg: 'rgba(71,85,105,0.08)', border: 'rgba(71,85,105,0.2)' };
  };

  const badge = getRoleBadge();

  return (
    <header className="page-header">
      {onMobileMenuToggle && (
        <button className="ph-mobile-menu-btn" onClick={onMobileMenuToggle} aria-label="Abrir menu">
          <MenuIcon />
        </button>
      )}
      <div className="page-header-left">
        <h1 className="page-header-title">{info.title}</h1>
        <p className="page-header-subtitle">{info.subtitle}</p>
      </div>

      <div className="page-header-right">
        {tenant?.name && (
          <div className="ph-tenant-badge">
            <BuildingIcon />
            <span>{tenant.name}</span>
          </div>
        )}

        <div
          className="ph-role-badge"
          style={{ background: badge.bg, borderColor: badge.border, color: badge.color }}
        >
          {badge.label}
        </div>

        <div className="ph-avatar">
          {user?.name?.charAt(0).toUpperCase() || 'U'}
        </div>

        {user?.name && (
          <span className="ph-user-name">{user.name.split(' ')[0]}</span>
        )}

        <button onClick={onLogout} className="ph-logout-btn">
          <LogoutIcon />
          Sair
        </button>
      </div>
    </header>
  );
}
