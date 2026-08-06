'use strict';

// =============================================================================
// backofficeModels.js — filas operacionais do back office (§16), dashboard
// executivo (§36), relatorios (§37) e visao 360 do cliente (§34).
//
// As filas nao sao um dashboard decorativo: cada uma devolve os REGISTROS da
// fila (com o que o operador precisa para agir) e o contador correspondente,
// para que a interface abra a lista ao clicar no indicador (§36).
//
// A visao 360 carrega por ABA e paginada (§34) — nunca tudo de uma vez.
// =============================================================================

const pool = require('../config/db');
const { clean, uuidOrNull, oneOf, dateOrNull, paging } = require('../services/commercialCommon');

// Definicao unica das filas: usada pelo resumo (contadores) e pela abertura de
// cada fila, para que numero e lista nunca divirjam.
const QUEUES = Object.freeze({
  pedidos_validacao: {
    label: 'Pedidos aguardando validacao',
    sql: `SELECT o.id, o.number, o.total, o.status, o.sent_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM orders o
            JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
            LEFT JOIN users u ON u.id = o.owner_id
           WHERE o.tenant_id = $1 AND o.status IN ('enviado_validacao','em_validacao')`,
    order: 'ORDER BY o.sent_at ASC NULLS LAST',
  },
  documentos_pendentes: {
    label: 'Pedidos com documentos pendentes',
    sql: `SELECT o.id, o.number, o.total, o.status, o.updated_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM orders o
            JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
            LEFT JOIN users u ON u.id = o.owner_id
           WHERE o.tenant_id = $1 AND o.status = 'aguardando_documentos'`,
    order: 'ORDER BY o.updated_at ASC',
  },
  pagamentos_conferencia: {
    label: 'Pagamentos aguardando conferencia',
    sql: `SELECT p.id, p.amount, p.paid_at, p.payment_method, p.proof_url, p.status,
                 p.created_at AS since, c.name AS client_name, o.number AS order_number,
                 o.id AS order_id
            FROM customer_payments p
            JOIN clients c ON c.id = p.client_id AND c.tenant_id = p.tenant_id
            LEFT JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
           WHERE p.tenant_id = $1 AND p.status IN ('informado','em_validacao')`,
    order: 'ORDER BY p.created_at ASC',
  },
  // As filas de "ainda nao aconteceu" usam anti-join (LEFT JOIN ... IS NULL) em
  // vez de NOT EXISTS correlacionado: mesma semantica, e roda tambem no Postgres
  // em memoria do servidor de demonstracao, que o E2E usa.
  pedidos_inconsistentes: {
    label: 'Pedidos com inconsistencia',
    // Inconsistencia = sem responsavel, total zerado ou sem nenhum item ativo.
    // Sao os casos que travam a conferencia do back office.
    sql: `SELECT o.id, o.number, o.total, o.status, o.updated_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM orders o
            JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
            LEFT JOIN users u ON u.id = o.owner_id
            LEFT JOIN (
              SELECT order_id, COUNT(*)::int AS active_items
                FROM order_items WHERE status = 'ativo' GROUP BY order_id
            ) oi ON oi.order_id = o.id
           WHERE o.tenant_id = $1
             AND o.status NOT IN ('cancelado','convertido')
             AND (o.owner_id IS NULL OR o.total <= 0 OR COALESCE(oi.active_items, 0) = 0)`,
    order: 'ORDER BY o.updated_at ASC',
  },
  pedidos_prontos_venda: {
    label: 'Pedidos prontos para virar venda',
    sql: `SELECT o.id, o.number, o.total, o.status, o.approved_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM orders o
            JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
            LEFT JOIN users u ON u.id = o.owner_id
            LEFT JOIN sales s ON s.order_id = o.id AND s.tenant_id = o.tenant_id
           WHERE o.tenant_id = $1 AND o.status = 'aprovado' AND s.id IS NULL`,
    order: 'ORDER BY o.approved_at ASC NULLS LAST',
  },
  vendas_sem_ordem: {
    label: 'Vendas aguardando ordem de servico',
    sql: `SELECT s.id, s.number, s.net_amount AS total, s.status, s.confirmed_at AS since,
                 c.name AS client_name, u.name AS owner_name
            FROM sales s
            JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
            LEFT JOIN users u ON u.id = s.owner_id
            LEFT JOIN service_orders so ON so.sale_id = s.id AND so.tenant_id = s.tenant_id
           WHERE s.tenant_id = $1 AND s.status = 'confirmada' AND so.id IS NULL`,
    order: 'ORDER BY s.confirmed_at ASC NULLS LAST',
  },
  execucao_liberacao: {
    label: 'Ordens aguardando liberacao',
    sql: `SELECT so.id, so.number, so.status, so.due_date, so.created_at AS since,
                 c.name AS client_name, u.name AS owner_name
            FROM service_orders so
            JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
            LEFT JOIN users u ON u.id = so.owner_id
           WHERE so.tenant_id = $1 AND so.status = 'rascunho'`,
    order: 'ORDER BY so.created_at ASC',
  },
  finalizacoes_pendentes: {
    label: 'Finalizacoes pendentes',
    sql: `SELECT so.id, so.number, so.status, so.finished_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM service_orders so
            JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
            LEFT JOIN users u ON u.id = so.owner_id
            LEFT JOIN finalization_records fr ON fr.service_order_id = so.id
                 AND fr.tenant_id = so.tenant_id
           WHERE so.tenant_id = $1 AND so.status = 'concluida' AND fr.id IS NULL`,
    order: 'ORDER BY so.finished_at ASC NULLS LAST',
  },
  notas_pendentes: {
    label: 'Notas fiscais pendentes',
    sql: `SELECT f.id, f.status, f.amount AS total, f.created_at AS since, s.number AS sale_number,
                 s.id AS sale_id, c.name AS client_name
            FROM fiscal_documents f
            LEFT JOIN sales s ON s.id = f.sale_id AND s.tenant_id = f.tenant_id
            LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
           WHERE f.tenant_id = $1 AND f.required = TRUE AND f.status IN ('pendente','solicitada')`,
    order: 'ORDER BY f.created_at ASC',
  },
  prontos_arquivamento: {
    label: 'Atendimentos prontos para arquivamento',
    sql: `SELECT so.id, so.number, so.status, fr.finalized_at AS since, c.name AS client_name,
                 u.name AS owner_name
            FROM finalization_records fr
            JOIN service_orders so ON so.id = fr.service_order_id AND so.tenant_id = fr.tenant_id
            JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
            LEFT JOIN users u ON u.id = so.owner_id
           WHERE fr.tenant_id = $1 AND fr.status = 'concluida'`,
    order: 'ORDER BY fr.finalized_at ASC',
  },
});

