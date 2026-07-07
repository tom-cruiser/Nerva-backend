-- =============================================================================
-- MIGRATION: 001_initial_schema.sql
-- PURPOSE:   Enterprise multi-tenant Retail SaaS — full baseline schema
-- STRATEGY:  Composite index pattern (tenant_id + business_key) on every table
-- COMPAT:    PostgreSQL 15+
-- =============================================================================

-- =============================================================================
-- 0. EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "btree_gin";   -- advanced GIN + btree composite ops

-- =============================================================================
-- 1. TENANTS  (root of multi-tenancy — no tenant_id FK on this table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(255) NOT NULL,
  slug         VARCHAR(100) NOT NULL,
  config       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  timezone     VARCHAR(50)  NOT NULL DEFAULT 'UTC',
  currency     VARCHAR(3)   NOT NULL DEFAULT 'XAF',
  billing_tier VARCHAR(20)  NOT NULL DEFAULT 'starter'
                            CHECK (billing_tier IN ('starter', 'premium', 'business', 'business_premium')),
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenants_slug UNIQUE (slug)
);

-- Partial index: active-tenant lookup is the hot path (auth, middleware)
CREATE INDEX IF NOT EXISTS idx_tenants_slug      ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_is_active ON tenants(is_active)
  WHERE is_active = TRUE;

-- =============================================================================
-- 2. USERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                 VARCHAR(255) NOT NULL,
  hashed_password       VARCHAR(255) NOT NULL,
  full_name             VARCHAR(255),
  role                  VARCHAR(50)  NOT NULL DEFAULT 'STAFF'
                                     CHECK (role IN ('OWNER', 'MANAGER', 'STAFF')),
  worker_tag            VARCHAR(100) NOT NULL DEFAULT 'system',
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at         TIMESTAMPTZ,
  failed_login_attempts SMALLINT     NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  version               INTEGER      NOT NULL DEFAULT 1,        -- optimistic lock
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,                            -- soft delete
  CONSTRAINT uq_users_tenant_email UNIQUE (tenant_id, email)
);

-- PRIMARY composite: tenant + email (login hot path)
CREATE INDEX IF NOT EXISTS idx_users_tenant_email
  ON users(tenant_id, email);

-- Secondary: role-based queries (RBAC middleware)
CREATE INDEX IF NOT EXISTS idx_users_tenant_role
  ON users(tenant_id, role);

-- Partial: active users only (most reads exclude soft-deleted rows)
CREATE INDEX IF NOT EXISTS idx_users_tenant_active
  ON users(tenant_id, is_active)
  WHERE is_active = TRUE AND deleted_at IS NULL;

-- Audit: worker_tag lookup across tenants (theft investigation reports)
CREATE INDEX IF NOT EXISTS idx_users_worker_tag
  ON users(worker_tag);

-- Soft-delete guard: fast filter for non-deleted rows
CREATE INDEX IF NOT EXISTS idx_users_tenant_live
  ON users(tenant_id, deleted_at)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 3. INVENTORIES
-- =============================================================================
CREATE TABLE IF NOT EXISTS inventories (
  id             UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_sku    VARCHAR(50)    NOT NULL,
  barcode        VARCHAR(100),
  name           VARCHAR(255)   NOT NULL,
  description    TEXT,
  unit_price     DECIMAL(10,2)  NOT NULL DEFAULT 0
                                CHECK (unit_price >= 0),
  stock_quantity INTEGER        NOT NULL DEFAULT 0
                                CHECK (stock_quantity >= 0),
  reorder_level  INTEGER        NOT NULL DEFAULT 0
                                CHECK (reorder_level >= 0),
  category       VARCHAR(100),
  supplier_id    UUID,
  version        INTEGER        NOT NULL DEFAULT 1,             -- optimistic lock
  -- LWW offline-sync: client-side logical timestamp (WatermelonDB)
  client_updated_at TIMESTAMPTZ,
  created_by     UUID           REFERENCES users(id) ON DELETE SET NULL,
  updated_by     UUID           REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT uq_inventories_tenant_sku UNIQUE (tenant_id, product_sku)
);

