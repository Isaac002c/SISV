-- =============================================================================
-- ROLLBACK de sisv_02_documents.sql — remove APENAS o que a migration criou.
-- ATENÇÃO: apaga categorias e metadados/soft-delete dos documentos. Backup antes.
-- =============================================================================

DROP TABLE IF EXISTS service_type_documents;

ALTER TABLE fine_documents DROP COLUMN IF EXISTS removed_at;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS removed_by;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS archived_at;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS status;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS notes;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS stored_name;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS original_name;
ALTER TABLE fine_documents DROP COLUMN IF EXISTS category_id;

ALTER TABLE documents DROP COLUMN IF EXISTS removed_at;
ALTER TABLE documents DROP COLUMN IF EXISTS removed_by;
ALTER TABLE documents DROP COLUMN IF EXISTS archived_at;
ALTER TABLE documents DROP COLUMN IF EXISTS status;
ALTER TABLE documents DROP COLUMN IF EXISTS stored_name;
ALTER TABLE documents DROP COLUMN IF EXISTS original_name;
ALTER TABLE documents DROP COLUMN IF EXISTS category_id;

DROP TABLE IF EXISTS document_categories;
