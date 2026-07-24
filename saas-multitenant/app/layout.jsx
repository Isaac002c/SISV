import './globals.css';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'SISV';
const APP_TAGLINE = process.env.NEXT_PUBLIC_APP_TAGLINE || 'Sistema Integrado da Sinal Verde';
const APP_DEVELOPER = process.env.NEXT_PUBLIC_APP_DEVELOPER || 'TELUN';

export const metadata = {
  title: `${APP_NAME} | ${APP_TAGLINE}`,
  description: `${APP_TAGLINE} — desenvolvido pela ${APP_DEVELOPER}.`,
  applicationName: APP_NAME,
  authors: [{ name: APP_DEVELOPER }],
  creator: APP_DEVELOPER,
  publisher: APP_DEVELOPER,
  icons: {
    icon: '/icon.png',
    shortcut: '/icon.png',
    apple: '/icon.png',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>{children}</body>
    </html>
  );
}

