import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { redis } from '@retail/redis';
import {
  getTenantContext,
  idempotency,
  Errors,
  sendError,
  requireAnyPermission,
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
          | 'FEATURE_FLAG_SET' | 'FEATURE_FLAG_RESET';
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
