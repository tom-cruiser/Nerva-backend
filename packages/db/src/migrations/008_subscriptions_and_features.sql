-- =============================================================================
-- MIGRATION: 008_subscriptions_and_features.sql
-- PURPOSE:   Subscription plans/billing status, resource limits, feature flags
--
-- `tenants.billing_tier` (existing) stays the single column every service
-- already reads for "which plan" (tierGate, seats-handler, the frontend's
-- TIER_SEAT_LIMITS) — this migration does NOT replace it. `subscriptions` adds
-- what billing_tier never had: a lifecycle status (TRIALING/ACTIVE/PAST_DUE/
-- CANCELLED), trial/period dates, and history. A trigger keeps
-- `tenants.billing_tier` in sync with `subscriptions.plan_code` so there is
-- still exactly one column everything else needs to read, and exactly one
-- write path (subscriptions) going forward — the superadmin tier-change route
-- is updated in code (not here) to write through `subscriptions`.
-- =============================================================================

-- =============================================================================
-- 1. SUBSCRIPTION PLAN CATALOG
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  code                      VARCHAR(20)   PRIMARY KEY
                                          CHECK (code IN ('starter', 'premium', 'business', 'business_premium')),
  name                      VARCHAR(100)  NOT NULL,
  price_cents               INTEGER       NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  billing_interval          VARCHAR(10)   NOT NULL DEFAULT 'monthly'
                                          CHECK (billing_interval IN ('monthly', 'annual')),
  max_cashiers              INTEGER       CHECK (max_cashiers IS NULL OR max_cashiers > 0),        -- NULL = unlimited
  max_locations             INTEGER       CHECK (max_locations IS NULL OR max_locations > 0),      -- NULL = unlimited; NOT YET ENFORCED — see note below
  max_monthly_transactions  INTEGER       CHECK (max_monthly_transactions IS NULL OR max_monthly_transactions > 0), -- NULL = unlimited
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- NOTE on max_locations: there is no `locations`/branches entity anywhere in
-- this schema yet (single shop per tenant). The limit column exists so a plan
-- can declare one, but nothing currently enforces it — that requires a real
-- locations table/feature that doesn't exist. Flagged here rather than
-- silently pretending it's wired up.

-- Seed rows matching the tier codes already hardcoded in
-- packages/gateway/src/router.ts's FEATURE_MAP and
-- services/auth-tenant/src/handlers/seats-handler.ts's TIER_LIMITS, so this
-- table becomes the single source of truth those should (and, for seats,
-- now do — see code changes) read from instead of a hardcoded object.
INSERT INTO subscription_plans (code, name, price_cents, billing_interval, max_cashiers, max_locations, max_monthly_transactions) VALUES
  ('starter',          'Starter',          0,     'monthly', 2,    1,    500),
  ('premium',          'Premium',          15000, 'monthly', 5,    1,    5000),
  ('business',         'Business',         45000, 'monthly', 15,   5,    50000),
  ('business_premium', 'Business Premium', 90000, 'monthly', NULL, NULL, NULL)
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 2. SUBSCRIPTIONS — one active billing record per tenant
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID          NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code             VARCHAR(20)   NOT NULL REFERENCES subscription_plans(code),
  status                VARCHAR(20)   NOT NULL DEFAULT 'TRIALING'
                                      CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED')),
  trial_ends_at         TIMESTAMPTZ,
  current_period_start  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  current_period_end    TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN       NOT NULL DEFAULT FALSE,
  canceled_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan   ON subscriptions(plan_code);

-- Backfill: every existing tenant gets an ACTIVE subscription matching its
-- current billing_tier, so the table is authoritative from the moment this
-- migration runs rather than starting empty while tenants.billing_tier
-- silently disagrees with "no subscription on file".
INSERT INTO subscriptions (tenant_id, plan_code, status, current_period_start)
SELECT id, billing_tier, 'ACTIVE', created_at
FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_tenant_billing_tier() RETURNS TRIGGER AS $$
BEGIN
  UPDATE tenants SET billing_tier = NEW.plan_code, updated_at = NOW() WHERE id = NEW.tenant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tenant_billing_tier ON subscriptions;
CREATE TRIGGER trg_sync_tenant_billing_tier
  AFTER INSERT OR UPDATE OF plan_code ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_tenant_billing_tier();

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- =============================================================================
-- 3. BILLING EVENTS — payment/plan history log
-- =============================================================================
CREATE TABLE IF NOT EXISTS billing_events (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  UUID          REFERENCES subscriptions(id) ON DELETE SET NULL,
  event_type       VARCHAR(30)   NOT NULL
                                 CHECK (event_type IN
                                   ('INVOICE_PAID', 'INVOICE_FAILED', 'PLAN_CHANGED',
                                    'TRIAL_STARTED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_REACTIVATED')),
  amount_cents     INTEGER,
  notes            TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events(tenant_id, created_at DESC);

-- =============================================================================
-- 4. FEATURE FLAGS — global catalog, per-plan defaults, per-tenant overrides
-- =============================================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  key              VARCHAR(50)   PRIMARY KEY,
  description      TEXT,
  default_enabled  BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO feature_flags (key, description, default_enabled) VALUES
  ('whatsapp_reporting',   'Automated WhatsApp sales/inventory reports',                FALSE),
  ('multi_currency',       'Accept/record sales in more than one currency',             FALSE),
  ('advanced_analytics',   'Extended reporting beyond the standard dashboard',          FALSE),
  ('markdowns',            'Bulk/scheduled price markdowns',                            FALSE),
  ('batch_expiry',         'Batch/lot expiry tracking and dashboards',                  FALSE),
  ('credit_ledger',        'Customer credit ledger (pay-later balances)',               TRUE),
  ('expiry_notifications', 'Proactive batch-expiry WhatsApp/email notifications',       FALSE)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS plan_feature_flags (
  plan_code  VARCHAR(20)  NOT NULL REFERENCES subscription_plans(code),
  flag_key   VARCHAR(50)  NOT NULL REFERENCES feature_flags(key),
  enabled    BOOLEAN      NOT NULL DEFAULT TRUE,
  PRIMARY KEY (plan_code, flag_key)
);

-- Seed per-plan defaults matching the FEATURE_MAP already hardcoded in
-- packages/gateway/src/router.ts, so the two never drift once code is
-- updated to read from here instead.
INSERT INTO plan_feature_flags (plan_code, flag_key, enabled) VALUES
  ('starter',          'credit_ledger',        TRUE),
  ('premium',          'credit_ledger',        TRUE),
  ('premium',          'markdowns',            TRUE),
  ('premium',          'batch_expiry',         TRUE),
  ('business',         'credit_ledger',        TRUE),
  ('business',         'markdowns',            TRUE),
  ('business',         'batch_expiry',         TRUE),
  ('business_premium', 'credit_ledger',        TRUE),
  ('business_premium', 'markdowns',            TRUE),
  ('business_premium', 'batch_expiry',         TRUE),
  ('business_premium', 'expiry_notifications', TRUE)
ON CONFLICT (plan_code, flag_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_feature_flags (
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_key       VARCHAR(50)  NOT NULL REFERENCES feature_flags(key),
  enabled        BOOLEAN      NOT NULL,
  overridden_by  UUID,                    -- superadmin's Supabase user id; no FK (not a tenant-scoped user)
  overridden_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, flag_key)
);

ANALYZE subscription_plans;
ANALYZE subscriptions;
ANALYZE billing_events;
ANALYZE feature_flags;
ANALYZE plan_feature_flags;
ANALYZE tenant_feature_flags;
