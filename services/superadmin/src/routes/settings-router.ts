import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { getClient } from '@retail/db';
import { redis, publishRealtimeEvent, ALL_TENANTS_ROOM } from '@retail/redis';
import {
  requireSuperadmin,
  requireAnyPermission,
  getTenantContext,
  idempotency,
  Errors,
  sendError,
  MAINTENANCE_MODE_CACHE_KEY,
  MAINTENANCE_MODE_CACHE_TTL_SECONDS,
  PLATFORM_SENTINEL_TENANT_ID,
} from '@retail/middleware';

const router = Router();

// Mounted behind normal tenant auth (see services/superadmin/src/app.ts) —
// gate per-route below rather than router.use(requireSuperadmin()) at the
// top, since reads here are open to any platform role.
const idempotent = idempotency(redis);

/** Any platform operator — support, billing, or full superadmin. */
const anyPlatformRole = requireAnyPermission('platform:support', 'platform:billing', 'superadmin:access');

// ─── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Writes to the platform-wide audit trail (`platform_audit_logs` — see
 * services/superadmin/src/routes/superadmin-router.ts for the full
 * rationale: not the tenant-scoped `audit_logs` table, and tenant_id here is
 * not an FK so it survives a tenant PURGE). Settings/announcement actions are
 * platform-level, not tenant-specific, and use PLATFORM_SENTINEL_TENANT_ID.
 */
