import { AsyncLocalStorage }              from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload }                 from 'jose';
import { env }                             from '@retail/config';
import type { TenantContext, UserRole, Permission } from '@retail/types';
import { ROLE_PERMISSIONS }                from '@retail/types';
import { ApiError, Errors, sendError }     from './api-error';

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

// ─── Supabase JWT claim shape ─────────────────────────────────────────────────

/**
 * Access-token payload issued by Supabase Auth (GoTrue).
 *
 * `sub`, `email`, `aud`, `iss`, `exp`, `iat` are standard. Application RBAC data
 * (tenant + role + optional explicit permissions) is expected in `app_metadata`
 * — set server-side via the Supabase Admin API so it cannot be tampered with by
 * the client. `user_metadata` is accepted as a fallback for older provisioning.
 */
interface SupabaseAppMetadata {
  tenant_id?:   string;
  role?:        string;
  permissions?: Permission[];
  worker_tag?:  string;
}

interface SupabaseClaims extends JWTPayload {
  email?:         string;
  app_metadata?:  SupabaseAppMetadata;
  user_metadata?: SupabaseAppMetadata;
}

// ─── Remote JWKS (asymmetric verification, auto-cached) ───────────────────────

/**
 * Remote JWK Set fetched from Supabase's `.well-known/jwks.json`.
 * jose caches the keys and refreshes on unknown `kid` with a built-in cooldown,
 * so this survives Supabase signing-key rotation without a redeploy.
 */
const JWKS = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));

// Supabase signs access tokens with an asymmetric key when JWT signing keys are
// enabled. Restrict to the algorithms Supabase actually uses — never "none".
const ALLOWED_ALGS = ['ES256', 'RS256', 'EdDSA'];

// GoTrue's issuer is the project's auth base URL.
const ISSUER = `${env.SUPABASE_URL.replace(/\/$/u, '')}/auth/v1`;

// ─── Role mapping ─────────────────────────────────────────────────────────────

const VALID_ROLES: readonly UserRole[] = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER'];

/**
 * Map a raw Supabase role claim to our RBAC role.
 * Supabase's top-level `role` claim is the Postgres role ("authenticated") — NOT
 * an application role — so we read the app role from app_metadata and normalise
 * it to upper-case. Returns null when the value is not a recognised RBAC role.
 */
function toUserRole(raw: string | undefined): UserRole | null {
  if (!raw) return null;
  const upper = raw.toUpperCase() as UserRole;
  return VALID_ROLES.includes(upper) ? upper : null;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Tenant Context Isolation Middleware  (agents.md §1 — Zero Data Leaks)
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces the #1 architectural boundary: every authenticated request MUST
 * carry a verifiable Supabase identity before any route handler executes.
 *
 * Security properties:
 *   - Signature verified against Supabase JWKS (asymmetric) — no shared secret
 *     lives in the app; signing-key rotation is handled transparently.
 *   - `iss` and `aud` are pinned to this Supabase project — tokens minted for a
 *     different project or audience are rejected.
 *   - tenantId + role come ONLY from `app_metadata` (server-controlled) — the
 *     client cannot spoof tenancy or elevate its role via editable user_metadata.
 *   - TenantContext is propagated via AsyncLocalStorage so repository functions
 *     never need `res` passed in — tenant isolation is automatic.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header.
 *   2. Verify signature + iss + aud against Supabase JWKS.
 *   3. Resolve tenantId (required) and role (defaults to VIEWER when absent).
 *   4. Resolve permissions — explicit app_metadata.permissions if present, else
 *      derive from the ROLE_PERMISSIONS matrix.
 *   5. Build TenantContext, set on res.locals AND AsyncLocalStorage.
 *   6. Call next() inside the ALS run callback — all downstream code inherits it.
 *
 * NEVER skip this middleware on any route that touches tenant data.
 */
export async function tenantContextMiddleware(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, Errors.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  const token = authHeader.slice(7);

  let claims: SupabaseClaims;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ALLOWED_ALGS,
      issuer:     ISSUER,
      audience:   env.SUPABASE_JWT_AUD,
    });
    claims = payload as SupabaseClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      sendError(res, Errors.unauthorized('Token has expired. Please refresh.'));
    } else {
      sendError(res, Errors.unauthorized('Invalid token format or signature'));
    }
    return;
  }

  // ── Identity extraction ───────────────────────────────────────────────────
  const meta  = claims.app_metadata ?? {};
  const uMeta = claims.user_metadata ?? {};

  const userId   = claims.sub;
  const email    = claims.email;
  const tenantId = meta.tenant_id ?? uMeta.tenant_id;

  if (!userId || !email) {
    sendError(res, Errors.unauthorized('Token is missing required claims (sub/email)'));
    return;
  }

  // tenantId is mandatory — a token without one cannot be scoped to any data.
  if (!tenantId) {
    sendError(res, Errors.forbidden('Token has no tenant assignment (app_metadata.tenant_id)'));
    return;
  }

  // Role from app_metadata; default to read-only VIEWER when unset.
  const role = toUserRole(meta.role ?? uMeta.role) ?? 'VIEWER';

  // ── Permission resolution ─────────────────────────────────────────────────
  // Prefer explicit permissions provisioned in app_metadata; otherwise derive
  // from the role matrix.
  const permissions: Permission[] =
    Array.isArray(meta.permissions) && meta.permissions.length > 0
      ? meta.permissions
      : ROLE_PERMISSIONS[role];

  const ctx: TenantContext = {
    tenantId,
    userId,
    email,
    role,
    workerTag: meta.worker_tag ?? `${role}:${userId.slice(0, 8)}`,
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
