-- ROLLBACK: 014_tenant_pending_approval.sql
-- NOTE: this will FAIL if any row currently has status = 'PENDING_APPROVAL' or
-- action = 'APPROVE' — by design; a rollback should not silently corrupt
-- existing data. Move/clear those rows first if you need to roll back live.

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'));

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR',
     'SETTINGS_UPDATE', 'ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_DEACTIVATE',
     'SUPPORT_TOKEN_ISSUE', 'SUPPORT_TOKEN_REVOKE',
     'PLAN_EDIT', 'PLAN_CHANGE', 'SUB_CANCEL', 'SUB_REACTIVATE',
     'FEATURE_FLAG_SET', 'FEATURE_FLAG_RESET'));
