-- =============================================================================
-- MIGRATION: 014_tenant_pending_approval.sql
-- PURPOSE:   Add a PENDING_APPROVAL tenant status so self-registered tenants
--            require superadmin sign-off before going live (design.md's
--            "Onboard, approve" tenant-lifecycle requirement — until now,
--            registration self-serve instant-activated a tenant with no
--            approval step at all).
--
-- `tenants.status` (migration 007) widens from ACTIVE/SUSPENDED/DELETED to
-- include PENDING_APPROVAL. `sync_tenant_is_active()` (also 007) needs no
-- change — it already sets `is_active := (status = 'ACTIVE')`, so a pending
-- tenant correctly reads as inactive everywhere `is_active` is still read.
--
-- `platform_audit_logs.action` (007, widened by 009/010/011/012) gains
-- 'APPROVE' for the new POST /api/v1/superadmin/tenants/:id/approve route.
-- Column is already VARCHAR(30) (migration 012) — 'APPROVE' fits with room
-- to spare, no width change needed.
-- =============================================================================

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED', 'PENDING_APPROVAL'));

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR',
     'SETTINGS_UPDATE', 'ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_DEACTIVATE',
     'SUPPORT_TOKEN_ISSUE', 'SUPPORT_TOKEN_REVOKE',
     'PLAN_EDIT', 'PLAN_CHANGE', 'SUB_CANCEL', 'SUB_REACTIVATE',
     'FEATURE_FLAG_SET', 'FEATURE_FLAG_RESET', 'APPROVE'));

ANALYZE tenants;
ANALYZE platform_audit_logs;
