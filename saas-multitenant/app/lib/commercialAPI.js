// =============================================================================
// commercialAPI.js — cliente das rotas do SISV 2.0 (comercial, back office,
// execução, financeiro operacional e finalização).
//
// Nenhuma regra de negócio vive aqui: situações, transições e permissões vêm do
// backend (endpoints /meta). O frontend apenas apresenta o que o servidor
// autoriza — nada é decidido nem persistido só na tela.
// =============================================================================

import { apiRequest, downloadAuthenticated } from './api';

const query = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  );
  const qs = new URLSearchParams(clean).toString();
  return qs ? `?${qs}` : '';
};

/** Listagens padronizadas: { rows, total, page, limit }. */
const listOf = async (path, filters = {}) => {
  const response = await apiRequest(`${path}${query(filters)}`);
  return { rows: response.rows || [], total: response.total || 0, page: response.page || 1 };
};

const dataOf = async (path, options) => (await apiRequest(path, options)).data;

// ── Fornecedores / prestadores / parceiros ───────────────────────────────────
export const listSuppliers = (filters) => listOf('/api/commercial/suppliers', filters);
export const getSupplier = (id) => dataOf(`/api/commercial/suppliers/${id}`);
export const createSupplier = (body) => dataOf('/api/commercial/suppliers', { method: 'POST', body });
export const updateSupplier = (id, body) => dataOf(`/api/commercial/suppliers/${id}`, { method: 'PUT', body });
export const setSupplierActive = (id, active, reason) =>
  dataOf(`/api/commercial/suppliers/${id}/status`, { method: 'POST', body: { active, reason } });
export const exportSuppliers = () =>
  downloadAuthenticated('/api/commercial/suppliers?format=csv', { filename: 'sisv-fornecedores.csv' });
export const listActivePartners = () => dataOf('/api/commercial/partners');

// ── Catálogo ─────────────────────────────────────────────────────────────────
export const listCatalog = (filters) => listOf('/api/commercial/catalog', filters);
export const getCatalogItem = (id) => dataOf(`/api/commercial/catalog/${id}`);
export const createCatalogItem = (body) => dataOf('/api/commercial/catalog', { method: 'POST', body });
export const updateCatalogItem = (id, body) => dataOf(`/api/commercial/catalog/${id}`, { method: 'PUT', body });
export const deleteCatalogItem = (id, reason) =>
  dataOf(`/api/commercial/catalog/${id}`, { method: 'DELETE', body: { reason } });

// ── Tabelas de preço ─────────────────────────────────────────────────────────
export const listPriceTables = (filters) => listOf('/api/commercial/price-tables', filters);
export const getPriceTable = (id) => dataOf(`/api/commercial/price-tables/${id}`);
export const createPriceTable = (body) => dataOf('/api/commercial/price-tables', { method: 'POST', body });
export const updatePriceTable = (id, body) => dataOf(`/api/commercial/price-tables/${id}`, { method: 'PUT', body });
export const deletePriceTable = (id, reason) =>
  dataOf(`/api/commercial/price-tables/${id}`, { method: 'DELETE', body: { reason } });
export const setPriceTableItems = (id, items) =>
  dataOf(`/api/commercial/price-tables/${id}/items`, { method: 'PUT', body: { items } });
export const duplicatePriceTable = (id, name) =>
  dataOf(`/api/commercial/price-tables/${id}/duplicate`, { method: 'POST', body: { name } });
export const resolvePrice = (params) => dataOf(`/api/commercial/resolve-price${query(params)}`);

// ── Pedidos ──────────────────────────────────────────────────────────────────
export const getOrderMeta = () => dataOf('/api/orders/meta');
export const listOrders = (filters) => listOf('/api/orders', filters);
export const getOrder = (id) => dataOf(`/api/orders/${id}`);
export const createOrder = (body) => dataOf('/api/orders', { method: 'POST', body });
export const updateOrder = (id, body) => dataOf(`/api/orders/${id}`, { method: 'PUT', body });
export const addOrderItem = (id, body) => dataOf(`/api/orders/${id}/items`, { method: 'POST', body });
export const updateOrderItem = (id, itemId, body) =>
  dataOf(`/api/orders/${id}/items/${itemId}`, { method: 'PUT', body });
export const removeOrderItem = (id, itemId) =>
  dataOf(`/api/orders/${id}/items/${itemId}`, { method: 'DELETE' });
