-- ROLLBACK: 012_widen_audit_action.sql
-- NOTE: this will FAIL if any row currently has an action value longer than
-- 20 characters (e.g. 'ANNOUNCEMENT_DEACTIVATE') — by design; a rollback
-- should not silently truncate/corrupt existing audit data.
ALTER TABLE platform_audit_logs ALTER COLUMN action TYPE VARCHAR(20);
