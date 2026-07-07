import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import type { LoginRequest, LoginResponse } from '@retail/types';
import { ROLE_PERMISSIONS }                 from '@retail/types';
import { Errors }                           from '@retail/middleware';
import {
  findUserByEmail,
  findTenantById,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../lib/user-repository';
import { CryptoService }        from '../services/crypto-service';
import { storeRefreshToken }    from '../lib/refresh-token-repository';
import { env }                  from '@retail/config';

/**
 * Parse JWT_EXPIRY / REFRESH_TOKEN_EXPIRES_IN strings into seconds for DB TTL.
 */
function expiryToSeconds(value: string): number {
  const match = value.match(/^(\d+)([smhd]?)$/u);
  if (!match) return 3600;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case 'd': return n * 86_400;
    case 'h': return n * 3_600;
    case 'm': return n * 60;
    default:  return n;
  }
}

const REFRESH_TTL_SEC = expiryToSeconds(env.REFRESH_TOKEN_EXPIRES_IN);

/**
 * POST /api/v1/auth/login
 *
 * Security guarantees:
 *   - Tenant resolved from X-Tenant-Id header (no JWT spoofing possible at this stage)
 *   - Generic 401 for all credential failures (no oracle: tenant missing = same error)
 *   - Timing-safe password comparison (PBKDF2 via CryptoService, bcrypt via library)
 *   - 5th consecutive failure → 30-minute lockout persisted in DB + audit log
 *   - Refresh token JTI stored in DB for server-side revocation
 *   - Access token signed with RS256 private key; contains permissions array
 */
export async function loginHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    if (!tenantId) {
      return next(Errors.invalidRequest('X-Tenant-Id header is required'));
    }

    const body = req.body as Partial<LoginRequest>;
    if (!body.email || typeof body.email !== 'string') {
      return next(Errors.invalidRequest('email is required'));
    }
    if (!body.password || typeof body.password !== 'string') {
      return next(Errors.invalidRequest('password is required'));
    }

    // ── Confirm tenant is active ───────────────────────────────────────────────
    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      // Same error as wrong credentials — never reveal whether the tenant exists
      return next(Errors.unauthorized('Invalid credentials'));
    }

    // ── Find user — always tenant-scoped ──────────────────────────────────────
    const user = await findUserByEmail(tenantId, body.email);
    if (!user) {
      return next(Errors.unauthorized('Invalid credentials'));
    }

    // ── Account active check ───────────────────────────────────────────────────
    if (!user.is_active) {
      return next(Errors.forbidden('Account is deactivated. Contact your administrator.'));
    }

    // ── Lockout check ─────────────────────────────────────────────────────────
    if (user.locked_until && user.locked_until > new Date()) {
      const unlockAt  = user.locked_until.toISOString();
      const remaining = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
      return next(
        Errors.forbidden(
          `Account locked for ${remaining} more minute(s) due to failed login attempts.`,
          { lockedUntil: unlockAt },
        ),
      );
    }

    // ── Password verification — supports both PBKDF2 and legacy bcrypt ────────
    let passwordMatch: boolean;
    if (user.hashed_password.startsWith('pbkdf2:')) {
      passwordMatch = CryptoService.verifyPassword(body.password, user.hashed_password);
    } else {
      // Legacy bcrypt hash — compare with timing-safe library function
      passwordMatch = await bcrypt.compare(body.password, user.hashed_password);
    }

    if (!passwordMatch) {
      await recordFailedLogin(tenantId, user.id);
      // Check if we just tripped the lockout threshold
      const freshAttempts = user.failed_login_attempts + 1;
      if (freshAttempts >= 5) {
        return next(
          Errors.forbidden(
            'Account locked for 30 minutes due to too many failed login attempts.',
            { attemptsRemaining: 0 },
          ),
        );
      }
      return next(
        Errors.unauthorized('Invalid credentials', {
          attemptsRemaining: 5 - freshAttempts,
        }),
      );
    }

    // ── Success path ──────────────────────────────────────────────────────────
    await recordSuccessfulLogin(tenantId, user.id);

    const permissions = ROLE_PERMISSIONS[user.role];
    const workerTag   = `${user.role}:${user.id.slice(0, 8)}`;

    const { accessToken, refreshToken, expiresIn, tokenType, refreshJti } =
      CryptoService.issueTokenPair({
        userId:      user.id,
        tenantId:    user.tenant_id,
        email:       user.email,
        role:        user.role,
        workerTag,
        permissions,
      });

    // Persist refresh JTI for server-side revocation
    await storeRefreshToken(refreshJti, user.id, tenantId, REFRESH_TTL_SEC);

    const response: LoginResponse = {
      accessToken,
      refreshToken,
      expiresIn,
      tokenType,
      user: {
        id:          user.id,
        tenantId:    user.tenant_id,
        email:       user.email,
        role:        user.role,
        workerTag,
        permissions: permissions as string[],
      },
    };

    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
}
