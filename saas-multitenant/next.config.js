/** @type {import('next').NextConfig} */

// Em desenvolvimento: proxy para localhost:5000.
// Em produção (Vercel): defina BACKEND_URL com a API do ambiente. No SISV:
//   BACKEND_URL=https://api-sisv.chronostek.com.br
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

// Origem da API para o CSP. Antes o domínio ficava fixo no arquivo, o que fazia
// um ambiente herdar o `connect-src` de outro; agora é derivado do BACKEND_URL.
// O navegador normalmente só fala com a própria origem (os rewrites abaixo fazem
// o proxy), mas manter a origem real aqui evita bloqueio em chamada direta.
const apiOrigin = (() => {
  try {
    const url = new URL(BACKEND_URL);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
})();

const nextConfig = {
  reactStrictMode: true,

  async rewrites() {
    return [
      // Proxy todas as chamadas /api/* e /auth/* para o backend
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
      {
        source: '/auth/:path*',
        destination: `${BACKEND_URL}/auth/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              ["connect-src 'self'", apiOrigin].filter(Boolean).join(' '),
              "frame-ancestors 'none'",
              "object-src 'none'",
            ].join('; '),
          },
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;