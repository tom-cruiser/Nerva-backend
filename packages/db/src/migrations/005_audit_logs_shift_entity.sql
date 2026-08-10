-- =============================================================================
-- MIGRATION: 005_audit_logs_shift_entity.sql
-- PURPOSE:   Allow cash_drawer_shift audit entries.
--
-- audit_logs.entity_type never included 'cash_drawer_shift', so shift-close
-- reconciliation (which writes an audit_logs row) violated
-- audit_logs_entity_type_check on every call. 'RECONCILE' was already a valid
-- `action` value — it just had no entity_type allowed to use it with.
-- =============================================================================

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp', 'cash_drawer_shift'));
