import { Request, Response, NextFunction } from 'express';
import { Errors, sendError } from './api-error';
import { getTenantContext } from './tenant-context';

/**
 * Require Superadmin middleware
 * Checks that the resolved tenant context carries a cluster-level superadmin
 * capability. This is intentionally permission-based so the property can be
 * granted by the auth service when issuing tokens (preferred) without
 * hard-coding org ids here.
 */
export function requireSuperadmin() {
  return function superadminMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    let ctx;
    try {
      ctx = getTenantContext(res);
    } catch {
      sendError(res, Errors.internal('requireSuperadmin called before tenantContextMiddleware'));
      return;
    }

    // Expect a dedicated permission 'superadmin:access' to be present
    if (!Array.isArray(ctx.permissions) || !(ctx.permissions as string[]).includes('superadmin:access')) {
      sendError(res, Errors.forbidden('Superadmin access required'));
      return;
    }

    next();
  };
}

export default requireSuperadmin;
