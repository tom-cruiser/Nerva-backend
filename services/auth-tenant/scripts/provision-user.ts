/**
 * User provisioning CLI.
 *
 * Creates a Supabase auth user with the correct app_metadata (tenant_id / role /
 * worker_tag) and mirrors it into the application `users` table with a matching
 * id — everything the Supabase-JWKS auth path needs.
 *
 * Env is read from the repo-root .env; point dotenv at it explicitly because
 * this script's cwd is the service directory:
 *
 *   DOTENV_CONFIG_PATH="$PWD/../../.env" \
 *     npx ts-node -r dotenv/config services/auth-tenant/scripts/provision-user.ts \
 *     --email owner@acme.com --password 'S3cret!' --role OWNER \
 *     --create-tenant-name "Acme Retail" --create-tenant-slug acme
 *
 * Provide EITHER --tenant <uuid> (existing) OR --create-tenant-name +
 * --create-tenant-slug (bootstrap a new tenant).
 *
 * From the repo root you can also run:  npm run provision-user --workspace=services/auth-tenant -- <flags>
 */
import { ensureTenant, provisionUser, type ProvisionRole } from '../src/lib/user-provisioning';
import { closePool } from '@retail/db';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const email    = arg('email');
  const password = arg('password');
  const role     = (arg('role') ?? 'OWNER') as ProvisionRole;
  const fullName = arg('name');

  if (!email || !password) {
    throw new Error('Missing required flags: --email and --password');
  }

  // Resolve tenant: existing id, or bootstrap a new one.
  let tenantId = arg('tenant');
  const createName = arg('create-tenant-name');
  const createSlug = arg('create-tenant-slug');

  if (!tenantId) {
    if (!createName || !createSlug) {
      throw new Error(
        'Provide --tenant <uuid>, or --create-tenant-name and --create-tenant-slug to bootstrap one.',
      );
    }
    tenantId = await ensureTenant({
      name:     createName,
      slug:     createSlug,
      currency: arg('currency'),
      timezone: arg('timezone'),
    });
    console.log(`[provision-user] Tenant ready: ${tenantId} (${createSlug})`);
  }

  const result = await provisionUser({ email, password, tenantId, role, fullName });

  console.log('\n[provision-user] ✓ Done');
  console.log(`  user id   : ${result.userId}  (== JWT sub / users.id)`);
  console.log(`  tenant_id : ${result.tenantId}`);
  console.log(`  email     : ${result.email}`);
  console.log(`  role      : ${result.role}`);
  console.log(`  worker_tag: ${result.workerTag}`);
  console.log(`  ${result.created ? 'created new' : 'updated existing'} Supabase auth user\n`);
}

main()
  .catch((err: unknown) => {
    console.error('[provision-user] ✗', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
