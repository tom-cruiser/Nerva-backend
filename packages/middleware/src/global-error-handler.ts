import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { getClient } from '@retail/db';
import { ApiError, sendError, Errors } from './api-error';

/**
 * Fire-and-forget insert into `platform_error_logs` for the superadmin
 * "Log Stream" / recent-errors feed (services/superadmin's
 * platform-ops-router.ts reads this table). Never awaited by the caller —
 * a logging failure (or the table not existing yet on an un-migrated DB)
 * must never delay or break the actual error response going back to the
 * client.
 */
function logPlatformError(
  service:    string,
  res:        Response,
  statusCode: number,
  errorCode:  string,
  message:    string,
  req:        Request,
): void {
  // Only 5xx is "system health" material — 4xx (validation, auth, not-found)
  // is normal traffic, not an incident, and would drown the feed.
  if (statusCode < 500) return;

  void (async () => {
    try {
      const tenantId = (res.locals['tenant'] as { tenantId?: string } | undefined)?.tenantId ?? null;
      const requestId = (res.locals['requestId'] as string | undefined) ?? null;
      const client = await getClient();
      try {
        await client.query(
          `INSERT INTO platform_error_logs
             (service, tenant_id, status_code, error_code, message, path, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [service, tenantId, statusCode, errorCode, message.slice(0, 2000), req.originalUrl?.slice(0, 500) ?? null, requestId],
        );
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[global-error-handler] Failed to persist platform_error_logs row', (err as Error).message);
    }
  })();
}

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
 *
 * @param service short service name (e.g. 'auth-tenant') recorded on every
 *   5xx row written to `platform_error_logs` — pass it explicitly rather
 *   than inferring it, so the log is never wrong about which service an
 *   error came from: `app.use(globalErrorHandler('auth-tenant'))`.
 */
export function globalErrorHandler(service: string) {
  return function globalErrorHandlerMiddleware(
    err:  unknown,
    req:  Request,
    res:  Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: NextFunction,
  ): void {
    if (err instanceof ApiError) {
      logPlatformError(service, res, err.statusCode, err.code, err.message, req);
      sendError(res, err);
      return;
    }

    if (err instanceof ZodError) {
      // Always 400 — never reaches the 5xx threshold, nothing to log.
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
    const internal = Errors.internal();
    logPlatformError(
      service, res, internal.statusCode, internal.code,
      err instanceof Error ? err.message : String(err), req,
    );
    sendError(res, internal);
  };
}
