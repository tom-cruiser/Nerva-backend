-- =============================================================================
-- MIGRATION: 015_inventory_variants_and_suppliers.sql
-- PURPOSE:   SKU-variant model + supplier receiving log (design.md's Admin
--            "Store Inventory & Pricing: product catalog, SKUs, variants,
--            stock limits, and supplier logs" requirement — until now,
--            `inventories` only had a single flat `product_sku` per row and
--            there was no supplier-receiving record at all).
--
-- Column/constraint conventions copied from `inventories` (001_initial_schema.sql)
-- so these two tables read like the rest of the inventory schema: UUID PK,
-- tenant_id FK ON DELETE CASCADE, DECIMAL(10,2) money, optimistic `version`
-- lock on the mutable one, created_by/updated_by FKs to users with
-- ON DELETE SET NULL, soft-delete via deleted_at.
--
-- No frontend UI ships with this migration (backend-only, per the "don't
-- redesign existing UI" constraint) — routes are added to
-- services/inventory/src/routes/inventory-router.ts for future/API use.
-- =============================================================================

-- =============================================================================
-- PRODUCT VARIANTS — e.g. size/color/pack-size variations of a base product
-- =============================================================================
CREATE TABLE IF NOT EXISTS product_variants (
  id                UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id        UUID           NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  variant_sku       VARCHAR(50)    NOT NULL,
  variant_name      VARCHAR(255)   NOT NULL,
  -- NULL = inherit the parent product's unit_price; non-NULL overrides it.
  unit_price        DECIMAL(10,2)  CHECK (unit_price IS NULL OR unit_price >= 0),
  stock_quantity    INTEGER        NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  version           INTEGER        NOT NULL DEFAULT 1,
  created_by        UUID           REFERENCES users(id) ON DELETE SET NULL,
  updated_by        UUID           REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT uq_product_variants_tenant_sku UNIQUE (tenant_id, variant_sku)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_tenant_product
  ON product_variants(tenant_id, product_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_variants_tenant_created
  ON product_variants(tenant_id, created_at DESC);

-- =============================================================================
-- SUPPLIER LOGS — append-only record of stock received from a supplier
-- =============================================================================
CREATE TABLE IF NOT EXISTS supplier_logs (
  id                UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id        UUID           NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  product_sku       VARCHAR(50)    NOT NULL, -- snapshot at receipt time; survives a later SKU/name change
  supplier_name     VARCHAR(255)   NOT NULL,
  supplier_contact  VARCHAR(255),
  quantity_received INTEGER        NOT NULL CHECK (quantity_received > 0),
  unit_cost         DECIMAL(10,2)  CHECK (unit_cost IS NULL OR unit_cost >= 0),
  received_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  notes             TEXT,
  created_by        UUID           REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_supplier_logs_tenant_product
  ON supplier_logs(tenant_id, product_id);

CREATE INDEX IF NOT EXISTS idx_supplier_logs_tenant_received
  ON supplier_logs(tenant_id, received_at DESC);

-- Both new tables need to appear in audit_logs (see inventory-router.ts's
-- variant/supplier-log routes) — widen the same way 005 did for
-- cash_drawer_shift.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_entity_type_check
  CHECK (entity_type IN
    ('inventory', 'sale', 'user', 'payment', 'ledger', 'whatsapp',
     'cash_drawer_shift', 'product_variant', 'supplier_log'));

ANALYZE product_variants;
ANALYZE supplier_logs;
