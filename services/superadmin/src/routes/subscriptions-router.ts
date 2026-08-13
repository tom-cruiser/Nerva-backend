import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { redis, publishRealtimeEvent, tenantRoom, PLATFORM_STAFF_ROOM } from '@retail/redis';
import { setTenantUsersBanned } from '@retail/supabase-admin';
import {
  getTenantContext,
  idempotency,
  Errors,
  sendError,
  requireAnyPermission,
  setTenantStatusCache,
  PLATFORM_SENTINEL_TENANT_ID,
} from '@retail/middleware';

const router = Router();

// This router is mounted with its OWN, more granular permission checks per
// route — unlike superadmin-router.ts, it deliberately does NOT call
// router.use(requireSuperadmin()) at the top. Reads are open to platform
// support/billing staff as well as full superadmins; writes are restricted
// to billing staff and superadmins. tenantContextMiddleware itself still runs
// upstream (mounted in app.ts, same as the other router), so ctx.userId/
// ctx.email/ctx.permissions are already resolved by the time any handler here
// runs.

const idempotent = idempotency(redis);

const READ_PERMISSIONS  = ['platform:support', 'platform:billing', 'superadmin:access'] as const;
const WRITE_PERMISSIONS = ['platform:billing', 'superadmin:access'] as const;

const requireRead  = requireAnyPermission(...READ_PERMISSIONS);
const requireWrite = requireAnyPermission(...WRITE_PERMISSIONS);

// ─── Shared helpers ────────────────────────────────────────────────────────────

const PLAN_CODES = ['starter', 'premium', 'business', 'business_premium'] as const;
type PlanCode = (typeof PLAN_CODES)[number];

