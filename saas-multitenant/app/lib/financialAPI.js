import { apiRequest } from './api.js';

// ============================================
// FINANCIAL API — módulo financeiro (SISV)
// Todas as chamadas passam pelo proxy /api → backend (tenant via token).
// ============================================

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

// ── Categorias ────────────────────────────────────────────────────────────
export const getCategories = (filters = {}) =>
  apiRequest(`/api/financial/categories${qs(filters)}`).then((r) => r.data);
export const createCategory = (body) =>
  apiRequest('/api/financial/categories', { method: 'POST', body }).then((r) => r.data);
export const updateCategory = (id, body) =>
  apiRequest(`/api/financial/categories/${id}`, { method: 'PUT', body }).then((r) => r.data);
export const setCategoryActive = (id, active) =>
  apiRequest(`/api/financial/categories/${id}/active`, { method: 'PATCH', body: { active } }).then((r) => r.data);
export const deleteCategory = (id) =>
  apiRequest(`/api/financial/categories/${id}`, { method: 'DELETE' });

// ── Lançamentos ───────────────────────────────────────────────────────────
export const getTransactions = (filters = {}) =>
  apiRequest(`/api/financial/transactions${qs(filters)}`);
export const getTransaction = (id) =>
  apiRequest(`/api/financial/transactions/${id}`).then((r) => r.data);
export const createTransaction = (body) =>
  apiRequest('/api/financial/transactions', { method: 'POST', body }).then((r) => r.data);
export const updateTransaction = (id, body) =>
  apiRequest(`/api/financial/transactions/${id}`, { method: 'PUT', body }).then((r) => r.data);
export const cancelTransaction = (id) =>
  apiRequest(`/api/financial/transactions/${id}/cancel`, { method: 'POST' }).then((r) => r.data);

// ── Caixa Semanal ─────────────────────────────────────────────────────────
export const getCashbox = (filters = {}) =>
  apiRequest(`/api/financial/cashbox${qs(filters)}`).then((r) => r.data);

// ── Faturamentos ──────────────────────────────────────────────────────────
export const getBillings = (filters = {}) =>
  apiRequest(`/api/financial/billings${qs(filters)}`);
export const getBilling = (id) =>
  apiRequest(`/api/financial/billings/${id}`).then((r) => r.data);
export const createBilling = (body) =>
  apiRequest('/api/financial/billings', { method: 'POST', body }).then((r) => r.data);
export const updateBilling = (id, body) =>
  apiRequest(`/api/financial/billings/${id}`, { method: 'PUT', body }).then((r) => r.data);
export const cancelBilling = (id) =>
  apiRequest(`/api/financial/billings/${id}/cancel`, { method: 'POST' }).then((r) => r.data);

// ── Pagamentos ────────────────────────────────────────────────────────────
export const getPayments = (filters = {}) =>
  apiRequest(`/api/financial/payments${qs(filters)}`);
export const registerPayment = (body) =>
  apiRequest('/api/financial/payments', { method: 'POST', body }).then((r) => r.data);
export const cancelPayment = (id, reason) =>
  apiRequest(`/api/financial/payments/${id}/cancel`, { method: 'POST', body: { reason } }).then((r) => r.data);

// ── Recibos ───────────────────────────────────────────────────────────────
export const getReceipts = (filters = {}) =>
  apiRequest(`/api/financial/receipts${qs(filters)}`);
export const getReceipt = (id) =>
  apiRequest(`/api/financial/receipts/${id}`).then((r) => r.data);
export const issueReceipt = (body) =>
  apiRequest('/api/financial/receipts', { method: 'POST', body }).then((r) => r.data);
export const cancelReceipt = (id, reason) =>
  apiRequest(`/api/financial/receipts/${id}/cancel`, { method: 'POST', body: { reason } }).then((r) => r.data);
export const reissueReceipt = (id, reason) =>
  apiRequest(`/api/financial/receipts/${id}/reissue`, { method: 'POST', body: { reason } }).then((r) => r.data);
export const receiptPdfUrl = (id, download = false) =>
  `/api/financial/receipts/${id}/pdf${download ? '?download=1' : ''}`;

// ── Configurações ─────────────────────────────────────────────────────────
export const getFinancialSettings = () =>
  apiRequest('/api/financial/settings').then((r) => r.data);
export const updateFinancialSettings = (body) =>
  apiRequest('/api/financial/settings', { method: 'PUT', body }).then((r) => r.data);

// ── Resumo / Dashboard / Histórico ────────────────────────────────────────
export const getFinanceDashboard = () =>
  apiRequest('/api/financial/summary/dashboard').then((r) => r.data);
// Dashboard financeiro completo (KPIs + séries p/ gráficos), filtrado por período
export const getFinanceOverview = (params = {}) =>
  apiRequest(`/api/financial/summary/overview${qs(params)}`).then((r) => r.data);
// Indicadores do topo de Faturamentos (respeitam os filtros da lista)
export const getBillingStats = (filters = {}) =>
  apiRequest(`/api/financial/billings/stats${qs(filters)}`).then((r) => r.data);
export const getClientFinance = (clientId) =>
  apiRequest(`/api/financial/summary/client/${clientId}`).then((r) => r.data);
export const getFineFinance = (fineId) =>
  apiRequest(`/api/financial/summary/fine/${fineId}`).then((r) => r.data);

// ── Constantes de apresentação (pt-BR) ────────────────────────────────────
export const PAYMENT_METHODS = [
  { value: 'pix', label: 'Pix' },
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'cartao_credito', label: 'Cartão de crédito' },
  { value: 'cartao_debito', label: 'Cartão de débito' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'transferencia', label: 'Transferência' },
  { value: 'outro', label: 'Outro' },
];
export const PAYMENT_METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export const TRANSACTION_STATUS = [
  { value: 'previsto', label: 'Previsto' },
  { value: 'pendente', label: 'Pendente' },
  { value: 'pago', label: 'Pago' },
  { value: 'recebido', label: 'Recebido' },
  { value: 'vencido', label: 'Vencido' },
  { value: 'cancelado', label: 'Cancelado' },
];
export const TRANSACTION_STATUS_LABELS = Object.fromEntries(TRANSACTION_STATUS.map((s) => [s.value, s.label]));

export const BILLING_STATUS = [
  { value: 'nao_faturado', label: 'Não faturado' },
  { value: 'faturado', label: 'Faturado' },
  { value: 'parcialmente_pago', label: 'Parcialmente pago' },
  { value: 'pago', label: 'Pago' },
  { value: 'vencido', label: 'Vencido' },
  { value: 'cancelado', label: 'Cancelado' },
];
export const BILLING_STATUS_LABELS = Object.fromEntries(BILLING_STATUS.map((s) => [s.value, s.label]));
