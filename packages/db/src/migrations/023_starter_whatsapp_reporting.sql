-- =============================================================================
-- MIGRATION: 023_starter_whatsapp_reporting.sql
-- PURPOSE:   Extend the `whatsapp_reporting` feature flag (008/013/022) to
--            the `starter` plan too, so every plan tier can now configure
--            automated WhatsApp report delivery.
-- =============================================================================

INSERT INTO plan_feature_flags (plan_code, flag_key, enabled) VALUES
  ('starter', 'whatsapp_reporting', TRUE)
ON CONFLICT (plan_code, flag_key) DO UPDATE SET enabled = TRUE;

ANALYZE plan_feature_flags;