const QUEUE_KEYS = Object.freeze(Object.keys(QUEUES));

/** Resumo com o contador de cada fila — cada indicador abre a fila (§36). */
async function queueSummary(tenantId) {
  const entries = await Promise.all(QUEUE_KEYS.map(async (key) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (${QUEUES[key].sql}) q`, [tenantId]);
    return [key, { key, label: QUEUES[key].label, total: rows[0].total }];
  }));
  return Object.fromEntries(entries);
}

async function queueItems(tenantId, key, query = {}) {
  const queue = QUEUES[key];
  if (!queue) return null;
  const { limit, offset, page } = paging(query);
  const { rows } = await pool.query(
    `${queue.sql} ${queue.order} LIMIT $2 OFFSET $3`, [tenantId, limit, offset]);
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM (${queue.sql}) q`, [tenantId]);
  return { key, label: queue.label, rows, total: countRows[0].total, page, limit };
}

// ── Dashboard executivo (§36) ────────────────────────────────────────────────

/** Periodo padrao: ultimos 30 dias, sempre com limites explicitos. */
function periodOf(query = {}) {
  const to = dateOrNull(query.date_to) || new Date().toISOString().slice(0, 10);
  const from = dateOrNull(query.date_from)
    || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

async function executiveDashboard(tenantId, query = {}) {
  const { from, to } = periodOf(query);
  const range = [tenantId, from, to];

  const [comercial, recebimentos, operacao, custos, finalizacao] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE o.created_at::date BETWEEN $2::date AND $3::date)::int AS pedidos_criados,
         COUNT(*) FILTER (WHERE o.status = 'aprovado')::int AS pedidos_aprovados,
         COUNT(*) FILTER (WHERE o.status = 'cancelado'
                            AND o.cancelled_at::date BETWEEN $2::date AND $3::date)::int AS pedidos_cancelados,
         COALESCE(SUM(o.total) FILTER (WHERE o.created_at::date BETWEEN $2::date AND $3::date), 0)::float AS valor_pedidos
       FROM orders o WHERE o.tenant_id = $1`, range),
    pool.query(
      `SELECT
         COALESCE(SUM(r.total_amount), 0)::float AS valor_previsto,
         COALESCE(SUM(r.received_amount), 0)::float AS valor_recebido,
         COALESCE(SUM(r.total_amount - r.received_amount) FILTER (WHERE r.status IN ('pendente','parcial')), 0)::float AS valor_pendente,
         COALESCE(SUM(r.total_amount - r.received_amount) FILTER (
           WHERE r.due_date < CURRENT_DATE AND r.status IN ('pendente','parcial')), 0)::float AS valor_vencido
       FROM receivables r WHERE r.tenant_id = $1 AND r.status <> 'cancelado'`, [tenantId]),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE so.status IN ('liberada','aguardando_execucao'))::int AS aguardando_execucao,
         COUNT(*) FILTER (WHERE so.status = 'em_execucao')::int AS em_execucao,
         COUNT(*) FILTER (WHERE so.status = 'concluida')::int AS concluidas,
         COUNT(*) FILTER (WHERE so.due_date < CURRENT_DATE
                            AND so.status NOT IN ('concluida','cancelada','arquivada'))::int AS atrasadas
       FROM service_orders so WHERE so.tenant_id = $1`, [tenantId]),
    pool.query(
      `SELECT
         COALESCE((SELECT SUM(planned_cost) FROM execution_costs
                    WHERE tenant_id = $1 AND status <> 'cancelado'), 0)::float AS custo_previsto,
         COALESCE((SELECT SUM(actual_cost) FROM execution_costs
                    WHERE tenant_id = $1 AND status = 'confirmado'), 0)::float AS custo_realizado,
         COALESCE((SELECT SUM(amount) FROM payables
                    WHERE tenant_id = $1 AND status IN ('previsto','aprovado','agendado','vencido')), 0)::float AS pagamentos_pendentes,
         COALESCE((SELECT SUM(amount) FROM commissions
                    WHERE tenant_id = $1 AND status IN ('prevista','confirmada')), 0)::float AS comissoes_pendentes`,
      [tenantId]),
    pool.query(
      `SELECT COUNT(*)::int AS aguardando_documentos
         FROM service_orders so
         LEFT JOIN finalization_records fr ON fr.service_order_id = so.id
              AND fr.tenant_id = so.tenant_id
        WHERE so.tenant_id = $1 AND so.status = 'concluida' AND fr.id IS NULL`,
      [tenantId]),
  ]);

  // Contagens simples e separadas: subconsulta escalar composta nao e portavel
  // entre o PostgreSQL e o banco em memoria usado por testes e demo.
  const [fiscalPending, readyToArchive] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM fiscal_documents
        WHERE tenant_id = $1 AND required = TRUE AND status IN ('pendente','solicitada')`, [tenantId]),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM finalization_records
        WHERE tenant_id = $1 AND status = 'concluida'`, [tenantId]),
  ]);
  const closure = {
    notas_pendentes: Number(fiscalPending.rows[0].total),
    prontos_arquivamento: Number(readyToArchive.rows[0].total),
  };

  const { rows: salesRows } = await pool.query(
    `SELECT COUNT(*)::int AS vendas_confirmadas,
            COALESCE(SUM(net_amount), 0)::float AS valor_vendido,
            COALESCE(AVG(net_amount), 0)::float AS ticket_medio,
            COALESCE(SUM(estimated_cost), 0)::float AS custo_estimado,
            COALESCE(SUM(estimated_margin), 0)::float AS margem_estimada
       FROM sales
      WHERE tenant_id = $1 AND status <> 'cancelada'
        AND confirmed_at::date BETWEEN $2::date AND $3::date`, range);

  const { rows: awaitingValidation } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM customer_payments
      WHERE tenant_id = $1 AND status IN ('informado','em_validacao')`, [tenantId]);

  const { rows: workload } = await pool.query(
    `SELECT u.id AS owner_id, u.name AS owner_name,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE so.due_date < CURRENT_DATE)::int AS atrasadas
       FROM service_orders so
       JOIN users u ON u.id = so.owner_id
      WHERE so.tenant_id = $1 AND so.status NOT IN ('concluida','cancelada','arquivada')
      GROUP BY u.id, u.name ORDER BY total DESC LIMIT 12`, [tenantId]);

  return {
    period: { from, to },
    comercial: { ...comercial.rows[0], ...salesRows[0] },
    recebimentos: {
      ...recebimentos.rows[0],
      pagamentos_aguardando_validacao: awaitingValidation[0].total,
    },
    operacao: { ...operacao.rows[0], carga_por_responsavel: workload },
    custos: {
      ...custos.rows[0],
      margem_estimada: salesRows[0].margem_estimada,
    },
    finalizacao: { ...finalizacao.rows[0], ...closure },
  };
}

// ── Relatorios (§37) ─────────────────────────────────────────────────────────

const REPORTS = Object.freeze({
  pedidos_periodo: {
    label: 'Pedidos por periodo',
    sql: `SELECT o.number AS numero, c.name AS cliente, o.status AS situacao,
                 o.total AS valor, u.name AS responsavel, o.created_at AS criado_em
            FROM orders o
            JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
            LEFT JOIN users u ON u.id = o.owner_id
           WHERE o.tenant_id = $1 AND o.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY o.created_at DESC`,
  },
  vendas_periodo: {
    label: 'Vendas por periodo',
    sql: `SELECT s.number AS numero, c.name AS cliente, s.status AS situacao,
                 s.net_amount AS valor_liquido, s.estimated_cost AS custo_estimado,
                 s.estimated_margin AS margem, s.confirmed_at AS confirmada_em
            FROM sales s
            JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
           WHERE s.tenant_id = $1 AND s.confirmed_at::date BETWEEN $2::date AND $3::date
           ORDER BY s.confirmed_at DESC`,
  },
  vendas_responsavel: {
    label: 'Vendas por responsavel',
    sql: `SELECT COALESCE(u.name, 'Sem responsavel') AS responsavel,
                 COUNT(*)::int AS vendas, SUM(s.net_amount) AS valor_total,
                 AVG(s.net_amount) AS ticket_medio, SUM(s.estimated_margin) AS margem
            FROM sales s LEFT JOIN users u ON u.id = s.owner_id
           WHERE s.tenant_id = $1 AND s.status <> 'cancelada'
             AND s.confirmed_at::date BETWEEN $2::date AND $3::date
           GROUP BY u.name ORDER BY valor_total DESC`,
  },
  vendas_servico: {
    label: 'Vendas por servico',
    sql: `SELECT i.description AS servico, i.item_type AS tipo,
                 SUM(i.quantity)::float AS quantidade, SUM(i.total) AS valor_total,
                 SUM(COALESCE(i.unit_cost,0) * i.quantity) AS custo_total
            FROM sale_items i
            JOIN sales s ON s.id = i.sale_id AND s.tenant_id = i.tenant_id
           WHERE i.tenant_id = $1 AND s.status <> 'cancelada'
             AND s.confirmed_at::date BETWEEN $2::date AND $3::date
           GROUP BY i.description, i.item_type ORDER BY valor_total DESC`,
  },
  recebimentos: {
    label: 'Recebimentos',
    sql: `SELECT c.name AS cliente, r.description AS descricao, r.total_amount AS previsto,
                 r.received_amount AS recebido,
                 (r.total_amount - r.received_amount) AS pendente,
                 r.due_date AS vencimento, r.status AS situacao
            FROM receivables r
            JOIN clients c ON c.id = r.client_id AND c.tenant_id = r.tenant_id
           WHERE r.tenant_id = $1 AND r.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY r.due_date NULLS LAST`,
  },
  pagamentos_pendentes: {
    label: 'Pagamentos pendentes',
    sql: `SELECT p.payee_name AS favorecido, p.kind AS tipo, p.description AS descricao,
                 p.amount AS valor, p.due_date AS vencimento, p.status AS situacao
            FROM payables p
           WHERE p.tenant_id = $1 AND p.status IN ('previsto','aprovado','agendado','vencido')
             AND (p.due_date IS NULL OR p.due_date BETWEEN $2::date AND $3::date)
           ORDER BY p.due_date NULLS LAST`,
  },
  pagamentos_realizados: {
    label: 'Pagamentos realizados',
    sql: `SELECT p.payee_name AS favorecido, p.kind AS tipo, p.description AS descricao,
                 p.amount AS valor, p.paid_at AS pago_em, p.payment_method AS forma
            FROM payables p
           WHERE p.tenant_id = $1 AND p.status = 'pago'
             AND p.paid_at BETWEEN $2::date AND $3::date
           ORDER BY p.paid_at DESC`,
  },
  fornecedores: {
    label: 'Fornecedores',
    // Este relatório cruza DOIS agregados independentes (custos de execução e
    // pagamentos). Fazer isso numa consulta só exigiria juntar duas tabelas
    // derivadas — construção que o banco em memória de testes/demo não suporta.
    // Compor em JS mantém o resultado idêntico e o relatório testável.
    run: async (tenantId, limit) => {
      const [suppliersResult, costs, paid] = await Promise.all([
        pool.query(
          `SELECT id, legal_name, kind, document, active FROM suppliers
            WHERE tenant_id = $1 ORDER BY legal_name LIMIT $2`, [tenantId, limit]),
        pool.query(
          `SELECT supplier_id, SUM(COALESCE(actual_cost, planned_cost))::float AS total
             FROM execution_costs WHERE tenant_id = $1 AND status <> 'cancelado'
            GROUP BY supplier_id`, [tenantId]),
        pool.query(
          `SELECT payee_supplier_id, SUM(amount)::float AS total
             FROM payables WHERE tenant_id = $1 AND status = 'pago'
            GROUP BY payee_supplier_id`, [tenantId]),
      ]);
      const costBySupplier = new Map(costs.rows.map((row) => [row.supplier_id, Number(row.total)]));
      const paidBySupplier = new Map(paid.rows.map((row) => [row.payee_supplier_id, Number(row.total)]));
      return suppliersResult.rows.map((supplier) => ({
        fornecedor: supplier.legal_name,
        classificacao: supplier.kind,
        documento: supplier.document,
        ativo: supplier.active,
        custo_total: costBySupplier.get(supplier.id) || 0,
        pago_total: paidBySupplier.get(supplier.id) || 0,
      }));
    },
  },
  comissoes: {
    label: 'Comissoes',
    sql: `SELECT c.beneficiary_name AS beneficiario, s.number AS venda, c.base_amount AS base,
                 c.rate_type AS tipo, c.rate_value AS taxa, c.amount AS valor,
                 c.status AS situacao, c.expected_date AS previsto_para, c.paid_at AS pago_em
            FROM commissions c
            LEFT JOIN sales s ON s.id = c.sale_id AND s.tenant_id = c.tenant_id
           WHERE c.tenant_id = $1 AND c.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY c.created_at DESC`,
  },
  custos_servico: {
    label: 'Custos por servico',
    sql: `SELECT e.description AS servico, sup.legal_name AS fornecedor,
                 SUM(e.planned_cost) AS custo_previsto,
                 SUM(COALESCE(e.actual_cost, 0)) AS custo_realizado
            FROM execution_costs e
            LEFT JOIN suppliers sup ON sup.id = e.supplier_id
           WHERE e.tenant_id = $1 AND e.status <> 'cancelado'
             AND e.created_at::date BETWEEN $2::date AND $3::date
           GROUP BY e.description, sup.legal_name ORDER BY custo_realizado DESC`,
  },
  margem_estimada: {
    label: 'Margem estimada',
    sql: `SELECT s.number AS venda, c.name AS cliente, s.net_amount AS valor_liquido,
                 s.estimated_cost AS custo_estimado, s.estimated_margin AS margem_estimada,
                 CASE WHEN s.net_amount > 0
                      THEN ROUND((s.estimated_margin / s.net_amount) * 100, 2)
                      ELSE NULL END AS margem_percentual
            FROM sales s
            JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
           WHERE s.tenant_id = $1 AND s.status <> 'cancelada'
             AND s.confirmed_at::date BETWEEN $2::date AND $3::date
           ORDER BY margem_percentual DESC NULLS LAST`,
  },
  ordens_execucao: {
    label: 'Ordens em execucao',
    sql: `SELECT so.number AS ordem, c.name AS cliente, so.status AS situacao,
                 u.name AS responsavel, so.due_date AS prazo, so.started_at AS iniciada_em
            FROM service_orders so
            JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
            LEFT JOIN users u ON u.id = so.owner_id
           WHERE so.tenant_id = $1 AND so.status NOT IN ('concluida','cancelada','arquivada')
             AND so.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY so.due_date NULLS LAST`,
  },
  ordens_concluidas: {
    label: 'Ordens concluidas',
    sql: `SELECT so.number AS ordem, c.name AS cliente, u.name AS responsavel,
                 so.started_at AS iniciada_em, so.finished_at AS concluida_em
            FROM service_orders so
            JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
            LEFT JOIN users u ON u.id = so.owner_id
           WHERE so.tenant_id = $1 AND so.status IN ('concluida','arquivada')
             AND so.finished_at::date BETWEEN $2::date AND $3::date
           ORDER BY so.finished_at DESC`,
  },
  notas_pendentes: {
    label: 'Notas fiscais pendentes',
    sql: `SELECT s.number AS venda, c.name AS cliente, f.status AS situacao,
                 f.amount AS valor, f.number AS numero_nota, f.issued_at AS emitida_em
            FROM fiscal_documents f
            LEFT JOIN sales s ON s.id = f.sale_id AND s.tenant_id = f.tenant_id
            LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
           WHERE f.tenant_id = $1 AND f.required = TRUE AND f.status IN ('pendente','solicitada')
             AND f.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY f.created_at`,
  },
  clientes_volume: {
    label: 'Clientes por volume',
    // INNER JOIN em vez de LEFT JOIN + HAVING: só entram clientes que têm venda
    // no período, que é exatamente o que o relatório mostra.
    sql: `SELECT c.name AS cliente, c.cpf AS documento,
                 COUNT(s.id)::int AS vendas, COALESCE(SUM(s.net_amount), 0) AS valor_total
            FROM clients c
            JOIN sales s ON s.client_id = c.id AND s.tenant_id = c.tenant_id
           WHERE c.tenant_id = $1 AND s.status <> 'cancelada'
             AND s.confirmed_at::date BETWEEN $2::date AND $3::date
           GROUP BY c.name, c.cpf
           ORDER BY valor_total DESC`,
  },
  historico_atendimento: {
    label: 'Historico do atendimento',
    sql: `SELECT h.created_at AS momento, h.entity_type AS entidade, h.action AS acao,
                 h.from_status AS de, h.to_status AS para, u.name AS usuario
            FROM commercial_history h
            LEFT JOIN users u ON u.id = h.user_id
           WHERE h.tenant_id = $1 AND h.created_at::date BETWEEN $2::date AND $3::date
           ORDER BY h.created_at DESC`,
  },
});

const REPORT_KEYS = Object.freeze(Object.keys(REPORTS));

async function report(tenantId, type, query = {}) {
  const definition = REPORTS[type];
  if (!definition) return { ok: false, error: 'Relatorio nao encontrado.' };
  const { from, to } = periodOf(query);
  // Relatorio nunca e paginado no servidor por offset livre: o limite protege
  // memoria e a exportacao CSV usa o mesmo teto.
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 5000);
  const rows = definition.run
    ? await definition.run(tenantId, limit, from, to)
    : (await pool.query(`SELECT * FROM (${definition.sql}) r LIMIT $4`,
      [tenantId, from, to, limit])).rows;
  return { ok: true, type, label: definition.label, period: { from, to }, rows };
}

// ── Visao 360 do cliente (§34) ───────────────────────────────────────────────

const CLIENT_TABS = Object.freeze([
  'pedidos', 'vendas', 'recebimentos', 'ordens', 'processos',
  'documentos', 'contratos', 'notas', 'historico',
]);

/** Cabecalho: dados do cliente e totais consolidados (leve, sem listas). */
async function clientOverview(tenantId, clientId) {
  const id = uuidOrNull(clientId);
  if (!id) return null;
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  if (!rows[0]) return null;

  const { rows: totals } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM orders WHERE tenant_id = $1 AND client_id = $2) AS pedidos,
       (SELECT COUNT(*)::int FROM sales WHERE tenant_id = $1 AND client_id = $2 AND status <> 'cancelada') AS vendas,
       (SELECT COALESCE(SUM(net_amount),0)::float FROM sales
         WHERE tenant_id = $1 AND client_id = $2 AND status <> 'cancelada') AS valor_vendido,
       (SELECT COALESCE(SUM(total_amount - received_amount),0)::float FROM receivables
         WHERE tenant_id = $1 AND client_id = $2 AND status IN ('pendente','parcial','vencido')) AS valor_em_aberto,
       (SELECT COUNT(*)::int FROM service_orders WHERE tenant_id = $1 AND client_id = $2) AS ordens,
       (SELECT COUNT(*)::int FROM service_orders
         WHERE tenant_id = $1 AND client_id = $2 AND status IN ('concluida','arquivada')) AS atendimentos_concluidos,
       (SELECT COUNT(*)::int FROM fines WHERE tenant_id = $1 AND client_id = $2) AS processos,
       (SELECT COUNT(*)::int FROM process_tasks t
          JOIN fines f ON f.id = t.fine_id AND f.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1 AND f.client_id = $2 AND t.status = 'aberta' AND t.deleted_at IS NULL) AS pendencias`,
    [tenantId, id]);

  return { client: rows[0], totals: totals[0] };
}