interface PlanRow {
  code: PlanCode;
  name: string;
  price_cents: number;
  billing_interval: string;
  max_cashiers: number | null;
  max_locations: number | null;
  max_monthly_transactions: number | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_code: PlanCode;
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TenantMeta {
  id: string;
  slug: string;
  name: string;
  billing_tier: string;
}

async function fetchTenantMeta(
  client: Awaited<ReturnType<typeof getClient>>,
  tenantId: string,
): Promise<TenantMeta | null> {
  const result = await client.query<TenantMeta>(
    `SELECT id, slug, name, billing_tier FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Writes to the tenant-lifecycle/platform audit trail — the same
 * `platform_audit_logs` table superadmin-router.ts's writePlatformAuditLog
 * writes to. Copied rather than imported per the task's own convention (each
 * router owns its slice of the action vocabulary — see
 * packages/db/src/migrations/011_subscriptions_audit_actions.sql for the
 * action values this router adds to the CHECK constraint).
 *
 * `tenantId`/`tenantSlug`/`tenantName` are NOT NULL columns even though a
 * plan edit (PATCH /plans/:code) isn't scoped to any one tenant — that route
 * passes PLATFORM_SENTINEL_TENANT_ID/"platform"/"Platform" (the same sentinel
 * tenant-context.ts uses for a superadmin token with no tenant of its own).
 */
async function writePlatformAuditLog(
  client: Awaited<ReturnType<typeof getClient>>,
  params: {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    action: 'PLAN_EDIT' | 'PLAN_CHANGE' | 'SUB_CANCEL' | 'SUB_REACTIVATE'
          | 'FEATURE_FLAG_SET' | 'FEATURE_FLAG_RESET'
          | 'SUB_REQUEST_APPROVE' | 'SUB_REQUEST_REJECT';
    reason?: string | null;
    performedBy: string;
    performedByEmail?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform_audit_logs
       (tenant_id, tenant_slug, tenant_name, action, reason,
        performed_by, performed_by_email, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      params.tenantId, params.tenantSlug, params.tenantName, params.action,
      params.reason ?? null, params.performedBy, params.performedByEmail ?? null,
      params.details ? JSON.stringify(params.details) : null,
    ],
  );
}

// ─── Plans catalog ─────────────────────────────────────────────────────────────

router.get('/plans', requireRead, async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query<PlanRow>(
      `SELECT code, name, price_cents, billing_interval,
              max_cashiers, max_locations, max_monthly_transactions,
              created_at, updated_at
       FROM subscription_plans
       ORDER BY price_cents ASC`,
    );
    res.json({ plans: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

const planPatchSchema = z.object({
  price_cents:              z.number().int().min(0),
  max_cashiers:             z.number().int().positive().nullable(),
  max_locations:            z.number().int().positive().nullable(),
  max_monthly_transactions: z.number().int().positive().nullable(),
}).partial();

type PlanPatchBody = z.infer<typeof planPatchSchema>;
const PLAN_PATCH_FIELDS: (keyof PlanPatchBody)[] = [
  'price_cents', 'max_cashiers', 'max_locations', 'max_monthly_transactions',
];

router.patch(
  '/plans/:code',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = planPatchSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const code = req.params.code as PlanCode;
    if (!PLAN_CODES.includes(code)) {
      sendError(res, Errors.notFound('Unknown plan code'));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const existing = await client.query<PlanRow>(
        `SELECT code, name, price_cents, billing_interval,
                max_cashiers, max_locations, max_monthly_transactions,
                created_at, updated_at
         FROM subscription_plans WHERE code = $1 FOR UPDATE`,
        [code],
      );
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Plan not found'));
        return;
      }

      // Only touch fields actually present in the request body — `.partial()`
      // makes every field optional, but a field explicitly set to `null`
      // (distinct from omitted) must still be written through as "unlimited".
      const setClauses: string[] = [];
      const values: unknown[] = [code];
      for (const field of PLAN_PATCH_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          values.push(parse.data[field] ?? null);
          setClauses.push(`${field} = $${values.length}`);
        }
      }

      if (setClauses.length === 0) {
        await client.query('ROLLBACK');
        res.status(200).json({ plan: existing.rows[0], unchanged: true });
        return;
      }
      setClauses.push('updated_at = NOW()');

      const updated = await client.query<PlanRow>(
        `UPDATE subscription_plans SET ${setClauses.join(', ')}
         WHERE code = $1
         RETURNING code, name, price_cents, billing_interval,
                   max_cashiers, max_locations, max_monthly_transactions,
                   created_at, updated_at`,
        values,
      );

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID, tenantSlug: 'platform', tenantName: 'Platform',
        action: 'PLAN_EDIT', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { plan_code: code, previous: existing.rows[0], updated_fields: Object.keys(parse.data) },
      });

      await client.query('COMMIT');
      res.status(200).json({ plan: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── Per-tenant subscription ───────────────────────────────────────────────────

router.get(
  '/tenants/:tenantId/subscription',
  requireRead,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const result = await client.query(
        `SELECT s.id, s.tenant_id, s.plan_code, s.status, s.trial_ends_at,
                s.current_period_start, s.current_period_end,
                s.cancel_at_period_end, s.canceled_at, s.created_at, s.updated_at,
                sp.name AS plan_name, sp.price_cents, sp.billing_interval,
                sp.max_cashiers, sp.max_locations, sp.max_monthly_transactions
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.code = s.plan_code
         WHERE s.tenant_id = $1
         LIMIT 1`,
        [req.params.tenantId],
      );
      if (result.rows.length === 0) {
        sendError(res, Errors.notFound('Subscription not found for this tenant'));
        return;
      }
      res.json({ subscription: result.rows[0], timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

const changePlanSchema = z.object({
  plan_code: z.enum(PLAN_CODES),
});

router.post(
  '/tenants/:tenantId/subscription/change-plan',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = changePlanSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const subResult = await client.query<SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`,
        [tenant.id],
      );
      if (subResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription not found for this tenant'));
        return;
      }
      const sub = subResult.rows[0];

      if (sub.plan_code === parse.data.plan_code) {
        await client.query('ROLLBACK');
        res.status(200).json({ subscription: sub, already_on_plan: true });
        return;
      }

      // The trigger sync_tenant_billing_tier() keeps tenants.billing_tier in
      // sync with this write — never write billing_tier directly.
      const updated = await client.query<SubscriptionRow>(
        `UPDATE subscriptions SET plan_code = $2 WHERE tenant_id = $1 RETURNING *`,
        [tenant.id, parse.data.plan_code],
      );

      await client.query(
        `INSERT INTO billing_events (tenant_id, subscription_id, event_type, notes)
         VALUES ($1, $2, 'PLAN_CHANGED', $3)`,
        [
          tenant.id, sub.id,
          `Plan changed from ${sub.plan_code} to ${parse.data.plan_code} by ${ctx.email}`,
        ],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'PLAN_CHANGE', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { previous_plan: sub.plan_code, new_plan: parse.data.plan_code },
      });

