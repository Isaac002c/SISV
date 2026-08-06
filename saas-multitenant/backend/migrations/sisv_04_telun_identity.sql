-- Sprint visual TELUN: atualiza apenas a identidade padrão do tenant SISV.
-- Assets oficiais permanecem nulos até a entrega dos arquivos isolados.
UPDATE tenants
SET brand_color = '#A56FFF',
    brand_color_dark = '#3B1F6A',
    tagline = 'Sistema Integrado da Sinal Verde'
WHERE LOWER(slug) = 'sisv';

DO $$
BEGIN
  IF to_regclass('public.tenant_financial_settings') IS NOT NULL THEN
    UPDATE tenant_financial_settings fs
    SET receipt_prefix = 'SISV'
    FROM tenants t
    WHERE t.id = fs.tenant_id
      AND LOWER(t.slug) = 'sisv'
      AND UPPER(fs.receipt_prefix) IN ('NEXO', 'NEXOS');
  END IF;
END $$;
