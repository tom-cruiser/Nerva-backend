import { Router }       from 'express';
import { rateLimit }    from '@retail/middleware';
import { redis }        from '@retail/redis';
import { loginHandler }      from '../handlers/login-handler';
import { refreshHandler }    from '../handlers/refresh-handler';
import { logoutHandler, logoutAllHandler } from '../handlers/logout-handler';

const authRouter = Router();

/**
 * IP-based rate limit for login — 10 attempts per 60 s.
 * Sits above the DB-level 5-failure lockout as a first defence layer.
 */
const loginRateLimit = rateLimit(redis, { max: 10, windowSeconds: 60 });

/**
 * POST /api/v1/auth/login
 * Headers: X-Tenant-Id (required), X-Client-Mutation-Id (required for idempotency)
 * Body:    LoginRequest
 * Returns: LoginResponse (RS256 access + refresh tokens, full user + permissions)
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

export { authRouter };
