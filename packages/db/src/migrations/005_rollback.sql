-- ROLLBACK: 005_audit_logs_shift_entity.sql
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp'));
