import { Request, Response, NextFunction } from 'express';
import type { RefreshTokenRequest, RefreshTokenResponse } from '@retail/types';
import { ROLE_PERMISSIONS }                               from '@retail/types';
import { Errors }                                         from '@retail/middleware';
import { findUserById }                                   from '../lib/user-repository';
import { validateRefreshJti }                             from '../lib/refresh-token-repository';
import { CryptoService }                                  from '../services/crypto-service';

/**
 * POST /api/v1/auth/refresh
 *
 * Security guarantees:
 *   - Refresh token verified with RS256 public key
 *   - JTI validated against DB (revocation check — server-side state)
 *   - User liveness re-checked on every refresh
 *   - Returns new access token only (refresh token is NOT rotated here;
 *     rotation requires a token-family table — add in a future migration)
 */
export async function refreshHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as Partial<RefreshTokenRequest>;

    // Accept from JSON body or HttpOnly cookie
    const rawToken =
      body.refreshToken ??
      (req.cookies as Record<string, string> | undefined)?.['refresh_token'];

    if (!rawToken) {
      return next(Errors.unauthorized('Refresh token is required'));
    }

    // ── Verify RS256 signature and decode claims ────────────────────────────
    let claims: ReturnType<typeof CryptoService.verifyRefreshToken>;
    try {
      claims = CryptoService.verifyRefreshToken(rawToken);
    } catch (err) {
      // CryptoService.verifyRefreshToken already throws ApiError — pass through
      return next(err);
    }

    // ── DB revocation check ────────────────────────────────────────────────
    const storedToken = await validateRefreshJti(claims.jti, claims.tenantId);
    if (!storedToken) {
      // Token was revoked, expired in DB, or never existed — possible token reuse
      return next(Errors.unauthorized('Refresh token is invalid or has been revoked'));
    }

    // ── User liveness ──────────────────────────────────────────────────────
    const user = await findUserById(claims.tenantId, claims.sub);
    if (!user) {
      return next(Errors.unauthorized('User account no longer exists'));
    }
    if (!user.is_active) {
      return next(Errors.forbidden('Account is deactivated'));
    }
    if (user.locked_until && user.locked_until > new Date()) {
      return next(Errors.forbidden('Account is locked. Contact your administrator.'));
    }

    // ── Issue fresh access token only ──────────────────────────────────────
    const permissions = ROLE_PERMISSIONS[user.role];
    const workerTag   = `${user.role}:${user.id.slice(0, 8)}`;

    const accessToken = CryptoService.signAccessToken({
      userId:      user.id,
      tenantId:    user.tenant_id,
      email:       user.email,
      role:        user.role,
      workerTag,
      permissions,
    });

    const decoded = require('jsonwebtoken').decode(accessToken) as
      { exp?: number; iat?: number } | null;
    const expiresIn = decoded?.exp && decoded?.iat
      ? decoded.exp - decoded.iat
      : 3600;

    const response: RefreshTokenResponse = { accessToken, expiresIn };
    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
}
