import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { redis } from '@retail/redis';
import {
  requireSuperadmin,
  getTenantContext,
  idempotency,
  Errors,
  sendError,
  tenantStatusCacheKey,
  TENANT_STATUS_CACHE_TTL_SECONDS,
} from '@retail/middleware';
import { setTenantUsersBanned } from '../lib/supabase-admin';

const router = Router();

router.use(requireSuperadmin());

const idempotent = idempotency(redis);

// ─── Shared helpers ────────────────────────────────────────────────────────────

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  billing_tier: string;
  currency: string;
  timezone: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  status_reason: string | null;
  status_changed_at: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
}

const TENANT_LIST_COLUMNS = `
  id, name, slug, billing_tier, currency, timezone,
  status, status_reason, status_changed_at, is_active, deleted_at, created_at
`;

/**
 * Writes to the tenant-lifecycle audit trail. Deliberately NOT the
 * tenant-scoped `audit_logs` table — see packages/db/src/migrations/
 * 007_tenant_lifecycle.sql for why (a hard PURGE cascade-deletes
 * `audit_logs` for that tenant, which would destroy the very record of the
 * purge itself). Snapshots tenant name/slug since PURGE means the tenant row
 * may not exist by the time anyone reads this back.
 */
async function writePlatformAuditLog(
  client: Awaited<ReturnType<typeof getClient>>,
  params: {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    action: 'SUSPEND' | 'UNBLOCK' | 'SOFT_DELETE' | 'PURGE' | 'TIER_CHANGE';
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

/** Write-through the tenant-status cache immediately — this, not TTL expiry,
 *  is what makes tenant-context.ts's rejection "immediate" cluster-wide. */
async function setTenantStatusCache(tenantId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DELETED'): Promise<void> {
  try {
    await redis.set(tenantStatusCacheKey(tenantId), status, 'EX', TENANT_STATUS_CACHE_TTL_SECONDS);
  } catch (err) {
    // Best-effort — the safety-net TTL on the read side, and the fact that a
    // Postgres miss always re-checks Postgres, bound the blast radius of a
    // failed cache write to at most TENANT_STATUS_CACHE_TTL_SECONDS of
    // staleness, not an incorrect state forever.
    console.error('[superadmin] Failed to write-through tenant status cache', (err as Error).message);
  }
}

async function fetchTenantOrNotFound(
  client: Awaited<ReturnType<typeof getClient>>,
  tenantId: string,
): Promise<TenantRow | null> {
  const result = await client.query<TenantRow>(
    `SELECT ${TENANT_LIST_COLUMNS} FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

// ─── Read endpoints ────────────────────────────────────────────────────────────

router.get('/health-metrics', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const totalTx = await client.query<{ count: string }>('SELECT COUNT(*) FROM sales');
    const lowStock = await client.query<{ count: string }>(
      'SELECT COUNT(*) FROM inventories WHERE stock_quantity <= reorder_level',
    );
    // Platform-level revenue — PAID sales only; excludes PENDING/FAILED/REFUNDED.
    const revenue = await client.query<{ sum: string | null }>(
      `SELECT SUM(total_amount) FROM sales WHERE payment_status = 'PAID'`,
    );
    const tenantsByStatus = await client.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*) AS count FROM tenants GROUP BY status',
    );
    const statusBreakdown: Record<string, number> = { ACTIVE: 0, SUSPENDED: 0, DELETED: 0 };
    for (const row of tenantsByStatus.rows) {
      statusBreakdown[row.status] = Number(row.count);
    }

    // Attempt to estimate BullMQ wait list length for sales-sync
    let syncBacklog = 0;
    try {
      const keys = await redis.keys('bull:sales-sync:batch*');
      for (const k of keys) {
        // look for wait list
        if (k.endsWith(':wait')) {
          const l = await redis.llen(k);
          syncBacklog += Number(l || 0);
        }
      }
    } catch (err) {
      // best-effort: ignore redis errors
    }

    res.json({
      total_transactions: Number(totalTx.rows[0].count || 0),
      global_low_stock_triggers: Number(lowStock.rows[0].count || 0),
      total_platform_revenue: Number(revenue.rows[0]?.sum || 0),
      tenants_by_status: statusBreakdown,
      sync_pipeline_backlog: syncBacklog,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/anomalies', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id, tenant_id, entity_type, action, worker_tag, old_values, new_values, created_at
       FROM audit_logs
       WHERE (COALESCE(old_values::text, '') ILIKE '%ANOMALY-%' OR COALESCE(new_values::text, '') ILIKE '%ANOMALY-%'
         OR action ILIKE 'ANOMALY-%')
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    res.json({ anomalies: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/tenants', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query<TenantRow>(
      `SELECT ${TENANT_LIST_COLUMNS} FROM tenants ORDER BY created_at DESC`,
    );
    res.json({ tenants: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/tenants/:tenantId', async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
    if (!tenant) {
      sendError(res, Errors.notFound('Tenant not found'));
      return;
    }
    res.json({ tenant, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

/** Platform audit trail for a single tenant (or, with no :tenantId, recent
 *  platform-wide superadmin activity) — the "who blocked/deleted a store
 *  and why" log called for in the Super Admin review. */
router.get('/audit-log', async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
    const rows = tenantId
      ? await client.query(
          `SELECT * FROM platform_audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [tenantId],
        )
      : await client.query(`SELECT * FROM platform_audit_logs ORDER BY created_at DESC LIMIT 200`);
    res.json({ entries: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ─── Lifecycle mutations ───────────────────────────────────────────────────────
// All POST/PATCH (never DELETE) so the shared idempotency() middleware — which
// only guards POST/PUT/PATCH — actually covers every one of these.

const reasonSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(1000),
});

router.post(
  '/tenants/:tenantId/suspend',
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = reasonSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }
      if (tenant.status === 'DELETED') {
        await client.query('ROLLBACK');
        sendError(res, Errors.conflict('Tenant is deleted — cannot suspend a deleted tenant'));
        return;
      }
      if (tenant.status === 'SUSPENDED') {
        // Idempotent at the domain level, not just via the mutation-id header.
        await client.query('ROLLBACK');
        res.status(200).json({ tenant, already_suspended: true });
        return;
      }

      const updated = await client.query<TenantRow>(
        `UPDATE tenants
         SET status = 'SUSPENDED', status_reason = $2,
             status_changed_at = NOW(), status_changed_by = $3
         WHERE id = $1
         RETURNING ${TENANT_LIST_COLUMNS}`,
        [tenant.id, parse.data.reason, ctx.userId],
      );

      const users = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenant.id],
      );
      // Best-effort defense-in-depth — the tenant-context.ts status gate is
      // what actually enforces this immediately regardless of ban outcome.
      const banResult = await setTenantUsersBanned(users.rows.map((u) => u.id), true);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'SUSPEND', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: {
          banned_user_count: banResult.succeeded.length,
          ban_failures: banResult.failed,
        },
      });

      await client.query('COMMIT');
      await setTenantStatusCache(tenant.id, 'SUSPENDED');

      res.status(200).json({ tenant: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/tenants/:tenantId/unblock',
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }
      if (tenant.status === 'DELETED') {
        await client.query('ROLLBACK');
        sendError(res, Errors.conflict('Tenant is deleted — restore is not supported via unblock'));
        return;
      }
      if (tenant.status === 'ACTIVE') {
        await client.query('ROLLBACK');
        res.status(200).json({ tenant, already_active: true });
        return;
      }

      const updated = await client.query<TenantRow>(
        `UPDATE tenants
         SET status = 'ACTIVE', status_reason = NULL,
             status_changed_at = NOW(), status_changed_by = $2
         WHERE id = $1
         RETURNING ${TENANT_LIST_COLUMNS}`,
        [tenant.id, ctx.userId],
      );

      const users = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenant.id],
      );
      const banResult = await setTenantUsersBanned(users.rows.map((u) => u.id), false);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'UNBLOCK', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: {
          unbanned_user_count: banResult.succeeded.length,
          ban_failures: banResult.failed,
        },
      });

      await client.query('COMMIT');
      await setTenantStatusCache(tenant.id, 'ACTIVE');

      res.status(200).json({ tenant: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/tenants/:tenantId/delete',
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = reasonSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }
      if (tenant.status === 'DELETED') {
        await client.query('ROLLBACK');
        res.status(200).json({ tenant, already_deleted: true });
        return;
      }

      const updated = await client.query<TenantRow>(
        `UPDATE tenants
         SET status = 'DELETED', deleted_at = NOW(), status_reason = $2,
             status_changed_at = NOW(), status_changed_by = $3
         WHERE id = $1
         RETURNING ${TENANT_LIST_COLUMNS}`,
        [tenant.id, parse.data.reason, ctx.userId],
      );

      const users = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenant.id],
      );
      const banResult = await setTenantUsersBanned(users.rows.map((u) => u.id), true);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'SOFT_DELETE', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: {
          banned_user_count: banResult.succeeded.length,
          ban_failures: banResult.failed,
        },
      });

      await client.query('COMMIT');
      await setTenantStatusCache(tenant.id, 'DELETED');

      res.status(200).json({ tenant: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

const purgeSchema = z.object({
  // Typed confirmation — must exactly match the tenant's slug. Mirrors the
  // "type the repo name to delete it" pattern so a hard, cascading delete
  // can never be triggered by a stray click, a copy-pasted request, or an
  // automated retry that doesn't know what it's about to do.
  confirm: z.string().min(1),
});

router.post(
  '/tenants/:tenantId/purge',
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = purgeSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }
      // Require the two-step "soft-delete, then purge" path — a hard delete
      // can never be the FIRST action taken against a live tenant.
      if (tenant.status !== 'DELETED') {
        await client.query('ROLLBACK');
        sendError(res, Errors.conflict(
          'Tenant must be soft-deleted (POST /tenants/:id/delete) before it can be purged',
        ));
        return;
      }
      if (parse.data.confirm !== tenant.slug) {
        await client.query('ROLLBACK');
        sendError(res, Errors.invalidRequest(
          `Confirmation does not match. Pass { "confirm": "${tenant.slug}" } to permanently delete this tenant.`,
        ));
        return;
      }

      // Snapshot BEFORE the cascade — the row (and everything FK'd to it:
      // users, sales, inventories, customer_ledger, ledger_entries,
      // refresh_tokens, sync_cursors, mobile_money_transactions,
      // cash_drawer_shifts, and that tenant's own audit_logs) is gone after
      // this DELETE. platform_audit_logs has no FK, so this row survives it.
      await client.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'PURGE', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { billing_tier: tenant.billing_tier },
      });

      await client.query('COMMIT');
      // Delete rather than write 'DELETED' — a purged tenant id should miss
      // the cache and hit Postgres, which correctly returns "not found" (see
      // resolveTenantStatus's not-found fallback path via GET /tenants/:id;
      // tenant-context.ts's own query will simply find zero rows and, per
      // its isTenantStatus() guard, that's treated the same as any other
      // "can't confirm this is ACTIVE" case).
      await redis.del(tenantStatusCacheKey(tenant.id)).catch(() => {});

      res.status(200).json({ purged_tenant_id: tenant.id, slug: tenant.slug });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

const tierSchema = z.object({
  billing_tier: z.enum(['starter', 'premium', 'business', 'business_premium']),
});

router.patch(
  '/tenants/:tenantId/tier',
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = tierSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const updated = await client.query<TenantRow>(
        `UPDATE tenants SET billing_tier = $2 WHERE id = $1
         RETURNING ${TENANT_LIST_COLUMNS}`,
        [tenant.id, parse.data.billing_tier],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'TIER_CHANGE', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { previous_tier: tenant.billing_tier, new_tier: parse.data.billing_tier },
      });

      await client.query('COMMIT');
      res.status(200).json({ tenant: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

export { router as superadminRouter };
