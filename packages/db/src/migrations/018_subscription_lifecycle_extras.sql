-- =============================================================================
-- MIGRATION: 018_subscription_lifecycle_extras.sql
-- PURPOSE:   Support the subscription-request approval flow and the
--            automated daily expiration cron.
--
-- 1. `subscriptions.billing_cycle` — the plan catalog's own
--    `subscription_plans.billing_interval` is a per-PLAN default
--    (monthly/annual), not something an Admin picks per request. This is the
--    ACTUAL cycle the tenant is currently on (monthly/semestral/annual),
--    set at approval time — used to compute `current_period_end` and to
--    display "renews in N days" correctly.
--
-- 2. Widen platform_audit_logs.action and billing_events.event_type CHECK
--    constraints for the new subscription-request and cron-driven-expiry
--    action/event values. Re-declaring the full list each time (not just
--    appending) is the established convention — see 009/010/011/014.
-- =============================================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'semestral', 'annual'));

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
     -- New this migration:
     'SUB_REQUEST_APPROVE', 'SUB_REQUEST_REJECT'));
  -- Column is already VARCHAR(30) (widened in 012) — both new values (19 and
  -- 18 chars) fit with room to spare; no column-width change needed here.

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_event_type_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN
    ('INVOICE_PAID', 'INVOICE_FAILED', 'PLAN_CHANGED',
     'TRIAL_STARTED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_REACTIVATED',
     -- New this migration:
     'UPGRADE_REQUESTED', 'SUBSCRIPTION_APPROVED', 'SUBSCRIPTION_EXPIRED'));
  -- Column is VARCHAR(30) (008) — longest new value ('SUBSCRIPTION_APPROVED',
  -- 22 chars) fits; no column-width change needed here either.

ANALYZE subscriptions;
ANALYZE platform_audit_logs;
ANALYZE billing_events;
