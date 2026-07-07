import { Request, Response, NextFunction } from 'express';
import type { Permission }                from '@retail/types';
import { Errors, sendError }              from './api-error';
import { getTenantContext }               from './tenant-context';

/**
 * RBAC Permission Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Gate a route behind one or more required permissions.
 * MUST be mounted AFTER tenantContextMiddleware.
 *
 * Usage:
 *   router.post(
 *     '/products',
 *     tenantContextMiddleware,
 *     requirePermission('inventory:create'),
 *     createProductHandler,
 *   );
 *
 *   // Require ALL of multiple permissions:
 *   requirePermission('inventory:update', 'inventory:read')
 *
 * The check is additive (AND): all listed permissions must be present.
 * For OR semantics, mount two separate routes or use requireAnyPermission.
 */
export function requirePermission(...required: Permission[]) {
  return function permissionMiddleware(
    _req: Request,
    res:  Response,
    next: NextFunction,
  ): void {
    let ctx: ReturnType<typeof getTenantContext>;
    try {
      ctx = getTenantContext(res);
    } catch {
      sendError(res, Errors.internal('requirePermission called before tenantContextMiddleware'));
      return;
    }

    const missing = required.filter((p) => !ctx.permissions.includes(p));
    if (missing.length > 0) {
      sendError(
        res,
        Errors.forbidden(
          `Insufficient permissions. Required: ${missing.join(', ')}`,
          { requiredPermissions: missing, userRole: ctx.role },
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Require AT LEAST ONE of the listed permissions (OR semantics).
 */
export function requireAnyPermission(...allowed: Permission[]) {
  return function anyPermissionMiddleware(
    _req: Request,
    res:  Response,
    next: NextFunction,
  ): void {
    let ctx: ReturnType<typeof getTenantContext>;
    try {
      ctx = getTenantContext(res);
    } catch {
      sendError(res, Errors.internal('requireAnyPermission called before tenantContextMiddleware'));
      return;
    }

    const hasAny = allowed.some((p) => ctx.permissions.includes(p));
    if (!hasAny) {
      sendError(
        res,
        Errors.forbidden(
          `Insufficient permissions. Requires one of: ${allowed.join(', ')}`,
          { allowedPermissions: allowed, userRole: ctx.role },
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Require the requesting user to be the resource owner OR have an elevated role.
 * Useful for "users can edit their own profile; managers can edit anyone's".
 */
export function requireOwnerOrPermission(
  getResourceUserId: (req: Request) => string | undefined,
  fallbackPermission: Permission,
) {
  return function ownerOrPermissionMiddleware(
    req:  Request,
    res:  Response,
    next: NextFunction,
  ): void {
    let ctx: ReturnType<typeof getTenantContext>;
    try {
      ctx = getTenantContext(res);
    } catch {
      sendError(res, Errors.internal('requireOwnerOrPermission called before tenantContextMiddleware'));
      return;
    }

    const resourceUserId = getResourceUserId(req);
    if (ctx.userId === resourceUserId) {
      next();
      return;
    }

    if (ctx.permissions.includes(fallbackPermission)) {
      next();
      return;
    }

    sendError(
      res,
      Errors.forbidden('Access denied — you can only modify your own resources', {
        requiredPermission: fallbackPermission,
      }),
    );
  };
}
