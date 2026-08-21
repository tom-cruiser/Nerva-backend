import { Request, Response, NextFunction } from 'express';
import { Errors, getTenantContext, checkResourceLimit, setUserOverrideCache } from '@retail/middleware';
import { query, getClient }                 from '@retail/db';
import type { UserRole, Permission }       from '@retail/types';
import { ROLE_PERMISSIONS }                from '@retail/types';
import { provisionUser, syncUserMetadata } from '../lib/user-provisioning';
import { getSupabaseAdmin }                from '../lib/supabase-admin';

interface TenantTierRow {
  billing_tier: string;
}

interface SeatRow {
  id:          string;
  email:       string;
  full_name:   string | null;
  role:        UserRole;
  worker_tag:  string;
  is_active:   boolean;
  created_at:  string;
  updated_at:  string;
  /** NULL = role-derived defaults (ROLE_PERMISSIONS); non-null = an explicit
   *  override, e.g. a STAFF seat individually granted ledger access (see
   *  GRANTABLE_EXTRA_PERMISSIONS below). Mirrors app_metadata.permissions. */
  permissions: Permission[] | null;
}

const SEAT_COLUMNS = `
  id, email, full_name, role, worker_tag, is_active, created_at, updated_at, permissions
`;

/**
 * Permissions an Admin can individually grant a worker on top of their
 * role's defaults (admin3.md: "assign shift permissions (ledger:create,
 * sales:create)"). Deliberately excludes anything that could let a worker
 * approach OWNER-level control (users:*, superadmin:*, platform:*) or
 * bypass the role system's own boundaries — every other operational
 * permission is fair game to grant individually.
 *
 * Grouped to match the frontend's EXTRA_PERMISSION_GROUPS (lib/types.ts) —
 * keep the two in sync; each group there grants/revokes its permissions as
 * one bundle rather than exposing every permission as its own checkbox.
 */
const GRANTABLE_EXTRA_PERMISSIONS: Permission[] = [
  // Ledger — view the customer debt book, record credit/payments
  'ledger:read', 'ledger:create', 'ledger:update', 'ledger:credit', 'ledger:payment',
  // Reports — sales/profit reports, WhatsApp report data
  'reports:read',
  // Inventory management — beyond the read-only default
  'inventory:create', 'inventory:update', 'inventory:delete',
  // Void a completed sale
  'sales:void',
  // Process a goods refund (full or partial) against a completed sale
  'sales:refund',
  // Send WhatsApp messages/reports
  'whatsapp:send',
];

/**
 * Validates a caller-supplied `extra_permissions` array against the
 * allowlist. Returns `[]` when the field is omitted (no extras requested —
 * the common case), `null` (and reports the error) when it's malformed or
 * contains anything not on the allowlist.
 */
function validateExtraPermissions(input: unknown, next: NextFunction): Permission[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.every((p) => typeof p === 'string')) {
    next(Errors.invalidRequest('extra_permissions must be an array of permission strings'));
    return null;
  }
  const invalid = input.filter((p) => !GRANTABLE_EXTRA_PERMISSIONS.includes(p as Permission));
  if (invalid.length > 0) {
    next(Errors.invalidRequest(
      `extra_permissions contains values that cannot be granted this way: ${invalid.join(', ')}. Allowed: ${GRANTABLE_EXTRA_PERMISSIONS.join(', ')}`,
    ));
    return null;
  }
  return input as Permission[];
}

/** Always the role's full default set plus whatever extras were granted —
 *  written explicitly rather than as a delta, so there's never an "how do I
 *  clear an override" ambiguity: setting extras to `[]` here always
 *  resolves to exactly the role's own defaults, nothing more, nothing less. */
function computeFinalPermissions(role: UserRole, extras: Permission[]): Permission[] {
  return Array.from(new Set([...(ROLE_PERMISSIONS[role] ?? []), ...extras]));
}

