'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // Verifica localStorage primeiro (token salvo pelo login/page.jsx).
    // Cookie httpOnly não chega ao browser quando Next.js faz proxy server-side.
    const token =
      localStorage.getItem('token') ||
      localStorage.getItem('auth-token') ||
      document.cookie.includes('auth-token');
    if (token) {
      router.push('/dashboard');
    } else {
      router.push('/login');
    }
  }, [router]);

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0B0B12',
      color: '#fff'
    }}>
      <div>Carregando...</div>
    </div>
  );
}

