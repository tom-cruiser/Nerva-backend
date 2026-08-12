-- =============================================================================
-- MIGRATION: 011_subscriptions_audit_actions.sql
-- PURPOSE:   Extend platform_audit_logs.action to cover the new
--            subscriptions/feature-flags superadmin routes
--            (services/superadmin/src/routes/subscriptions-router.ts).
--
-- Same pattern as 009/010: that CHECK constraint is re-declared (not just
-- appended to) every time a new router needs to write a new action value,
-- so it stays a single readable list rather than a chain of ALTERs.
-- platform_audit_logs.action is VARCHAR(20) — every value below fits.
-- =============================================================================

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
