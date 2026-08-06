// =============================================================================
// financeRepo.js — Repositório transacional de produção (usa pg).
//
// Encapsula TODAS as queries com efeito colateral usadas pelos serviços
// transacionais (pagamentos e recibos). Os serviços dependem apenas desta
// interface, o que permite injetar um repositório em memória nos testes.
// =============================================================================

function createTx(client) {
  const q = (text, params) => client.query(text, params);
  return {
    // ── Faturamento ──────────────────────────────────────────────────────────
    async getBillingForUpdate(billingId, tenantId) {
      const { rows } = await q(
        `SELECT * FROM service_billings WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [billingId, tenantId]
      );
      return rows[0] || null;
    },
    async sumConfirmedPayments(billingId, tenantId) {
      const { rows } = await q(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
         WHERE billing_id = $1 AND tenant_id = $2 AND status = 'confirmado'`,
        [billingId, tenantId]
      );
      return Number(rows[0].total);
    },
    async updateBillingPaid(billingId, tenantId, paidAmount, status) {
      const { rows } = await q(
        `UPDATE service_billings
           SET paid_amount = $1, financial_status = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4 RETURNING *`,
        [paidAmount, status, billingId, tenantId]
      );
      return rows[0];
    },

    // ── Pagamentos ───────────────────────────────────────────────────────────
    async insertPayment(data) {
      const { rows } = await q(
        `INSERT INTO payments (
           tenant_id, billing_id, client_id, fine_id, amount, payment_date,
           payment_method, status, installment_number, installments_total,
           is_deposit, notes, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmado',$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          data.tenant_id, data.billing_id || null, data.client_id || null,
          data.fine_id || null, data.amount, data.payment_date || null,
          data.payment_method || null, data.installment_number || 1,
          data.installments_total || 1, data.is_deposit || false,
          data.notes || null, data.created_by || null,
        ]
      );
      return rows[0];
    },
    async getPaymentForUpdate(paymentId, tenantId) {
      const { rows } = await q(
        `SELECT * FROM payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [paymentId, tenantId]
      );
      return rows[0] || null;
    },
    async cancelPaymentRow(paymentId, tenantId, reason) {
      const { rows } = await q(
        `UPDATE payments
           SET status = 'cancelado', canceled_at = NOW(), cancel_reason = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND status = 'confirmado' RETURNING *`,
        [reason || null, paymentId, tenantId]
      );
      return rows[0] || null;
    },

    // ── Lançamentos (Caixa) ligados a pagamento ──────────────────────────────
    // Idempotente: o índice único parcial uq_fin_tx_payment garante 1 entrada/pagamento.
    async insertPaymentEntryIfAbsent(data) {
      const { rows } = await q(
        `INSERT INTO financial_transactions (
           tenant_id, type, category_id, description, amount, transaction_date,
           payment_method, status, client_id, fine_id, billing_id, payment_id,
           origin, created_by
         ) VALUES ($1,'entrada',$2,$3,$4,$5,$6,'recebido',$7,$8,$9,$10,'pagamento',$11)
         ON CONFLICT (payment_id) DO NOTHING
         RETURNING *`,
        [
          data.tenant_id, data.category_id || null, data.description || null,
          data.amount, data.transaction_date || null, data.payment_method || null,
          data.client_id || null, data.fine_id || null, data.billing_id || null,
          data.payment_id, data.created_by || null,
        ]
      );
      return rows[0] || null;
    },
    async cancelPaymentEntry(paymentId, tenantId) {
      const { rows } = await q(
        `UPDATE financial_transactions
           SET status = 'cancelado', canceled_at = NOW(), updated_at = NOW()
         WHERE payment_id = $1 AND tenant_id = $2 AND status <> 'cancelado' RETURNING *`,
        [paymentId, tenantId]
      );
      return rows[0] || null;
    },

    // ── Recibos ──────────────────────────────────────────────────────────────
    async ensureSettingsForUpdate(tenantId, defaultPrefix) {
      await q(
        `INSERT INTO tenant_financial_settings (tenant_id, receipt_prefix)
         VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, defaultPrefix || 'SISV']
      );
      const { rows } = await q(
        `SELECT * FROM tenant_financial_settings WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId]
      );
      return rows[0];
    },
    async bumpReceiptNumber(tenantId) {
      const { rows } = await q(
        `UPDATE tenant_financial_settings
           SET last_receipt_number = last_receipt_number + 1, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING last_receipt_number AS number, receipt_prefix AS prefix`,
        [tenantId]
      );
      return rows[0];
    },
    async getPayment(paymentId, tenantId) {
      const { rows } = await q(
        `SELECT * FROM payments WHERE id = $1 AND tenant_id = $2`,
        [paymentId, tenantId]
      );
      return rows[0] || null;
    },
    async getActiveReceiptByPayment(paymentId, tenantId) {
      const { rows } = await q(
        `SELECT * FROM receipts WHERE payment_id = $1 AND tenant_id = $2 AND status = 'emitido' LIMIT 1`,
        [paymentId, tenantId]
      );
      return rows[0] || null;
    },
    async insertReceipt(data) {
      const { rows } = await q(
        `INSERT INTO receipts (
           tenant_id, number, prefix, full_number, issue_date,
           client_id, payment_id, billing_id, fine_id,
           client_name, client_document, service_description, amount, payment_method,
           issuer_name, issuer_document, issuer_address, notes, created_by, created_by_name
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          data.tenant_id, data.number, data.prefix, data.full_number, data.issue_date || null,
          data.client_id || null, data.payment_id || null, data.billing_id || null, data.fine_id || null,
          data.client_name || null, data.client_document || null, data.service_description || null,
          data.amount || 0, data.payment_method || null,
          data.issuer_name || null, data.issuer_document || null, data.issuer_address || null,
          data.notes || null, data.created_by || null, data.created_by_name || null,
        ]
      );
      return rows[0];
    },
    async getReceiptForUpdate(receiptId, tenantId) {
      const { rows } = await q(
        `SELECT * FROM receipts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [receiptId, tenantId]
      );
      return rows[0] || null;
    },
    async cancelReceiptRow(receiptId, tenantId, reason) {
      const { rows } = await q(
        `UPDATE receipts
           SET status = 'cancelado', canceled_at = NOW(), cancel_reason = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND status = 'emitido' RETURNING *`,
        [reason || null, receiptId, tenantId]
      );
      return rows[0] || null;
    },
  };
}

function createDbRepo(customPool) {
  // Lazy require: só carrega o pool (pg) quando o repo de produção é usado,
  // permitindo que os serviços sejam testados sem banco/dependências instaladas.
  const activePool = customPool || require('../../config/db');
  return {
    async withTransaction(fn) {
      const client = await activePool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(createTx(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createDbRepo, createTx };
