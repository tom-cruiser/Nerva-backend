-- =============================================================================
-- MIGRATION: 004_cash_drawer_shifts.sql
-- PURPOSE:   Cash drawer shift open/close/reconciliation tracking.
--
-- NOTE: An earlier attempt at this feature shipped only a rollback script
-- (002_premium_modules_down.sql) — the matching "up" migration that actually
-- creates this table was never committed, so the table has never existed in
-- any environment that only ran the checked-in migrations. This migration is
-- the real "up" for that feature.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cash_drawer_shifts (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Immutable worker tag of whoever opened / closed the shift (mirrors the
  -- worker_tag convention used on sales and audit_logs — no FK, plain string).
  worker_tag           VARCHAR(100) NOT NULL,
  closed_by_worker_tag VARCHAR(100),

  opened_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,

  opening_balance  DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  -- Populated at close time: opening_balance + CASH-only PAID sales in the window.
  sales_total      DECIMAL(12,2) CHECK (sales_total >= 0),
  expected_cash    DECIMAL(12,2) CHECK (expected_cash >= 0),
  reported_cash    DECIMAL(12,2) CHECK (reported_cash >= 0),
  -- reported_cash - expected_cash; negative = drawer short, positive = drawer over.
  discrepancy      DECIMAL(12,2),

  status           VARCHAR(20)   NOT NULL DEFAULT 'OPEN'
                                 CHECK (status IN ('OPEN', 'CLOSED', 'ANOMALY', 'FORCE_CLOSED')),

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Hottest query: "does this tenant have an open shift right now" (GET /current,
-- and the guard in POST /open). A partial UNIQUE index doubles as an
-- application-level invariant enforced at the DB layer — at most one open
-- shift per tenant, even under concurrent open requests.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_drawer_shifts_one_open_per_tenant
  ON cash_drawer_shifts(tenant_id)
  WHERE closed_at IS NULL;

-- Shift history listing, most recent first.
CREATE INDEX IF NOT EXISTS idx_cash_drawer_shifts_tenant_opened
  ON cash_drawer_shifts(tenant_id, opened_at DESC);

ANALYZE cash_drawer_shifts;
