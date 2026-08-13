-- =============================================================================
-- MIGRATION: 013_seed_whatsapp_reporting_flag.sql
-- PURPOSE:   Seed per-plan defaults for the `whatsapp_reporting` feature flag
--            BEFORE runtime enforcement of it ships (see @retail/middleware's
--            requireFeatureFlag(), applied to services/whatsapp-engine's
--            report-routes.ts in the same change).
--
-- `feature_flags.whatsapp_reporting` (migration 008) has always had
-- `default_enabled = FALSE`, and it was never listed in the legacy
-- `packages/gateway/src/router.ts` FEATURE_MAP either — so up to now, calling
-- POST /send-report or /schedule-report worked for every tenant regardless of
-- plan (the flag existed but nothing ever checked it). The moment enforcement
-- ships, every tenant would be locked out unless a plan explicitly grants it
-- here first. Gate it the same way credit_ledger/markdowns/batch_expiry
-- already step up by tier: available on the two higher tiers only.
-- =============================================================================

INSERT INTO plan_feature_flags (plan_code, flag_key, enabled) VALUES
  ('business',         'whatsapp_reporting', TRUE),
  ('business_premium', 'whatsapp_reporting', TRUE)
ON CONFLICT (plan_code, flag_key) DO NOTHING;

ANALYZE plan_feature_flags;
