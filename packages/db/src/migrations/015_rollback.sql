-- ROLLBACK: 015_inventory_variants_and_suppliers.sql

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp', 'cash_drawer_shift'));

DROP TABLE IF EXISTS supplier_logs;
DROP TABLE IF EXISTS product_variants;