-- 1. PRIMARY composite: tenant + SKU — single-product fetch (fastest path)
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventories_tenant_sku
  ON inventories(tenant_id, product_sku);

-- 2. Category filter: browsing / category-level reports
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_category
  ON inventories(tenant_id, category)
  WHERE deleted_at IS NULL;

-- 3. Time-series: newest products first (dashboard, sync pull)
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_created
  ON inventories(tenant_id, created_at DESC);

-- 4. Low-stock alert: partial index — only rows at or below reorder level
--    Cannot reference another column in WHERE; use a generated expression instead.
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_low_stock
  ON inventories(tenant_id, stock_quantity)
  WHERE deleted_at IS NULL;

-- 5. Name search: full product-name lookup (search bar)
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_name
  ON inventories(tenant_id, name)
  WHERE deleted_at IS NULL;

-- 6. Price-range queries: (tenant_id, unit_price) for filtered browsing
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_price
  ON inventories(tenant_id, unit_price)
  WHERE deleted_at IS NULL;

-- 7. Covering index for dashboard list view — avoids heap fetch
--    Columns: tenant_id + name (sort/filter), stock_quantity + unit_price (display)
CREATE INDEX IF NOT EXISTS idx_inventories_tenant_covering
  ON inventories(tenant_id, name, stock_quantity, unit_price)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 4. SALES
-- =============================================================================
CREATE TABLE IF NOT EXISTS sales (
  id               UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id   VARCHAR(100)   NOT NULL,                   -- client idempotency key
  customer_id      UUID,
  -- Denormalised line items for offline-first sync (WatermelonDB batch payload)
  -- Schema: [{product_sku, quantity, unit_price, total, worker_tag}]
  items_sold       JSONB          NOT NULL DEFAULT '[]'::jsonb,
  total_amount     DECIMAL(10,2)  NOT NULL DEFAULT 0
                                  CHECK (total_amount >= 0),
  discount_amount  DECIMAL(10,2)  NOT NULL DEFAULT 0
                                  CHECK (discount_amount >= 0),
  tax_amount       DECIMAL(10,2)  NOT NULL DEFAULT 0
                                  CHECK (tax_amount >= 0),
  payment_method   VARCHAR(50)    NOT NULL
                                  CHECK (payment_method IN ('CASH','MOMO','CREDIT','CARD')),
  payment_status   VARCHAR(50)    NOT NULL DEFAULT 'PENDING'
                                  CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED')),
  worker_tag       VARCHAR(100)   NOT NULL,                   -- immutable theft-prevention tag
  sale_timestamp   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  voided_at        TIMESTAMPTZ,
  void_reason      VARCHAR(255),
  version          INTEGER        NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT uq_sales_tenant_transaction UNIQUE (tenant_id, transaction_id)
);

-- 1. Primary composite: tenant + transaction_id (idempotency dedup lookup)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_tenant_transaction
  ON sales(tenant_id, transaction_id);

-- 2. Time-series: daily/weekly sales reports — most critical query path
CREATE INDEX IF NOT EXISTS idx_sales_tenant_timestamp
  ON sales(tenant_id, sale_timestamp DESC);

-- 3. Payment status: pending/failed reconciliation queue
CREATE INDEX IF NOT EXISTS idx_sales_tenant_status
  ON sales(tenant_id, payment_status)
  WHERE deleted_at IS NULL;

-- 4. Customer purchase history (debt book joins)
CREATE INDEX IF NOT EXISTS idx_sales_tenant_customer
  ON sales(tenant_id, customer_id)
  WHERE customer_id IS NOT NULL AND deleted_at IS NULL;

-- 5. Worker performance / anti-theft reports
CREATE INDEX IF NOT EXISTS idx_sales_tenant_worker
  ON sales(tenant_id, worker_tag, sale_timestamp DESC);

-- 6. Void tracking: partial index — only voided rows
CREATE INDEX IF NOT EXISTS idx_sales_tenant_voided
  ON sales(tenant_id, voided_at DESC)
  WHERE voided_at IS NOT NULL;

