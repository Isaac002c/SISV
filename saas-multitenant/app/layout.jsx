import './globals.css';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'SISV';
const APP_TAGLINE = process.env.NEXT_PUBLIC_APP_TAGLINE || 'Sistema Integrado da Sinal Verde';
const APP_DEVELOPER = process.env.NEXT_PUBLIC_APP_DEVELOPER || 'TELUN';
const APP_ICON = process.env.NEXT_PUBLIC_SISV_FAVICON_URL || '/brand/telun/logo_telun.jpeg';

export const metadata = {
  title: `${APP_NAME} | ${APP_TAGLINE}`,
  description: `${APP_TAGLINE} — uma solução ${APP_DEVELOPER}.`,
  applicationName: APP_NAME,
  authors: [{ name: APP_DEVELOPER }],
  creator: APP_DEVELOPER,
  publisher: APP_DEVELOPER,
  icons: {
    icon: [{ url: APP_ICON, type: 'image/jpeg' }],
    shortcut: [{ url: APP_ICON, type: 'image/jpeg' }],
    apple: [{ url: APP_ICON, type: 'image/jpeg' }],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
