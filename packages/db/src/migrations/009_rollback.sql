-- ROLLBACK: 009_platform_rbac_and_ops.sql

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE'));

DROP TABLE IF EXISTS platform_error_logs;
DROP TABLE IF EXISTS tenant_rate_limits;
DROP TABLE IF EXISTS platform_staff;
