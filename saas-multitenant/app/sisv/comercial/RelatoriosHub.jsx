'use client';

// =============================================================================
// RelatoriosHub.jsx — reúne os relatórios operacionais que já existiam com os
// relatórios comerciais e financeiros do SISV 2.0 (§37), em duas abas.
//
// Nada do módulo anterior foi substituído: RelatoriosSISV continua intacto na
// aba "Operacional".
// =============================================================================

import { useState } from 'react';
import RelatoriosSISV from '../RelatoriosSISV';
import RelatoriosComerciais from './Relatorios';
import { Tabs } from './shared';

export default function RelatoriosHub() {
  const [tab, setTab] = useState('operacional');
  return (
    <div className="sisv-report-hub">
      <Tabs
        ariaLabel="Tipos de relatório"
        tabs={[
          { key: 'operacional', label: 'Operacional' },
          { key: 'comercial', label: 'Comercial e financeiro' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'operacional' ? <RelatoriosSISV /> : <RelatoriosComerciais />}
    </div>
  );
}