-- 7. Covering index for daily digest / WhatsApp report cron
--    INCLUDE pushes display columns into the index leaf pages
CREATE INDEX IF NOT EXISTS idx_sales_tenant_covering
  ON sales(tenant_id, sale_timestamp DESC)
  INCLUDE (total_amount, payment_method, worker_tag);

-- 8. Date-range BETWEEN queries (reporting date picker)
CREATE INDEX IF NOT EXISTS idx_sales_tenant_date_range
  ON sales(tenant_id, sale_timestamp);

-- =============================================================================
-- 5. AUDIT LOGS  (IMMUTABLE — application role has INSERT only, no UPDATE/DELETE)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type VARCHAR(50)  NOT NULL  -- 'inventory' | 'sale' | 'user' | 'payment'
                           CHECK (entity_type IN
                             ('inventory','sale','user','payment','ledger','whatsapp')),
  entity_id   UUID         NOT NULL,
  action      VARCHAR(50)  NOT NULL
                           CHECK (action IN
                             ('CREATE','UPDATE','SOFT_DELETE','VOID','RECONCILE',
                              'LOGIN','LOGIN_FAIL','LOCK','CREDIT','PAYMENT')),
  worker_tag  VARCHAR(100) NOT NULL,
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  old_values  JSONB,
  new_values  JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  -- NO updated_at, NO deleted_at — immutability enforced at DB trigger level
);

-- 1. Entity tracking: find all changes to a specific record
CREATE INDEX IF NOT EXISTS idx_audit_tenant_entity
  ON audit_logs(tenant_id, entity_type, entity_id);

-- 2. Time-series: recent activity feed
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created
  ON audit_logs(tenant_id, created_at DESC);

-- 3. Worker tracking: anti-theft investigation (tenant + tag + time)
CREATE INDEX IF NOT EXISTS idx_audit_tenant_worker
  ON audit_logs(tenant_id, worker_tag, created_at DESC);

-- 4. Action filter: e.g. all LOGIN_FAIL events in last 24 h
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action
  ON audit_logs(tenant_id, action, created_at DESC);

-- 5. Covering index: entity-type timeline with action + tag in leaf pages
CREATE INDEX IF NOT EXISTS idx_audit_tenant_covering
  ON audit_logs(tenant_id, entity_type, created_at DESC)
  INCLUDE (action, worker_tag);

-- =============================================================================
-- 6. MOBILE MONEY TRANSACTIONS
-- =============================================================================
CREATE TABLE IF NOT EXISTS mobile_money_transactions (
  id                     UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code          VARCHAR(20)   NOT NULL
                                       CHECK (provider_code IN
                                         ('MTN_MOMO','AIRTEL_MONEY','ORANGE_MONEY','VODAFONE_CASH')),
  external_transaction_id VARCHAR(100) NOT NULL,
  local_reference        VARCHAR(100)  NOT NULL,
  amount                 DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  currency               VARCHAR(3)    NOT NULL DEFAULT 'XAF',
  customer_phone         VARCHAR(20)   NOT NULL,
  customer_name          VARCHAR(255),
  sale_id                UUID          REFERENCES sales(id) ON DELETE SET NULL,
  status                 VARCHAR(50)   NOT NULL DEFAULT 'PENDING'
                                       CHECK (status IN ('PENDING','COMPLETED','FAILED','REVERSED')),
  provider_response      JSONB,
  reconciliation_status  VARCHAR(50)   NOT NULL DEFAULT 'UNMATCHED'
                                       CHECK (reconciliation_status IN
                                         ('UNMATCHED','RECONCILED','DISPUTED')),
  reconciled_at          TIMESTAMPTZ,
  worker_tag             VARCHAR(100)  NOT NULL,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ,
  CONSTRAINT uq_momo_tenant_external
    UNIQUE (tenant_id, external_transaction_id),
  CONSTRAINT uq_momo_local_reference
    UNIQUE (local_reference)
);

-- 1. Primary composite: dedup on external provider reference
CREATE UNIQUE INDEX IF NOT EXISTS idx_momo_tenant_external
  ON mobile_money_transactions(tenant_id, external_transaction_id);

