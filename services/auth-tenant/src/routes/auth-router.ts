import { Router }       from 'express';
import { rateLimit, tenantContextMiddleware, requirePermission, idempotency } from '@retail/middleware';
import { redis }        from '@retail/redis';
import { loginHandler }      from '../handlers/login-handler';
import { refreshHandler }    from '../handlers/refresh-handler';
import { logoutHandler, logoutAllHandler } from '../handlers/logout-handler';
import { registerHandler }   from '../handlers/register-handler';
import { listSeatsHandler, createSeatHandler } from '../handlers/seats-handler';

const authRouter = Router();

/**
 * IP-based rate limit for login — 10 attempts per 60 s.
 * Sits above the DB-level 5-failure lockout as a first defence layer.
 */
const loginRateLimit = rateLimit(redis, { max: 10, windowSeconds: 60 });

/**
 * IP-based rate limit for registration — 5 workspaces per 10 min per IP.
 */
const registerRateLimit = rateLimit(redis, { max: 5, windowSeconds: 600 });

/**
 * POST /api/v1/auth/register
 * Creates a tenant + provisions the OWNER (Supabase auth user + users row).
 * No auth. Owner then signs in through Supabase.
 */
authRouter.post('/register', registerRateLimit, registerHandler);

/**
 * POST /api/v1/auth/login
 * Headers: X-Tenant-Id (required)
 * Body:    LoginRequest
 * Returns: LoginResponse (RS256 access + refresh tokens, full user + permissions)
 *
 * NOTE: this route does NOT run the shared `idempotency()` middleware — it
 * requires a resolved TenantContext (from a verified Supabase JWT), which
 * doesn't exist yet at login. login-handler never reads X-Client-Mutation-Id
 * either. That's acceptable here because a retried login is naturally
 * idempotent (it just re-authenticates; it doesn't create duplicate state)
 * — unlike /seats below, which provisions a new row per call and does need
 * the guard.
 */
authRouter.post('/login', loginRateLimit, loginHandler);

/**
 * POST /api/v1/auth/refresh
 * Body: RefreshTokenRequest  -OR-  Cookie: refresh_token
 * Returns: RefreshTokenResponse (new access token)
 */
authRouter.post('/refresh', refreshHandler);

/**
 * POST /api/v1/auth/logout
 * Revokes the provided refresh token JTI in the DB.
 */
authRouter.post('/logout', logoutHandler);

/**
 * POST /api/v1/auth/logout-all
 * Revokes ALL active refresh tokens for the authenticated user.
 */
authRouter.post('/logout-all', logoutAllHandler);

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

export { authRouter };
