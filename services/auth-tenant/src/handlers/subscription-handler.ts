import { Request, Response, NextFunction } from 'express';
import { Errors, getTenantContext } from '@retail/middleware';
import { query } from '@retail/db';
import { publishRealtimeEvent, PLATFORM_STAFF_ROOM } from '@retail/redis';

/**
 * Tenant-facing subscription endpoints — the Shop Admin's own view of
 * their plan/limits/trial status, and the "request an upgrade" pipeline a
 * Super Admin later approves/declines (see services/superadmin's
 * subscriptions-router.ts POST /subscription-requests/:id/approve|reject).
 *
 * Deliberately lives here (auth-tenant), not in services/superadmin — this
 * is the tenant's OWN account/billing view, the same territory as seats
 * management in this file's sibling seats-handler.ts, not a platform-staff
 * operation. Both services already read/write the same `subscriptions`/
 * `subscription_plans`/`subscription_requests` tables directly — there is
 * no per-service DB ownership boundary in this codebase (sales-sync's
 * analytics-router.ts already reads `inventories` the same way).
 */

const PLAN_CODES = ['starter', 'premium', 'business', 'business_premium'] as const;
type PlanCode = (typeof PLAN_CODES)[number];

const BILLING_CYCLES = ['monthly', 'semestral', 'annual'] as const;
type BillingCycle = (typeof BILLING_CYCLES)[number];

interface SubscriptionRow {
  id:                    string;
  plan_code:             PlanCode;
  status:                'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  billing_cycle:         BillingCycle;
  trial_ends_at:         string | null;
  current_period_start:  string;
  current_period_end:    string | null;
  cancel_at_period_end:  boolean;
}

interface PlanRow {
  code:                      PlanCode;
  name:                      string;
  price_cents:               number;
  max_cashiers:              number | null;
  max_locations:             number | null;
  max_monthly_transactions:  number | null;
}

interface PendingRequestRow {
  id:                  string;
  requested_plan_code: PlanCode;
  billing_cycle:       BillingCycle;
  created_at:          string;
}

/** Billing is the tenant Owner's territory, same as seats management — no
 *  dedicated permission type exists for it (mirrors how seats-handler.ts's
 *  assertNotOwner does an inline role check rather than inventing one). */
function assertOwner(ctx: { role: string }, next: NextFunction): boolean {
  if (ctx.role !== 'OWNER') {
    next(Errors.forbidden('Only the store owner can view or manage billing'));
    return false;
  }
  return true;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * GET /api/v1/auth/subscription
 * Current plan/limits/trial-or-period days remaining, plus the latest
 * PENDING upgrade request for this tenant, if any.
 */
export async function getSubscriptionHandler(
  _req: Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);
    if (!assertOwner(ctx, next)) return;

    const subResult = await query<SubscriptionRow>(
      `SELECT id, plan_code, status, billing_cycle, trial_ends_at,
              current_period_start, current_period_end, cancel_at_period_end
       FROM subscriptions
       WHERE tenant_id = $1
       LIMIT 1`,
      [ctx.tenantId],
    );
    if (subResult.rows.length === 0) {
      next(Errors.notFound('Subscription not found for this tenant'));
      return;
    }
    const sub = subResult.rows[0];

    const planResult = await query<PlanRow>(
      `SELECT code, name, price_cents, max_cashiers, max_locations, max_monthly_transactions
       FROM subscription_plans WHERE code = $1 LIMIT 1`,
      [sub.plan_code],
    );

    const pendingResult = await query<PendingRequestRow>(
      `SELECT id, requested_plan_code, billing_cycle, created_at
       FROM subscription_requests
       WHERE tenant_id = $1 AND status = 'PENDING'
       LIMIT 1`,
      [ctx.tenantId],
    );

    res.status(200).json({
      subscription: {
        planCode:           sub.plan_code,
        status:             sub.status,
        billingCycle:       sub.billing_cycle,
        trialEndsAt:        sub.trial_ends_at,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd:   sub.current_period_end,
        cancelAtPeriodEnd:  sub.cancel_at_period_end,
        daysRemaining:      sub.status === 'TRIALING' ? daysUntil(sub.trial_ends_at) : daysUntil(sub.current_period_end),
      },
      plan: planResult.rows[0] ?? null,
      pendingRequest: pendingResult.rows[0]
        ? {
            id:          pendingResult.rows[0].id,
            planCode:    pendingResult.rows[0].requested_plan_code,
            billingCycle: pendingResult.rows[0].billing_cycle,
            createdAt:   pendingResult.rows[0].created_at,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

interface RequestUpgradeBody {
  plan_code?:     string;
  billing_cycle?: string;
}

/**
 * POST /api/v1/auth/subscription/request
 * Queues a plan/billing-cycle upgrade request for Super Admin review — see
 * subscription_requests's partial unique index (one PENDING row per tenant).
 */
export async function requestSubscriptionUpgradeHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = getTenantContext(res);
    if (!assertOwner(ctx, next)) return;

    const body = req.body as RequestUpgradeBody;
    const planCode = body.plan_code as PlanCode | undefined;
    if (!planCode || !PLAN_CODES.includes(planCode)) {
      next(Errors.invalidRequest(`plan_code must be one of: ${PLAN_CODES.join(', ')}`));
      return;
    }
    const billingCycle = body.billing_cycle as BillingCycle | undefined;
    if (!billingCycle || !BILLING_CYCLES.includes(billingCycle)) {
      next(Errors.invalidRequest(`billing_cycle must be one of: ${BILLING_CYCLES.join(', ')}`));
      return;
    }

    let inserted;
    try {
      inserted = await query<{ id: string; created_at: string }>(
        `INSERT INTO subscription_requests (tenant_id, requested_plan_code, billing_cycle, requested_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [ctx.tenantId, planCode, billingCycle, ctx.userId],
      );
    } catch (err) {
      // Partial unique index idx_subscription_requests_one_pending — a
      // second request while one is still PENDING is a 409, not a 500.
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
        next(Errors.conflict('You already have a pending upgrade request awaiting review'));
        return;
      }
      throw err;
    }

    // Notify the Super Admin dashboard live — see services/realtime's
    // socket auth, which joins any platform:support/billing/superadmin
    // token to this room.
    await publishRealtimeEvent(PLATFORM_STAFF_ROOM, 'subscription:request_created', {
      requestId: inserted.rows[0].id,
      tenantId:  ctx.tenantId,
      planCode,
      billingCycle,
    });

    res.status(201).json({
      id:           inserted.rows[0].id,
      planCode,
      billingCycle,
      status:       'PENDING',
      createdAt:    inserted.rows[0].created_at,
    });
  } catch (err) {
    next(err);
  }
}
