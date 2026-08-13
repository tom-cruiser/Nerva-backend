-- =============================================================================
-- MIGRATION: 016_users_permission_overrides.sql
-- PURPOSE:   Let an Admin grant a specific worker extra permissions beyond
--            their role's defaults (admin3.md's "Worker Management Controls:
--            ... assign shift permissions (ledger:create, sales:create)").
--
-- Permission overrides have always lived in Supabase `app_metadata.permissions`
-- (see tenant-context.ts's resolution: explicit app_metadata.permissions wins
-- over the ROLE_PERMISSIONS-derived default) — that part already worked. What
-- was missing was a local, cheaply-queryable mirror: `GET /api/v1/auth/seats`
-- lists every worker in one query, and there was no way to show "does this
-- seat have an override" without an N+1 Supabase Admin API call per row.
-- This column is written by the same code path that sets app_metadata
-- (see user-provisioning.ts's upsertAppUser), so it never drifts from the
-- source of truth — it's a read-optimization, not a second source of truth.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB;

COMMENT ON COLUMN users.permissions IS
  'Mirror of this user''s Supabase app_metadata.permissions override (NULL = role-derived defaults, per ROLE_PERMISSIONS). Written by user-provisioning.ts alongside every app_metadata write — never written independently.';
