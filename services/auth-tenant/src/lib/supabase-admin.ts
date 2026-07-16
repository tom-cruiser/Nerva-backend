import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '@retail/config';

/**
 * Server-side Supabase admin client (service-role / secret key).
 *
 * SECURITY: this client bypasses Row Level Security and can mint/modify any
 * user. It MUST only ever run server-side inside auth-tenant — never expose the
 * SUPABASE_SECRET_KEY or this client to a browser or downstream tenant request.
 *
 * Session persistence and token auto-refresh are disabled: this is a stateless
 * backend actor, not a logged-in user session.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  if (!env.SUPABASE_SECRET_KEY) {
    throw new Error(
      '[supabase-admin] SUPABASE_SECRET_KEY is required for user provisioning.',
    );
  }

  client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
  });

  return client;
}
