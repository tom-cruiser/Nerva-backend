-- ROLLBACK: 007_tenant_lifecycle.sql

DROP INDEX IF EXISTS idx_platform_audit_logs_action;
DROP INDEX IF EXISTS idx_platform_audit_logs_tenant;
DROP TABLE IF EXISTS platform_audit_logs;

DROP INDEX IF EXISTS idx_tenants_status_nonactive;

DROP TRIGGER IF EXISTS trg_sync_tenant_is_active ON tenants;
DROP FUNCTION IF EXISTS sync_tenant_is_active();

ALTER TABLE tenants
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS status_reason,
  DROP COLUMN IF EXISTS status_changed_at,
  DROP COLUMN IF EXISTS status_changed_by,
  DROP COLUMN IF EXISTS deleted_at;
