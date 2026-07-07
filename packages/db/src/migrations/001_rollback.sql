-- =============================================================================
-- ROLLBACK: 001_rollback.sql
-- PURPOSE:  Fully reverse migration 001_initial_schema.sql
-- WARNING:  DESTRUCTIVE — drops all data. Use only in development/CI.
-- =============================================================================

-- ── Triggers (must drop before functions) ─────────────────────────────────────
DROP TRIGGER IF EXISTS trg_version_customer_ledger      ON customer_ledger;
DROP TRIGGER IF EXISTS trg_version_inventories          ON inventories;
DROP TRIGGER IF EXISTS trg_audit_immutable              ON audit_logs;
DROP TRIGGER IF EXISTS trg_stock_non_negative           ON inventories;

DROP TRIGGER IF EXISTS trg_updated_at_whatsapp          ON whatsapp_notifications;
DROP TRIGGER IF EXISTS trg_updated_at_ledger            ON customer_ledger;
DROP TRIGGER IF EXISTS trg_updated_at_momo              ON mobile_money_transactions;
DROP TRIGGER IF EXISTS trg_updated_at_sales             ON sales;
DROP TRIGGER IF EXISTS trg_updated_at_inventories       ON inventories;
DROP TRIGGER IF EXISTS trg_updated_at_users             ON users;
DROP TRIGGER IF EXISTS trg_updated_at_tenants           ON tenants;

DROP TRIGGER IF EXISTS trg_tenant_id_whatsapp           ON whatsapp_notifications;
DROP TRIGGER IF EXISTS trg_tenant_id_ledger_entries     ON ledger_entries;
DROP TRIGGER IF EXISTS trg_tenant_id_ledger             ON customer_ledger;
DROP TRIGGER IF EXISTS trg_tenant_id_momo               ON mobile_money_transactions;
DROP TRIGGER IF EXISTS trg_tenant_id_audit_logs         ON audit_logs;
DROP TRIGGER IF EXISTS trg_tenant_id_sales              ON sales;
DROP TRIGGER IF EXISTS trg_tenant_id_inventories        ON inventories;
DROP TRIGGER IF EXISTS trg_tenant_id_users              ON users;

-- ── Functions ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS fn_bump_version()          CASCADE;
DROP FUNCTION IF EXISTS fn_audit_immutable()       CASCADE;
DROP FUNCTION IF EXISTS fn_check_stock_non_negative() CASCADE;
DROP FUNCTION IF EXISTS fn_set_updated_at()        CASCADE;
DROP FUNCTION IF EXISTS fn_enforce_tenant_id()     CASCADE;

-- ── Tables (reverse FK dependency order) ─────────────────────────────────────
DROP TABLE IF EXISTS whatsapp_notifications       CASCADE;
DROP TABLE IF EXISTS ledger_entries               CASCADE;
DROP TABLE IF EXISTS customer_ledger              CASCADE;
DROP TABLE IF EXISTS mobile_money_transactions    CASCADE;
DROP TABLE IF EXISTS audit_logs                   CASCADE;
DROP TABLE IF EXISTS sales                        CASCADE;
DROP TABLE IF EXISTS inventories                  CASCADE;
DROP TABLE IF EXISTS users                        CASCADE;
DROP TABLE IF EXISTS tenants                      CASCADE;

-- ── Extensions ────────────────────────────────────────────────────────────────
DROP EXTENSION IF EXISTS btree_gin;
DROP EXTENSION IF EXISTS "uuid-ossp";
