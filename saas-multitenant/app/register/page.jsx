'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '../lib/api.js';
import { APP_BRAND } from '../lib/brand';

export default function Register() {
  const [formData, setFormData] = useState({
    tenantName: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validações
    if (formData.password !== formData.confirmPassword) {
      setError('As senhas não coincidem');
      return;
    }

    if (formData.password.length < 6) {
      setError('A senha deve ter pelo menos 6 caracteres');
      return;
    }

    setLoading(true);

    try {
      // Usa o mesmo proxy relativo do restante do app (next.config rewrites → BACKEND_URL).
      // Assim funciona na Vercel (HTTPS, mesma origem) sem URL fixa/insegura.
      await apiRequest('/auth/register', {
        method: 'POST',
        body: {
          tenantName: formData.tenantName,
          name: formData.name,
          email: formData.email,
          password: formData.password,
        },
      });

      // Redirecionar para login com mensagem de sucesso
      alert('Conta criada com sucesso! Faça login para continuar.');
      router.push('/login');
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
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      padding: '20px'
    }}>
      <div style={{
        background: '#1e293b',
        padding: '40px',
        borderRadius: '12px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
        width: '100%',
        maxWidth: '450px',
        textAlign: 'center'
      }}>
        <div style={{ marginBottom: '30px' }}>
          <h1 style={{ 
            fontSize: '28px', 
            fontWeight: 'bold', 
            color: APP_BRAND.color,
            marginBottom: '8px'
          }}>
            {APP_BRAND.name}
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '14px' }}>
            Criação de contas temporariamente desativada
          </p>
        </div>

        <div style={{
          background: '#fef3c7',
          color: '#92400e',
          padding: '16px',
          borderRadius: '8px',
          marginBottom: '24px',
          fontSize: '14px'
        }}>
          <p style={{ margin: 0 }}>
            Para criar uma nova conta, entre em contato com o administrador do sistema.
          </p>
        </div>

        <a 
          href="/login"
          style={{ 
            display: 'inline-block',
            padding: '14px 32px',
            background: '#3b82f6',
            color: 'white',
            borderRadius: '6px',
            fontSize: '16px',
            fontWeight: '600',
            textDecoration: 'none'
          }}
        >
          Ir para Login
        </a>
      </div>
    </div>
  );
}

