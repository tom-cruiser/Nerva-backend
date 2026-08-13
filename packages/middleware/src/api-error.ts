import { Response } from 'express';
import type { ErrorCode, ApiErrorPayload } from '@retail/types';

/**
 * Structured API error — extend to carry HTTP status + details.
 * Throw this anywhere in route handlers; the global error handler catches it.
 */
export class ApiError extends Error {
  public readonly code:       ErrorCode;
  public readonly statusCode: number;
  public readonly details:    Record<string, unknown>;

  constructor(
    message:    string,
    code:       ErrorCode,
    statusCode: number,
    details:    Record<string, unknown> = {},
  ) {
    super(message);
    this.name       = 'ApiError';
    this.code       = code;
    this.statusCode = statusCode;
    this.details    = details;
    Error.captureStackTrace(this, ApiError);
  }
}

// ─── Convenience factories ────────────────────────────────────────────────────

export const Errors = {
  unauthorized:   (msg = 'Authentication required', d: Record<string, unknown> = {})  => new ApiError(msg, 'UNAUTHORIZED',   401, d),
  forbidden:      (msg = 'Access denied', d: Record<string, unknown> = {})            => new ApiError(msg, 'FORBIDDEN',      403, d),
  notFound:       (msg = 'Resource not found')       => new ApiError(msg, 'NOT_FOUND',      404),
  conflict:       (msg = 'Duplicate request',
                   d: Record<string, unknown> = {})  => new ApiError(msg, 'CONFLICT',       409, d),
  invalidRequest: (msg: string,
                   d: Record<string, unknown> = {})  => new ApiError(msg, 'INVALID_REQUEST', 400, d),
  // Reuses the existing RATE_LIMITED code (see packages/middleware/src/rate-limit.ts,
  // which throws this same code/status directly) rather than adding a new one.
  tooManyRequests: (msg = 'Too many requests',
                    d: Record<string, unknown> = {}) => new ApiError(msg, 'RATE_LIMITED', 429, d),
  serviceUnavailable: (msg = 'Service temporarily unavailable',
                       d: Record<string, unknown> = {}) => new ApiError(msg, 'SERVICE_UNAVAILABLE', 503, d),
  // 423 Locked — the resource exists but is administratively blocked from
  // being acted on right now. Used for tenant-suspension enforcement (see
  // tenant-context.ts) rather than 403 Forbidden, so clients can tell
  // "you're not allowed" apart from "your whole account is suspended".
  locked:         (msg = 'This resource is locked',
                   d: Record<string, unknown> = {})  => new ApiError(msg, 'LOCKED', 423, d),
  // The tenant's plan/feature-flag config does not grant this feature — see
  // resolveFeatureFlag()/requireFeatureFlag() in feature-flags.ts.
  featureDisabled: (msg = 'This feature is not enabled for your plan',
                    d: Record<string, unknown> = {}) => new ApiError(msg, 'FEATURE_NOT_ENABLED', 403, d),
  internal:       (msg = 'Internal server error')    => new ApiError(msg, 'INTERNAL_ERROR', 500),
};

/**
 * Serialise an ApiError into the canonical wire format and send the response.
 */
export function sendError(res: Response, err: ApiError): void {
  const payload: ApiErrorPayload = {
    error:     err.message,
    code:      err.code,
    details:   err.details,
    timestamp: new Date().toISOString(),
    requestId: (res.locals['requestId'] as string | undefined) ?? 'unknown',
  };
  res.status(err.statusCode).json(payload);
}