      await client.query('COMMIT');
      await publishRealtimeEvent(tenantRoom(tenant.id), 'subscription:updated', { subscription: updated.rows[0] });
      res.status(200).json({ subscription: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

const cancelSchema = z.object({
  at_period_end: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
});

router.post(
  '/tenants/:tenantId/subscription/cancel',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = cancelSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const subResult = await client.query<SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`,
        [tenant.id],
      );
      if (subResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription not found for this tenant'));
        return;
      }
      const sub = subResult.rows[0];

      // Idempotent at the domain level — already in the requested end state.
      if (sub.status === 'CANCELLED' || (parse.data.at_period_end && sub.cancel_at_period_end)) {
        await client.query('ROLLBACK');
        res.status(200).json({ subscription: sub, already_cancelled: true });
        return;
      }

      const updated = parse.data.at_period_end
        ? await client.query<SubscriptionRow>(
            `UPDATE subscriptions SET cancel_at_period_end = TRUE WHERE tenant_id = $1 RETURNING *`,
            [tenant.id],
          )
        : await client.query<SubscriptionRow>(
            `UPDATE subscriptions
             SET status = 'CANCELLED', canceled_at = NOW(), cancel_at_period_end = TRUE
             WHERE tenant_id = $1
             RETURNING *`,
            [tenant.id],
          );

      await client.query(
        `INSERT INTO billing_events (tenant_id, subscription_id, event_type, notes)
         VALUES ($1, $2, 'SUBSCRIPTION_CANCELLED', $3)`,
        [
          tenant.id, sub.id,
          `Cancelled ${parse.data.at_period_end ? 'at period end' : 'immediately'} by ${ctx.email}`
            + (parse.data.reason ? ` — ${parse.data.reason}` : ''),
        ],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'SUB_CANCEL', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { at_period_end: parse.data.at_period_end, previous_status: sub.status },
      });

      await client.query('COMMIT');
      await publishRealtimeEvent(tenantRoom(tenant.id), 'subscription:updated', { subscription: updated.rows[0] });
      res.status(200).json({ subscription: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/tenants/:tenantId/subscription/reactivate',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const subResult = await client.query<SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`,
        [tenant.id],
      );
      if (subResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription not found for this tenant'));
        return;
      }
      const sub = subResult.rows[0];

      const isCancelledOrPending = sub.status === 'CANCELLED' || sub.cancel_at_period_end;
      if (!isCancelledOrPending) {
        await client.query('ROLLBACK');
        sendError(res, Errors.conflict(
          'Subscription is not cancelled or pending cancellation — nothing to reactivate',
        ));
        return;
      }

      const updated = await client.query<SubscriptionRow>(
        `UPDATE subscriptions
         SET status = 'ACTIVE', cancel_at_period_end = FALSE, canceled_at = NULL
         WHERE tenant_id = $1
         RETURNING *`,
        [tenant.id],
      );

      await client.query(
        `INSERT INTO billing_events (tenant_id, subscription_id, event_type, notes)
         VALUES ($1, $2, 'SUBSCRIPTION_REACTIVATED', $3)`,
        [tenant.id, sub.id, `Reactivated by ${ctx.email}`],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'SUB_REACTIVATE', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { previous_status: sub.status },
      });

      await client.query('COMMIT');
      await publishRealtimeEvent(tenantRoom(tenant.id), 'subscription:updated', { subscription: updated.rows[0] });
      res.status(200).json({ subscription: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.get(
  '/tenants/:tenantId/billing-events',
  requireRead,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const result = await client.query(
        `SELECT id, tenant_id, subscription_id, event_type, amount_cents, notes, created_at
         FROM billing_events
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.params.tenantId],
      );
      res.json({ events: result.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── Subscription upgrade requests ─────────────────────────────────────────────
//
// The other direction from change-plan above: a Shop Admin requests a plan/
// billing-cycle upgrade (services/auth-tenant's POST /api/v1/auth/
// subscription/request) and a Super Admin approves or declines it here.
// Approval writes through to `subscriptions` exactly like change-plan does —
// this table only tracks the request/decision lifecycle around that write.

interface SubscriptionRequestRow {
  id:                  string;
  tenant_id:           string;
  requested_plan_code: PlanCode;
  billing_cycle:       'monthly' | 'semestral' | 'annual';
  status:              'PENDING' | 'APPROVED' | 'REJECTED';
  requested_by:        string;
  decided_by:          string | null;
  decided_at:          string | null;
  decision_reason:     string | null;
  created_at:          string;
  updated_at:          string;
}

const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/** Computes a period end from the chosen billing cycle — 30/180/365 days —
 *  used unless the approver supplies an explicit `custom_end_date`. */
function periodEndFromCycle(cycle: SubscriptionRequestRow['billing_cycle'], start: Date): Date {
  const days = cycle === 'monthly' ? 30 : cycle === 'semestral' ? 180 : 365;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

router.get(
  '/subscription-requests',
  requireRead,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const statusParam = typeof req.query['status'] === 'string' ? req.query['status'].toUpperCase() : undefined;
      const filterStatus = (REQUEST_STATUSES as readonly string[]).includes(statusParam ?? '') ? statusParam : undefined;

      const result = await client.query(
        `SELECT sr.id, sr.tenant_id, sr.requested_plan_code, sr.billing_cycle, sr.status,
                sr.requested_by, sr.decided_by, sr.decided_at, sr.decision_reason,
                sr.created_at, sr.updated_at,
                t.name AS tenant_name, t.slug AS tenant_slug,
                u.email AS requested_by_email
         FROM subscription_requests sr
         JOIN tenants t ON t.id = sr.tenant_id
         LEFT JOIN users u ON u.id = sr.requested_by
         ${filterStatus ? 'WHERE sr.status = $1' : ''}
         ORDER BY sr.created_at DESC
         LIMIT 100`,
        filterStatus ? [filterStatus] : [],
      );
      res.json({ requests: result.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

const approveRequestSchema = z.object({
  custom_end_date: z.string().datetime().optional(),
  reason:          z.string().trim().max(1000).optional(),
});

router.post(
  '/subscription-requests/:id/approve',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = approveRequestSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const requestResult = await client.query<SubscriptionRequestRow>(
        `SELECT * FROM subscription_requests WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      if (requestResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription request not found'));
        return;
      }
      const request = requestResult.rows[0];

      if (request.status !== 'PENDING') {
        // Idempotent at the domain level — a retried/duplicate approval
        // click on an already-decided request is a no-op, not an error.
        await client.query('ROLLBACK');
        res.status(200).json({ request, already_decided: true });
        return;
      }

      const tenantStatusResult = await client.query<{ status: string }>(
        `SELECT status FROM tenants WHERE id = $1 FOR UPDATE`,
        [request.tenant_id],
      );
      if (tenantStatusResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }
      const previousTenantStatus = tenantStatusResult.rows[0].status;

      const subResult = await client.query<SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`,
        [request.tenant_id],
      );
      if (subResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription not found for this tenant'));
        return;
      }
      const sub = subResult.rows[0];

      const periodStart = new Date();
      const periodEnd = parse.data.custom_end_date
        ? new Date(parse.data.custom_end_date)
        : periodEndFromCycle(request.billing_cycle, periodStart);
      if (periodEnd.getTime() <= periodStart.getTime()) {
        await client.query('ROLLBACK');
        sendError(res, Errors.invalidRequest('custom_end_date must be in the future'));
        return;
      }

      // The trigger sync_tenant_billing_tier() keeps tenants.billing_tier in
      // sync with this write — never write billing_tier directly.
      const updatedSub = await client.query<SubscriptionRow>(
        `UPDATE subscriptions
         SET plan_code = $2, billing_cycle = $3, status = 'ACTIVE',
             current_period_start = $4, current_period_end = $5,
             cancel_at_period_end = FALSE, canceled_at = NULL
         WHERE tenant_id = $1
         RETURNING *`,
        [request.tenant_id, request.requested_plan_code, request.billing_cycle,
         periodStart.toISOString(), periodEnd.toISOString()],
      );

      // Approving an upgrade also lifts a suspension/pending-approval state —
      // mirrors the existing /unblock handler's shape exactly (unban users,
      // flip status to ACTIVE).
      let tenantReactivated = false;
      if (previousTenantStatus !== 'ACTIVE') {
        const usersResult = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
          [request.tenant_id],
        );
        await setTenantUsersBanned(usersResult.rows.map((u) => u.id), false);
        await client.query(
          `UPDATE tenants
           SET status = 'ACTIVE', status_reason = NULL, status_changed_at = NOW(), status_changed_by = $2
           WHERE id = $1`,
          [request.tenant_id, ctx.userId],
        );
        tenantReactivated = true;
      }

      await client.query(
        `UPDATE subscription_requests
         SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), decision_reason = $3
         WHERE id = $1`,
        [request.id, ctx.userId, parse.data.reason ?? null],
      );

      await client.query(
        `INSERT INTO billing_events (tenant_id, subscription_id, event_type, notes)
         VALUES ($1, $2, 'SUBSCRIPTION_APPROVED', $3)`,
        [
          request.tenant_id, sub.id,
          `Upgrade request approved: ${sub.plan_code} -> ${request.requested_plan_code} (${request.billing_cycle}) by ${ctx.email}`,
        ],
      );

      const tenantMeta = await fetchTenantMeta(client, request.tenant_id);
      await writePlatformAuditLog(client, {
        tenantId: request.tenant_id, tenantSlug: tenantMeta?.slug ?? '', tenantName: tenantMeta?.name ?? '',
        action: 'SUB_REQUEST_APPROVE', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: {
          requested_plan: request.requested_plan_code, billing_cycle: request.billing_cycle,
          previous_plan: sub.plan_code, tenant_reactivated: tenantReactivated,
        },
      });

      await client.query('COMMIT');

      if (tenantReactivated) {
        await setTenantStatusCache(request.tenant_id, 'ACTIVE');
      }
      await publishRealtimeEvent(tenantRoom(request.tenant_id), 'subscription:updated', { subscription: updatedSub.rows[0] });
      if (tenantReactivated) {
        await publishRealtimeEvent(tenantRoom(request.tenant_id), 'tenant:status_changed', {
          status: 'ACTIVE', reason: 'SUBSCRIPTION_APPROVED',
        });
      }
      await publishRealtimeEvent(PLATFORM_STAFF_ROOM, 'subscription:request_decided', {
        requestId: request.id, status: 'APPROVED',
      });

      res.status(200).json({ subscription: updatedSub.rows[0], tenant_reactivated: tenantReactivated });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

const rejectRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required when declining a request').max(1000),
});

router.post(
  '/subscription-requests/:id/reject',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = rejectRequestSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const requestResult = await client.query<SubscriptionRequestRow>(
        `SELECT * FROM subscription_requests WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      if (requestResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Subscription request not found'));
        return;
      }
      const request = requestResult.rows[0];

      if (request.status !== 'PENDING') {
        await client.query('ROLLBACK');
        res.status(200).json({ request, already_decided: true });
        return;
      }

      const updated = await client.query<SubscriptionRequestRow>(
        `UPDATE subscription_requests
         SET status = 'REJECTED', decided_by = $2, decided_at = NOW(), decision_reason = $3
         WHERE id = $1
         RETURNING *`,
        [request.id, ctx.userId, parse.data.reason],
      );

      const tenantMeta = await fetchTenantMeta(client, request.tenant_id);
      await writePlatformAuditLog(client, {
        tenantId: request.tenant_id, tenantSlug: tenantMeta?.slug ?? '', tenantName: tenantMeta?.name ?? '',
        action: 'SUB_REQUEST_REJECT', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { requested_plan: request.requested_plan_code, billing_cycle: request.billing_cycle },
      });

      await client.query('COMMIT');

      await publishRealtimeEvent(tenantRoom(request.tenant_id), 'subscription:request_rejected', {
        requestId: request.id, reason: parse.data.reason,
      });
      await publishRealtimeEvent(PLATFORM_STAFF_ROOM, 'subscription:request_decided', {
        requestId: request.id, status: 'REJECTED',
      });

      res.status(200).json({ request: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── Feature flags ──────────────────────────────────────────────────────────────

router.get('/feature-flags', requireRead, async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const result = await client.query(
      `SELECT ff.key, ff.description, ff.default_enabled,
              COALESCE(
                json_object_agg(pff.plan_code, pff.enabled) FILTER (WHERE pff.plan_code IS NOT NULL),
                '{}'
              ) AS plan_defaults
       FROM feature_flags ff
       LEFT JOIN plan_feature_flags pff ON pff.flag_key = ff.key
       GROUP BY ff.key, ff.description, ff.default_enabled
       ORDER BY ff.key`,
    );
    res.json({ flags: result.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get(
  '/tenants/:tenantId/feature-flags',
  requireRead,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      // Reproduces resolveFeatureFlag()'s exact resolution order (tenant
      // override → plan default → global default → false) in one query, plus
      // whether the resolved value came from an override.
      const result = await client.query(
        `SELECT ff.key, ff.description,
                COALESCE(tff.enabled, pff.enabled, ff.default_enabled, FALSE) AS enabled,
                (tff.tenant_id IS NOT NULL) AS is_override,
                tff.overridden_by, tff.overridden_at
         FROM feature_flags ff
         LEFT JOIN tenant_feature_flags tff
           ON tff.tenant_id = $1 AND tff.flag_key = ff.key
         LEFT JOIN plan_feature_flags pff
           ON pff.plan_code = $2 AND pff.flag_key = ff.key
         ORDER BY ff.key`,
        [tenant.id, tenant.billing_tier],
      );
      res.json({
        tenant_id: tenant.id,
        billing_tier: tenant.billing_tier,
        flags: result.rows,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

const featureFlagPatchSchema = z.object({
  enabled: z.boolean(),
});

router.patch(
  '/tenants/:tenantId/feature-flags/:key',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = featureFlagPatchSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const flagResult = await client.query<{ key: string }>(
        `SELECT key FROM feature_flags WHERE key = $1 LIMIT 1`,
        [req.params.key],
      );
      if (flagResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Unknown feature flag key'));
        return;
      }

      const upserted = await client.query(
        `INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled, overridden_by, overridden_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id, flag_key) DO UPDATE SET
           enabled       = EXCLUDED.enabled,
           overridden_by = EXCLUDED.overridden_by,
           overridden_at = NOW()
         RETURNING tenant_id, flag_key, enabled, overridden_by, overridden_at`,
        [tenant.id, req.params.key, parse.data.enabled, ctx.userId],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'FEATURE_FLAG_SET', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { flag_key: req.params.key, enabled: parse.data.enabled },
      });

      await client.query('COMMIT');
      res.status(200).json({ override: upserted.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/tenants/:tenantId/feature-flags/:key/reset',
  requireWrite,
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantMeta(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const flagResult = await client.query<{ key: string }>(
        `SELECT key FROM feature_flags WHERE key = $1 LIMIT 1`,
        [req.params.key],
      );
      if (flagResult.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Unknown feature flag key'));
        return;
      }

      // Idempotent regardless of whether an override existed.
      const deleted = await client.query(
        `DELETE FROM tenant_feature_flags WHERE tenant_id = $1 AND flag_key = $2`,
        [tenant.id, req.params.key],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'FEATURE_FLAG_RESET', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { flag_key: req.params.key, had_override: (deleted.rowCount ?? 0) > 0 },
      });

      await client.query('COMMIT');
      res.status(200).json({ tenant_id: tenant.id, flag_key: req.params.key, reset: true });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

export { router as subscriptionsRouter };
