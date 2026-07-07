import { Router, Request, Response, NextFunction } from 'express';
import { getClient } from '@retail/db';
import { Errors, sendError } from '@retail/middleware';
import { getTenantContext } from '@retail/middleware';
import type { TenantContext } from '@retail/types';
import { z } from 'zod';

const router = Router();

// Feature map per subscription tier
const FEATURE_MAP: Record<string, string[]> = {
  starter: [],
  premium: ['markdowns', 'batch_expiry'],
  business: ['markdowns', 'batch_expiry', 'credit_ledger'],
  business_premium: ['markdowns', 'batch_expiry', 'credit_ledger', 'expiry_notifications'],
};

/**
 * Tier gating middleware.
 * Looks up the organization's subscription_tier and rejects requests for features
 * that are not included in their tier.
 */
export function tierGate(feature: string) {
  return async function tierGateMiddleware(req: Request, res: Response, next: NextFunction) {
    let ctx: TenantContext;
    try {
      ctx = getTenantContext(res) as TenantContext;
    } catch (err) {
      sendError(res, Errors.internal('Tenant context required for tier gating'));
      return;
    }

    const client = await getClient();
    try {
      const q = await client.query<{ subscription_tier: string }>(
        `SELECT subscription_tier FROM organizations WHERE id = $1 LIMIT 1`,
        [ctx.tenantId],
      );
      const tier = q.rows[0]?.subscription_tier ?? 'starter';
      const allowed = FEATURE_MAP[tier] ?? [];
      if (!allowed.includes(feature)) {
        sendError(res, Errors.forbidden(`Feature "${feature}" is not available in tier: ${tier}`));
        return;
      }
      next();
    } catch (err) {
      sendError(res, Errors.internal());
    } finally {
      client.release();
    }
  };
}

/**
 * Path-based routing coordinator.
 * Mounts child routers by prefix and ensures tenant context is present.
 */
export function createGatewayRouter(routes: { prefix: string; router: Router }[]) {
  const r = Router();

  // mount child routers
  for (const entry of routes) {
    r.use(entry.prefix, entry.router);
  }

  // fallback
  r.use((_req, res) => {
    sendError(res, Errors.notFound('No route matched'));
  });

  return r;
}

export default router;
