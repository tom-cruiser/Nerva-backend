import { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { ApiError, sendError } from './api-error';

/**
 * Token-bucket rate limiter backed by Redis.
 *
 * Key schema:  ratelimit:{tenantId|ip}:{windowKey}
 * Default:     100 requests per 60-second sliding window per tenant.
 *
 * Used on public-facing endpoints (login, refresh) where tenant context
 * may not yet exist — falls back to IP address bucketing.
 */

interface RateLimitOptions {
  /** Max requests allowed in the window (default: 100) */
  max?: number;
  /** Window duration in seconds (default: 60) */
  windowSeconds?: number;
  /** Key discriminator function — defaults to tenantId if present, else IP */
  keyFn?: (req: Request, res: Response) => string;
}

export function rateLimit(redisClient: Redis, options: RateLimitOptions = {}) {
  const max           = options.max           ?? 100;
  const windowSeconds = options.windowSeconds ?? 60;

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
    const windowKey     = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey      = `ratelimit:${discriminator}:${windowKey}`;

    const count = await redisClient.incr(redisKey);
    if (count === 1) {
      // Set TTL on first increment — key expires naturally after the window
      await redisClient.expire(redisKey, windowSeconds + 1);
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
