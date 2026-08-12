/**
 * Superadmin grant/revoke CLI.
 *
 * There is deliberately no API endpoint or UI flow for this — granting
 * cluster-level `superadmin:access` (which lets a token bypass every
 * tenant boundary via requireSuperadmin(), see @retail/middleware) is an
 * operator-only, out-of-band action, the same way `provisionUser` in
 * auth-tenant treats tenant OWNER creation. A superadmin is a platform
 * operator, not a role within any one tenant, so this intentionally does
 * NOT touch tenant_id/role — it only adds or removes one permission string
 * on top of whatever app_metadata (if any) the target user already has.
 *
 * Usage (from the repo root):
 *   DOTENV_CONFIG_PATH="$PWD/.env" \
 *     npx ts-node -r dotenv/config services/superadmin/scripts/grant-superadmin.ts \
 *     --email ops@nerva.internal
 *
 *   ... --email ops@nerva.internal --revoke     # remove superadmin:access
 *
 * From the repo root you can also run:
 *   npm run grant-superadmin --workspace=services/superadmin -- --email ops@nerva.internal
 */
import { getSupabaseAdmin } from '../src/lib/supabase-admin';

const SUPERADMIN_PERMISSION = 'superadmin:access';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const target   = email.toLowerCase().trim();
  const perPage  = 200;
  const maxPages = 50;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

async function main(): Promise<void> {
  const email  = arg('email');
  const revoke = flag('revoke');

  if (!email) {
    throw new Error('Missing required flag: --email <address>');
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) {
    throw new Error(
      `No Supabase auth user found for ${email}. ` +
      `Create the account first (e.g. a normal signup, or provision-user.ts) — ` +
      `this script only grants/revokes the permission on an EXISTING user.`,
    );
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new Error(`getUserById failed: ${error?.message ?? 'no user'}`);
  }

  const current = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  const existingPermissions = Array.isArray(current['permissions'])
    ? (current['permissions'] as string[])
    : [];

  const nextPermissions = revoke
    ? existingPermissions.filter((p) => p !== SUPERADMIN_PERMISSION)
    : Array.from(new Set([...existingPermissions, SUPERADMIN_PERMISSION]));

  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...current, permissions: nextPermissions },
  });
  if (updateErr) {
    throw new Error(`updateUserById failed: ${updateErr.message}`);
  }

  console.log(
    `\n[grant-superadmin] ✓ ${revoke ? 'Revoked' : 'Granted'} ${SUPERADMIN_PERMISSION} ` +
    `for ${email} (user id: ${userId})\n`,
  );
  console.log(`  resulting permissions: ${nextPermissions.join(', ') || '(none)'}\n`);
  console.log(
    '  NOTE: this user must sign out and back in (or wait for their next token\n' +
    '  refresh) before the new permissions appear in their JWT.\n',
  );
}

main().catch((err: unknown) => {
  console.error('[grant-superadmin] ✗', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
