-- =============================================================================
-- MIGRATION: 025_inventory_tax_rate.sql
-- PURPOSE:   Per-product tax rate, set by the shop owner on each item —
--            replaces the flat 5% tax the POS used to apply to every sale
--            regardless of product (see app/(app)/pos/page.tsx on the
--            frontend). There is no tenant-wide "general tax rate" setting;
--            each product carries its own rate, defaulting to 0 (no tax)
--            for every existing and newly-created row until the owner sets
--            one explicitly.
--
-- DECIMAL(5,2): 0.00-100.00 with 2 decimal places — enough precision for any
-- real-world sales-tax/VAT rate, same column-sizing rationale as
-- customer_ledger.balance et al. elsewhere in this schema.
-- =============================================================================

ALTER TABLE inventories
  ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0
    CHECK (tax_rate >= 0 AND tax_rate <= 100);

COMMENT ON COLUMN inventories.tax_rate IS
  'Percentage tax rate the shop owner sets on this specific product (0-100). Applied per line item at POS checkout — there is no tenant-wide default; unset means 0%.';

ANALYZE inventories;
