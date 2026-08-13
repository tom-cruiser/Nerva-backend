-- =============================================================================
-- MIGRATION: 019_inventory_stock_decimal.sql
-- PURPOSE:   Widen inventories.stock_quantity from INTEGER to DECIMAL so
--            fractional selling-unit deductions (e.g. 1.5 kg, 0.5 L) can be
--            recorded exactly, not truncated to whole units.
--
-- Deliberately isolated in its own migration: an INTEGER -> NUMERIC column
-- type change has no binary-compatible cast in Postgres, so this rewrites
-- the entire `inventories` table under an ACCESS EXCLUSIVE lock for the
-- duration of this file's transaction (packages/db/src/migrate.ts runs each
-- migration as one BEGIN...COMMIT). Kept separate from 020's purely additive
-- changes (new columns/tables/CHECK widening) so the one genuinely risky
-- statement in this body of work is independently timed/rolled back from the
-- cheap, safe stuff.
--
-- Existing consumers unaffected: sales-sync's `stock_quantity - $N` deduction
-- and the CHECK/trigger (`stock_quantity >= 0`, fn_check_stock_non_negative)
-- both work identically over NUMERIC. inventory-router.ts's response mapping
-- DOES need a code-side fix (`Number(row.stock_quantity)` — pg returns
-- DECIMAL columns as strings) — that lands in 020's accompanying code change,
-- not here, since this file is schema-only.
-- =============================================================================

ALTER TABLE inventories ALTER COLUMN stock_quantity TYPE DECIMAL(12,3);

ANALYZE inventories;
