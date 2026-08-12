-- =============================================================================
-- MIGRATION: 012_widen_audit_action.sql
-- PURPOSE:   Fix platform_audit_logs.action being too narrow for its own
--            allowed values.
--
-- The column was declared VARCHAR(20) in migration 007, but 'ANNOUNCEMENT_
-- DEACTIVATE' (23 chars, added by migration 010) exceeds that — the CHECK
-- constraint allows the value, but Postgres would reject the INSERT itself
-- with "value too long for type character varying(20)" the moment
-- settings-router.ts's POST /announcements/:id/deactivate ever ran. The CHECK
-- constraint listing a value doesn't imply the column can hold it — this
-- migration was needed regardless of which future action names get added.
-- VARCHAR(30) covers every current value with headroom for reasonably-named
-- future ones without needing another widening migration immediately.
-- =============================================================================

ALTER TABLE platform_audit_logs ALTER COLUMN action TYPE VARCHAR(30);
