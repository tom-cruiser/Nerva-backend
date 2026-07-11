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