-- 2. Status + reconciliation: reconciliation worker queue
CREATE INDEX IF NOT EXISTS idx_momo_tenant_status
  ON mobile_money_transactions(tenant_id, status, reconciliation_status)
  WHERE deleted_at IS NULL;

-- 3. Provider + time: per-provider reporting
CREATE INDEX IF NOT EXISTS idx_momo_tenant_provider
  ON mobile_money_transactions(tenant_id, provider_code, created_at DESC);

-- 4. Customer lookup: transaction history by phone number
CREATE INDEX IF NOT EXISTS idx_momo_tenant_customer
  ON mobile_money_transactions(tenant_id, customer_phone);

-- 5. Reconciliation queue: partial index — unmatched only (small, hot set)
CREATE INDEX IF NOT EXISTS idx_momo_tenant_unmatched
  ON mobile_money_transactions(tenant_id, reconciliation_status)
  WHERE reconciliation_status = 'UNMATCHED' AND deleted_at IS NULL;

-- =============================================================================
-- 7. CUSTOMER LEDGER  (Digital Debt Book)
-- =============================================================================
CREATE TABLE IF NOT EXISTS customer_ledger (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id             UUID          NOT NULL,
  customer_name           VARCHAR(255)  NOT NULL,
  customer_phone          VARCHAR(20),
  balance                 DECIMAL(10,2) NOT NULL DEFAULT 0
                                        CHECK (balance >= 0),
  credit_limit            DECIMAL(10,2) NOT NULL DEFAULT 0
                                        CHECK (credit_limit >= 0),
  total_credit_given      DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_payments_received DECIMAL(10,2) NOT NULL DEFAULT 0,
  last_payment_date       TIMESTAMPTZ,
  last_credit_date        TIMESTAMPTZ,
  version                 INTEGER       NOT NULL DEFAULT 1,    -- optimistic lock
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ,
  CONSTRAINT uq_ledger_tenant_customer UNIQUE (tenant_id, customer_id)
);

-- 1. Primary composite: tenant + customer (single-customer fetch)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_tenant_customer
  ON customer_ledger(tenant_id, customer_id);

-- 2. Debtors list: partial index — only customers with outstanding balance
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_balance
  ON customer_ledger(tenant_id, balance DESC)
  WHERE balance > 0 AND deleted_at IS NULL;

-- 3. Last payment: recent-activity sort for the debt dashboard
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_payment_date
  ON customer_ledger(tenant_id, last_payment_date DESC)
  WHERE deleted_at IS NULL;

-- 4. Name search: WhatsApp notification recipient lookup
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_name
  ON customer_ledger(tenant_id, customer_name)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 8. LEDGER ENTRIES  (FIFO credit/payment trail)
-- =============================================================================
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_ledger_id  UUID          NOT NULL
                                    REFERENCES customer_ledger(id) ON DELETE CASCADE,
  entry_type          VARCHAR(20)   NOT NULL
                                    CHECK (entry_type IN ('CREDIT','PAYMENT','ADJUSTMENT')),
  amount              DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  balance_after       DECIMAL(10,2) NOT NULL,
  sale_id             UUID          REFERENCES sales(id) ON DELETE SET NULL,
  payment_reference   VARCHAR(100),
  description         TEXT,
  worker_tag          VARCHAR(100)  NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
  -- No updated_at — entries are financial records; mutations create new rows
);

-- 1. Customer timeline: DESC for display, ASC variant below for FIFO
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant_customer
  ON ledger_entries(tenant_id, customer_ledger_id, created_at DESC);

-- 2. Entry type filter: all CREDIT or PAYMENT events for a tenant
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant_type
  ON ledger_entries(tenant_id, entry_type, created_at DESC);

-- 3. FIFO processing: oldest unresolved credits first (ASC)
CREATE INDEX IF NOT EXISTS idx_ledger_entries_fifo
  ON ledger_entries(tenant_id, customer_ledger_id, created_at ASC)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- 9. WHATSAPP NOTIFICATION LOGS
