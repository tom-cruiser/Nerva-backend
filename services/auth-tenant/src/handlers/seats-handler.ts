import { Request, Response, NextFunction } from 'express';
import { Errors, getTenantContext, checkResourceLimit } from '@retail/middleware';
import { query, getClient }                 from '@retail/db';
import type { UserRole }                   from '@retail/types';
import { provisionUser }                   from '../lib/user-provisioning';

interface TenantTierRow {
  billing_tier: string;
}

interface SeatRow {
  id:         string;
  email:      string;
  full_name:  string | null;
  role:       UserRole;
  worker_tag: string;
  is_active:  boolean;
  created_at: string;
  updated_at: string;
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
        `SELECT id, email, full_name, role, worker_tag, is_active,
                created_at, updated_at
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
  email?:             string;
  password?:          string;
  full_name?:         string;
  role?:              string;
  worker_tag?:        string;
  client_created_at?: string;
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
    const provisioned = await provisionUser({
      email,
      password:  body.password,
      tenantId:  ctx.tenantId,
      role:      role as 'MANAGER' | 'STAFF',
      fullName:  body.full_name.trim(),
      workerTag: body.worker_tag.trim(),
    });

    // Return the newly created seat in the same shape as GET /seats items.
    res.status(201).json({
      id:         provisioned.userId,
      email:      provisioned.email,
      full_name:  body.full_name.trim(),
      role:       provisioned.role,
      worker_tag: provisioned.workerTag,
      is_active:  true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}
