import { Request, Response, NextFunction } from 'express';
import { Errors, getTenantContext }        from '@retail/middleware';
import { query }                           from '@retail/db';
import type { UserRole }                   from '@retail/types';
import { provisionUser }                   from '../lib/user-provisioning';

// Seat limit per billing tier — mirrors TIER_SEAT_LIMITS in the frontend.
const TIER_LIMITS: Record<string, number> = {
  starter:          2,
  premium:          5,
  business:         15,
  business_premium: Infinity,
};

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
 */
export async function listSeatsHandler(
  _req: Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);

    const [seatsResult, tierResult] = await Promise.all([
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
    ]);

    const tier      = tierResult.rows[0]?.billing_tier ?? 'starter';
    const max_seats = TIER_LIMITS[tier] ?? 2;

    res.status(200).json({
      seats:      seatsResult.rows,
      tier,
      max_seats:  Number.isFinite(max_seats) ? max_seats : null,
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
 * Only OWNER can create seats. Enforces the billing-tier seat limit.
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

    // ── Tier-limit enforcement ───────────────────────────────────────────────
    const [countResult, tierResult] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users
         WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [ctx.tenantId],
      ),
      query<TenantTierRow>(
        `SELECT billing_tier FROM tenants WHERE id = $1 LIMIT 1`,
        [ctx.tenantId],
      ),
    ]);

    const tier      = tierResult.rows[0]?.billing_tier ?? 'starter';
    const max_seats = TIER_LIMITS[tier] ?? 2;
    const used      = parseInt(countResult.rows[0]?.count ?? '0', 10);

    if (Number.isFinite(max_seats) && used >= max_seats) {
      return next(
        Errors.forbidden(
          `Seat limit reached for ${tier} tier (${max_seats} seats). Upgrade to add more users.`,
          { tier, max_seats, used_seats: used },
        ),
      );
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
