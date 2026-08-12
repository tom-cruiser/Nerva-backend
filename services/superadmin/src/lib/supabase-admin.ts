import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '@retail/config';

/**
 * Server-side Supabase admin client (service-role / secret key).
 *
 * Mirrors services/auth-tenant/src/lib/supabase-admin.ts — duplicated rather
 * than shared because services in this repo don't import each other's `src`,
 * only published @retail/* packages.
 *
 * SECURITY: this client bypasses Row Level Security and can list/ban/modify
 * any user across every tenant. It MUST only ever run inside this service,
 * behind requireSuperadmin() — never expose SUPABASE_SECRET_KEY or this
 * client to a browser or a regular tenant-scoped request.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error('[supabase-admin] SUPABASE_SECRET_KEY is required.');
  }

  client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
  });

  return client;
}

/**
 * Bans (or unbans) every Supabase auth user belonging to a tenant.
 *
 * This is defense-in-depth, NOT the primary revocation mechanism — the
 * primary one is packages/middleware/src/tenant-context.ts rejecting every
 * request for a SUSPENDED/DELETED tenant regardless of JWT validity, which
 * takes effect immediately. Banning additionally stops Supabase itself from
 * ever issuing that user a NEW session (sign-in, refresh) while the ban is
 * active, so the block holds even for a request path that somehow bypassed
 * tenant-context.ts.
 *
 * Supabase's admin API bans/unbans by user id one at a time — there is no
 * bulk "ban by tenant" call, so this fetches every user row for the tenant
 * from Postgres and issues one admin call per user, tolerating individual
 * failures (a user that was already deleted from Supabase directly, etc.)
 * rather than letting one bad row abort the whole tenant action.
 */
export async function setTenantUsersBanned(
  userIds: string[],
  banned: boolean,
): Promise<{ succeeded: string[]; failed: Array<{ userId: string; error: string }> }> {
  const admin = getSupabaseAdmin();
  const succeeded: string[] = [];
  const failed: Array<{ userId: string; error: string }> = [];

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const { error } = await admin.auth.admin.updateUserById(userId, {
          // Supabase's ban_duration accepts a duration string; 'none' lifts a
          // ban. There is no first-class "forever" value, so a suspension
          // uses a very long duration — the middleware-level DB check is
          // what actually re-admits the user the instant a superadmin
          // unblocks the tenant, not this expiring on its own.
          ban_duration: banned ? '876000h' /* ~100 years */ : 'none',
        });
        if (error) {
          failed.push({ userId, error: error.message });
        } else {
          succeeded.push(userId);
        }
      } catch (err) {
        failed.push({ userId, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  return { succeeded, failed };
}
