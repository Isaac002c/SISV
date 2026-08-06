'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '../lib/api.js';
import { APP_BRAND } from '../lib/brand';
import { SisvLockup, TelunAsset, TelunSignature } from '../components/TelunBrand';

export default function Login() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await apiRequest('/auth/login', {
        method: 'POST',
        body: { login, password },
      });

      if (data.token) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('auth-token', data.token);
      }

      const userData = { ...data.user, role: data.user.role || 'admin' };
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('tenant', JSON.stringify(data.tenant));
      localStorage.setItem('tenantId', data.tenant?.id || '');
      router.push(userData.role === 'super_admin' ? '/master' : '/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="telun-login">
      <div className="telun-login-light telun-login-light--violet" aria-hidden="true" />
      <div className="telun-login-light telun-login-light--copper" aria-hidden="true" />
      <div className="telun-convergence" aria-hidden="true">
        <i /><i /><i /><i />
      </div>

      <section className="telun-login-shell" aria-labelledby="login-title">
        <div className="telun-login-institutional">
          <TelunAsset kind="logo" />
          <p>Propósito · direção · clareza</p>
        </div>

        <div className="telun-login-card">
          <header className="telun-login-brand">
            <SisvLockup institutional />
            <h1 id="login-title">Acesse sua operação</h1>
            <p>Processos diferentes convergem para um fluxo claro e organizado.</p>
          </header>

          <form onSubmit={handleLogin} className="telun-login-form">
            {error && <div className="telun-login-error" role="alert">{error}</div>}

            <label className="telun-login-field">
              <span>Usuário</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                placeholder="Nome.Sobrenome"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                required
              />
            </label>

            <label className="telun-login-field">
              <span>Senha</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            <button type="submit" className="telun-login-submit" disabled={loading}>
              {loading ? 'Entrando…' : `Entrar no ${APP_BRAND.name}`}
            </button>
          </form>

          <footer className="telun-login-footer">
            <TelunSignature />
            <span aria-hidden="true">✦</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
