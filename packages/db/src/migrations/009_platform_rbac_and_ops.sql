-- =============================================================================
-- MIGRATION: 009_platform_rbac_and_ops.sql
-- PURPOSE:   Platform-staff RBAC registry, per-tenant rate limits, error log
--
-- `platform_staff` is a DENORMALIZED MIRROR, not the source of truth for
-- authorization — the actual auth decision is always the Supabase JWT's
-- app_metadata.permissions (see packages/middleware/src/tenant-context.ts /
-- require-platform-permission.ts), exactly like every other permission in
-- this system. This table exists so "who currently has platform access and
-- what role" can be listed/audited via a query instead of paging through
-- every Supabase user — granting/revoking staff access (see
-- services/superadmin/src/routes/platform-ops-router.ts) writes to BOTH the
-- Supabase user's app_metadata AND this table in the same request, but if
-- they were ever to disagree, Supabase wins.
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_staff (
  user_id        UUID         PRIMARY KEY,   -- Supabase user id; no FK (not a row in tenant-scoped `users`)
  email          VARCHAR(255) NOT NULL,
  platform_role  VARCHAR(20)  NOT NULL
                              CHECK (platform_role IN ('SUPPORT', 'BILLING_ADMIN', 'SUPERADMIN')),
  granted_by     UUID         NOT NULL,
  granted_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_platform_staff_active
  ON platform_staff(platform_role)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant_rate_limits (
  tenant_id       UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_requests    INTEGER      NOT NULL CHECK (max_requests > 0),
  window_seconds  INTEGER      NOT NULL CHECK (window_seconds > 0),
  reason          TEXT,
  set_by          UUID         NOT NULL,
  set_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_error_logs (
  id           UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  service      VARCHAR(50)   NOT NULL,
  tenant_id    UUID,                     -- best-effort context; nullable, no FK — logging must never fail because a tenant lookup failed
  status_code  INTEGER       NOT NULL,
  error_code   VARCHAR(50),
  message      TEXT          NOT NULL,
  path         VARCHAR(500),
  request_id   VARCHAR(100),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Hot path: "show me the last N errors" / "errors for service X" — both
-- ORDER BY created_at DESC, so the index carries that order directly.
CREATE INDEX IF NOT EXISTS idx_platform_error_logs_created ON platform_error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_error_logs_service ON platform_error_logs(service, created_at DESC);

-- Retention: error logs are high-volume and short-lived value; a partial
-- index isn't useful here (queries always want "recent"), but callers doing
-- cleanup (DELETE WHERE created_at < NOW() - INTERVAL '30 days') benefit from
-- the plain created_at index above.

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR'));

ANALYZE platform_staff;
ANALYZE tenant_rate_limits;
ANALYZE platform_error_logs;