/** Uma aba por vez, paginada — evita carregar tudo de uma vez (§34). */
async function clientTab(tenantId, clientId, tab, query = {}) {
  const id = uuidOrNull(clientId);
  const key = oneOf(tab, CLIENT_TABS, null);
  if (!id || !key) return null;
  const { limit, offset, page } = paging({ ...query, limit: query.limit || 10 });

  const queries = {
    pedidos: [
      `SELECT o.id, o.number, o.status, o.total, o.created_at, u.name AS owner_name
         FROM orders o LEFT JOIN users u ON u.id = o.owner_id
        WHERE o.tenant_id = $1 AND o.client_id = $2 ORDER BY o.created_at DESC`,
      'SELECT COUNT(*)::int AS total FROM orders WHERE tenant_id = $1 AND client_id = $2'],
    vendas: [
      `SELECT s.id, s.number, s.status, s.net_amount, s.confirmed_at
         FROM sales s WHERE s.tenant_id = $1 AND s.client_id = $2 ORDER BY s.confirmed_at DESC NULLS LAST`,
      'SELECT COUNT(*)::int AS total FROM sales WHERE tenant_id = $1 AND client_id = $2'],
    recebimentos: [
      `SELECT r.id, r.description, r.total_amount, r.received_amount,
              (r.total_amount - r.received_amount) AS pending_amount, r.due_date, r.status
         FROM receivables r WHERE r.tenant_id = $1 AND r.client_id = $2
        ORDER BY r.due_date NULLS LAST`,
      'SELECT COUNT(*)::int AS total FROM receivables WHERE tenant_id = $1 AND client_id = $2'],
    ordens: [
      `SELECT so.id, so.number, so.status, so.due_date, so.finished_at, u.name AS owner_name
         FROM service_orders so LEFT JOIN users u ON u.id = so.owner_id
        WHERE so.tenant_id = $1 AND so.client_id = $2 ORDER BY so.created_at DESC`,
      'SELECT COUNT(*)::int AS total FROM service_orders WHERE tenant_id = $1 AND client_id = $2'],
    processos: [
      `SELECT f.id, f.fine_number, f.stage, f.status, f.due_date, f.finalized_at
         FROM fines f WHERE f.tenant_id = $1 AND f.client_id = $2 ORDER BY f.created_at DESC`,
      'SELECT COUNT(*)::int AS total FROM fines WHERE tenant_id = $1 AND client_id = $2'],
    documentos: [
      `SELECT g.id, g.doc_type, g.title, g.stage, g.status, g.created_at
         FROM generated_documents g
        WHERE g.tenant_id = $1 AND g.client_id = $2 AND g.status <> 'cancelado'
        ORDER BY g.created_at DESC`,
      `SELECT COUNT(*)::int AS total FROM generated_documents
        WHERE tenant_id = $1 AND client_id = $2 AND status <> 'cancelado'`],
    contratos: [
      `SELECT ct.id, ct.number, ct.title, ct.status, ct.signed_at, ct.created_at
         FROM commercial_contracts ct WHERE ct.tenant_id = $1 AND ct.client_id = $2
        ORDER BY ct.created_at DESC`,
      'SELECT COUNT(*)::int AS total FROM commercial_contracts WHERE tenant_id = $1 AND client_id = $2'],
    notas: [
      `SELECT f.id, f.status, f.number, f.series, f.issued_at, f.amount, s.number AS sale_number
         FROM fiscal_documents f
         LEFT JOIN sales s ON s.id = f.sale_id AND s.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND f.client_id = $2 ORDER BY f.created_at DESC`,
      'SELECT COUNT(*)::int AS total FROM fiscal_documents WHERE tenant_id = $1 AND client_id = $2'],
    historico: [
      `SELECT h.created_at, h.entity_type, h.entity_id, h.action, h.from_status, h.to_status,
              h.reason, u.name AS user_name
         FROM commercial_history h
         LEFT JOIN users u ON u.id = h.user_id
        WHERE h.tenant_id = $1 AND h.entity_id IN (
          SELECT id FROM orders WHERE tenant_id = $1 AND client_id = $2
          UNION SELECT id FROM sales WHERE tenant_id = $1 AND client_id = $2
          UNION SELECT id FROM service_orders WHERE tenant_id = $1 AND client_id = $2
        ) ORDER BY h.created_at DESC`,
      `SELECT COUNT(*)::int AS total FROM commercial_history h
        WHERE h.tenant_id = $1 AND h.entity_id IN (
          SELECT id FROM orders WHERE tenant_id = $1 AND client_id = $2
          UNION SELECT id FROM sales WHERE tenant_id = $1 AND client_id = $2
          UNION SELECT id FROM service_orders WHERE tenant_id = $1 AND client_id = $2
        )`],
  };

  const [listSql, countSql] = queries[key];
  const { rows } = await pool.query(`${listSql} LIMIT $3 OFFSET $4`, [tenantId, id, limit, offset]);
  const { rows: countRows } = await pool.query(countSql, [tenantId, id]);
  return { tab: key, rows, total: countRows[0].total, page, limit };
}

