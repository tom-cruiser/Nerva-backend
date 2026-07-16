import { query } from '@retail/db';
import type { Permission } from '@retail/types';
import { getSupabaseAdmin } from './supabase-admin';
import { findTenantById } from './user-repository';

/**
 * User provisioning — the single source of truth for creating a user that works
 * with Supabase-JWKS auth (see tenant-context middleware).
 *
 * It keeps three things in sync:
 *   1. The Supabase Auth user (auth.users)   — owns credentials + the JWT.
 *   2. That user's `app_metadata`             — carries tenant_id / role /
 *      permissions / worker_tag, which the middleware trusts (server-controlled).
 *   3. Our application `users` row            — where `users.id === the Supabase
 *      user id (== JWT sub)`, so repository queries by user id line up with the
 *      identity in the token.
 *
 * Roles here are limited to the values the `users.role` CHECK constraint accepts.
 * VIEWER exists only as a runtime JWT role and is not persisted.
 */
export type ProvisionRole = 'OWNER' | 'MANAGER' | 'STAFF';

const PROVISION_ROLES: readonly ProvisionRole[] = ['OWNER', 'MANAGER', 'STAFF'];

// Sentinel stored in the NOT NULL users.hashed_password column. Credentials live
// in Supabase Auth now, so this local field is never used for verification.
const SUPABASE_MANAGED_PASSWORD = '__supabase_managed__';

/**
 * Ensure a tenant exists, creating it if absent. Returns the tenant id.
 * Useful for first-run bootstrap before provisioning the first (OWNER) user.
 * Matches on slug (unique); if a tenant with the slug already exists it is reused.
 */
export async function ensureTenant(input: {
  name: string;
  slug: string;
  currency?: string;
  timezone?: string;
}): Promise<string> {
  const slug = input.slug.toLowerCase().trim();

  const existing = await query<{ id: string }>(
    'SELECT id FROM tenants WHERE slug = $1 LIMIT 1',
    [slug],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await query<{ id: string }>(
    `INSERT INTO tenants (name, slug, currency, timezone)
     VALUES ($1, $2, COALESCE($3, 'XAF'), COALESCE($4, 'UTC'))
     RETURNING id`,
    [input.name, slug, input.currency ?? null, input.timezone ?? null],
  );
  return created.rows[0]!.id;
}

export interface ProvisionUserInput {
  email:        string;
  /** Initial password. Supabase owns it thereafter (reset via Supabase). */
  password:     string;
  /** UUID of an existing, active tenant the user belongs to. */
  tenantId:     string;
  role:         ProvisionRole;
  fullName?:    string;
  /** Explicit permission set; omit to let the middleware derive from role. */
  permissions?: Permission[];
  /** Override the audit worker tag; defaults to "<role>:<userId[:8]>". */
  workerTag?:   string;
}

export interface ProvisionedUser {
  userId:   string;
  tenantId: string;
  email:    string;
  role:     ProvisionRole;
  workerTag: string;
  /** true when a new Supabase auth user was created; false when one already existed. */
  created:  boolean;
}

/** The app_metadata shape the tenant-context middleware reads from the JWT. */
interface AppMetadata {
  tenant_id:    string;
  role:         ProvisionRole;
  worker_tag:   string;
  permissions?: Permission[];
}

function assertRole(role: string): asserts role is ProvisionRole {
  if (!PROVISION_ROLES.includes(role as ProvisionRole)) {
    throw new Error(
      `[provisioning] Invalid role "${role}". Allowed: ${PROVISION_ROLES.join(', ')} ` +
      `(VIEWER is a runtime-only JWT role and cannot be provisioned).`,
    );
  }
}

/**
 * Find a Supabase auth user by email by paging listUsers.
 * Supabase's admin API has no direct get-by-email, so we scan (bounded).
 */
export async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const target   = email.toLowerCase().trim();
  const perPage  = 200;
  const maxPages = 50; // 10k users — raise if you outgrow it

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`[provisioning] listUsers failed: ${error.message}`);

    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;

    if (data.users.length < perPage) break; // last page
  }
  return null;
}

/**
 * Upsert the application `users` row so its id equals the Supabase user id.
 * ON CONFLICT (id) refreshes the mutable identity fields.
 */