/**
 * GET /api/v1/auth/seats
 *
 * Returns all provisioned users for the authenticated tenant plus tier metadata.
 * Requires: users:read permission (OWNER or MANAGER).
 *
 * Seat ceiling now comes from `subscription_plans.max_cashiers` (via
 * `checkResourceLimit`) instead of a hardcoded tier map, so a superadmin plan
 * edit (PATCH /api/v1/superadmin/plans/:code) takes effect here immediately.
 */
export async function listSeatsHandler(
  _req: Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);

    const [seatsResult, tierResult, limitCheck] = await Promise.all([
      query<SeatRow>(
        `SELECT ${SEAT_COLUMNS}
         FROM users
         WHERE tenant_id = $1
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [ctx.tenantId],
      ),
      query<TenantTierRow>(
        `SELECT billing_tier FROM tenants WHERE id = $1 LIMIT 1`,
        [ctx.tenantId],
      ),
      checkResourceLimit(ctx.tenantId, 'max_cashiers'),
    ]);

    const tier = tierResult.rows[0]?.billing_tier ?? 'starter';

    res.status(200).json({
      seats:      seatsResult.rows,
      tier,
      max_seats:  limitCheck.limit, // null = unlimited (business_premium)
      used_seats: seatsResult.rows.length,
    });
  } catch (err) {
    next(err);
  }
}

interface CreateSeatBody {
  email?:              string;
  password?:           string;
  full_name?:          string;
  role?:               string;
  worker_tag?:         string;
  client_created_at?:  string;
  /** Optional extra permissions beyond the role's defaults — see
   *  GRANTABLE_EXTRA_PERMISSIONS. */
  extra_permissions?:  unknown;
}

const ALLOWED_ROLES: UserRole[] = ['MANAGER', 'STAFF'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * POST /api/v1/auth/seats
 *
 * Provisions a new team-member seat scoped to the authenticated tenant.
 * Only OWNER can create seats. Enforces the billing-plan seat limit
 * (`subscription_plans.max_cashiers`, via `checkResourceLimit`).
 */
export async function createSeatHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx  = getTenantContext(res);
    const body = req.body as CreateSeatBody;

    // ── Validation ──────────────────────────────────────────────────────────
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return next(Errors.invalidRequest('A valid email is required'));
    }
    if (!body.password || body.password.length < 8) {
      return next(Errors.invalidRequest('password must be at least 8 characters'));
    }
    if (!body.full_name || body.full_name.trim().length < 1) {
      return next(Errors.invalidRequest('full_name is required'));
    }
    const role = body.role?.toUpperCase() as UserRole | undefined;
    if (!role || !ALLOWED_ROLES.includes(role)) {
      return next(Errors.invalidRequest(`role must be one of: ${ALLOWED_ROLES.join(', ')}`));
    }
    if (!body.worker_tag || body.worker_tag.trim().length < 1) {
      return next(Errors.invalidRequest('worker_tag is required'));
    }
    const extraPermissions = validateExtraPermissions(body.extra_permissions, next);
    if (extraPermissions === null) return; // validateExtraPermissions already called next(err)

    // ── Tier-limit enforcement, race-guarded ─────────────────────────────────
    // The tenant row is locked (SELECT ... FOR UPDATE) for the duration of the
    // count-and-decide step below, so two concurrent seat-creation requests
    // for the same tenant queue on that lock instead of both reading the same
    // stale seat count and both passing the check before either commits
    // (the TOCTOU race the old hardcoded-map version had).
    //
    // provisionUser() talks to the Supabase Admin API, not Postgres — it
    // cannot run inside this DB transaction, so the lock is released at
    // COMMIT, immediately before provisionUser is called below. That leaves a
    // narrow residual window between this COMMIT and provisionUser's own
    // users-table mirror INSERT completing, during which a second request
    // could still slip through. Closing that fully would mean holding a
    // Postgres row lock for the duration of an external HTTP round-trip,
    // which is a worse trade-off (lock contention / timeout risk) than the
    // narrow race it would remove — this is the minimal-correct fix, not a
    // perfect one.
    const lockClient = await getClient();
    let tier: string;
    try {
      await lockClient.query('BEGIN');

      const tenantRow = await lockClient.query<{ id: string; billing_tier: string }>(
        'SELECT id, billing_tier FROM tenants WHERE id = $1 FOR UPDATE',
        [ctx.tenantId],
      );
      if (tenantRow.rows.length === 0) {
        await lockClient.query('ROLLBACK');
        return next(Errors.notFound('Tenant not found'));
      }
      tier = tenantRow.rows[0].billing_tier;

      const limitCheck = await checkResourceLimit(ctx.tenantId, 'max_cashiers');
      if (!limitCheck.allowed) {
        await lockClient.query('ROLLBACK');
        return next(
          Errors.forbidden(
            `Seat limit reached for ${tier} tier (${limitCheck.limit} seats). Upgrade to add more users.`,
            { tier, max_seats: limitCheck.limit, used_seats: limitCheck.current },
          ),
        );
      }

      await lockClient.query('COMMIT');
    } catch (err) {
      await lockClient.query('ROLLBACK');
      throw err;
    } finally {
      lockClient.release();
    }

    // ── Provision ────────────────────────────────────────────────────────────
    // Only write an EXPLICIT permissions array when this seat actually has an
    // override (extraPermissions.length > 0). Otherwise leave app_metadata.
    // permissions unset entirely, so tenant-context.ts keeps deriving this
    // seat's permissions live from ROLE_PERMISSIONS[role] on every request —
    // a future change to the role's defaults still reaches seats with no
    // individual override, exactly as it always has. Freezing an explicit
    // array is the right behavior ONLY for the seats that actually need one.
    const finalPermissions = computeFinalPermissions(role, extraPermissions);
    const provisioned = await provisionUser({
      email,
      password:    body.password,
      tenantId:    ctx.tenantId,
      role:        role as 'MANAGER' | 'STAFF',
      fullName:    body.full_name.trim(),
      workerTag:   body.worker_tag.trim(),
      permissions: extraPermissions.length > 0 ? finalPermissions : undefined,
    });

    // Return the newly created seat in the same shape as GET /seats items.
    res.status(201).json({
      id:          provisioned.userId,
      email:       provisioned.email,
      full_name:   body.full_name.trim(),
      role:        provisioned.role,
      worker_tag:  provisioned.workerTag,
      is_active:   true,
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
      permissions: extraPermissions.length > 0 ? finalPermissions : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Fetch a seat scoped to the caller's tenant (never trust the :id param
 * alone — cross-tenant seat management is exactly what this guards
 * against). Returns null when not found under this tenant, deleted, or
 * belongs to a different tenant entirely.
 */
async function findTenantSeat(
  tenantId: string,
  userId:   string,
): Promise<SeatRow | null> {
  const result = await query<SeatRow>(
    `SELECT ${SEAT_COLUMNS}
     FROM users
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [userId, tenantId],
  );
  return result.rows[0] ?? null;
}

/** Every worker-management handler below rejects the tenant's own OWNER as
 *  a target — these endpoints exist to manage MANAGER/STAFF seats (the ones
 *  createSeatHandler can provision), not the store owner. OWNER accounts
 *  can only ever be created via /register, never via /seats, so this also
 *  closes off any path to demoting/deactivating/resetting the owner through
 *  what's meant to be a subordinate-worker API. */
function assertNotOwner(seat: SeatRow, next: NextFunction): boolean {
  if (seat.role === 'OWNER') {
    next(Errors.forbidden('The store owner cannot be managed through worker endpoints'));
    return false;
  }
  return true;
}

interface UpdateSeatBody {
  role?:              string;
  is_active?:         boolean;
  /** Full desired list of extra permissions (replaces, not merges, any
   *  existing override) — see GRANTABLE_EXTRA_PERMISSIONS. Pass `[]` to
   *  revert this seat back to its role's plain defaults. */
  extra_permissions?: unknown;
}

/**
 * PATCH /api/v1/auth/seats/:id
 *
 * Updates a worker's role (MANAGER/STAFF), active status, and/or extra
 * permissions. Requires: users:update (OWNER only, per ROLE_PERMISSIONS).
 *
 * Role/permission changes go through syncUserMetadata (updates Supabase
 * app_metadata + the local `users` mirror); active-status changes ban/unban
 * in Supabase (blocks new logins/refreshes once their current token expires
 * — defense-in-depth, not what makes this immediate). What actually makes
 * every one of these changes reach the worker's very next request — instead
 * of waiting for their current JWT to expire, since Supabase doesn't
 * retroactively rewrite an already-issued token — is the write-through to
 * tenant-context.ts's live-override cache at the end of this handler.
 */
export async function updateSeatHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx  = getTenantContext(res);
    const body = req.body as UpdateSeatBody;
    const userId = req.params.id;

    if (body.role === undefined && body.is_active === undefined && body.extra_permissions === undefined) {
      return next(Errors.invalidRequest('At least one of role, is_active, or extra_permissions must be provided'));
    }

    let role: UserRole | undefined;
    if (body.role !== undefined) {
      role = body.role.toUpperCase() as UserRole;
      if (!ALLOWED_ROLES.includes(role)) {
        return next(Errors.invalidRequest(`role must be one of: ${ALLOWED_ROLES.join(', ')}`));
      }
    }

    const extraPermissions = validateExtraPermissions(body.extra_permissions, next);
    if (extraPermissions === null) return; // validateExtraPermissions already called next(err)

    const seat = await findTenantSeat(ctx.tenantId, userId);
    if (!seat) return next(Errors.notFound('Seat not found'));
    if (!assertNotOwner(seat, next)) return;

    if (role || body.extra_permissions !== undefined) {
      const effectiveRole = role ?? seat.role;
      // Whichever extras apply after this call: the newly-requested list if
      // extra_permissions was sent, otherwise whatever extras this seat
      // already had (recovered by filtering its current permissions down to
      // the grantable set — seat.permissions may also include the role's
      // own base permissions, which aren't "extras").
      const resolvedExtras = body.extra_permissions !== undefined
        ? extraPermissions
        : (seat.permissions ?? []).filter(
            (p): p is Permission => (GRANTABLE_EXTRA_PERMISSIONS as string[]).includes(p),
          );

      await syncUserMetadata(userId, {
        tenantId: ctx.tenantId,
        role: effectiveRole as 'MANAGER' | 'STAFF',
        // Only set an EXPLICIT permissions array when this seat actually has
        // an override — same reasoning as createSeatHandler: a seat with no
        // extras should keep deriving permissions live from
        // ROLE_PERMISSIONS[role] on every request, not freeze a snapshot of
        // today's role defaults into app_metadata. When extra_permissions
        // was explicitly sent as `[]`, that's a deliberate "revert to
        // defaults" request — clearPermissions forces that instead of
        // syncUserMetadata's normal "preserve whatever's already there"
        // fallback (which would otherwise silently keep the old override).
        ...(resolvedExtras.length > 0
          ? { permissions: computeFinalPermissions(effectiveRole, resolvedExtras) }
          : body.extra_permissions !== undefined
            ? { clearPermissions: true }
            : {}),
      });
    }

    if (body.is_active !== undefined) {
      const supabase = getSupabaseAdmin();
      const { error: banErr } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: body.is_active ? 'none' : '876000h', // ~100 years — see setTenantUsersBanned's rationale
      });
      if (banErr) {
        return next(Errors.internal(`Failed to update session access: ${banErr.message}`));
      }
      await query(
        `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
        [body.is_active, userId, ctx.tenantId],
      );
    }

    await query(
      `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
       VALUES ($1, 'user', $2, 'UPDATE', $3, $4::jsonb, $5::jsonb)`,
      [
        ctx.tenantId, userId, ctx.workerTag,
        JSON.stringify({ role: seat.role, is_active: seat.is_active }),
        JSON.stringify(body),
      ],
    );

    const updated = await findTenantSeat(ctx.tenantId, userId);

    // Write-through the live-override cache with the just-committed state —
    // this is what makes the role/permissions/active-status change reach
    // this worker's very next request instead of waiting for their current
    // JWT to expire (see tenant-context.ts's resolveUserOverride).
    if (updated) {
      await setUserOverrideCache(userId, { isActive: updated.is_active, permissions: updated.permissions });
    }

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/auth/seats/:id
 *
 * Deactivates ("blocks") a worker seat — NOT a hard delete. Sets
 * `users.is_active = FALSE` and write-throughs the live-override cache (see
 * tenant-context.ts's resolveUserOverride) so this takes effect on the
 * worker's very next request, not whenever their current JWT happens to
 * expire. Also bans the user in Supabase as defense-in-depth (blocks new
 * logins/refreshes once their current token does eventually expire — the
 * ban alone does NOT invalidate an already-issued, still-valid JWT, which
 * is why the cache write-through above is what actually makes this
 * immediate). Domain-idempotent: deactivating an already-inactive seat
 * succeeds with `already_inactive: true` rather than erroring, matching the
 * pattern used by the superadmin tenant-lifecycle routes (suspend/unblock)
 * for the same reason — a retried or double-clicked request shouldn't
 * surface as a failure.
 * Requires: users:delete (OWNER only).
 */
export async function deactivateSeatHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);
    const userId = req.params.id;

    const seat = await findTenantSeat(ctx.tenantId, userId);
    if (!seat) return next(Errors.notFound('Seat not found'));
    if (!assertNotOwner(seat, next)) return;

    if (!seat.is_active) {
      res.status(200).json({ success: true, message: 'Seat is already deactivated.' });
      return;
    }

    const supabase = getSupabaseAdmin();
    const { error: banErr } = await supabase.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
    if (banErr) {
      return next(Errors.internal(`Failed to revoke access: ${banErr.message}`));
    }

    await query(
      `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [userId, ctx.tenantId],
    );

    // See tenant-context.ts's resolveUserOverride — this is what actually
    // makes the deactivation immediate, not the Supabase ban above.
    await setUserOverrideCache(userId, { isActive: false, permissions: seat.permissions });

    await query(
      `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
       VALUES ($1, 'user', $2, 'UPDATE', $3, $4::jsonb)`,
      [ctx.tenantId, userId, ctx.workerTag, JSON.stringify({ deactivated: true, email: seat.email })],
    );

    res.status(200).json({ success: true, message: 'Seat deactivated.' });
  } catch (err) {
    next(err);
  }
}

