-- =============================================================================
-- MIGRATION: 017_subscription_requests.sql
-- PURPOSE:   Admin-initiated plan-upgrade request queue.
--
-- A Shop Admin can already have their plan changed unilaterally by a Super
-- Admin (services/superadmin's subscriptions-router.ts POST
-- /tenants/:id/subscription/change-plan) — what's missing is the OTHER
-- direction: the Admin asking for an upgrade and a Super Admin approving or
-- declining it. This table is that request queue. It does NOT duplicate
-- `subscriptions` — approval WRITES to `subscriptions` (plan_code,
-- billing_cycle, status, period dates), this table only tracks the
-- request/decision lifecycle around that write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_requests (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_plan_code VARCHAR(20)   NOT NULL REFERENCES subscription_plans(code),
  billing_cycle       VARCHAR(10)   NOT NULL
                                    CHECK (billing_cycle IN ('monthly', 'semestral', 'annual')),
  status              VARCHAR(10)   NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by        UUID          NOT NULL REFERENCES users(id),
  decided_by          UUID,         -- superadmin's Supabase user id; no FK (not a tenant-scoped user)
  decided_at          TIMESTAMPTZ,
  decision_reason     TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- A tenant can only have one outstanding request at a time — prevents a
-- confused/impatient Admin from queuing duplicate requests, and keeps "does
-- this tenant have a pending request" a trivial existence check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_requests_one_pending
  ON subscription_requests(tenant_id)
  WHERE status = 'PENDING';

-- The Super Admin dashboard's hot query: list pending requests newest-first.
CREATE INDEX IF NOT EXISTS idx_subscription_requests_status
  ON subscription_requests(status, created_at DESC);

DROP TRIGGER IF EXISTS trg_subscription_requests_updated_at ON subscription_requests;
CREATE TRIGGER trg_subscription_requests_updated_at
  BEFORE UPDATE ON subscription_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  -- touch_updated_at() already exists (defined in 008_subscriptions_and_features.sql).

ANALYZE subscription_requests;
