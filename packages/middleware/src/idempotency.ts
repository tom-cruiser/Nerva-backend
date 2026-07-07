import { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { Errors, sendError } from './api-error';
import { getTenantContext } from './tenant-context';

/**
 * Idempotency Middleware  (skill-2: idempotency.md §1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces zero-duplicate-state on every mutating endpoint (POST / PUT / PATCH).
 *
 * Key schema:  idempotency:{tenantId}:{clientMutationId}
 * TTL:         7 days (604_800 seconds)
 *
 * Flow:
 *   1. Require `X-Client-Mutation-Id` header on the request.
 *   2. Check Redis for the composite key.
 *      HIT  → return the cached response body (409 Conflict with prior result).
 *      MISS → set a processing lock (NX flag), continue to route handler.
 *   3. After the route handler resolves, the response interceptor stores the
 *      final JSON body in Redis against the same key.
 *
 * Usage — mount AFTER tenantContextMiddleware on any mutating router:
 *   router.post('/endpoint', tenantContextMiddleware, idempotency(redis), handler)
 */

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const LOCK_VALUE = '__PROCESSING__';

export function idempotency(redisClient: Redis) {
  return async function idempotencyMiddleware(
    req:  Request,
    res:  Response,
    next: NextFunction,
  ): Promise<void> {
    // Only apply to mutating methods
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      next();
      return;
    }

    const mutationId = req.headers['x-client-mutation-id'] as string | undefined;
    if (!mutationId || mutationId.trim() === '') {
      sendError(res, Errors.invalidRequest('X-Client-Mutation-Id header is required for mutating requests'));
      return;
    }

    let ctx: ReturnType<typeof getTenantContext>;
    try {
      ctx = getTenantContext(res);
    } catch {
      // tenantContextMiddleware must run first
      sendError(res, Errors.internal('Idempotency middleware called before tenant context was resolved'));
      return;
    }

    const key = `idempotency:${ctx.tenantId}:${mutationId}`;

    // ── Check for existing result ─────────────────────────────────────────────
    const existing = await redisClient.get(key);

    if (existing !== null && existing !== LOCK_VALUE) {
      // Replay the previously stored response
      res.setHeader('X-Idempotency-Replayed', 'true');
      res.status(200).json(JSON.parse(existing) as unknown);
      return;
    }

    if (existing === LOCK_VALUE) {
      // Another in-flight request is already processing this mutation
      sendError(
        res,
        Errors.conflict('This mutation is currently being processed. Retry in a moment.', {
          clientMutationId: mutationId,
        }),
      );
      return;
    }

    // ── Set processing lock (NX = only if key does not exist) ────────────────
    await redisClient.set(key, LOCK_VALUE, 'EX', 30); // 30 s processing window

    // ── Intercept the response to store the final result ─────────────────────
    const originalJson = res.json.bind(res);
    res.json = function interceptedJson(body: unknown): Response {
      // Only cache successful responses (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Fire-and-forget — do not await here to avoid delaying the response
        redisClient
          .set(key, JSON.stringify(body), 'EX', IDEMPOTENCY_TTL_SECONDS)
          .catch((err: Error) =>
            console.error('[idempotency] Failed to persist result to Redis', err.message),
          );
      } else {
        // Release the processing lock on non-2xx so the client can retry
        redisClient.del(key).catch((err: Error) =>
          console.error('[idempotency] Failed to release lock', err.message),
        );
      }
      return originalJson(body);
    };

    next();
  };
}
