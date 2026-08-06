'use strict';
// Smoke test: garante que todos os módulos do financeiro CARREGAM sem erro
// (sintaxe, require paths, exports). Não conecta ao banco — apenas require().
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/db?sslmode=disable';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('models financeiros carregam', () => {
  assert.ok(require('../models/financialCategoryModels').listCategories);
  assert.ok(require('../models/serviceBillingModels').createBilling);
  assert.ok(require('../models/paymentModels').listPayments);
  assert.ok(require('../models/financialTransactionModels').getSummary);
  assert.ok(require('../models/receiptModels').listReceipts);
  assert.ok(require('../models/tenantFinancialSettingsModels').ensureSettings);
});

test('services financeiros carregam', () => {
  assert.ok(require('../services/finance/calc').computeBilling);
  assert.ok(require('../services/finance/constants').DEFAULT_CATEGORIES);
  assert.ok(require('../services/finance/paymentService').confirmPayment);
  assert.ok(require('../services/finance/receiptService').issueReceipt);
  assert.ok(require('../services/finance/financeRepo').createDbRepo);
  assert.ok(require('../services/finance/branding').resolveBranding);
  assert.ok(require('../services/finance/pdfService').buildReceiptPdf);
});

test('middleware e rotas financeiras carregam', () => {
  assert.ok(require('../middlewares/financeAccess').requireFinanceManage);
  assert.ok(require('../routes/financialRoutes'));
  assert.ok(require('../routes/financial/categoryRoutes'));
  assert.ok(require('../routes/financial/transactionRoutes'));
  assert.ok(require('../routes/financial/cashboxRoutes'));
  assert.ok(require('../routes/financial/billingRoutes'));
  assert.ok(require('../routes/financial/paymentRoutes'));
  assert.ok(require('../routes/financial/receiptRoutes'));
  assert.ok(require('../routes/financial/settingsRoutes'));
  assert.ok(require('../routes/financial/summaryRoutes'));
});

test('branding: usa identidade do tenant quando existe; senão SISV/TELUN', () => {
  const { resolveBranding } = require('../services/finance/branding');
  const own = resolveBranding({ tenant: { name: 'Empresa Exemplo', logo_url: '/logos/x.png' } });
  assert.equal(own.name, 'Empresa Exemplo');
  assert.equal(own.is_default, false);
  assert.equal(own.signature, null); // não força assinatura padrão sobre marca própria do tenant

  const def = resolveBranding({ tenant: null, settings: null });
  assert.equal(def.name, 'SISV');
  assert.equal(def.is_default, true);
  assert.equal(def.signature, 'Uma solução TELUN');
});
