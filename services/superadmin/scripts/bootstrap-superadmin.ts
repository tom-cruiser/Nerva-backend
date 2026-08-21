/**
 * First-superadmin bootstrap CLI.
 *
 * `grant-superadmin.ts` only grants `superadmin:access` to an EXISTING
 * Supabase auth user, and `POST /staff/grant` requires an existing
 * superadmin caller — so neither can mint the very first superadmin.
 * This script closes that gap for a brand-new platform: it creates the
 * Supabase auth user directly (email/password, pre-confirmed) with
 * `app_metadata.permissions: ['superadmin:access']` already set, then
 * mirrors the grant into `platform_staff` and `platform_audit_logs` the
 * same way `POST /staff/grant` does (see platform-ops-router.ts).
 *
 * Like grant-superadmin.ts, this is deliberately operator-only/out-of-band
 * — there is no API or UI path for creating a superadmin from scratch.
 *
 * Usage (from the repo root):
 *   DOTENV_CONFIG_PATH="$PWD/.env" \
 *     npx ts-node -r dotenv/config services/superadmin/scripts/bootstrap-superadmin.ts \
 *     --email ops@nerva.internal --password 'S3cret!'
 *
 * From the repo root you can also run:
 *   npm run bootstrap-superadmin --workspace=services/superadmin -- --email ops@nerva.internal --password 'S3cret!'
 */
import { getClient, closePool } from '@retail/db';
import { PLATFORM_SENTINEL_TENANT_ID } from '@retail/middleware';
import { getSupabaseAdmin } from '../src/lib/supabase-admin';

const SUPERADMIN_PERMISSION = 'superadmin:access';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
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
  const email    = arg('email');
  const password = arg('password');

  if (!email || !password) {
    throw new Error('Missing required flags: --email and --password');
  }

  const supabase = getSupabaseAdmin();

  let userId = await findUserIdByEmail(email);
  let created = false;

  if (userId) {
    // User already exists — just make sure the permission is set (same
    // merge behavior as grant-superadmin.ts).
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) {
      throw new Error(`getUserById failed: ${error?.message ?? 'no user'}`);
    }
    const current = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const existingPermissions = Array.isArray(current['permissions'])
      ? (current['permissions'] as string[])
      : [];
    const nextPermissions = Array.from(new Set([...existingPermissions, SUPERADMIN_PERMISSION]));

    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      app_metadata: { ...current, permissions: nextPermissions },
    });
    if (updateErr) {
      throw new Error(`updateUserById failed: ${updateErr.message}`);
    }
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { permissions: [SUPERADMIN_PERMISSION] },
    });
    if (error || !data.user) {
      throw new Error(`createUser failed: ${error?.message ?? 'no user returned'}`);
    }
    userId = data.user.id;
    created = true;
  }

  // Mirror into platform_staff + platform_audit_logs, matching POST /staff/grant
  // (platform-ops-router.ts). No existing superadmin caller exists yet, so the
  // new user is recorded as its own grantor — both columns are NOT NULL but
  // carry no FK constraint, so a self-referential bootstrap value is valid.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO platform_staff (user_id, email, platform_role, granted_by, granted_at, revoked_at)
       VALUES ($1, $2, 'SUPERADMIN', $1, NOW(), NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET platform_role = EXCLUDED.platform_role,
             granted_by    = EXCLUDED.granted_by,
             granted_at    = NOW(),
             revoked_at    = NULL`,
      [userId, email],
    );
    await client.query(
      `INSERT INTO platform_audit_logs
         (tenant_id, tenant_slug, tenant_name, action, reason,
          performed_by, performed_by_email, details)
       VALUES ($1,$2,$3,'GRANT_STAFF',$4,$5,$6,$7::jsonb)`,
      [
        PLATFORM_SENTINEL_TENANT_ID, 'platform', 'PLATFORM',
        'bootstrap-superadmin.ts: first superadmin self-grant',
        userId, email,
        JSON.stringify({ target_email: email, platform_role: 'SUPERADMIN', bootstrap: true }),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `\n[bootstrap-superadmin] ✓ ${created ? 'Created' : 'Updated existing'} Supabase auth user ` +
    `and granted ${SUPERADMIN_PERMISSION} for ${email} (user id: ${userId})\n`,
  );
  console.log('  Recorded in platform_staff and platform_audit_logs.\n');
}

main()
  .catch((err: unknown) => {
    console.error('[bootstrap-superadmin] ✗', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
