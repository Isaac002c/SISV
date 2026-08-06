'use client';

import { APP_BRAND } from '../lib/brand';

/**
 * Slot de marca preparado para os arquivos oficiais isolados.
 *
 * Enquanto NEXT_PUBLIC_TELUN_*_URL não estiver configurado, o componente usa
 * um fallback tipográfico deliberadamente neutro. Ele não tenta reconstruir o
 * símbolo TELUN a partir do brand board.
 */
export function TelunAsset({ kind = 'symbol', compact = false, className = '' }) {
  const source = kind === 'logo' ? APP_BRAND.assets.logo : APP_BRAND.assets.symbol;

  if (source) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={source}
        alt={kind === 'logo' ? 'TELUN' : ''}
        aria-hidden={kind === 'symbol' ? 'true' : undefined}
        className={`telun-brand-asset ${kind === 'logo' ? 'is-logo' : ''} ${compact ? 'is-compact' : ''} ${className}`.trim()}
      />
    );
  }

  return (
    <span
      className={`telun-brand-fallback ${compact ? 'is-compact' : ''} ${className}`.trim()}
      aria-label={compact ? 'SISV' : undefined}
      aria-hidden={compact ? undefined : 'true'}
    >
      {compact ? 'S' : 'TELUN'}
    </span>
  );
}

export function TelunSignature({ wording = 'solution', className = '' }) {
  return (
    <span className={`telun-signature ${className}`.trim()}>
      <span>{wording === 'developed' ? 'Desenvolvido pela' : 'Uma solução'}</span>
      <strong>TELUN</strong>
    </span>
  );
}

export function SisvLockup({ compact = false, institutional = false }) {
  if (compact) return <TelunAsset compact />;

  return (
    <div className={`sisv-lockup ${institutional ? 'is-institutional' : ''}`}>
      <div className="sisv-lockup-product">
        <span className="sisv-lockup-name">{APP_BRAND.name}</span>
        <span className="sisv-lockup-tagline">{APP_BRAND.tagline}</span>
      </div>
      <TelunSignature />
    </div>
  );
}