interface ResetSeatPasswordBody {
  password?: string;
}

/**
 * POST /api/v1/auth/seats/:id/reset-password
 *
 * Sets a new password for a worker's Supabase auth account — the only way
 * an Admin can reset a worker's credentials, since credentials are
 * Supabase-managed (see user-provisioning.ts's SUPABASE_MANAGED_PASSWORD
 * sentinel — our own `users.hashed_password` column is never used for
 * verification). Requires: users:update (OWNER only).
 */
export async function resetSeatPasswordHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx  = getTenantContext(res);
    const body = req.body as ResetSeatPasswordBody;
    const userId = req.params.id;

    if (!body.password || body.password.length < 8) {
      return next(Errors.invalidRequest('password must be at least 8 characters'));
    }

    const seat = await findTenantSeat(ctx.tenantId, userId);
    if (!seat) return next(Errors.notFound('Seat not found'));
    if (!assertNotOwner(seat, next)) return;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.auth.admin.updateUserById(userId, { password: body.password });
    if (error) {
      return next(Errors.internal(`Failed to reset password: ${error.message}`));
    }

    await query(
      `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
       VALUES ($1, 'user', $2, 'UPDATE', $3, $4::jsonb)`,
      [ctx.tenantId, userId, ctx.workerTag, JSON.stringify({ password_reset: true, email: seat.email })],
    );

    res.status(200).json({ success: true, message: 'Password has been reset.' });
  } catch (err) {
    next(err);
  }
}
