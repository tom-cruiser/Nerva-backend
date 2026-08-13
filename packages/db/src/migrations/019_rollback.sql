-- ROLLBACK: 019_inventory_stock_decimal.sql
-- NOTE: any fractional values already stored will be truncated by this cast.

ALTER TABLE inventories ALTER COLUMN stock_quantity TYPE INTEGER USING stock_quantity::INTEGER;
