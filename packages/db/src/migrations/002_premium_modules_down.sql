-- =============================================================================
-- MIGRATION: 002_premium_modules.sql (FIXED)
-- =============================================================================

BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Safely drop indexes if they exist
DROP INDEX IF EXISTS public.idx_batches_tenant_expiry;
DROP INDEX IF EXISTS public.idx_shifts_tenant_worker;
DROP INDEX IF EXISTS public.idx_ledger_transactions_lookup;

-- Safely drop tables if they exist
DROP TABLE IF EXISTS public.product_batches CASCADE;
DROP TABLE IF EXISTS public.cash_drawer_shifts CASCADE;
DROP TABLE IF EXISTS public.ledger_transactions CASCADE;
DROP TABLE IF EXISTS public.customer_ledgers CASCADE;

COMMIT;