async function writePlatformAuditLog(
  client: Awaited<ReturnType<typeof getClient>>,
  params: {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    action:
      | 'SETTINGS_UPDATE'
      | 'ANNOUNCEMENT_CREATE'
      | 'ANNOUNCEMENT_UPDATE'
      | 'ANNOUNCEMENT_DEACTIVATE'
      | 'ANNOUNCEMENT_DELETE'
      | 'SUPPORT_TOKEN_ISSUE'
      | 'SUPPORT_TOKEN_REVOKE';
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

/** Fetches a tenant's slug/name for audit-log snapshotting; null if it does not exist. */
async function fetchTenantSlugName(
  client: Awaited<ReturnType<typeof getClient>>,
  tenantId: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const result = await client.query<{ id: string; slug: string; name: string }>(
    'SELECT id, slug, name FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId],
  );
  return result.rows[0] ?? null;
}

// ─── Platform settings ─────────────────────────────────────────────────────────

router.get('/settings', anyPlatformRole, async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const result = await client.query('SELECT * FROM platform_settings WHERE id = TRUE LIMIT 1');
    res.json({ settings: result.rows[0] ?? null });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

const settingsUpdateSchema = z
  .object({
    default_currency: z.string().trim().length(3, 'default_currency must be exactly 3 characters'),
    default_timezone: z.string().trim().min(1),
    maintenance_mode: z.boolean(),
    maintenance_message: z.string().nullable(),
  })
  .partial();

router.patch(
  '/settings',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = settingsUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const body = parse.data;
    if (Object.keys(body).length === 0) {
      sendError(res, Errors.invalidRequest('No fields to update'));
      return;
    }

    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Dynamic SET list — only touch columns that were actually provided in
      // the body (see ledger-payments/src/routes/ledger-router.ts's
      // PATCH /customers/:id for the same pattern).
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (body.default_currency !== undefined) {
        updates.push(`default_currency = $${paramIndex++}`);
        values.push(body.default_currency);
      }
      if (body.default_timezone !== undefined) {
        updates.push(`default_timezone = $${paramIndex++}`);
        values.push(body.default_timezone);
      }
      if (body.maintenance_mode !== undefined) {
        updates.push(`maintenance_mode = $${paramIndex++}`);
        values.push(body.maintenance_mode);
      }
      if (body.maintenance_message !== undefined) {
        updates.push(`maintenance_message = $${paramIndex++}`);
        values.push(body.maintenance_message);
      }
      updates.push(`updated_by = $${paramIndex++}`);
      values.push(ctx.userId);
      updates.push('updated_at = NOW()');

      const updated = await client.query(
        `UPDATE platform_settings SET ${updates.join(', ')} WHERE id = TRUE RETURNING *`,
        values,
      );

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID,
        tenantSlug: 'platform',
        tenantName: 'PLATFORM',
        action: 'SETTINGS_UPDATE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: body,
      });

      await client.query('COMMIT');

      // Write-through the maintenance-mode cache immediately — this, not TTL
      // expiry, is what makes toggling it take effect cluster-wide right away.
      if (body.maintenance_mode !== undefined) {
        try {
          await redis.set(
            MAINTENANCE_MODE_CACHE_KEY,
            String(body.maintenance_mode),
            'EX',
            MAINTENANCE_MODE_CACHE_TTL_SECONDS,
          );
        } catch (err) {
          // Best-effort — bounded by MAINTENANCE_MODE_CACHE_TTL_SECONDS of
          // staleness on the read side, same rationale as the tenant-status
          // cache write-through in superadmin-router.ts.
          console.error('[settings] Failed to write-through maintenance-mode cache', (err as Error).message);
        }
      }

      res.status(200).json({ settings: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── Announcements ──────────────────────────────────────────────────────────────

router.get('/announcements', anyPlatformRole, async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query(
      'SELECT * FROM platform_announcements ORDER BY created_at DESC LIMIT 100',
    );
    res.json({ announcements: rows.rows });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

const announcementCreateSchema = z.object({
  message: z.string().trim().min(1, 'message is required'),
  level: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
  ends_at: z.string().datetime().optional(),
});

router.post(
  '/announcements',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = announcementCreateSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO platform_announcements (message, level, ends_at, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [parse.data.message, parse.data.level, parse.data.ends_at ?? null, ctx.userId],
      );
      const announcement = inserted.rows[0];

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID,
        tenantSlug: 'platform',
        tenantName: 'PLATFORM',
        action: 'ANNOUNCEMENT_CREATE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: { announcement_id: announcement.id, level: announcement.level },
      });

      await client.query('COMMIT');

      // Pushed to every connected tenant socket (see ALL_TENANTS_ROOM /
      // services/realtime's socket.ts) so the dashboard banner appears
      // instantly instead of waiting for that tab's next poll of
      // GET /announcements/active. Best-effort — publishRealtimeEvent never
      // throws, and any tab that missed it still picks the announcement up
      // on its own next fetch of that same endpoint (see
      // AnnouncementBanner.tsx's periodic refetch).
      void publishRealtimeEvent(ALL_TENANTS_ROOM, 'platform:announcement_created', announcement);

      res.status(201).json({ announcement });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/announcements/:id/deactivate',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const updated = await client.query(
        'UPDATE platform_announcements SET active = FALSE WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Announcement not found'));
        return;
      }

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID,
        tenantSlug: 'platform',
        tenantName: 'PLATFORM',
        action: 'ANNOUNCEMENT_DEACTIVATE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: { announcement_id: req.params.id },
      });

      await client.query('COMMIT');

      void publishRealtimeEvent(ALL_TENANTS_ROOM, 'platform:announcement_deactivated', {
        id: updated.rows[0].id,
      });

      res.status(200).json({ announcement: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

const announcementUpdateSchema = z.object({
  message: z.string().trim().min(1).optional(),
  level: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  ends_at: z.string().datetime().nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field must be provided');

router.patch(
  '/announcements/:id',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = announcementUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Build the SET clause from whatever subset of fields was sent —
      // same pattern as inventory-router.ts's PATCH /products/:id.
      const fields = parse.data;
      const setClauses: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of Object.entries(fields)) {
        params.push(value);
        setClauses.push(`${key} = $${params.length}`);
      }
      params.push(req.params.id);

      const updated = await client.query(
        `UPDATE platform_announcements SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Announcement not found'));
        return;
      }

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID,
        tenantSlug: 'platform',
        tenantName: 'PLATFORM',
        action: 'ANNOUNCEMENT_UPDATE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: { announcement_id: req.params.id, changed: Object.keys(fields) },
      });

      await client.query('COMMIT');

      // Same event a tenant dashboard already listens for when an
      // announcement is created — the banner just re-renders that
      // announcement's row with the new fields, keyed by id.
      void publishRealtimeEvent(ALL_TENANTS_ROOM, 'platform:announcement_updated', updated.rows[0]);

      res.status(200).json({ announcement: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.delete(
  '/announcements/:id',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Hard delete, unlike /deactivate — there's no deleted_at column on
      // this table (it's a small, low-stakes broadcast-banner log, not
      // financial/audit data), and the superadmin action that removed it is
      // itself durably recorded in platform_audit_logs below regardless.
      const deleted = await client.query(
        'DELETE FROM platform_announcements WHERE id = $1 RETURNING id',
        [req.params.id],
      );
      if (deleted.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Announcement not found'));
        return;
      }

      await writePlatformAuditLog(client, {
        tenantId: PLATFORM_SENTINEL_TENANT_ID,
        tenantSlug: 'platform',
        tenantName: 'PLATFORM',
        action: 'ANNOUNCEMENT_DELETE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: { announcement_id: req.params.id },
      });

      await client.query('COMMIT');

      // Deliberately a DIFFERENT event name than /deactivate's
      // 'platform:announcement_deactivated' — same immediate effect on the
      // tenant banner (the announcement disappears), but kept distinct so
      // anything that cares about the difference later (analytics, an
      // activity feed) isn't stuck inferring it from context.
      void publishRealtimeEvent(ALL_TENANTS_ROOM, 'platform:announcement_deleted', {
        id: req.params.id,
      });

      res.status(200).json({ success: true, id: req.params.id });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── Support-impersonation tokens ───────────────────────────────────────────────
// See packages/middleware/src/tenant-context.ts's resolveSupportToken() —
// the raw token must be hashed with the EXACT same
// createHash('sha256').update(rawToken).digest('hex') before storage, or
// validation on the read side will never succeed for any token issued here.

const supportTokenIssueSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required'),
  ttl_minutes: z.number().int().positive().max(240).default(30),
});

router.post(
  '/tenants/:tenantId/support-token',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const parse = supportTokenIssueSchema.safeParse(req.body);
    if (!parse.success) {
      sendError(res, Errors.invalidRequest(parse.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tenant = await fetchTenantSlugName(client, req.params.tenantId);
      if (!tenant) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Tenant not found'));
        return;
      }

      // The raw token is returned exactly once, in this response, and never
      // stored — only its SHA-256 hash is persisted (matching
      // resolveSupportToken's lookup in tenant-context.ts).
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + parse.data.ttl_minutes * 60 * 1000);

      const inserted = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO platform_support_tokens
           (token_hash, tenant_id, issued_by, issued_by_email, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, expires_at`,
        [tokenHash, tenant.id, ctx.userId, ctx.email, parse.data.reason, expiresAt],
      );
      const row = inserted.rows[0];

      await writePlatformAuditLog(client, {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        action: 'SUPPORT_TOKEN_ISSUE',
        reason: parse.data.reason,
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        // Deliberately never the raw token or its hash — only what's needed
        // to explain why this token was issued and when it dies.
        details: { reason: parse.data.reason, expires_at: row.expires_at },
      });

      await client.query('COMMIT');

      res.status(201).json({
        id: row.id,
        token: rawToken,
        expires_at: row.expires_at,
        message: 'Save this now — it cannot be retrieved again.',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

router.get(
  '/tenants/:tenantId/support-tokens',
  anyPlatformRole,
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await getClient();
    try {
      // Explicitly enumerated columns — token_hash is never selected, even
      // though it isn't the raw token, there's no reason to expose it.
      const rows = await client.query(
        `SELECT id, tenant_id, issued_by, issued_by_email, reason,
                issued_at, expires_at, revoked_at, last_used_at
         FROM platform_support_tokens
         WHERE tenant_id = $1
         ORDER BY issued_at DESC`,
        [req.params.tenantId],
      );
      res.json({ support_tokens: rows.rows });
    } catch (err) {
      next(err);
    } finally {
      client.release();
    }
  },
);

router.post(
  '/support-tokens/:id/revoke',
  requireSuperadmin(),
  idempotent,
  async (req: Request, res: Response, next: NextFunction) => {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const updated = await client.query<{ id: string; tenant_id: string }>(
        `UPDATE platform_support_tokens
         SET revoked_at = NOW()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, tenant_id`,
        [req.params.id],
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Support token not found or already revoked'));
        return;
      }
      const row = updated.rows[0];

      const tenant = await fetchTenantSlugName(client, row.tenant_id);

      await writePlatformAuditLog(client, {
        tenantId: row.tenant_id,
        tenantSlug: tenant?.slug ?? 'unknown',
        tenantName: tenant?.name ?? 'unknown',
        action: 'SUPPORT_TOKEN_REVOKE',
        performedBy: ctx.userId,
        performedByEmail: ctx.email,
        details: { support_token_id: row.id },
      });

      await client.query('COMMIT');
      res.status(200).json({ id: row.id, revoked: true });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

export { router as settingsRouter };
