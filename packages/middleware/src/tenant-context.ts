import { AsyncLocalStorage }          from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import * as jwt                        from 'jsonwebtoken';
import { env }                         from '@retail/config';
import type { TenantContext, UserRole, Permission } from '@retail/types';
import { ROLE_PERMISSIONS }            from '@retail/types';
import { ApiError, Errors, sendError } from './api-error';

// ─── AsyncLocalStorage context carrier ───────────────────────────────────────

/**
 * Cluster-wide async context store.
 * Once set by tenantContextMiddleware, the TenantContext is available anywhere
 * in the call chain without threading `res` through every function.
 *
 * Usage in a repository or service:
 *   import { getTenantStore } from '@retail/middleware';
 *   const ctx = getTenantStore().getStore();
 *   // ctx is TenantContext | undefined
 */
export const tenantStore = new AsyncLocalStorage<TenantContext>();

// ─── JWT claim shape emitted by auth-tenant CryptoService ─────────────────────

interface AccessTokenClaims extends jwt.JwtPayload {
  userId:      string;
  tenantId:    string;
  email:       string;
  role:        UserRole;
  workerTag:   string;
  permissions: Permission[];
}

// ─── PEM normalisation (literal \n in env vars) ───────────────────────────────

function normalisePem(raw: string): string {
  return raw.replace(/\\n/g, '\n');
}

const PUBLIC_KEY = normalisePem(env.JWT_PUBLIC_KEY);

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Tenant Context Isolation Middleware  (agents.md §1 — Zero Data Leaks)
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces the #1 architectural boundary: every authenticated request MUST
 * carry a verifiable RS256 tenant identity before any route handler executes.
 *
 * Security properties:
 *   - tenantId is extracted ONLY from the verified JWT (prevents header spoofing)
 *   - RS256: private key stays in auth-tenant; all other services verify with
 *     the public key — compromise of a downstream service cannot mint new tokens
 *   - TenantContext is propagated via AsyncLocalStorage so repository functions
 *     never need `res` passed in — tenant isolation is automatic
 *   - Role validated against known enum; unknown roles reject the request
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header.
 *   2. Verify RS256 signature against JWT_PUBLIC_KEY.
 *   3. Validate required claims (userId, tenantId, email, role).
 *   4. Resolve permissions — use claims.permissions if present, else derive
 *      from the ROLE_PERMISSIONS matrix (backward compat with older tokens).
 *   5. Build TenantContext, set on res.locals AND AsyncLocalStorage.
 *   6. Call next() inside the ALS run callback — all downstream code inherits context.
 *
 * NEVER skip this middleware on any route that touches tenant data.
 */
export function tenantContextMiddleware(
  req:  Request,
  res:  Response,
  next: NextFunction,
): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, Errors.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  const token = authHeader.slice(7);

  let claims: AccessTokenClaims;
  try {
    claims = jwt.verify(token, PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer:     'retail-saas',
      audience:   'tenant-api',
    }) as AccessTokenClaims;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      sendError(res, Errors.unauthorized('Token has expired. Please refresh.'));
    } else {
      sendError(res, Errors.unauthorized('Invalid token format or signature'));
    }
    return;
  }

  // ── Required claim validation ─────────────────────────────────────────────
  if (!claims.userId || !claims.tenantId || !claims.email || !claims.role) {
    sendError(res, Errors.unauthorized('Token is missing required claims'));
    return;
  }

  const validRoles: UserRole[] = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER'];
  if (!validRoles.includes(claims.role)) {
    sendError(res, Errors.forbidden(`Unknown role: ${claims.role}`));
    return;
  }

  // ── Permission resolution ─────────────────────────────────────────────────
  // Use claims.permissions when present (issued by current CryptoService).
  // Fall back to role matrix for tokens issued before permissions were added.
  const permissions: Permission[] =
    Array.isArray(claims.permissions) && claims.permissions.length > 0
      ? claims.permissions
      : ROLE_PERMISSIONS[claims.role];

  const ctx: TenantContext = {
    tenantId:    claims.tenantId,
    userId:      claims.userId,
    email:       claims.email,
    role:        claims.role,
    workerTag:   claims.workerTag ?? `${claims.role}:${claims.userId.slice(0, 8)}`,
    permissions,
  };

  // ── Dual-store: res.locals (Express) + AsyncLocalStorage ─────────────────
  res.locals['tenant'] = ctx;

  // Run the rest of the request chain inside the ALS context
  tenantStore.run(ctx, next);
}

// ─── Accessors ────────────────────────────────────────────────────────────────

/**
 * Type-safe accessor for the resolved TenantContext from res.locals.
 * Throws immediately if middleware was skipped — surfaces misconfigured routers fast.
 *
 * Use this in Express route handlers where `res` is in scope.
 */
export function getTenantContext(res: Response): TenantContext {
  const ctx = res.locals['tenant'] as TenantContext | undefined;
  if (!ctx) {
    throw Errors.internal(
      'getTenantContext called before tenantContextMiddleware — check router setup',
    );
  }
  return ctx;
}

/**
 * AsyncLocalStorage-based accessor.
 * Use this in repository/service functions where `res` is NOT available.
 *
 * @example
 * import { getAsyncTenantContext } from '@retail/middleware';
 * const ctx = getAsyncTenantContext(); // throws if outside a request context
 */
export function getAsyncTenantContext(): TenantContext {
  const ctx = tenantStore.getStore();
  if (!ctx) {
    throw new ApiError(
      'getAsyncTenantContext called outside a tenant-context request — check router setup',
      'INTERNAL_ERROR', 500,
    );
  }
  return ctx;
}
