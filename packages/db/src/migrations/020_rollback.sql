-- ROLLBACK: 020_inventory_uom_reorder.sql

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp',
     'cash_drawer_shift', 'product_variant', 'supplier_log'));
  -- NOTE: this restores 015's (buggy) list, i.e. re-drops 'sync_device'.
  -- Intentional for a clean rollback of exactly what 020 changed — re-fixing
  -- that regression again would need its own forward migration.

DROP TABLE IF EXISTS inventory_reorder_logs;

DROP TRIGGER IF EXISTS trg_product_units_updated_at ON product_units;
DROP TABLE IF EXISTS product_units;

ALTER TABLE inventories
  DROP COLUMN IF EXISTS config,
  DROP COLUMN IF EXISTS reorder_quantity,
  DROP COLUMN IF EXISTS base_unit;
