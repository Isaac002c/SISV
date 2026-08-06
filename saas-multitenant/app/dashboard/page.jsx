'use client';

import { useState, useEffect, Suspense, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Sidebar from '../components/Sidebar';
import PageHeader from '../components/PageHeader';

// Leads
import LeadsOverview     from '../leads/Overview';
import LeadsAcquisition  from '../leads/Acquisition';
import LeadsPipeline     from '../leads/Pipeline';
import LeadsLeaderboard  from '../leads/Leaderboard';
import LeadsExport       from '../leads/Export';
import LeadsPerformance  from '../leads/Performance';
import LeadsReports      from '../leads/Reports';

// Multas
import MultasDashboard from '../multas/Dashboard';
import MultasClients   from '../multas/Clients';
import MultasCompanies from '../multas/Companies';
import MultasDeferidos from '../multas/Deferidos';
import CalendarioEventos from '../multas/CalendarioEventos';
import MultasHistory   from '../multas/History';
import MultasLeadsList from '../multas/LeadsList';
import MultasTarefas   from '../multas/Tarefas';
import MultasApprovals from '../multas/Approvals';
import MultasAgenda    from '../multas/Calendario';
import MultasUsers     from '../multas/Users';

// SISV — processos de CNH (operação Sinal Verde)
import Processos       from '../sisv/Processos';
import ProcessosConfig from '../sisv/ProcessosConfig';
import DashboardSISV   from '../sisv/comercial/DashboardHub';
import HistoricoSISV   from '../sisv/HistoricoSISV';
import MeuTrabalho     from '../sisv/MeuTrabalho';
import CentralAtencao  from '../sisv/CentralAtencao';
import RelatoriosSISV  from '../sisv/comercial/RelatoriosHub';
import { AuditoriaSISV, QualidadeSISV } from '../sisv/GovernancaSISV';

// SISV 2.0 — jornada comercial, back office, execução e financeiro operacional.
import Pedidos             from '../sisv/comercial/Pedidos';
import BackOfficeSISV      from '../sisv/comercial/BackOffice';
import ExecucaoSISV        from '../sisv/comercial/Execucao';
import FinanceiroOperacional from '../sisv/comercial/Financeiro';
import Fornecedores        from '../sisv/comercial/Fornecedores';
import CatalogoComercial   from '../sisv/comercial/Catalogo';
import DocumentosComerciais from '../sisv/comercial/Documentos';
import RelatoriosComerciais from '../sisv/comercial/Relatorios';
import {
  APP_BRAND,
  getTenantModules,
  getUserModules,
  hasAnyUserModule,
  isModuleEnabled,
} from '../lib/brand';

// Financeiro
import dynamic from 'next/dynamic';
import CaixaSemanal     from '../multas/financeiro/CaixaSemanal';
import Lancamentos      from '../multas/financeiro/Lancamentos';
import Faturamentos     from '../multas/financeiro/Faturamentos';
import Pagamentos       from '../multas/financeiro/Pagamentos';
import Recibos          from '../multas/financeiro/Recibos';
import ConfigFinanceira from '../multas/financeiro/ConfigFinanceira';
// Dashboard financeiro com gráficos (recharts) — lazy p/ não pesar o bundle geral
const VisaoFinanceira = dynamic(() => import('../multas/financeiro/VisaoFinanceira'), {
  loading: () => (
    <div className="loading-screen" style={{ height: 300 }}>
      <div className="loading-spinner" />
      <p>Carregando visão financeira...</p>
    </div>
  ),
  ssr: false,
});

// Settings
import SettingsPage from '../settings/page';

const ComingSoon = ({ moduleName }) => (
  <div className="coming-soon">
    <div style={{ marginBottom: 20 }}>
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>
    <h2>{moduleName}</h2>
    <p>Esta seção está em desenvolvimento</p>
  </div>
);

// Dashboard sensível ao tenant: SISV (e tenants com módulo 'processos') usam o
// painel operacional de CNH; os demais mantêm o dashboard legado de despachantes.
function isSisvTenant() {
  try {
    const modules = getTenantModules(JSON.parse(localStorage.getItem('tenant') || '{}'));
    return Array.isArray(modules) && modules.includes('processos');
  } catch { return false; }
}

function DashboardRouter() {
  return isSisvTenant() ? <DashboardSISV /> : <MultasDashboard />;
}

// Histórico: SISV mostra as movimentações dos processos; legado mantém o seu.
function HistoryRouter() {
  return isSisvTenant() ? <HistoricoSISV /> : <MultasHistory />;
}

const modulePages = {
  // ── Operação (processos, clientes, agenda, leads) ──────────────────────
  multas: {
    pages: {
      dashboard:     DashboardRouter,
      processos:     Processos,
      'meu-trabalho': MeuTrabalho,
      atencao:        CentralAtencao,
      relatorios:     RelatoriosSISV,
      auditoria:      AuditoriaSISV,
      qualidade:      QualidadeSISV,
      configuracoes: ProcessosConfig,
      users:         MultasUsers,
      clients:       MultasClients,

      // ── SISV 2.0 ────────────────────────────────────────────────────────
      pedidos:                  Pedidos,
      backoffice:               BackOfficeSISV,
      execucao:                 ExecucaoSISV,
      'financeiro-operacional': FinanceiroOperacional,
      vendas:                   () => <FinanceiroOperacional initialTab="vendas" />,
      comissoes:                () => <FinanceiroOperacional initialTab="comissoes" />,
      fornecedores:             Fornecedores,
      catalogo:                 CatalogoComercial,
      'documentos-comerciais':  DocumentosComerciais,

      companies:     MultasCompanies,
      leads:         MultasLeadsList,
      tarefas:       MultasTarefas,
      approvals:     MultasApprovals,
      history:       HistoryRouter,
      calendario:    MultasAgenda,
      eventos:       CalendarioEventos,
      deferidos:     MultasDeferidos,
      // legacy / coming-soon
      defesa:     () => <ComingSoon moduleName="Defesa Prévia" />,
      instancia1: () => <ComingSoon moduleName="1ª Instância" />,
      instancia2: () => <ComingSoon moduleName="2ª Instância" />,
      documents:  () => <ComingSoon moduleName="Documentos" />,
    },
  },
  // ── Financeiro (área própria) ──────────────────────────────────────────
  financeiro: {
    pages: {
      visao:        VisaoFinanceira,
      resumo:       VisaoFinanceira, // alias legado
      caixa:        CaixaSemanal,
      lancamentos:  Lancamentos,
      faturamentos: Faturamentos,
      pagamentos:   Pagamentos,
      recibos:      Recibos,
      config:       ConfigFinanceira,
    },
  },
  settings: {
    pages: {
      general:      SettingsPage,
      team:         () => <ComingSoon moduleName="Equipe" />,
      integrations: () => <ComingSoon moduleName="Integrações" />,
    },
  },
  // ── Módulo legado de Leads (URLs antigas continuam funcionando) ────────
  leads: {
    pages: {
      overview:    LeadsOverview,
      acquisition: LeadsAcquisition,
      pipeline:    LeadsPipeline,
      leaderboard: LeadsLeaderboard,
      export:      LeadsExport,
      performance: LeadsPerformance,
      reports:     LeadsReports,
    },
  },
};

// Aliases de módulos do overhaul anterior → Despachantes/Financeiro (URLs antigas).
const MODULE_ALIASES = { visao: 'multas', crm: 'multas', processos: 'multas', agenda: 'multas' };
const TAB_ALIASES = { painel: 'dashboard', home: 'dashboard' };

const getDefaultTab = (module) => {
  const defaults = { leads: 'overview', multas: 'dashboard', financeiro: 'visao', settings: 'general' };
  return defaults[module] || 'dashboard';
};

function CachedTabs({ moduleKey, activeTab }) {
  const moduleData = modulePages[moduleKey] || modulePages.leads;
  const mountedRef = useRef({});

  return (
    <>
      {Object.entries(moduleData.pages).map(([key, Page]) => {
        const isActive = key === activeTab;
        if (!isActive && !mountedRef.current[key]) return null;
        mountedRef.current[key] = true;
        return (
          <div key={key} style={{ display: isActive ? 'block' : 'none' }}>
            <Page />
          </div>
        );
      })}
    </>
  );
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [user, setUser]       = useState(null);
  const [tenant, setTenant]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const rawModule = searchParams.get('module') || 'multas';
  const currentModule = MODULE_ALIASES[rawModule] || rawModule;
  const rawTab    = searchParams.get('tab');
  const activeTab = (rawTab && (TAB_ALIASES[rawTab] || rawTab)) || getDefaultTab(currentModule);

  useEffect(() => {
    // Aceita token de localStorage (primário) ou cookie (fallback)
    const lsToken    = localStorage.getItem('auth-token') || localStorage.getItem('token');
    const cookieTok  = document.cookie.includes('auth-token');
    const hasToken   = !!(lsToken || cookieTok);
    const userData   = localStorage.getItem('user');
    const tenantData = localStorage.getItem('tenant');
    if (!hasToken || !userData) { router.push('/login'); return; }
    const parsedUser = JSON.parse(userData);
    // super_admin (Chronostek) não usa o dashboard de tenant — vai para o painel master.
    if (parsedUser?.role === 'super_admin') { router.replace('/master'); return; }
    setUser(parsedUser);
    setTenant(JSON.parse(tenantData || '{}'));
    setLoading(false);
  }, [router]);

  // CR Recursos: consultor (não-admin) não acessa "Prazos" (tab calendario) nem por URL direta.
  // Redireciona para a home do módulo. Não afeta admin nem outros tenants.
  useEffect(() => {
    if (!user || !tenant) return;
    if ((tenant.slug || '') === 'cr-recursos' && user.role !== 'admin' && activeTab === 'calendario') {
      router.replace('/dashboard?module=multas');
    }
  }, [user, tenant, activeTab, router]);

  // Gating de módulo por ROTA (spec §16): módulo desabilitado para o tenant não é
  // acessível nem por URL direta. Redireciona para uma aba permitida.
  useEffect(() => {
    if (!user || !tenant) return;
    const modules = getTenantModules(tenant);
    if (modules == null) return; // legado: tudo liberado
    const userModules = getUserModules(user);
    const TAB_MODULE = {
      dashboard: 'dashboard', processos: 'processos', configuracoes: 'config', users: 'usuarios',
      'meu-trabalho': 'processos', atencao: 'processos', relatorios: 'processos',
      auditoria: 'processos', qualidade: 'processos',
      clients: 'clientes', companies: 'empresas', deferidos: 'deferidos', leads: 'leads',
      tarefas: 'tarefas', calendario: 'agenda', eventos: 'agenda', history: 'historico', approvals: 'aprovacoes',
      // SISV 2.0 — todas sob o módulo 'processos', igual ao gate do backend.
      pedidos: 'processos', backoffice: 'processos', execucao: 'processos',
      'financeiro-operacional': 'processos', vendas: 'processos', comissoes: 'processos',
      fornecedores: 'processos', catalogo: 'processos', 'documentos-comerciais': 'processos',
    };
    let allowed = true;
    if (currentModule === 'financeiro') allowed = isModuleEnabled(modules, 'financeiro');
    else if (currentModule === 'settings') allowed = false; // ajustes gerais ocultos p/ tenants restritos
    else if (currentModule === 'leads') allowed = isModuleEnabled(modules, 'leads');
    else if (currentModule === 'multas') {
      const mod = TAB_MODULE[activeTab];
      allowed = mod ? isModuleEnabled(modules, mod) : true;
      // Abas administrativas: bloqueadas por rota para não-admin (complementa o
      // enforcement do backend, que já rejeita as escritas).
      const ADMIN_ONLY = ['configuracoes', 'users', 'history'];
      const MANAGER_OR_ADMIN = ['atencao', 'auditoria', 'qualidade', 'catalogo'];
      // Abas do SISV 2.0 restritas por perfil. O backend continua sendo a
      // barreira real (checkPermission); isto só evita abrir uma tela vazia.
      const ROLE_RESTRICTED = {
        backoffice: ['admin', 'manager', 'back_office', 'sales_backoffice', 'finance'],
        vendas: ['admin', 'manager', 'front_office', 'back_office', 'sales_backoffice', 'finance'],
        'financeiro-operacional': ['admin', 'manager', 'finance', 'back_office', 'sales_backoffice'],
        comissoes: ['admin', 'manager', 'finance'],
        relatorios: ['admin', 'manager', 'finance'],
      };
      if (allowed && ADMIN_ONLY.includes(activeTab) && user.role !== 'admin') {
        allowed = false;
      }
      if (allowed && MANAGER_OR_ADMIN.includes(activeTab) && user.role !== 'admin' && user.role !== 'manager') {
        allowed = false;
      }
      if (allowed && ROLE_RESTRICTED[activeTab] && !ROLE_RESTRICTED[activeTab].includes(user.role)) {
        allowed = false;
      }

      const USER_ACCESS_BY_TAB = {
        clients: ['sales', 'backoffice', 'payments', 'operations'],
        pedidos: ['sales', 'backoffice'],
        'documentos-comerciais': ['sales', 'backoffice'],
        backoffice: ['backoffice'],
        vendas: ['sales', 'backoffice'],
        execucao: ['operations'],
        processos: ['backoffice', 'operations'],
        'meu-trabalho': ['backoffice', 'operations'],
        atencao: ['backoffice', 'operations'],
        'financeiro-operacional': ['payments'],
        fornecedores: ['payments'],
        comissoes: ['payments'],
        relatorios: ['sales', 'backoffice', 'payments', 'operations'],
        qualidade: ['backoffice', 'operations'],
        auditoria: ['backoffice', 'operations'],
        catalogo: ['sales'],
        companies: ['sales'],
        leads: ['sales'],
        tarefas: ['backoffice', 'operations'],
        calendario: ['backoffice', 'operations'],
        eventos: ['backoffice', 'operations'],
      };
      if (allowed && user.role !== 'admin' && !hasAnyUserModule(userModules, USER_ACCESS_BY_TAB[activeTab])) {
        allowed = false;
      }
    }
    if (allowed && currentModule === 'financeiro' && user.role !== 'admin'
        && !hasAnyUserModule(userModules, ['payments'])) allowed = false;
    if (!allowed) {
      const home = userModules?.includes('sales') ? 'pedidos'
        : userModules?.includes('backoffice') ? 'backoffice'
          : userModules?.includes('payments') ? 'financeiro-operacional'
            : userModules?.includes('operations') ? 'meu-trabalho'
              : (isModuleEnabled(modules, 'processos') ? 'processos' : 'dashboard');
      router.replace(`/dashboard?module=multas&tab=${home}`);
    }
  }, [user, tenant, currentModule, activeTab, router]);

  const handleLogout = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (_) {}
    finally {
      ['user', 'tenant', 'token', 'auth-token', 'tenantId', 'tenant-id'].forEach(k => localStorage.removeItem(k));
      ['token', 'auth-token', 'tenantId'].forEach(k => {
        document.cookie = `${k}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC`;
      });
      router.push('/login');
    }
  };

  const handleNavigate = (moduleKey, tabKey) => {
    setMobileSidebarOpen(false);
    router.push(`/dashboard?module=${moduleKey}&tab=${tabKey}`);
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Carregando {APP_BRAND.name}...</p>
      </div>
    );
  }

  const sisvTheme = (() => {
    const m = getTenantModules(tenant);
    return Array.isArray(m) && m.includes('processos');
  })();

  return (
    <div className={`app-shell${sisvTheme ? ' sisv-theme' : ''}`}>
      {/* Mobile overlay */}
      {mobileSidebarOpen && (
        <div
          className="sidebar-mobile-overlay"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <Sidebar
        currentModule={currentModule}
        currentTab={activeTab}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        mobileOpen={mobileSidebarOpen}
        user={user}
        tenant={tenant}
      />

      <div className={`shell-main${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}`}>
        <PageHeader
          currentTab={activeTab}
          user={user}
          tenant={tenant}
          onLogout={handleLogout}
          onMobileMenuToggle={() => setMobileSidebarOpen(v => !v)}
        />
        <div className="shell-content">
          <CachedTabs moduleKey={currentModule} activeTab={activeTab} />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Carregando...</p>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}
