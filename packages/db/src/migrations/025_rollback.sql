-- ROLLBACK: 025_inventory_tax_rate.sql
ALTER TABLE inventories DROP COLUMN IF EXISTS tax_rate;
