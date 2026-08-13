-- =============================================================================
-- MIGRATION: 020_inventory_uom_reorder.sql
-- PURPOSE:   Unit-of-measure conversion table, reorder-quantity + a JSONB
--            config column on inventories, an append-only reorder-event log,
--            and a real fix for a live, currently-active bug in
--            audit_logs.entity_type's CHECK constraint.
-- =============================================================================

ALTER TABLE inventories
  ADD COLUMN IF NOT EXISTS base_unit VARCHAR(20) NOT NULL DEFAULT 'pieces',
  ADD COLUMN IF NOT EXISTS reorder_quantity DECIMAL(12,3),
  -- Fixes services/inventory/src/routes/batches-router.ts's pre-existing,
  -- currently-broken reference to `inventories.config` (batch/expiry
  -- tracking reads/writes this column, which never actually existed —
  -- /batches and /expired-alerts 500 today). Not related to this feature's
  -- own scope, but this migration is already touching `inventories` and the
  -- fix is free.
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN inventories.reorder_level IS
  'Reorder-point / min-stock-level threshold — triggers LOW_STOCK when stock_quantity <= this value. Deliberately not renamed to min_stock_level: that would require a wide rename across the frontend Product type/table column/ProductFormModal and two backend services'' low-stock filters for a purely cosmetic gain.';

-- =============================================================================
-- UNIT-OF-MEASURE CONVERSION TABLE
-- =============================================================================
-- Holds only NON-base selling units for a product — the base unit itself
-- (inventories.base_unit) is implicit and never gets a row here. Conversion
-- direction: "1 of this unit = conversion_factor base_units", e.g.
-- unit_name='Carton', conversion_factor=24 when base_unit='pieces'.
CREATE TABLE IF NOT EXISTS product_units (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id         UUID          NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  unit_name          VARCHAR(30)   NOT NULL,
  conversion_factor  DECIMAL(12,4) NOT NULL CHECK (conversion_factor > 0),
  is_default         BOOLEAN       NOT NULL DEFAULT FALSE,
  created_by         UUID          REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_units_tenant_product_unit
  ON product_units(tenant_id, product_id, unit_name) WHERE deleted_at IS NULL;

-- At most one default selling unit per product — prevents "which unit does
-- the POS show by default" from ever being ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_units_one_default
  ON product_units(product_id) WHERE is_default = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_product_units_updated_at ON product_units;
CREATE TRIGGER trg_product_units_updated_at
  BEFORE UPDATE ON product_units
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
  -- fn_set_updated_at() already exists (001_initial_schema.sql), same
  -- trigger function inventories/product_variants already use.

-- =============================================================================
-- REORDER EVENT LOG — append-only, one row per sale that left a product
-- at/below its reorder_level. NOT a mutable status column (would drift the
-- moment stock changes via restock/adjust/import without updating it).
-- =============================================================================
CREATE TABLE IF NOT EXISTS inventory_reorder_logs (
  id                          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id                  UUID          NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  product_sku                 VARCHAR(50)   NOT NULL,   -- snapshot at trigger time
  stock_at_trigger             DECIMAL(12,3) NOT NULL,
  reorder_level_at_trigger     INTEGER       NOT NULL,
  reorder_quantity_at_trigger  DECIMAL(12,3),
  -- Same shared Postgres DB as sales-sync's `sales` table — no per-service
  -- DB ownership boundary in this codebase (product_variants/supplier_logs
  -- already FK into inventories from a migration owned by this exact
  -- service). ON DELETE SET NULL: the log entry survives a purged sale.
  triggered_by_sale_id         UUID          REFERENCES sales(id) ON DELETE SET NULL,
  created_at                   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_reorder_logs_tenant
  ON inventory_reorder_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_reorder_logs_product
  ON inventory_reorder_logs(product_id, created_at DESC);

-- =============================================================================
-- audit_logs.entity_type CHECK — restore 'sync_device' (regression fix) and
-- add 'product_unit'.
--
-- Migration 015 redeclared this CHECK to add 'product_variant'/'supplier_log'
-- but, in doing so, silently dropped 'sync_device' (added by migration 006).
-- services/sales-sync/src/services/sync-service.ts's flagDeviceClockDrift()
-- is live code that still writes entity_type='sync_device' on every detected
-- clock-drift event — confirmed against the live DB constraint (queried
-- directly via pg_get_constraintdef) that 'sync_device' is genuinely absent
-- today. Every clock-drift detection has been throwing a CHECK violation and
-- rolling back that sync batch since 015 shipped. Fixed here since this
-- migration is already touching the exact same constraint for 'product_unit'
-- — re-shipping the same gap a second time would be indefensible.
-- =============================================================================
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp',
     'cash_drawer_shift', 'sync_device', 'product_variant', 'supplier_log', 'product_unit'));

ANALYZE inventories;
ANALYZE product_units;
ANALYZE inventory_reorder_logs;
