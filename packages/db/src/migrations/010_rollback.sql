-- ROLLBACK: 010_platform_settings_and_support.sql

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR'));

DROP TABLE IF EXISTS platform_support_tokens;
DROP TABLE IF EXISTS platform_announcements;
DROP TABLE IF EXISTS platform_settings;
