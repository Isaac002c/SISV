// =============================================================================
// Constantes canônicas do módulo financeiro (fonte da verdade do backend).
// Os valores aqui DEVEM casar com os CHECKs das migrations e com o frontend.
// =============================================================================

const TRANSACTION_TYPES = ['entrada', 'saida'];

const TRANSACTION_STATUSES = [
  'previsto', 'pendente', 'pago', 'recebido', 'vencido', 'cancelado',
];

const BILLING_STATUSES = [
  'nao_faturado', 'faturado', 'parcialmente_pago', 'pago', 'vencido', 'cancelado',
];

const PAYMENT_STATUSES = ['confirmado', 'cancelado'];

const RECEIPT_STATUSES = ['emitido', 'cancelado'];

const PAYMENT_METHODS = [
  'pix', 'dinheiro', 'cartao_credito', 'cartao_debito',
  'boleto', 'transferencia', 'outro',
];

const PAYMENT_METHOD_LABELS = {
  pix: 'Pix',
  dinheiro: 'Dinheiro',
  cartao_credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  outro: 'Outro',
};

const TRANSACTION_ORIGINS = ['manual', 'pagamento', 'sistema'];

// Categorias iniciais criadas (idempotentemente) por tenant no primeiro acesso.
const DEFAULT_CATEGORIES = [
  { name: 'Pagamento de serviço',      type: 'entrada' },
  { name: 'Sinal',                     type: 'entrada' },
  { name: 'Parcela',                   type: 'entrada' },
  { name: 'Outros recebimentos',       type: 'entrada' },
  { name: 'Taxas',                     type: 'saida'   },
  { name: 'Custas',                    type: 'saida'   },
  { name: 'Despesas administrativas',  type: 'saida'   },
  { name: 'Pagamentos',                type: 'saida'   },
  { name: 'Outras despesas',           type: 'saida'   },
];

// Identidade padrão do produto (usada quando o tenant não tem branding próprio).
const DEFAULT_BRANDING = {
  name: 'SISV',
  signature: 'Uma solução TELUN',
  receipt_prefix: 'SISV',
};

module.exports = {
  TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  BILLING_STATUSES,
  PAYMENT_STATUSES,
  RECEIPT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  TRANSACTION_ORIGINS,
  DEFAULT_CATEGORIES,
  DEFAULT_BRANDING,
};
