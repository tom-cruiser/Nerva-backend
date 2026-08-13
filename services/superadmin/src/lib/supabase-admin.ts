/**
 * Re-export shim. `getSupabaseAdmin`/`setTenantUsersBanned` moved to
 * `@retail/supabase-admin` so services/realtime's expiration cron can share
 * the exact same implementation (see that package for the real code and
 * rationale). Kept here so this file's existing importers
 * (superadmin-router.ts, platform-ops-router.ts) don't need an import-path
 * change.
 */
export { getSupabaseAdmin, setTenantUsersBanned } from '@retail/supabase-admin';
