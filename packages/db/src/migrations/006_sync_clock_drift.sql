-- =============================================================================
-- MIGRATION: 006_sync_clock_drift.sql
-- PURPOSE:   Support server-side clock-skew detection for offline sync.
--
-- sales-sync validates every incoming change's client timestamp against the
-- server clock and rejects (rather than silently applying) any change whose
-- timestamp drifts beyond an acceptable window — see
-- services/sales-sync/src/services/sync-service.ts (`checkClockDrift`).
--
-- This migration adds:
--   1. Per-device drift bookkeeping on sync_cursors, so a device with a
--      misconfigured clock can be identified/flagged for the client to
--      prompt a clock resync, and so operators can see which devices are
--      repeatedly drifting.
--   2. A `CLOCK_DRIFT` audit action + `sync_device` entity_type, so each
--      drift event is durably logged (tenant + device + observed drift)
--      alongside every other audit trail entry.
-- =============================================================================

ALTER TABLE sync_cursors
  ADD COLUMN IF NOT EXISTS clock_drift_flagged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clock_drift_count      INTEGER NOT NULL DEFAULT 0;

-- Ops/monitoring: quickly find devices currently flagged for clock drift.
CREATE INDEX IF NOT EXISTS idx_sync_cursors_clock_drift
  ON sync_cursors(tenant_id, clock_drift_flagged_at)
  WHERE clock_drift_flagged_at IS NOT NULL;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp',
     'cash_drawer_shift', 'sync_device'));

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN
    ('CREATE', 'UPDATE', 'SOFT_DELETE', 'VOID', 'RECONCILE',
     'LOGIN', 'LOGIN_FAIL', 'LOCK', 'CREDIT', 'PAYMENT', 'CLOCK_DRIFT'));
