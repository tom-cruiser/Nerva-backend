import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError, sendError, Errors } from './api-error';

/**
 * Express 4-argument error handler — MUST be registered LAST on every app.
 * Catches all unhandled errors from route handlers and middleware.
 *
 * Maps:
 *   - ApiError instances → their own status code and structured payload
 *   - ZodError instances → 400 INVALID_REQUEST with the field-level issues
 *     (several routers call `schema.parse(req.body)` directly and let the
 *     thrown ZodError bubble here rather than pre-checking with safeParse —
 *     without this branch those requests surfaced as an opaque 500)
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

  if (err instanceof ZodError) {
    sendError(
      res,
      Errors.invalidRequest('Request validation failed', {
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      }),
    );
    return;
  }

  // Log the raw error server-side; never leak internals to the client
  console.error('[error:unhandled]', err);
  sendError(res, Errors.internal());
}
