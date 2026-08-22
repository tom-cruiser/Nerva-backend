import { Router }       from 'express';
import { rateLimit, tenantContextMiddleware, requirePermission, idempotency } from '@retail/middleware';
import { redis }        from '@retail/redis';
import { registerHandler }   from '../handlers/register-handler';
import {
  listSeatsHandler,
  createSeatHandler,
  updateSeatHandler,
  deactivateSeatHandler,
  resetSeatPasswordHandler,
} from '../handlers/seats-handler';
import {
  getSubscriptionHandler,
  requestSubscriptionUpgradeHandler,
} from '../handlers/subscription-handler';
import {
  listSupportMessagesHandler,
  sendSupportMessageHandler,
} from '../handlers/support-handler';

const authRouter = Router();

/**
 * IP-based rate limit for registration — 5 workspaces per 10 min per IP.
 */
const registerRateLimit = rateLimit(redis, { max: 5, windowSeconds: 600 });

/**
 * POST /api/v1/auth/register
 * Creates a tenant + provisions the OWNER (Supabase auth user + users row).
 * No auth. Owner then signs in through Supabase.
 *
 * NOTE: this service used to also expose /login, /refresh, /logout, and
 * /logout-all backed by a custom RS256 signer (crypto-service.ts). That path
 * minted tokens with a different issuer/audience than the Supabase-JWKS
 * tokens every other service (and tenant-context.ts) actually verifies — a
 * token from that /login could never be used anywhere else in the cluster.
 * The real, working auth path has always been the frontend calling Supabase's
 * signInWithPassword() directly (see app/context/AuthContext.tsx). Those four
 * dead routes/handlers (and crypto-service.ts, token-service.ts, and
 * refresh-token-repository.ts, which existed only to support them) have been
 * removed. Session revocation on tenant suspension is unaffected — it never
 * depended on this: see tenant-context.ts's per-request status gate and
 * services/superadmin's Supabase-ban-based kill-sessions.
 */
authRouter.post('/register', registerRateLimit, registerHandler);

/**
 * GET  /api/v1/auth/seats
 * List all provisioned seats for the authenticated tenant.
 * Requires: users:read (OWNER / MANAGER)
 *
 * POST /api/v1/auth/seats
 * Provision a new MANAGER or STAFF seat within the tenant.
 * Requires: users:create (OWNER only)
 * Headers: X-Client-Mutation-Id (required) — a retried request with the same
 * id replays the original result instead of provisioning a second seat.
 */
authRouter.get(
  '/seats',
  tenantContextMiddleware,
  requirePermission('users:read'),
  listSeatsHandler,
);

authRouter.post(
  '/seats',
  tenantContextMiddleware,
  requirePermission('users:create'),
  idempotency(redis),
  createSeatHandler,
);

/**
 * PATCH /api/v1/auth/seats/:id — update a worker's role and/or active status.
 * Requires: users:update (OWNER only)
 *
 * DELETE /api/v1/auth/seats/:id — deactivate ("block") a worker seat.
 * Requires: users:delete (OWNER only)
 *
 * POST /api/v1/auth/seats/:id/reset-password — reset a worker's password.
 * Requires: users:update (OWNER only)
 *
 * All three are tenant-scoped (see seats-handler.ts's findTenantSeat) and
 * reject targeting the tenant's own OWNER — these manage subordinate
 * MANAGER/STAFF seats only, the same set createSeatHandler can provision.
 */
authRouter.patch(
  '/seats/:id',
  tenantContextMiddleware,
  requirePermission('users:update'),
  idempotency(redis),
  updateSeatHandler,
);

authRouter.delete(
  '/seats/:id',
  tenantContextMiddleware,
  requirePermission('users:delete'),
  deactivateSeatHandler,
);

authRouter.post(
  '/seats/:id/reset-password',
  tenantContextMiddleware,
  requirePermission('users:update'),
  idempotency(redis),
  resetSeatPasswordHandler,
);

/**
 * GET  /api/v1/auth/subscription — current plan/limits/trial days remaining
 *   for the authenticated tenant, plus its latest pending upgrade request.
 * POST /api/v1/auth/subscription/request — queue a plan/billing-cycle
 *   upgrade request for Super Admin review.
 * Both OWNER-only (checked inline in subscription-handler.ts — billing has
 * no dedicated permission type, same territory as seats management).
 */
authRouter.get(
  '/subscription',
  tenantContextMiddleware,
  getSubscriptionHandler,
);

authRouter.post(
  '/subscription/request',
  tenantContextMiddleware,
  idempotency(redis),
  requestSubscriptionUpgradeHandler,
);

/**
 * GET  /api/v1/auth/support/messages — full thread history with the Super
 *   Admin support team, oldest first. Marks the Super Admin's replies read.
 * POST /api/v1/auth/support/messages — send a message to the Super Admin
 *   team. Deliberately requires no Permission — every role, including
 *   STAFF, can reach support (see support-handler.ts).
 */
authRouter.get(
  '/support/messages',
  tenantContextMiddleware,
  listSupportMessagesHandler,
);

authRouter.post(
  '/support/messages',
  tenantContextMiddleware,
  idempotency(redis),
  sendSupportMessageHandler,
);

export { authRouter };
