'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const operations = require('../models/operationsModels');
const fineModel = require('../models/fineModels');
const saas = require('../models/saasModels');
const { toCsv } = require('../services/csvService');
const { checkPermission, requireAdmin, requireAdminOrManager } = require('../middlewares/checkPermission');

const fail = (res, error, status = 500) => {
  console.error('[operations]', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Erro interno do servidor.' : (error?.message || 'Nao foi possivel concluir a acao.'),
  });
};

router.get('/settings', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await operations.getSettings(req.tenantId) });
  } catch (error) { fail(res, error); }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const result = await operations.updateSettings(req.tenantId, req.userId, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    await saas.createActivityLog({
      tenant_id: req.tenantId,
      user_id: req.userId,
      action: 'operation_settings_updated',
      entity_type: 'configuracao',
      description: 'Configuracao operacional atualizada',
      metadata: result.settings,
    });
    res.json({ success: true, data: result.settings });
  } catch (error) { fail(res, error); }
});

router.get('/my-work', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await operations.getMyWork(req.tenantId, req.userId, req.userRole) });
  } catch (error) { fail(res, error); }
});

router.get('/attention', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await operations.getAttention(req.tenantId) });
  } catch (error) { fail(res, error); }
});

router.get('/dashboard', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await operations.getDashboardV2(req.tenantId, req.query) });
  } catch (error) { fail(res, error); }
});

router.get('/quality', requireAdminOrManager, async (req, res) => {
  try {
    res.json({ success: true, data: await operations.getQualityIssues(req.tenantId, req.query) });
  } catch (error) { fail(res, error); }
});

router.get('/search', checkPermission('fines:read'), async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const rows = await operations.globalSearch(req.tenantId, q, req.query);
    res.json({ success: true, data: rows });
  } catch (error) { fail(res, error); }
});

router.get('/saved-views', checkPermission('fines:read'), async (req, res) => {
  try {
    res.json({ success: true, data: await operations.listViews(req.tenantId, req.userId, req.query.type) });
  } catch (error) { fail(res, error); }
});

router.post('/saved-views', checkPermission('fines:read'), async (req, res) => {
  try {
    const result = await operations.createView(req.tenantId, req.userId, req.userRole, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    res.status(201).json({ success: true, data: result.view });
  } catch (error) { fail(res, error); }
});

router.put('/saved-views/:id', checkPermission('fines:read'), async (req, res) => {
  try {
    const result = await operations.updateView(req.tenantId, req.userId, req.userRole, req.params.id, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });
    res.json({ success: true, data: result.view });
  } catch (error) { fail(res, error); }
});

router.delete('/saved-views/:id', checkPermission('fines:read'), async (req, res) => {
  try {
    const removed = await operations.deleteView(req.tenantId, req.userId, req.params.id);
    if (!removed) return res.status(404).json({ success: false, error: 'Visualizacao nao encontrada.' });
    res.json({ success: true, data: removed });
  } catch (error) { fail(res, error); }
});

router.get('/reports/:type', checkPermission('reports:read'), async (req, res) => {
  try {
    const result = await operations.reportData(req.tenantId, req.params.type, req.query);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    if (req.query.format === 'csv') {
      const keys = result.rows[0] ? Object.keys(result.rows[0]) : [];
      const columns = keys.map((key) => ({ label: key, value: key }));
      const csv = toCsv(result.rows, columns);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sisv-${req.params.type}.csv"`);
      return res.send(csv);
    }
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error); }
});

router.get('/audit', requireAdminOrManager, async (req, res) => {
  try {
    res.json({ success: true, ...(await operations.listAudit(req.tenantId, req.query)) });
  } catch (error) { fail(res, error); }
});

router.post('/export/processes', checkPermission('reports:export'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
    if (ids.length > 200) return res.status(400).json({ success: false, error: 'Limite de 200 processos por exportacao.' });
    let rows;
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(',');
      const result = await pool.query(
        `SELECT f.id, c.name AS cliente, c.cpf AS documento_cliente,
                f.fine_number AS numero, f.protocol_number AS protocolo,
                st.label AS servico, f.stage AS etapa, f.status,
                u.name AS responsavel, d.name AS setor, f.due_date AS prazo,
                COALESCE(f.last_moved_at, f.updated_at) AS ultima_movimentacao,
                f.finalized_at AS finalizado_em
         FROM fines f
         LEFT JOIN clients c ON c.id=f.client_id AND c.tenant_id=f.tenant_id
         LEFT JOIN tenant_service_types st ON st.id=f.tenant_service_type_id AND st.tenant_id=f.tenant_id
         LEFT JOIN users u ON u.id=f.seller_id AND u.tenant_id=f.tenant_id
         LEFT JOIN departments d ON d.id=f.department_id AND d.tenant_id=f.tenant_id
         WHERE f.tenant_id=$1 AND f.id IN (${placeholders})
         ORDER BY COALESCE(f.last_moved_at, f.updated_at) DESC`,
        [req.tenantId, ...ids]
      );
      rows = result.rows;
    } else {
      const result = await fineModel.listProcesses(req.tenantId, {
        ...(req.body?.filters || {}),
        limit: 200,
        offset: 0,
        sort_by: req.body?.sort_by,
        sort_dir: req.body?.sort_dir,
      });
      rows = result.rows;
    }
    const columns = [
      ['Cliente', (r) => r.cliente ?? r.client_name],
      ['CPF/CNPJ', (r) => r.documento_cliente ?? r.client_cpf],
      ['Numero', (r) => r.numero ?? r.fine_number],
      ['Protocolo', (r) => r.protocolo ?? r.protocol_number],
      ['Servico', (r) => r.servico ?? r.service_type_label],
      ['Etapa', (r) => r.etapa ?? r.stage],
      ['Status', (r) => r.status],
      ['Responsavel', (r) => r.responsavel ?? r.seller_name],
      ['Setor', (r) => r.setor ?? r.department_name],
      ['Prazo', (r) => r.prazo ?? r.due_date],
      ['Ultima movimentacao', (r) => r.ultima_movimentacao ?? r.last_moved_at ?? r.updated_at],
      ['Finalizado em', (r) => r.finalizado_em ?? r.finalized_at],
    ].map(([label, value]) => ({ label, value }));
    const csv = toCsv(rows, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="processos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) { fail(res, error); }
});

module.exports = router;
