-- ROLLBACK: 026_announcement_crud.sql
-- NOTE: will FAIL if any row currently has action = 'ANNOUNCEMENT_UPDATE' or
-- 'ANNOUNCEMENT_DELETE' — by design; a rollback should not silently corrupt
-- existing audit data.
ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR',
     'SETTINGS_UPDATE', 'ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_DEACTIVATE',
     'SUPPORT_TOKEN_ISSUE', 'SUPPORT_TOKEN_REVOKE',
     'PLAN_EDIT', 'PLAN_CHANGE', 'SUB_CANCEL', 'SUB_REACTIVATE',
     'FEATURE_FLAG_SET', 'FEATURE_FLAG_RESET', 'APPROVE',
     'SUB_REQUEST_APPROVE', 'SUB_REQUEST_REJECT'));
