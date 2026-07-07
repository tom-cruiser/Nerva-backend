import { Request, Response, NextFunction } from 'express';
import { ApiError, sendError, Errors } from './api-error';

/**
 * Express 4-argument error handler — MUST be registered LAST on every app.
 * Catches all unhandled errors from route handlers and middleware.
 *
 * Maps:
 *   - ApiError instances → their own status code and structured payload
 *   - Everything else   → 500 INTERNAL_ERROR (safe message, no stack leak)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(
  err:  unknown,
  _req: Request,
  res:  Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    sendError(res, err);
    return;
  }

  // Log the raw error server-side; never leak internals to the client
  console.error('[error:unhandled]', err);
  sendError(res, Errors.internal());
}