-- =============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_notifications (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_phone   VARCHAR(20)  NOT NULL,
  template_name     VARCHAR(100) NOT NULL,
  template_data     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(50)  NOT NULL DEFAULT 'QUEUED'
                                 CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED')),
  provider_response JSONB,
  error_message     TEXT,
  retry_count       SMALLINT     NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  -- No deleted_at — notification history must be queryable for delivery proofs
);

-- 1. Status + time: failed/queued retry worker queue
CREATE INDEX IF NOT EXISTS idx_whatsapp_tenant_status
  ON whatsapp_notifications(tenant_id, status, created_at DESC);

-- 2. Recipient history: per-customer delivery proof
CREATE INDEX IF NOT EXISTS idx_whatsapp_tenant_recipient
  ON whatsapp_notifications(tenant_id, recipient_phone, created_at DESC);

-- 3. Template usage: analytics on which templates fire most
CREATE INDEX IF NOT EXISTS idx_whatsapp_tenant_template
  ON whatsapp_notifications(tenant_id, template_name, created_at DESC);

-- =============================================================================
-- 10. TRIGGERS
-- =============================================================================

-- ── 10a. Enforce non-null tenant_id at DB level (belt-and-suspenders) ─────────
CREATE OR REPLACE FUNCTION fn_enforce_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION
      'tenant_id cannot be NULL on table %. Attempted INSERT with id=%',
      TG_TABLE_NAME, NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_id_users
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_inventories
  BEFORE INSERT ON inventories
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_sales
  BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_audit_logs
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_momo
  BEFORE INSERT ON mobile_money_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_ledger
  BEFORE INSERT ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_ledger_entries
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

CREATE TRIGGER trg_tenant_id_whatsapp
  BEFORE INSERT ON whatsapp_notifications
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_tenant_id();

-- ── 10b. Auto-update updated_at ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_updated_at_tenants
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_users
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_inventories
  BEFORE UPDATE ON inventories
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_sales
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_momo
  BEFORE UPDATE ON mobile_money_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_ledger
  BEFORE UPDATE ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_updated_at_whatsapp
  BEFORE UPDATE ON whatsapp_notifications
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ── 10c. Prevent negative stock (defensive — CHECK constraint is primary guard) ─
CREATE OR REPLACE FUNCTION fn_check_stock_non_negative()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stock_quantity < 0 THEN
    RAISE EXCEPTION
      'stock_quantity cannot be negative. Tenant=%, SKU=%, Attempted=%',
      NEW.tenant_id, NEW.product_sku, NEW.stock_quantity;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_non_negative
  BEFORE INSERT OR UPDATE ON inventories
  FOR EACH ROW EXECUTE FUNCTION fn_check_stock_non_negative();

-- ── 10d. Immutability guard on audit_logs (block UPDATE and DELETE) ───────────
CREATE OR REPLACE FUNCTION fn_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only. UPDATE and DELETE are forbidden. '
    'Attempted operation: % by role %',
    TG_OP, current_user;
END;
$$;

CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_audit_immutable();

-- ── 10e. Optimistic lock version bump on inventories and customer_ledger ──────
CREATE OR REPLACE FUNCTION fn_bump_version()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Reject stale writes: client must send the current version
  IF NEW.version IS DISTINCT FROM (OLD.version + 1) THEN
    RAISE EXCEPTION
      'Optimistic lock conflict on %.id=%. Expected version %, got %',
      TG_TABLE_NAME, OLD.id, OLD.version + 1, NEW.version
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_version_inventories
  BEFORE UPDATE ON inventories
  FOR EACH ROW EXECUTE FUNCTION fn_bump_version();

CREATE TRIGGER trg_version_customer_ledger
  BEFORE UPDATE ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_bump_version();

-- =============================================================================
-- 11. ANALYZE (seed planner statistics after schema creation)
-- =============================================================================
ANALYZE tenants;
ANALYZE users;
ANALYZE inventories;
ANALYZE sales;
ANALYZE audit_logs;
ANALYZE mobile_money_transactions;
ANALYZE customer_ledger;
ANALYZE ledger_entries;
ANALYZE whatsapp_notifications;
