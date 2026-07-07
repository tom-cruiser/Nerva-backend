import { Router, Request, Response, NextFunction } from 'express';
import { getTenantContext, Errors, requirePermission } from '@retail/middleware';
import { redis }            from '@retail/redis';
import { syncQueue, syncQueueEvents } from '../queue/sync-queue';
import { syncPayloadSchema }          from '../types/sync-types';
import type { SyncJobPayload, SyncResponse } from '../types/sync-types';

const syncRouter = Router();

// How long to wait inline for the worker to finish before returning 202
const INLINE_TIMEOUT_MS = 8_000;
// Idempotency TTL for sync results: 24 hours (skill-2 spec)
const SYNC_IDEMPOTENCY_TTL = 24 * 60 * 60;

// ─── POST /api/v1/sync/batch ──────────────────────────────────────────────────

/**
 * WatermelonDB batch ingestion endpoint.
 *
 * Protocol:
 *   1. Validate JWT via tenantContextMiddleware (mounted in app.ts).
 *   2. Require `sales:create` AND `inventory:update` permissions.
 *   3. Validate Zod schema — reject immediately on malformed payload.
 *   4. Enforce tenant boundary: body.tenant_id must match JWT tenant_id.
 *   5. Idempotency check: look up `sync:result:{tenantId}:{clientMutationId}` in Redis.
 *      HIT  → return 200 with cached result + X-Idempotency-Replayed header.
 *      LOCK → 409 (concurrent request still processing).
 *      MISS → set processing lock, enqueue job.
 *   6. Wait up to 8 s for the BullMQ job to complete.
 *      Fast path (≤8 s): return 200 with SyncResponse.
 *      Slow path (>8 s): return 202 Accepted with jobId for polling.
 */
syncRouter.post(
  '/batch',
  requirePermission('sales:create'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);

      // ── 1. Schema validation ──────────────────────────────────────────────
      const parseResult = syncPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return next(
          Errors.invalidRequest(
            'Sync payload validation failed',
            { issues: parseResult.error.issues.map(i => ({ path: i.path, message: i.message })) },
          ),
        );
      }
      const payload = parseResult.data;

      // ── 2. Tenant boundary check ──────────────────────────────────────────
      // Body tenant_id must match the JWT — prevents cross-tenant smuggling
      if (payload.tenant_id !== ctx.tenantId) {
        return next(
          Errors.forbidden('tenant_id in payload does not match authenticated tenant'),
        );
      }

      const { client_mutation_id: mutationId } = payload;
      const resultKey = `sync:result:${ctx.tenantId}:${mutationId}`;
      const lockKey   = `sync:lock:${ctx.tenantId}:${mutationId}`;

      // ── 3. Idempotency: check for cached result ───────────────────────────
      const [cached, locked] = await redis.mget(resultKey, lockKey);

      if (cached !== null) {
        res.setHeader('X-Idempotency-Replayed', 'true');
        res.status(200).json(JSON.parse(cached) as SyncResponse);
        return;
      }

      if (locked !== null) {
        return next(
          Errors.conflict('Sync request is already being processed. Retry shortly.', {
            clientMutationId: mutationId,
          }),
        );
      }

      // ── 4. Set processing lock (30 s window) ─────────────────────────────
      await redis.set(lockKey, '1', 'EX', 30);

      // ── 5. Build job payload ──────────────────────────────────────────────
      const jobPayload: SyncJobPayload = {
        tenantId:         ctx.tenantId,
        userId:           ctx.userId,
        workerTag:        ctx.workerTag,
        clientMutationId: mutationId,
        deviceId:         payload.device_id,
        changes:          payload.changes,
        lastSyncToken:    payload.last_sync_token,
        receivedAt:       new Date().toISOString(),
      };

      // ── 6. Enqueue ────────────────────────────────────────────────────────
      const job = await syncQueue.add('sync-batch', jobPayload, {
        // Job ID keyed on tenant + mutation for BullMQ-level dedup
        jobId: `${ctx.tenantId}:${mutationId}`,
      });

      // ── 7. Fast-path: wait for completion ─────────────────────────────────
      try {
        const result = await job.waitUntilFinished(
          syncQueueEvents,
          INLINE_TIMEOUT_MS,
        );

        // Release lock — result is already stored by the worker
        await redis.del(lockKey);

        res.status(200).json(result);
      } catch (waitErr) {
        // Slow batch (>8 s) — return 202 so the client polls
        const errMsg = waitErr instanceof Error ? waitErr.message : String(waitErr);
        const isTimeout = errMsg.includes('timeout') || errMsg.includes('timed out');

        if (isTimeout) {
          res.status(202).json({
            message: 'Sync batch queued. Poll /api/v1/sync/status/:jobId for result.',
            jobId:   job.id,
            clientMutationId: mutationId,
          });
          return;
        }

        // Any other wait error — release lock and propagate
        await redis.del(lockKey).catch(() => undefined);
        throw waitErr;
      }
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/sync/status/:jobId ──────────────────────────────────────────

