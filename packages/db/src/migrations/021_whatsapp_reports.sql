-- =============================================================================
-- MIGRATION: 021_whatsapp_reports.sql
-- PURPOSE:   Admin Reports & Analytics Dashboard + Automated WhatsApp
--            Scheduled Reporting Engine (whatsapp-report.md).
--
-- 1. inventories.cost_price — a stable per-product cost basis. Nothing like
--    this existed before (only supplier_logs.unit_cost, a point-in-time
--    receiving cost) so "Net Profit" could never be honestly computed.
--    Nullable, no default: a product with no cost set is deliberately
--    excluded from profit calculations rather than assumed to cost 0.
--
-- 2. whatsapp_report_schedules — one row per tenant (singular config,
--    matches the Admin Settings framing). Beyond whatsapp-report.md's own
--    literal column list, this adds three columns the feature cannot
--    function without:
--      - day_of_week / day_of_month: the spec's "WEEKLY (select day of
--        week)" / "MONTHLY (select day of month)" fields need somewhere to
--        actually store that selection — the literal deliverable list only
--        had `frequency`, which alone can't express "which day".
--      - last_sent_on: idempotency guard. Without it, a schedule sitting in
--        its matching 15-minute cron window (or two overlapping cron ticks)
--        would double-send.
--
-- 3. whatsapp_report_logs — append-style dispatch history, one row per
--    recipient per attempt (mirrors whatsapp-report.md's column list
--    exactly).
-- =============================================================================

ALTER TABLE inventories
  ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2)
    CHECK (cost_price IS NULL OR cost_price >= 0);

CREATE TABLE IF NOT EXISTS whatsapp_report_schedules (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- One schedule per tenant — the Admin Settings UI configures a single
  -- automated-report setup per store, not a list of independent schedules.
  tenant_id          UUID          NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  enabled            BOOLEAN       NOT NULL DEFAULT FALSE,
  frequency          VARCHAR(10)   NOT NULL DEFAULT 'DAILY'
                                   CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  delivery_time      TIME          NOT NULL DEFAULT '20:00',
  timezone           VARCHAR(50)   NOT NULL DEFAULT 'UTC',
  -- 0=Sunday..6=Saturday, matching Intl/JS Date.getDay() convention used by
  -- the cron's tenant-local-time resolution. Required when frequency='WEEKLY'.
  day_of_week        SMALLINT      CHECK (day_of_week BETWEEN 0 AND 6),
  -- 1-31. Required when frequency='MONTHLY'. A tenant whose chosen day
  -- exceeds the current month's length (e.g. 31 in a 30-day month) fires on
  -- that month's last day instead — handled in the cron's matching logic,
  -- not here.
  day_of_month       SMALLINT      CHECK (day_of_month BETWEEN 1 AND 31),
  -- Primary Shop Owner phone (+ optional secondary manager phone) as a
  -- JSON string array, e.g. ["+237600000000", "+237600000001"].
  recipient_phones   JSONB         NOT NULL DEFAULT '[]',
  -- Subset of {"sales_summary","cashier_breakdown","low_stock_warnings","profit_metrics"}.
  included_sections  JSONB         NOT NULL DEFAULT '["sales_summary"]',
  -- Tenant-local calendar date (YYYY-MM-DD) this schedule last had a
  -- dispatch attempted for — the double-send guard described above.
  last_sent_on       DATE,
  updated_by         UUID          REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_report_logs (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_phone   VARCHAR(30)   NOT NULL,
  status            VARCHAR(10)   NOT NULL CHECK (status IN ('SENT', 'FAILED')),
  sent_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  error_details     TEXT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_report_logs_tenant
  ON whatsapp_report_logs(tenant_id, sent_at DESC);