export const changeOrderStatus = (id, body) => dataOf(`/api/orders/${id}/status`, { method: 'POST', body });
export const validateOrder = (id, body) => dataOf(`/api/orders/${id}/validate`, { method: 'POST', body });
export const claimOrder = (id) => dataOf(`/api/orders/${id}/claim`, { method: 'POST' });
export const exportOrders = (filters) =>
  downloadAuthenticated(`/api/orders${query({ ...filters, format: 'csv' })}`, { filename: 'sisv-pedidos.csv' });

// ── Recebíveis e pagamentos do cliente ───────────────────────────────────────
export const getReceivableMeta = () => dataOf('/api/receivables/meta');
export const listReceivables = (filters) => listOf('/api/receivables', filters);
export const getReceivable = (id) => dataOf(`/api/receivables/${id}`);
export const createReceivable = (body) => dataOf('/api/receivables', { method: 'POST', body });
export const listCustomerPayments = (filters) => listOf('/api/customer-payments', filters);
export const registerPayment = (body) => dataOf('/api/customer-payments', { method: 'POST', body });
/** Validação explícita: retorna { payment, receivable, sale_ready }. */
export const decidePayment = (id, body) =>
  dataOf(`/api/customer-payments/${id}/decision`, { method: 'POST', body });
export const reversePayment = (id, reason) =>
  dataOf(`/api/customer-payments/${id}/reverse`, { method: 'POST', body: { reason } });

// ── Vendas ───────────────────────────────────────────────────────────────────
export const listSales = (filters) => listOf('/api/sales', filters);
export const getSale = (id) => dataOf(`/api/sales/${id}`);
/** Prévia somente-leitura exibida antes da confirmação consciente (§22). */
export const previewSale = (orderId) => dataOf(`/api/sales/preview/${orderId}`);
export const confirmSale = (orderId, body = {}) =>
  dataOf(`/api/sales/confirm/${orderId}`, { method: 'POST', body });
export const changeSaleStatus = (id, body) => dataOf(`/api/sales/${id}/status`, { method: 'POST', body });

// ── Ordens de serviço e execução ─────────────────────────────────────────────
export const getServiceOrderMeta = () => dataOf('/api/service-orders/meta');
export const listServiceOrders = (filters) => listOf('/api/service-orders', filters);
export const getServiceOrder = (id) => dataOf(`/api/service-orders/${id}`);
export const createServiceOrder = (body) => dataOf('/api/service-orders', { method: 'POST', body });
export const changeServiceOrderStatus = (id, body) =>
  dataOf(`/api/service-orders/${id}/status`, { method: 'POST', body });
export const assignServiceOrder = (id, body) => dataOf(`/api/service-orders/${id}/assign`, { method: 'POST', body });
export const addServiceOrderProgress = (id, note) =>
  dataOf(`/api/service-orders/${id}/progress`, { method: 'POST', body: { note } });
export const linkItemProcess = (id, itemId, processId) =>
  dataOf(`/api/service-orders/${id}/items/${itemId}/process`, { method: 'POST', body: { process_id: processId } });
export const addExecutionCost = (id, body) => dataOf(`/api/service-orders/${id}/costs`, { method: 'POST', body });
export const updateExecutionCost = (costId, body) =>
  dataOf(`/api/service-orders/costs/${costId}`, { method: 'PUT', body });

// ── Obrigações: ação guiada em dois passos (§28) ─────────────────────────────
/** Passo 1 — prévia calculada. Nada é gravado. */
export const previewObligations = (saleId) => dataOf(`/api/service-orders/obligations/${saleId}`);
/** Passo 2 — grava apenas o que o usuário revisou e confirmou. */
export const confirmObligations = (saleId, obligations) =>
  dataOf(`/api/service-orders/obligations/${saleId}`, { method: 'POST', body: { obligations } });

// ── Contas a pagar e comissões ───────────────────────────────────────────────
export const getPayableMeta = () => dataOf('/api/payables/meta');
export const listPayables = (filters) => listOf('/api/payables', filters);
export const createPayable = (body) => dataOf('/api/payables', { method: 'POST', body });
export const changePayableStatus = (id, body) => dataOf(`/api/payables/${id}/status`, { method: 'POST', body });
export const listCommissions = (filters) => listOf('/api/commissions', filters);
export const changeCommissionStatus = (id, body) =>
  dataOf(`/api/commissions/${id}/status`, { method: 'POST', body });

