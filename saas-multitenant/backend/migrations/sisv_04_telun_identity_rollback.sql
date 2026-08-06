-- Reversão restrita à paleta anterior do tenant SISV.
UPDATE tenants
SET brand_color = '#15803d',
    brand_color_dark = '#052e16'
WHERE LOWER(slug) = 'sisv';

DO $$
BEGIN
  IF to_regclass('public.tenant_financial_settings') IS NOT NULL THEN
    UPDATE tenant_financial_settings fs
    SET receipt_prefix = 'NEXO'
    FROM tenants t
    WHERE t.id = fs.tenant_id
      AND LOWER(t.slug) = 'sisv'
      AND UPPER(fs.receipt_prefix) = 'SISV';
  END IF;
END $$;
