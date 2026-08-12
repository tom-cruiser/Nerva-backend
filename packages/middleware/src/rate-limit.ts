import { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { getClient } from '@retail/db';
import { ApiError, sendError } from './api-error';

/**
 * Token-bucket rate limiter backed by Redis.
 *
 * Key schema:  ratelimit:{tenantId|ip}:{windowKey}
 * Default:     100 requests per 60-second sliding window per tenant.
 *
 * Used on public-facing endpoints (login, refresh) where tenant context
 * may not yet exist — falls back to IP address bucketing.
 *
 * A superadmin can additionally set a PER-TENANT override (see
 * services/superadmin/src/routes/platform-ops-router.ts, `tenant_rate_limits`
 * table) — e.g. to tighten a tenant suspected of abusive scraping, or loosen
 * one for a legitimately high-volume customer. The override, when present,
 * replaces this middleware's static `max`/`windowSeconds` for that tenant's
 * requests only; requests with no tenant context (pre-auth routes) are
 * unaffected since there's nothing to look an override up by.
 */

interface RateLimitOptions {
  /** Max requests allowed in the window (default: 100) */
  max?: number;
  /** Window duration in seconds (default: 60) */
  windowSeconds?: number;
  /** Key discriminator function — defaults to tenantId if present, else IP */
  keyFn?: (req: Request, res: Response) => string;
}

/** Redis key for a tenant's rate-limit override. Exported so the superadmin
 *  service's write-through `redis.set(...)` on change uses this exact key. */
export function tenantRateLimitCacheKey(tenantId: string): string {
  return `tenant:ratelimit:${tenantId}`;
}
/** Safety-net TTL only, same rationale as tenant-context.ts's status cache. */
export const TENANT_RATE_LIMIT_CACHE_TTL_SECONDS = 60;
/** Sentinel cached value meaning "no override — use the route's default". */
const NO_OVERRIDE_SENTINEL = 'none';

interface RateLimitOverride {
  max: number;
  windowSeconds: number;
}

function isRateLimitOverride(value: unknown): value is RateLimitOverride {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as RateLimitOverride).max === 'number' &&
    typeof (value as RateLimitOverride).windowSeconds === 'number'
  );
}

async function resolveTenantRateLimitOverride(
  redisClient: Redis,
  tenantId:    string,
): Promise<RateLimitOverride | null> {
  const cacheKey = tenantRateLimitCacheKey(tenantId);

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached === NO_OVERRIDE_SENTINEL) return null;
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      if (isRateLimitOverride(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[rate-limit] Redis unavailable for tenant override lookup, falling back to Postgres', (err as Error).message);
  }

  try {
    const client = await getClient();
    try {
      const result = await client.query<{ max_requests: number; window_seconds: number }>(
        'SELECT max_requests, window_seconds FROM tenant_rate_limits WHERE tenant_id = $1 LIMIT 1',
        [tenantId],
      );
      const row = result.rows[0];
      const override: RateLimitOverride | null = row
        ? { max: row.max_requests, windowSeconds: row.window_seconds }
        : null;
      redisClient
        .set(cacheKey, override ? JSON.stringify(override) : NO_OVERRIDE_SENTINEL, 'EX', TENANT_RATE_LIMIT_CACHE_TTL_SECONDS)
        .catch(() => {});
      return override;
    } finally {
      client.release();
    }
  } catch (err) {
    // Fail toward the route's own static default — a Postgres outage here
    // should never turn into "everyone rate-limited" or "no one rate-limited".
    console.error('[rate-limit] Postgres unavailable for tenant override lookup — using route default', (err as Error).message);
    return null;
  }
}

export function rateLimit(redisClient: Redis, options: RateLimitOptions = {}) {
  const defaultMax           = options.max           ?? 100;
  const defaultWindowSeconds = options.windowSeconds ?? 60;

  const defaultKeyFn = (req: Request, res: Response): string => {
    const tenantId = (res.locals['tenant'] as { tenantId?: string } | undefined)?.tenantId;
    if (tenantId) return `tenant:${tenantId}`;
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    return `ip:${ip}`;
  };

  const keyFn = options.keyFn ?? defaultKeyFn;

  return async function rateLimitMiddleware(
    req:  Request,
    res:  Response,
    next: NextFunction,
  ): Promise<void> {
    const discriminator = keyFn(req, res);

    let max           = defaultMax;
    let windowSeconds  = defaultWindowSeconds;

    const tenantId = (res.locals['tenant'] as { tenantId?: string } | undefined)?.tenantId;
    if (tenantId) {
      const override = await resolveTenantRateLimitOverride(redisClient, tenantId);
      if (override) {
        max           = override.max;
        windowSeconds = override.windowSeconds;
      }
    }

    const windowKey = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey  = `ratelimit:${discriminator}:${windowKey}`;

    let count: number;
    try {
      count = await redisClient.incr(redisKey);
      if (count === 1) {
        // Set TTL on first increment — key expires naturally after the window
        await redisClient.expire(redisKey, windowSeconds + 1);
      }
    } catch (err) {
      // Fail OPEN: a rate limiter must never take down the endpoint it guards.
      // If Redis is unreachable, allow the request rather than hanging/erroring.
      console.error('[rate-limit] Redis unavailable — allowing request', (err as Error).message);
      next();
      return;
    }

    res.setHeader('X-RateLimit-Limit',     max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

    if (count > max) {
      sendError(res, new ApiError('Rate limit exceeded', 'RATE_LIMITED', 429));
      return;
    }

    next();
  };
}