// ── Templates, documentos, recibos e contratos ───────────────────────────────
export const getTemplateFields = () => dataOf('/api/doc-templates/fields');
export const listTemplates = (filters) => listOf('/api/doc-templates', filters);
export const getTemplate = (id) => dataOf(`/api/doc-templates/${id}`);
export const createTemplate = (body) => dataOf('/api/doc-templates', { method: 'POST', body });
export const updateTemplate = (id, body) => dataOf(`/api/doc-templates/${id}`, { method: 'PUT', body });
export const deleteTemplate = (id, reason) =>
  dataOf(`/api/doc-templates/${id}`, { method: 'DELETE', body: { reason } });
export const listCommercialDocs = (filters) => listOf('/api/commercial-docs', filters);
export const getCommercialDoc = (id) => dataOf(`/api/commercial-docs/${id}`);
export const updateCommercialDoc = (id, body) =>
  dataOf(`/api/commercial-docs/${id}`, { method: 'PUT', body });
export const generateDocument = (body) => dataOf('/api/commercial-docs/generate', { method: 'POST', body });
export const attachDocument = (body) => dataOf('/api/commercial-docs/attach', { method: 'POST', body });
export const cancelDocument = (id, reason) =>
  dataOf(`/api/commercial-docs/${id}/cancel`, { method: 'POST', body: { reason } });
export const deleteCommercialDoc = (id, reason) =>
  dataOf(`/api/commercial-docs/${id}`, { method: 'DELETE', body: { reason } });
/** Recibo operacional — não equivale a nota fiscal (§15). */
export const issueReceipt = (paymentId, body = {}) =>
  dataOf(`/api/commercial-docs/receipts/${paymentId}`, { method: 'POST', body });
export const listContracts = (filters) => listOf('/api/contracts-op', filters);
export const createContract = (body) => dataOf('/api/contracts-op', { method: 'POST', body });
export const updateContract = (id, body) => dataOf(`/api/contracts-op/${id}`, { method: 'PUT', body });
export const replaceContract = (id, body) => dataOf(`/api/contracts-op/${id}/replace`, { method: 'POST', body });
export const deleteContract = (id, reason) =>
  dataOf(`/api/contracts-op/${id}`, { method: 'DELETE', body: { reason } });

// ── Nota fiscal: REGISTRO MANUAL, sem emissão nem integração fiscal (§32) ────
export const getFiscalMeta = () => dataOf('/api/fiscal-documents/meta');
export const listFiscalDocuments = (filters) => listOf('/api/fiscal-documents', filters);
export const saveFiscalDocument = (body) => dataOf('/api/fiscal-documents', { method: 'POST', body });

// ── Finalização e arquivamento ───────────────────────────────────────────────
export const getFinalizationChecklist = (serviceOrderId) =>
  dataOf(`/api/closure/checklist/${serviceOrderId}`);
export const finalizeServiceOrder = (serviceOrderId, body = {}) =>
  dataOf(`/api/closure/finalize/${serviceOrderId}`, { method: 'POST', body });
export const archiveServiceOrder = (serviceOrderId) =>
  dataOf(`/api/closure/archive/${serviceOrderId}`, { method: 'POST' });
export const reopenServiceOrder = (serviceOrderId, reason) =>
  dataOf(`/api/closure/reopen/${serviceOrderId}`, { method: 'POST', body: { reason } });

// ── Back office, dashboard, relatórios, 360 e busca ──────────────────────────
export const getQueues = () => dataOf('/api/backoffice/queues');
export const getQueue = (key, filters) => {
  const path = `/api/backoffice/queues/${key}${query(filters)}`;
  return apiRequest(path).then((response) => ({
    key, label: response.label, rows: response.rows || [], total: response.total || 0,
  }));
};
export const getExecutiveDashboard = (filters) => dataOf(`/api/backoffice/dashboard${query(filters)}`);
export const listReports = () => dataOf('/api/backoffice/reports');
export const getReport = (type, filters) => dataOf(`/api/backoffice/reports/${type}${query(filters)}`);
export const exportReport = (type, filters) =>
  downloadAuthenticated(`/api/backoffice/reports/${type}${query({ ...filters, format: 'csv' })}`,
    { filename: `sisv-${type}.csv` });
export const getClientOverview = (clientId) => dataOf(`/api/backoffice/clients/${clientId}/overview`);
export const getClientTab = (clientId, tab, filters) => {
  const path = `/api/backoffice/clients/${clientId}/tabs/${tab}${query(filters)}`;
  return apiRequest(path).then((response) => ({
    rows: response.rows || [], total: response.total || 0, page: response.page || 1,
  }));
};
export const commercialSearch = (term) => dataOf(`/api/backoffice/search${query({ q: term })}`);
