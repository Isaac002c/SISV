'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '../lib/api.js';
import { APP_BRAND, APP_INITIAL, DEVELOPED_BY } from '../lib/brand';

// Tela de login institucional do sistema (SISV, configurável por env). Não usa
// branding específico de tenant — a identidade do tenant aparece DEPOIS do login
// (sidebar/header). Cor/nome vêm de APP_BRAND (variáveis de tema configuráveis).
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiRequest('/auth/login', {
        method: 'POST',
        body: { email, password },
      });

      // Armazenar token em cookie HTTP-only (backend envia cookie)
      // Salva no localStorage para uso nas chamadas API
      if (data.token) {
        // Token em localStorage para o header Authorization nas chamadas API
        // O backend também envia cookie httpOnly via Set-Cookie (mais seguro)
        localStorage.setItem('token', data.token);
        localStorage.setItem('auth-token', data.token);
      }

      // Salvar dados do usuário
      const userData = {
        ...data.user,
        role: data.user.role || 'admin'
      };
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('tenant', JSON.stringify(data.tenant));
      
      localStorage.setItem('tenantId', data.tenant?.id || '');

      // Master Chronostek vai para o painel /master; demais usuários para o tenant.
      router.push(userData.role === 'super_admin' ? '/master' : '/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      background: 'linear-gradient(160deg, #060a14 0%, #0a0f1e 60%, #0d1428 100%)',
      padding: '20px'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(59,130,246,0.2)',
        padding: '48px 40px',
        borderRadius: '16px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(59,130,246,0.08)',
        width: '100%',
        maxWidth: '420px'
      }}>
        {/* Marca institucional (SISV) */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '80px',
            height: '80px',
            marginBottom: '16px',
            borderRadius: '20px',
            background: `linear-gradient(135deg, ${APP_BRAND.color} 0%, ${APP_BRAND.colorDark} 100%)`,
            boxShadow: `0 0 24px ${APP_BRAND.color}55`,
            fontSize: '38px',
            fontWeight: 800,
            color: '#fff',
          }}>
            {APP_INITIAL}
          </div>
          <h1 style={{
            fontSize: '26px',
            fontWeight: '700',
            color: '#ffffff',
            marginBottom: '4px',
            letterSpacing: '-0.5px'
          }}>
            {APP_BRAND.name}
          </h1>
          <p style={{ color: '#64748b', fontSize: '13px' }}>
            {APP_BRAND.tagline}
          </p>
        </div>

        <form onSubmit={handleLogin}>
          {error && (
            <div style={{
              background: '#fef2f2',
              color: '#ef4444',
              padding: '12px',
              borderRadius: '6px',
              marginBottom: '20px',
              fontSize: '14px'
            }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              color: '#94a3b8',
              fontSize: '13px',
              fontWeight: '500',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              E-mail
            </label>
            <input
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(59,130,246,0.2)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ marginBottom: '28px' }}>
            <label style={{
              display: 'block',
              marginBottom: '8px',
              color: '#94a3b8',
              fontSize: '13px',
              fontWeight: '500',
              textTransform: 'uppercase',
              letterSpacing: '0.5px'
            }}>
              Senha
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(59,130,246,0.2)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              background: loading ? APP_BRAND.colorDark : APP_BRAND.color,
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.8 : 1,
              fontSize: '15px',
              fontWeight: '600',
              letterSpacing: '0.3px',
              transition: 'background 0.2s, transform 0.1s',
              boxShadow: loading ? 'none' : `0 4px 16px ${APP_BRAND.color}66`
            }}
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: '24px',
          color: 'rgba(211,207,195,0.35)',
          fontSize: '11px',
          letterSpacing: '0.5px'
        }}>
          {DEVELOPED_BY}
        </p>
      </div>
    </div>
  );
}
