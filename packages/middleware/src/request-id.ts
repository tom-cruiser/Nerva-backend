import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Stamps every inbound request with a UUIDv4 request ID.
 * Must be the FIRST middleware registered on every service app.
 *
 * The ID is:
 *   - Written to `res.locals['requestId']` for downstream access
 *   - Echoed in the `X-Request-Id` response header for client correlation
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