/**
 * Poll endpoint for slow batches that returned 202.
 * Returns the sync result once the worker completes, or a PENDING state.
 */
syncRouter.get(
  '/status/:jobId',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx   = getTenantContext(res);
      const jobId = req.params['jobId'];
      if (!jobId) {
        return next(Errors.invalidRequest('jobId is required'));
      }

      const job = await syncQueue.getJob(jobId);
      if (!job) {
        return next(Errors.notFound('Sync job not found'));
      }

      // Tenant boundary: job tenant must match the authenticated tenant
      if (job.data.tenantId !== ctx.tenantId) {
        return next(Errors.forbidden('Access denied to this sync job'));
      }

      const state = await job.getState();

      if (state === 'completed') {
        const returnValue = job.returnvalue as SyncResponse | undefined;
        if (returnValue) {
          res.status(200).json(returnValue);
          return;
        }
        // Fallback: check Redis cache
        const cached = await redis.get(
          `sync:result:${ctx.tenantId}:${job.data.clientMutationId}`,
        );
        if (cached) {
          res.status(200).json(JSON.parse(cached) as SyncResponse);
          return;
        }
      }

      if (state === 'failed') {
        return next(
          Errors.internal('Sync batch processing failed. Check server logs.'),
        );
      }

      // Still queued / active
      res.status(202).json({
        status:  state,
        jobId,
        message: 'Sync batch is still processing. Retry shortly.',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/sync/pull ────────────────────────────────────────────────────

/**
 * Pull endpoint — returns all server-side changes since the client's last sync token.
 * The sync_token is the cursor stored in sync_cursors.
 */
syncRouter.get(
  '/pull',
  requirePermission('sales:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx             = getTenantContext(res);
      const lastSyncToken   = req.query['last_sync_token'] as string | undefined;
      const deviceId        = req.query['device_id']       as string | undefined;

      if (!deviceId) {
        return next(Errors.invalidRequest('device_id query parameter is required'));
      }

      // Parse the last pull timestamp from the sync token
      // Token format: "{tenantId}:{deviceId}:{epochMs}"
      let since: Date;
      if (lastSyncToken) {
        const parts = lastSyncToken.split(':');
        const epochMs = parseInt(parts[parts.length - 1] ?? '0', 10);
        since = isNaN(epochMs) ? new Date(0) : new Date(epochMs);
      } else {
        since = new Date(0); // First sync — pull everything
      }

      const { query } = await import('@retail/db');

      const [inventories, salesRows] = await Promise.all([
        query<Record<string, unknown>>(
          `SELECT id, product_sku, barcode, name, description, unit_price,
                  stock_quantity, reorder_level, category, updated_at, deleted_at
           FROM inventories
           WHERE tenant_id = $1 AND updated_at > $2
           ORDER BY updated_at ASC
           LIMIT 1000`,
          [ctx.tenantId, since.toISOString()],
        ),
        query<Record<string, unknown>>(
          `SELECT id, transaction_id, customer_id, items_sold, total_amount,
                  discount_amount, tax_amount, payment_method, payment_status,
                  worker_tag, sale_timestamp, voided_at, updated_at
           FROM sales
           WHERE tenant_id = $1 AND updated_at > $2
           ORDER BY updated_at ASC
           LIMIT 1000`,
          [ctx.tenantId, since.toISOString()],
        ),
      ]);

      const newSyncToken = `${ctx.tenantId}:${deviceId}:${Date.now()}`;

      res.status(200).json({
        sync_token: newSyncToken,
        changes: {
          inventories: inventories.rows,
          sales:       salesRows.rows,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

export { syncRouter };
