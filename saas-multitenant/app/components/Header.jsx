'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { APP_BRAND } from '../lib/brand';

const modules = [
  { key: 'leads', label: 'Leads' },
  { key: 'multas', label: 'Multas' },
  { key: 'settings', label: 'Settings' },
];

export default function Header({ user, tenant, onLogout }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [role, setRole] = useState('seller');
  const dropdownRef = useRef(null);
  
  const currentModule = searchParams.get('module') || 'leads';
  const currentModuleLabel = modules.find(m => m.key === currentModule)?.label || 'Leads';

  useEffect(() => {
    if (user?.role) {
      setRole(user.role);
    }
    
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [user]);

  const moduleDefaultTabs = {
    leads: 'overview',
    multas: 'dashboard',
    settings: 'general'
  };

  const handleModuleChange = (moduleKey) => {
    setDropdownOpen(false);
    const defaultTab = moduleDefaultTabs[moduleKey] || 'overview';
    router.push(`/dashboard?module=${moduleKey}&tab=${defaultTab}`);
  };

  const getRoleBadge = () => {
    if (role === 'admin') {
      return { label: 'ADMIN', color: '#7B43CE', bg: '#F1E9FF' };
    }
    return { label: 'VENDEDOR', color: '#3B1F6A', bg: '#F1EEF6' };
  };

  const roleBadge = getRoleBadge();

  return (
    <header className="global-header">
      <div className="header-left">
        <div className="header-logo">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '36px',
            height: '36px',
            background: 'linear-gradient(135deg, #3B1F6A, #A56FFF)',
            borderRadius: '10px',
            flexShrink: 0
          }}>
            <svg width="20" height="16" viewBox="0 0 44 36" fill="none">
              <line x1="30" y1="2" x2="30" y2="14" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="24" y1="5" x2="36" y2="5" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
              <path d="M23 5 Q21 9 23 11 Q25 13 27 11 Q29 9 27 5" fill="none" stroke="white" strokeWidth="1.6"/>
              <path d="M33 5 Q31 9 33 11 Q35 13 37 11 Q39 9 37 5" fill="none" stroke="white" strokeWidth="1.6"/>
              <path d="M2 24 L4 19 Q6 16 9 16 L12 14 Q14 13 18 13 L26 14 Q27 14 28 16 L31 19 L33 24 Q33 27 31 27 L5 27 Q2 27 2 24Z"
                    fill="white" opacity="0.9"/>
              <circle cx="9" cy="27" r="3" fill="white" opacity="0.7"/>
              <circle cx="25" cy="27" r="3" fill="white" opacity="0.7"/>
            </svg>
          </div>
          <div style={{ marginLeft: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: '700', color: '#1e293b', lineHeight: 1.2 }}>
              {APP_BRAND.name}
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.2 }}>
              Uma solução TELUN
            </div>
          </div>
        </div>
      </div>

      <div className="header-right">
        {tenant && (
          <div className="tenant-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
            <span>{tenant.name}</span>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 12px',
            background: roleBadge.bg,
            border: `1px solid ${roleBadge.color}30`,
            borderRadius: '16px',
            fontSize: '11px',
            fontWeight: '700',
            color: roleBadge.color,
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}
          title={role === 'admin' ? 'Acesso administrativo' : 'Acesso de vendedor'}
        >
          {roleBadge.label}
        </div>

        <div className="module-dropdown" ref={dropdownRef}>
          <button
            className="dropdown-trigger"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#7B43CE' }}>
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
            {currentModuleLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={`dropdown-arrow ${dropdownOpen ? 'open' : ''}`}
              style={{ transition: 'transform 0.2s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {dropdownOpen && (
            <div className="dropdown-menu">
              {modules.map((module) => (
                <button
                  key={module.key}
                  className={`dropdown-item ${currentModule === module.key ? 'active' : ''}`}
                  onClick={() => handleModuleChange(module.key)}
                >
                  {module.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="header-user-info">
          <div className="user-avatar" style={{ background: 'linear-gradient(135deg, #3B1F6A, #A56FFF)' }}>
            {user?.name?.charAt(0).toUpperCase() || 'U'}
          </div>
          <button onClick={onLogout} className="logout-btn-header">
            Sair
          </button>
        </div>
      </div>
    </header>
  );
}

