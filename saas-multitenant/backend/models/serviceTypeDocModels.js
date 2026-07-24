'use strict';
const pool = require('../config/db');

// =============================================================================
// serviceTypeDocModels — checklist documental por tipo de serviço (por tenant).
// Define quais categorias de documento são recomendadas/obrigatórias para cada
// tipo de serviço. Orienta a equipe (não bloqueia o fluxo automaticamente).
// =============================================================================

// Lista as categorias configuradas para um tipo de serviço.
const getChecklist = async (tenant_id, service_type_id) => {
  const { rows } = await pool.query(
    `SELECT std.category_id, std.required, std.sort_order,
            dc.name AS category_name, dc.color AS category_color
     FROM service_type_documents std
     JOIN document_categories dc ON dc.id = std.category_id AND dc.tenant_id = std.tenant_id
     WHERE std.tenant_id = $1 AND std.tenant_service_type_id = $2
     ORDER BY std.sort_order ASC, dc.name ASC`,
    [tenant_id, service_type_id]
  );
  return rows;
};

// Substitui (transacional) o checklist de um tipo de serviço.
// items: [{ category_id, required }]. Só grava categorias do próprio tenant.
const setChecklist = async (tenant_id, service_type_id, items) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // valida que o tipo de serviço é do tenant
    const svc = await client.query(
      'SELECT 1 FROM tenant_service_types WHERE id = $1 AND tenant_id = $2', [service_type_id, tenant_id]);
    if (!svc.rows[0]) { await client.query('ROLLBACK'); return { ok: false, error: 'Tipo de serviço inválido.' }; }

    await client.query(
      'DELETE FROM service_type_documents WHERE tenant_id = $1 AND tenant_service_type_id = $2',
      [tenant_id, service_type_id]);

    let order = 0;
    for (const it of (items || [])) {
      if (!it || !it.category_id) continue;
      // só insere categoria pertencente ao tenant (anti-injeção de id de outro tenant)
      const cat = await client.query(
        'SELECT 1 FROM document_categories WHERE id = $1 AND tenant_id = $2', [it.category_id, tenant_id]);
      if (!cat.rows[0]) continue;
      await client.query(
        `INSERT INTO service_type_documents (tenant_id, tenant_service_type_id, category_id, required, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenant_id, service_type_id, it.category_id, !!it.required, order++]);
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

module.exports = { getChecklist, setChecklist };