// ── Busca global ampliada (§35) ──────────────────────────────────────────────

/**
 * Busca por cliente, documento, fornecedor, parceiro, pedido, venda, ordem,
 * processo, protocolo, recibo, contrato e nota. Sempre com tenant no WHERE e
 * limite fixo por dominio.
 */
async function globalSearch(tenantId, term, query = {}) {
  const text = clean(term, 120);
  if (text.length < 2) return [];
  const like = `%${text.toLowerCase()}%`;
  const perDomain = Math.min(Math.max(parseInt(query.limit, 10) || 5, 1), 20);

  const domains = [
    ['cliente', `SELECT id, name AS title, COALESCE(cpf,'') AS subtitle FROM clients
                  WHERE tenant_id = $1 AND (LOWER(name) LIKE $2 OR COALESCE(cpf,'') LIKE $2)`],
    ['fornecedor', `SELECT id, legal_name AS title, kind AS subtitle FROM suppliers
                     WHERE tenant_id = $1 AND (LOWER(legal_name) LIKE $2
                       OR LOWER(COALESCE(trade_name,'')) LIKE $2 OR COALESCE(document,'') LIKE $2)`],
    ['pedido', `SELECT o.id, o.number AS title, c.name AS subtitle FROM orders o
                 JOIN clients c ON c.id = o.client_id AND c.tenant_id = o.tenant_id
                WHERE o.tenant_id = $1 AND LOWER(o.number) LIKE $2`],
    ['venda', `SELECT s.id, s.number AS title, c.name AS subtitle FROM sales s
                JOIN clients c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
               WHERE s.tenant_id = $1 AND LOWER(s.number) LIKE $2`],
    ['ordem', `SELECT so.id, so.number AS title, c.name AS subtitle FROM service_orders so
                JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
               WHERE so.tenant_id = $1 AND LOWER(so.number) LIKE $2`],
    ['processo', `SELECT f.id, COALESCE(f.fine_number, f.id::text) AS title, c.name AS subtitle
                    FROM fines f
                    LEFT JOIN clients c ON c.id = f.client_id AND c.tenant_id = f.tenant_id
                   WHERE f.tenant_id = $1 AND (LOWER(COALESCE(f.fine_number,'')) LIKE $2
                     OR LOWER(COALESCE(f.protocol_number,'')) LIKE $2)`],
    ['contrato', `SELECT ct.id, ct.number AS title, ct.title AS subtitle FROM commercial_contracts ct
                   WHERE ct.tenant_id = $1 AND (LOWER(ct.number) LIKE $2 OR LOWER(ct.title) LIKE $2)`],
    ['documento', `SELECT g.id, g.title, g.doc_type AS subtitle FROM generated_documents g
                    WHERE g.tenant_id = $1 AND g.status <> 'cancelado' AND LOWER(g.title) LIKE $2`],
    ['nota_fiscal', `SELECT f.id, COALESCE(f.number, 'sem numero') AS title, f.status AS subtitle
                       FROM fiscal_documents f
                      WHERE f.tenant_id = $1 AND (LOWER(COALESCE(f.number,'')) LIKE $2
                        OR LOWER(COALESCE(f.access_key,'')) LIKE $2)`],
  ];

  const results = await Promise.all(domains.map(async ([type, sql]) => {
    const { rows } = await pool.query(`SELECT * FROM (${sql}) d LIMIT $3`, [tenantId, like, perDomain]);
    return rows.map((row) => ({ type, ...row }));
  }));
  return results.flat();
}

module.exports = {
  QUEUES,
  QUEUE_KEYS,
  REPORTS,
  REPORT_KEYS,
  CLIENT_TABS,
  queueSummary,
  queueItems,
  executiveDashboard,
  report,
  clientOverview,
  clientTab,
  globalSearch,
};