async function upsertAppUser(
  userId: string,
  meta:   AppMetadata,
  email:  string,
  fullName: string | null,
): Promise<void> {
  await query(
    `INSERT INTO users
       (id, tenant_id, email, hashed_password, full_name, role, worker_tag, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (id) DO UPDATE SET
       tenant_id  = EXCLUDED.tenant_id,
       -- preserve existing email/full_name when the caller didn't supply them
       email      = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
       full_name  = COALESCE(EXCLUDED.full_name, users.full_name),
       role       = EXCLUDED.role,
       worker_tag = EXCLUDED.worker_tag,
       is_active  = TRUE,
       updated_at = NOW()`,
    [
      userId,
      meta.tenant_id,
      email.toLowerCase().trim(),
      SUPABASE_MANAGED_PASSWORD,
      fullName,
      meta.role,
      meta.worker_tag,
    ],
  );
}

/**
 * Create (or adopt an existing) Supabase auth user and mirror it into our DB.
 *
 * Idempotent: if a Supabase user with the email already exists, its app_metadata
 * is updated and the app `users` row is re-synced rather than erroring.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<ProvisionedUser> {
  assertRole(input.role);

  // Tenant must exist and be active — a user cannot be scoped to nothing.
  const tenant = await findTenantById(input.tenantId);
  if (!tenant) {
    throw new Error(`[provisioning] Tenant not found or inactive: ${input.tenantId}`);
  }

  const supabase = getSupabaseAdmin();
  const email    = input.email.toLowerCase().trim();

  // Build app_metadata WITHOUT worker_tag first (we need the user id to derive it).
  const basePermissions = input.permissions && input.permissions.length > 0
    ? input.permissions
    : undefined;

  // 1. Create the Supabase auth user.
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password:      input.password,
    email_confirm: true,
    app_metadata: {
      tenant_id: input.tenantId,
      role:      input.role,
      ...(basePermissions ? { permissions: basePermissions } : {}),
    },
  });

  let userId: string;
  let created = true;

  if (error) {
    // Adopt an existing user rather than failing (idempotent provisioning).
    const existingId = await findAuthUserIdByEmail(email);
    if (!existingId) {
      throw new Error(`[provisioning] createUser failed: ${error.message}`);
    }
    userId  = existingId;
    created = false;
  } else if (data.user) {
    userId = data.user.id;
  } else {
    throw new Error('[provisioning] createUser returned no user and no error');
  }

  const workerTag = input.workerTag ?? `${input.role}:${userId.slice(0, 8)}`;

  const meta: AppMetadata = {
    tenant_id:  input.tenantId,
    role:       input.role,
    worker_tag: workerTag,
    ...(basePermissions ? { permissions: basePermissions } : {}),
  };

  // 2. Write the final app_metadata (adds worker_tag; also fixes the adopted-user case).
  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: meta,
  });
  if (updateErr) {
    throw new Error(`[provisioning] updateUserById failed: ${updateErr.message}`);
  }

  // 3. Mirror into the application users table (id === Supabase user id).
  await upsertAppUser(userId, meta, email, input.fullName ?? null);

  return {
    userId,
    tenantId: input.tenantId,
    email,
    role: input.role,
    workerTag,
    created,
  };
}

export interface SyncMetadataPatch {
  tenantId?:    string;
  role?:        ProvisionRole;
  permissions?: Permission[];
  workerTag?:   string;
}

/**
 * Update a provisioned user's app_metadata (and mirror to the app users row).
 * Use to move a user between tenants, change role, or backfill worker_tag.
 * Only provided fields are changed; the rest are preserved.
 */
export async function syncUserMetadata(
  userId: string,
  patch:  SyncMetadataPatch,
): Promise<AppMetadata> {
  if (patch.role) assertRole(patch.role);

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new Error(`[provisioning] getUserById failed: ${error?.message ?? 'no user'}`);
  }

  const current = (data.user.app_metadata ?? {}) as Partial<AppMetadata>;

  const tenantId = patch.tenantId ?? current.tenant_id;
  const role     = patch.role     ?? current.role;
  if (!tenantId || !role) {
    throw new Error('[provisioning] Cannot sync: tenant_id and role must be resolvable');
  }

  const merged: AppMetadata = {
    tenant_id:  tenantId,
    role,
    worker_tag: patch.workerTag ?? current.worker_tag ?? `${role}:${userId.slice(0, 8)}`,
    ...(patch.permissions && patch.permissions.length > 0
      ? { permissions: patch.permissions }
      : current.permissions ? { permissions: current.permissions } : {}),
  };

  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: merged,
  });
  if (updateErr) {
    throw new Error(`[provisioning] updateUserById failed: ${updateErr.message}`);
  }

  await upsertAppUser(userId, merged, data.user.email ?? '', null);

  return merged;
}
