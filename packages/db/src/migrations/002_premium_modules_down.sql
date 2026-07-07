BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Safely drop indexes created by migration 002_premium_modules.sql
DROP INDEX IF EXISTS public.idx_batches_tenant_expiry;
DROP INDEX IF EXISTS public.idx_shifts_tenant_worker;
DROP INDEX IF EXISTS public.idx_ledger_transactions_lookup;

-- Drop tables in reverse dependency order
-- ledger_transactions depends on customer_ledgers
DROP TABLE IF EXISTS public.ledger_transactions CASCADE;

-- customer_ledgers depends on organizations
DROP TABLE IF EXISTS public.customer_ledgers CASCADE;

-- cash_drawer_shifts depends on organizations
DROP TABLE IF EXISTS public.cash_drawer_shifts CASCADE;

-- product_batches depends on products and organizations
DROP TABLE IF EXISTS public.product_batches CASCADE;

COMMIT;
