-- =============================================================================
-- MIGRATION: 024_sale_refunds.sql
-- PURPOSE:   Goods-refund support — a customer returning purchased items
--            against an existing `sales` row.
--
-- Design notes:
--   * `sale_refunds` is append-only, like `ledger_entries`/`audit_logs` — a
--     sale can be refunded more than once (partial returns over several
--     visits), so this is a log of refund events, not a mutable status flag.
--   * `items_refunded` mirrors `sales.items_sold`'s denormalised JSONB shape
--     ([{product_sku, quantity, unit?, unit_price, total}]) rather than a
--     child table — consistent with how this codebase already stores sale
--     line items, and the set of refund lines is always small and never
--     queried/filtered on individually.
--   * `sales.refunded_amount` is a maintained running total (same pattern as
--     `customer_ledger.balance` next to append-only `ledger_entries`) so
--     "how much of this sale has been refunded" is an O(1) read rather than
--     a SUM() over sale_refunds on every sale list/detail fetch.
--   * payment_status gains 'PARTIALLY_REFUNDED' alongside the existing
--     'REFUNDED' (which up to now was declared but never actually reachable
--     — nothing set it). 'REFUNDED' means the full total_amount has been
--     returned; 'PARTIALLY_REFUNDED' means some but not all of it has.
--   * audit_logs.action gains 'REFUND', following the exact widen-a-CHECK
--     pattern used by migrations 006/009/011/012/014/018/020.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_refunds (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id           UUID          NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  -- Schema: [{product_sku, quantity, unit_price, total, unit?}] — the
  -- subset of the original sale's items_sold being returned, at the
  -- quantities/unit-prices they were originally sold at.
  items_refunded    JSONB         NOT NULL,
  refund_amount     DECIMAL(10,2) NOT NULL CHECK (refund_amount > 0),
  reason            VARCHAR(255)  NOT NULL,
  -- FALSE for goods that came back damaged/unsellable — money is still
  -- refunded but stock is deliberately NOT put back into inventories.
  restocked         BOOLEAN       NOT NULL DEFAULT TRUE,
  -- Set only when the original sale was on customer credit — the
  -- customer_ledger ADJUSTMENT entry this refund produced.
  ledger_entry_id   UUID          REFERENCES ledger_entries(id) ON DELETE SET NULL,
  -- Caller-supplied dedup key (e.g. a client-generated UUID) — lets a
  -- retried/double-submitted request replay the same refund idempotently
  -- instead of refunding stock/ledger twice. NULL when the caller doesn't
  -- supply one.
  client_reference  VARCHAR(100),
  worker_tag        VARCHAR(100)  NOT NULL,
  refunded_by       UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 1. Refund history for one sale, newest first (sale detail view)
CREATE INDEX IF NOT EXISTS idx_sale_refunds_tenant_sale
  ON sale_refunds(tenant_id, sale_id, created_at DESC);

-- 2. Tenant-wide refund feed / reporting
CREATE INDEX IF NOT EXISTS idx_sale_refunds_tenant_created
  ON sale_refunds(tenant_id, created_at DESC);

-- 3. Idempotency lookup — only when the caller actually supplied a key
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_refunds_client_reference
  ON sale_refunds(tenant_id, sale_id, client_reference)
  WHERE client_reference IS NOT NULL;

CREATE TRIGGER trg_tenant_id_sale_refunds
  BEFORE INSERT ON sale_refunds
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

-- ── running total on the parent sale ────────────────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS refunded_amount DECIMAL(10,2) NOT NULL DEFAULT 0
    CHECK (refunded_amount >= 0);

-- ── payment_status: add PARTIALLY_REFUNDED ──────────────────────────────────
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_status_check
  CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED'));

-- ── audit_logs.action: add REFUND (superset of 001's list + 006's CLOCK_DRIFT
--    addition — see 006_sync_clock_drift.sql) ────────────────────────────────
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN
    ('CREATE','UPDATE','SOFT_DELETE','VOID','RECONCILE',
     'LOGIN','LOGIN_FAIL','LOCK','CREDIT','PAYMENT','CLOCK_DRIFT','REFUND'));

ANALYZE sale_refunds;
ANALYZE sales;
