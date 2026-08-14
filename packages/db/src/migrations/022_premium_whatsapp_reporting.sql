-- =============================================================================
-- MIGRATION: 022_premium_whatsapp_reporting.sql
-- PURPOSE:   Extend the `whatsapp_reporting` feature flag (008/013) to the
--            `premium` plan, not just `business`/`business_premium`.
--
-- Product decision made live: with the Admin Reports & Analytics Dashboard
-- and the automated WhatsApp Scheduled Reporting Engine now shipped
-- (whatsapp-report.md), `premium`-tier tenants should also be able to
-- configure automated report delivery — confirmed against a real tenant
-- ("Dollar", premium plan) hitting 403 FEATURE_NOT_ENABLED on
-- POST /api/v1/whatsapp/reports/schedule before this change.
-- =============================================================================

INSERT INTO plan_feature_flags (plan_code, flag_key, enabled) VALUES
  ('premium', 'whatsapp_reporting', TRUE)
ON CONFLICT (plan_code, flag_key) DO UPDATE SET enabled = TRUE;

ANALYZE plan_feature_flags;
