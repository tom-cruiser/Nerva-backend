import { Request, Response, NextFunction } from 'express';
import { Errors }                          from '@retail/middleware';
import { CryptoService }                   from '../services/crypto-service';
import {
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
} from '../lib/refresh-token-repository';

/**
 * POST /api/v1/auth/logout
 *
 * Revokes the provided refresh token in the database.
 * The short-lived access token continues to work until it expires naturally
 * (15m window is acceptable; add a Redis deny-list if you need instant revocation).
 *
 * POST /api/v1/auth/logout-all
 * Revokes ALL active refresh tokens for the authenticated user (force-logout all devices).
 */

export async function logoutHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as { refreshToken?: string };
    const rawToken =
      body.refreshToken ??
      (req.cookies as Record<string, string> | undefined)?.['refresh_token'];

    if (!rawToken) {
      return next(Errors.invalidRequest('refreshToken is required'));
    }

    let claims: ReturnType<typeof CryptoService.verifyRefreshToken>;
    try {
      claims = CryptoService.verifyRefreshToken(rawToken);
    } catch {
      // Even if the token is expired, attempt revocation by returning success
      // — prevents leaking whether the token was valid
      res.status(200).json({ message: 'Logged out successfully' });
      return;
    }

    await revokeRefreshToken(claims.jti, claims.tenantId);

    res.clearCookie('refresh_token', { httpOnly: true, sameSite: 'strict', secure: true });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function logoutAllHandler(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as { refreshToken?: string };
    const rawToken =
      body.refreshToken ??
      (req.cookies as Record<string, string> | undefined)?.['refresh_token'];

    if (!rawToken) {
      return next(Errors.invalidRequest('refreshToken is required'));
    }

    let claims: ReturnType<typeof CryptoService.verifyRefreshToken>;
    try {
      claims = CryptoService.verifyRefreshToken(rawToken);
    } catch (err) {
      return next(err);
    }

    await revokeAllUserRefreshTokens(claims.sub, claims.tenantId);

    res.clearCookie('refresh_token', { httpOnly: true, sameSite: 'strict', secure: true });
    res.status(200).json({ message: 'All sessions revoked' });
  } catch (err) {
    next(err);
  }
}
