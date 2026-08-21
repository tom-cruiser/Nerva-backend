-- =============================================================================
-- MIGRATION: 026_announcement_crud.sql
-- PURPOSE:   Round out platform announcements to full CRUD — until now
--            superadmin could only create one and (soft) deactivate it.
--            Adds edit (PATCH) and hard delete (DELETE), each producing its
--            own platform_audit_logs action.
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
     'FEATURE_FLAG_SET', 'FEATURE_FLAG_RESET', 'APPROVE',
     'SUB_REQUEST_APPROVE', 'SUB_REQUEST_REJECT',
     -- New this migration:
     'ANNOUNCEMENT_UPDATE', 'ANNOUNCEMENT_DELETE'));
  -- Column is already VARCHAR(30) (widened in 012) — both new values (19
  -- chars each) fit with room to spare; no column-width change needed here.
