-- =============================================================================
-- MIGRATION: 007_tenant_lifecycle.sql
-- PURPOSE:   Superadmin tenant lifecycle management (block/suspend/soft-delete/purge)
--
-- 1. Adds a first-class `status` state machine to `tenants` — ACTIVE,
--    SUSPENDED, DELETED — enforced on every request cluster-wide by
--    packages/middleware/src/tenant-context.ts (`resolveTenantStatus`).
--    `is_active` already existed and is read elsewhere (idx_tenants_is_active,
--    tierGate) — a trigger keeps it in lockstep with `status` so nothing that
--    reads `is_active` needs to change.
--
-- 2. Adds `platform_audit_logs` — deliberately NOT foreign-keyed to `tenants`.
--    `audit_logs.tenant_id` IS foreign-keyed with ON DELETE CASCADE, so a hard
--    PURGE (services/superadmin) would wipe that tenant's own audit trail —
--    including the very row recording who purged it and why, the moment the
--    DELETE FROM tenants statement runs. platform_audit_logs is the durable,
--    tenant-independent home for superadmin actions on a tenant (suspend /
--    unblock / soft-delete / purge / tier change) — it survives the tenant
--    it describes no longer existing, by snapshotting name/slug instead of
--    depending on the row still being there to join against.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  ADD COLUMN IF NOT EXISTS status_reason     TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID,  -- superadmin's Supabase user id; no FK (superadmins are not necessarily rows in `users`, which is tenant-scoped)
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- Backfill: any tenant already inactive under the old boolean should read as
-- SUSPENDED under the new state machine rather than silently staying ACTIVE.
UPDATE tenants SET status = 'SUSPENDED' WHERE is_active = FALSE AND status = 'ACTIVE';

CREATE OR REPLACE FUNCTION sync_tenant_is_active() RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'ACTIVE');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tenant_is_active ON tenants;
CREATE TRIGGER trg_sync_tenant_is_active
  BEFORE INSERT OR UPDATE OF status ON tenants
  FOR EACH ROW EXECUTE FUNCTION sync_tenant_is_active();

-- Ops: quickly list suspended/deleted tenants (the hot query for a superadmin
-- dashboard); ACTIVE tenants are the overwhelming majority so a partial index
-- on the non-ACTIVE minority keeps this cheap.
CREATE INDEX IF NOT EXISTS idx_tenants_status_nonactive
  ON tenants(status, status_changed_at DESC)
  WHERE status <> 'ACTIVE';

-- =============================================================================
-- PLATFORM AUDIT LOGS — superadmin actions on tenants (survives tenant purge)
-- =============================================================================
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id                  UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID         NOT NULL,  -- NOT a FK — must outlive a PURGEd tenant
  tenant_slug         VARCHAR(100) NOT NULL,  -- snapshot at action time
  tenant_name         VARCHAR(255) NOT NULL,  -- snapshot at action time
  action              VARCHAR(20)  NOT NULL
                       CHECK (action IN ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE')),
  reason              TEXT,
  performed_by        UUID         NOT NULL,  -- superadmin's Supabase user id
  performed_by_email  VARCHAR(255),
  details             JSONB,                  -- e.g. { previous_tier, new_tier } or { banned_user_count, ban_failures }
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_tenant
  ON platform_audit_logs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_action
  ON platform_audit_logs(action, created_at DESC);

ANALYZE tenants;
ANALYZE platform_audit_logs;
