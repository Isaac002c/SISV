'use client';

import { useRouter } from 'next/navigation';
import { APP_BRAND, DEVELOPED_BY } from '../lib/brand';

const quickActionsConsultor = [
  {
    label: 'Leads',
    desc: 'Lista e cadastro de leads',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
      </svg>
    ),
    route: '/dashboard?module=multas&tab=leads',
    primary: true,
  },
  {
    label: 'Tarefas',
    desc: 'Quadro kanban operacional',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
        <polyline points="9 16 11 18 15 14"/>
      </svg>
    ),
    route: '/dashboard?module=multas&tab=tarefas',
  },
  {
    label: 'Clientes',
    desc: 'Lista de clientes cadastrados',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    ),
    route: '/dashboard?module=multas&tab=clients',
  },
];

export default function UserHome({ user }) {
  const router    = useRouter();
  const isAdmin   = user?.role === 'admin';
  const firstName = user?.name?.split(' ')[0] || 'bem-vindo';
  const greeting  = isAdmin ? `Olá, ${firstName}!` : `Olá, Consultor ${firstName}!`;
  const actions   = quickActionsConsultor;
  // Nome do tenant (data-driven) — sem branding fixo de cliente.
  let tenantName = APP_BRAND.name;
  if (typeof window !== 'undefined') {
    try { tenantName = JSON.parse(localStorage.getItem('tenant') || '{}').name || APP_BRAND.name; } catch { /* noop */ }
  }

  return (
    <div className="user-home">
      {/* Hero */}
      <div className="user-home-hero">
        <div className="user-home-welcome">
          <p className="user-home-greeting">{greeting}</p>
          <h1 className="user-home-title">{tenantName}</h1>
          <p className="user-home-subtitle">Plataforma de Gestão</p>
          <p className="user-home-desc">
            Selecione uma ação abaixo para começar ou use o menu lateral para navegar.
          </p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="user-home-actions-title">O que deseja fazer?</div>
      <div className="user-home-grid">
        {actions.map((action) => (
          <button
            key={action.label}
            className={`user-home-card${action.primary ? ' primary' : ''}`}
            onClick={() => router.push(action.route)}
          >
            <div className={`user-home-card-icon${action.primary ? ' primary' : ''}`}>
              {action.icon}
            </div>
            <div className="user-home-card-body">
              <span className="user-home-card-label">{action.label}</span>
              <span className="user-home-card-desc">{action.desc}</span>
            </div>
            <svg className="user-home-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="user-home-footer">
        <span>{DEVELOPED_BY}</span>
      </div>
    </div>
  );
}
