import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient, getPoolStats } from '@retail/db';
import { redis } from '@retail/redis';
import type { Permission } from '@retail/types';
import {
  requireSuperadmin,
  requireAnyPermission,
  getTenantContext,
  idempotency,
  Errors,
  sendError,
  tenantRateLimitCacheKey,
  TENANT_RATE_LIMIT_CACHE_TTL_SECONDS,
  PLATFORM_SENTINEL_TENANT_ID,
} from '@retail/middleware';
import { getSupabaseAdmin, setTenantUsersBanned } from '../lib/supabase-admin';

const router = Router();

const idempotent = idempotency(redis);

/** Any of the three platform roles — read-only endpoints in this file (health,
 *  error log, rate-limit listing, staff listing) are open to all of them,
 *  mirroring the `Permission` doc comment in @retail/types/tenant-context.ts. */
const ANY_PLATFORM_ROLE: Permission[] = ['platform:support', 'platform:billing', 'superadmin:access'];

// ─── Shared helpers ────────────────────────────────────────────────────────────

interface TenantRow {
  id: string;
  name: string;
  slug: string;
}

async function fetchTenantOrNotFound(
  client: Awaited<ReturnType<typeof getClient>>,
  tenantId: string,
): Promise<TenantRow | null> {
  const result = await client.query<TenantRow>(
    `SELECT id, name, slug FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Writes to the tenant-lifecycle audit trail. Deliberately NOT the
 * tenant-scoped `audit_logs` table — see packages/db/src/migrations/
 * 007_tenant_lifecycle.sql for why (a hard PURGE cascade-deletes
 * `audit_logs` for that tenant, which would destroy the very record of the
 * purge itself). Snapshots tenant name/slug since PURGE means the tenant row
 * may not exist by the time anyone reads this back.
 *
 * Duplicated from superadmin-router.ts rather than imported — services in
 * this repo don't import each other's `src`, and this file lives in the same
 * service but as a matter of convention each router keeps its own copy.
 */
async function writePlatformAuditLog(
  client: Awaited<ReturnType<typeof getClient>>,
  params: {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    action: 'KILL_SESSIONS' | 'GRANT_STAFF' | 'REVOKE_STAFF' | 'RATE_LIMIT_SET' | 'RATE_LIMIT_CLEAR';
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

/**
 * Pages through `supabase.auth.admin.listUsers` looking for an exact
 * (case-insensitive) email match. Duplicated from
 * services/superadmin/scripts/grant-superadmin.ts's `findUserIdByEmail` —
 * that file is a standalone CLI script, not a module this service imports.
 */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const target = email.toLowerCase().trim();
  const perPage = 200;
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

/** Maps a `platform_staff.platform_role` value to the `Permission` string
 *  granting it in the user's Supabase app_metadata.permissions. */
const PLATFORM_ROLE_PERMISSION: Record<'SUPPORT' | 'BILLING_ADMIN' | 'SUPERADMIN', Permission> = {
  SUPPORT: 'platform:support',
  BILLING_ADMIN: 'platform:billing',
  SUPERADMIN: 'superadmin:access',
};

const ALL_PLATFORM_PERMISSIONS: Permission[] = ['platform:support', 'platform:billing', 'superadmin:access'];

/** Bans then immediately unbans a batch of Supabase user ids — the
 *  "kick everyone off without locking anyone out" primitive shared by both
 *  session-kill routes below. Returns the union of ban-phase failures (an
 *  unban failure after a successful ban is logged but not treated as fatal —
 *  the ban itself, which is what invalidates sessions, already succeeded). */
async function banThenUnban(
  userIds: string[],
): Promise<{ banFailures: Array<{ userId: string; error: string }> }> {
  const banResult = await setTenantUsersBanned(userIds, true);
  await setTenantUsersBanned(userIds, false);
  return { banFailures: banResult.failed };
}

// ═══════════════════════════════════════════════════════════════════════════
// Staff RBAC (superadmin-only)
// ═══════════════════════════════════════════════════════════════════════════

const grantStaffSchema = z.object({
  email: z.string().trim().email(),
  platform_role: z.enum(['SUPPORT', 'BILLING_ADMIN', 'SUPERADMIN']),
});

router.post(
  '/staff/grant',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = grantStaffSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      const userId = await findUserIdByEmail(parse.data.email);
      if (!userId) {
        sendError(res, Errors.notFound(
          `No Supabase auth user found for ${parse.data.email}. Create the account first, then grant platform staff access.`,
        ));
        return;
      }

      const permissionToGrant = PLATFORM_ROLE_PERMISSION[parse.data.platform_role];

      const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId);
      if (error || !data.user) {
        sendError(res, Errors.internal(`getUserById failed: ${error?.message ?? 'no user'}`));
        return;
      }
      const currentMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>;
      const existingPermissions = Array.isArray(currentMetadata['permissions'])
        ? (currentMetadata['permissions'] as string[])
        : [];
      const nextPermissions = Array.from(new Set([...existingPermissions, permissionToGrant]));

      const { error: updateErr } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
        app_metadata: { ...currentMetadata, permissions: nextPermissions },
      });
      if (updateErr) {
        sendError(res, Errors.internal(`updateUserById failed: ${updateErr.message}`));
        return;
      }

      await client.query('BEGIN');
      await client.query(
        `INSERT INTO platform_staff (user_id, email, platform_role, granted_by, granted_at, revoked_at)
         VALUES ($1, $2, $3, $4, NOW(), NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET platform_role = EXCLUDED.platform_role,
               granted_by    = EXCLUDED.granted_by,
               granted_at    = NOW(),
               revoked_at    = NULL`,
        [userId, parse.data.email, parse.data.platform_role, ctx.userId],
      );

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID, tenantSlug: 'platform', tenantName: 'PLATFORM',
        action: 'GRANT_STAFF', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { target_email: parse.data.email, platform_role: parse.data.platform_role },
      });

      await client.query('COMMIT');
      res.status(200).json({
        user_id: userId,
        email: parse.data.email,
        platform_role: parse.data.platform_role,
        permissions: nextPermissions,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  },
);

const revokeStaffSchema = z.object({
  email: z.string().trim().email(),
});

router.post(
  '/staff/revoke',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = revokeStaffSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      const userId = await findUserIdByEmail(parse.data.email);
      if (!userId) {
        sendError(res, Errors.notFound(
          `No Supabase auth user found for ${parse.data.email}.`,
        ));
        return;
      }

      const { data, error } = await getSupabaseAdmin().auth.admin.getUserById(userId);
      if (error || !data.user) {
        sendError(res, Errors.internal(`getUserById failed: ${error?.message ?? 'no user'}`));
        return;
      }
      const currentMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>;
      const existingPermissions = Array.isArray(currentMetadata['permissions'])
        ? (currentMetadata['permissions'] as string[])
        : [];
      const nextPermissions = existingPermissions.filter(
        (p) => !ALL_PLATFORM_PERMISSIONS.includes(p as Permission),
      );

      const { error: updateErr } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
        app_metadata: { ...currentMetadata, permissions: nextPermissions },
      });
      if (updateErr) {
        sendError(res, Errors.internal(`updateUserById failed: ${updateErr.message}`));
        return;
      }

      await client.query('BEGIN');
      await client.query(
        `UPDATE platform_staff SET revoked_at = NOW() WHERE user_id = $1`,
        [userId],
      );

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID, tenantSlug: 'platform', tenantName: 'PLATFORM',
        action: 'REVOKE_STAFF', performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { target_email: parse.data.email },
      });

      await client.query('COMMIT');
      res.status(200).json({ user_id: userId, email: parse.data.email, permissions: nextPermissions });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  },
);

router.get(
  '/staff',
  requireAnyPermission(...ANY_PLATFORM_ROLE),
  async (_req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const rows = await client.query(
        `SELECT * FROM platform_staff WHERE revoked_at IS NULL ORDER BY granted_at DESC`,
      );
      res.json({ staff: rows.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Session kill (superadmin-only)
// ═══════════════════════════════════════════════════════════════════════════

const killSessionsSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(1000),
});

router.post(
  '/tenants/:tenantId/kill-sessions',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = killSessionsSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      const tenant = await fetchTenantOrNotFound(client, req.params.tenantId);
      if (!tenant) {
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      const users = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenant.id],
      );
      const userIds = users.rows.map((u) => u.id);
      const { banFailures } = await banThenUnban(userIds);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'KILL_SESSIONS', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { user_count: userIds.length, ban_failures: banFailures },
      });

      res.status(200).json({
        tenant_id: tenant.id,
        user_count: userIds.length,
        ban_failures: banFailures,
      });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

const killAllSessionsSchema = z.object({
  confirm: z.string(),
  reason: z.string().trim().min(1, 'reason is required').max(1000),
});
const KILL_ALL_CONFIRMATION = 'KILL ALL SESSIONS';

router.post(
  '/kill-all-sessions',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = killAllSessionsSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    if (parse.data.confirm !== KILL_ALL_CONFIRMATION) {
      sendError(res, Errors.invalidRequest(
        `Confirmation does not match. Pass { "confirm": "${KILL_ALL_CONFIRMATION}" } to kill every session on the platform.`,
      ));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      const allUserIds: string[] = [];
      const allBanFailures: Array<{ userId: string; error: string }> = [];

      // Batch to bound memory/concurrency against a very large `users` table —
      // a single unbounded query is acceptable per the table's current size,
      // but batching costs nothing and scales safely if it grows.
      const BATCH_SIZE = 500;
      let lastId: string | null = null;
      for (;;) {
        let batchRows: Array<{ id: string }>;
        if (lastId) {
          const result = await client.query<{ id: string }>(
            `SELECT id FROM users WHERE deleted_at IS NULL AND id > $1 ORDER BY id LIMIT $2`,
            [lastId, BATCH_SIZE],
          );
          batchRows = result.rows;
        } else {
          const result = await client.query<{ id: string }>(
            `SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id LIMIT $1`,
            [BATCH_SIZE],
          );
          batchRows = result.rows;
        }
        if (batchRows.length === 0) break;

        const batchIds = batchRows.map((u) => u.id);
        allUserIds.push(...batchIds);
        const { banFailures } = await banThenUnban(batchIds);
        allBanFailures.push(...banFailures);

        lastId = batchIds[batchIds.length - 1];
        if (batchRows.length < BATCH_SIZE) break;
      }

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID, tenantSlug: '*', tenantName: 'ALL TENANTS',
        action: 'KILL_SESSIONS', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { user_count: allUserIds.length, ban_failures: allBanFailures, reason: parse.data.reason },
      });

      res.status(200).json({
        user_count: allUserIds.length,
        ban_failures: allBanFailures,
      });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Health & diagnostics (any platform role)
// ═══════════════════════════════════════════════════════════════════════════

async function checkRedis(): Promise<{ status: string; latency_ms: number | null }> {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: redis.status, latency_ms: Date.now() - start };
  } catch {
    return { status: 'unreachable', latency_ms: null };
  }
}

async function checkWhatsappGateway(): Promise<{ reachable: boolean; status?: string }> {
  const baseUrl = process.env.WHATSAPP_ENGINE_URL ?? 'http://localhost:3005';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return { reachable: response.ok, status: String(response.status) };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

router.get(
  '/health',
  requireAnyPermission(...ANY_PLATFORM_ROLE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [redisHealth, whatsappHealth] = await Promise.all([
        checkRedis(),
        checkWhatsappGateway(),
      ]);
      res.json({
        database: getPoolStats(),
        redis: redisHealth,
        whatsapp_gateway: whatsappHealth,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/error-log',
  requireAnyPermission(...ANY_PLATFORM_ROLE),
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const conditions: string[] = [];
      const values: unknown[] = [];

      const service = typeof req.query.service === 'string' ? req.query.service : undefined;
      if (service) {
        values.push(service);
        conditions.push(`AND service = $${values.length}`);
      }

      const minStatusRaw = typeof req.query.min_status === 'string' ? Number(req.query.min_status) : undefined;
      if (minStatusRaw !== undefined && Number.isFinite(minStatusRaw)) {
        values.push(minStatusRaw);
        conditions.push(`AND status_code >= $${values.length}`);
      }

      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      if (since) {
        values.push(since);
        conditions.push(`AND created_at >= $${values.length}`);
      }

      const rows = await client.query(
        `SELECT * FROM platform_error_logs WHERE 1=1 ${conditions.join(' ')} ORDER BY created_at DESC LIMIT 200`,
        values,
      );
      res.json({ errors: rows.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Per-tenant rate limits
// ═══════════════════════════════════════════════════════════════════════════

router.get(
  '/rate-limits',
  requireAnyPermission(...ANY_PLATFORM_ROLE),
  async (_req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      const rows = await client.query(
        `SELECT * FROM tenant_rate_limits ORDER BY set_at DESC`,
      );
      res.json({ rate_limits: rows.rows, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

const setRateLimitSchema = z.object({
  max_requests: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
  reason: z.string().trim().min(1, 'reason is required').max(1000),
});

router.patch(
  '/tenants/:tenantId/rate-limit',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = setRateLimitSchema.safeParse(req.body);
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

      const updated = await client.query(
        `INSERT INTO tenant_rate_limits (tenant_id, max_requests, window_seconds, reason, set_by, set_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tenant_id) DO UPDATE
           SET max_requests   = EXCLUDED.max_requests,
               window_seconds = EXCLUDED.window_seconds,
               reason         = EXCLUDED.reason,
               set_by         = EXCLUDED.set_by,
               set_at         = NOW()
         RETURNING *`,
        [tenant.id, parse.data.max_requests, parse.data.window_seconds, parse.data.reason, ctx.userId],
      );

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'RATE_LIMIT_SET', reason: parse.data.reason, performedBy: ctx.userId, performedByEmail: ctx.email,
        details: { max_requests: parse.data.max_requests, window_seconds: parse.data.window_seconds },
      });

      await client.query('COMMIT');

      try {
        await redis.set(
          tenantRateLimitCacheKey(tenant.id),
          JSON.stringify({ max: parse.data.max_requests, windowSeconds: parse.data.window_seconds }),
          'EX', TENANT_RATE_LIMIT_CACHE_TTL_SECONDS,
        );
      } catch (err) {
        // Best-effort — the rate-limiter's own Postgres fallback bounds the
        // blast radius of a failed cache write to a re-query, not incorrect
        // enforcement forever.
        console.error('[platform-ops] Failed to write-through rate-limit cache', (err as Error).message);
      }

      res.status(200).json({ rate_limit: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/tenants/:tenantId/rate-limit/reset',
  requireSuperadmin(),
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

      await client.query('DELETE FROM tenant_rate_limits WHERE tenant_id = $1', [tenant.id]);

      await writePlatformAuditLog(client, {
        tenantId: tenant.id, tenantSlug: tenant.slug, tenantName: tenant.name,
        action: 'RATE_LIMIT_CLEAR', performedBy: ctx.userId, performedByEmail: ctx.email,
      });

      await client.query('COMMIT');

      await redis.del(tenantRateLimitCacheKey(tenant.id)).catch((err: Error) => {
        console.error('[platform-ops] Failed to clear rate-limit cache', err.message);
      });

      res.status(200).json({ tenant_id: tenant.id, cleared: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  },
);

export { router as platformOpsRouter };
