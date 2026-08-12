-- ROLLBACK: 006_sync_clock_drift.sql

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN
    ('CREATE', 'UPDATE', 'SOFT_DELETE', 'VOID', 'RECONCILE',
     'LOGIN', 'LOGIN_FAIL', 'LOCK', 'CREDIT', 'PAYMENT'));

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp', 'cash_drawer_shift'));

DROP INDEX IF EXISTS idx_sync_cursors_clock_drift;

ALTER TABLE sync_cursors
  DROP COLUMN IF EXISTS clock_drift_flagged_at,
  DROP COLUMN IF EXISTS clock_drift_count;
