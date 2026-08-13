import { AsyncLocalStorage }              from 'async_hooks';
import { createHash }                     from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload }                 from 'jose';
import { env }                             from '@retail/config';
import { getClient }                       from '@retail/db';
import { redis }                           from '@retail/redis';
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
 * the client. There is NO fallback to `user_metadata` — see the SupabaseClaims
 * comment below.
 */
export interface SupabaseAppMetadata {
  tenant_id?:   string;
  role?:        string;
  permissions?: Permission[];
  worker_tag?:  string;
}

export interface SupabaseClaims extends JWTPayload {
  email?:         string;
  app_metadata?:  SupabaseAppMetadata;
  // NOTE: user_metadata is intentionally NOT part of the trusted claim shape.
  // It is editable by the end user via the standard Supabase client SDK
  // (`supabase.auth.updateUser({ data: {...} })`), so tenancy/role must never
  // be resolved from it — see the security-properties note on
  // tenantContextMiddleware below.
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

/**
 * Thrown by verifySupabaseJwt() — `reason` lets callers reproduce the exact
 * "expired vs. invalid" message distinction tenantContextMiddleware has
 * always made, without each caller re-deriving it from the raw jose error.
 */
export class JwtVerificationError extends Error {
  constructor(public readonly reason: 'expired' | 'invalid', message: string) {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

/**
 * Verifies a raw bearer-token string against Supabase's JWKS (signature,
 * issuer, audience, algorithm allowlist) and returns its claims. This is the
 * one real implementation of "is this a genuine, current Supabase access
 * token" in the cluster — factored out of tenantContextMiddleware so any
 * other entry point that needs to authenticate a Supabase JWT outside a
 * normal Express request/response cycle (e.g. services/realtime's
 * Socket.IO handshake, which has no `req`/`res` to run this middleware
 * against) can reuse it instead of re-declaring JWKS/issuer/audience.
 */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ALLOWED_ALGS,
      issuer:     ISSUER,
      audience:   env.SUPABASE_JWT_AUD,
    });
    return payload as SupabaseClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new JwtVerificationError('expired', 'Token has expired. Please refresh.');
    }
    throw new JwtVerificationError('invalid', 'Invalid token format or signature');
  }
}

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

// ─── Tenant lifecycle enforcement ─────────────────────────────────────────────
//
// A superadmin can move a tenant to SUSPENDED or DELETED (see
// services/superadmin). That state must take effect immediately for every
// cashier/manager/owner of that tenant, on every service — not just the next
// time their JWT happens to expire and they re-authenticate. Since JWT
// verification above is stateless (no DB round-trip), tenant status has to
// be checked separately, here, on every request that resolves a tenant.

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'PENDING_APPROVAL';

/**
 * Cache key for a tenant's lifecycle status. Exported so the superadmin
 * service can write straight to this same key — invalidating/updating the
 * cache as PART of the suspend/unblock/delete transaction, rather than
 * relying solely on TTL expiry, is what makes enforcement "immediate"
 * instead of "eventually, within TENANT_STATUS_CACHE_TTL_SECONDS".
 */
export function tenantStatusCacheKey(tenantId: string): string {
  return `tenant:status:${tenantId}`;
}

/** Safety-net TTL only — the cache is actively kept fresh by superadmin
 *  lifecycle actions writing directly to tenantStatusCacheKey(). This just
 *  bounds the damage if a write-through invalidation is ever missed (e.g. a
 *  crash between the Postgres COMMIT and the cache write). Exported so the
 *  superadmin service's own write-through `redis.set(...)` uses the exact
 *  same TTL, rather than a second, possibly-drifting magic number. */
export const TENANT_STATUS_CACHE_TTL_SECONDS = 60;

/**
 * Write-through the tenant-status cache immediately — this, not TTL expiry,
 * is what makes tenantContextMiddleware's rejection above "immediate"
 * cluster-wide the moment a superadmin action (or the automated expiration
 * cron in services/realtime) changes a tenant's status. Promoted here from
 * a private per-file copy in services/superadmin/src/routes/
 * superadmin-router.ts so every writer — the superadmin service AND the new
 * cron job — shares the one canonical implementation instead of each
 * re-declaring it.
 */
export async function setTenantStatusCache(tenantId: string, status: TenantStatus): Promise<void> {
  try {
    await redis.set(tenantStatusCacheKey(tenantId), status, 'EX', TENANT_STATUS_CACHE_TTL_SECONDS);
  } catch (err) {
    // Best-effort — the safety-net TTL on the read side, and the fact that a
    // Postgres miss always re-checks Postgres, bound the blast radius of a
    // failed cache write to at most TENANT_STATUS_CACHE_TTL_SECONDS of
    // staleness, not an incorrect state forever.
    console.error('[tenant-context] Failed to write-through tenant status cache', (err as Error).message);
  }
}

function isTenantStatus(value: unknown): value is TenantStatus {
  return (
    value === 'ACTIVE' ||
    value === 'SUSPENDED' ||
    value === 'DELETED' ||
    value === 'PENDING_APPROVAL'
  );
}

/**
 * A superadmin (see requireSuperadmin()) is a platform operator, not a role
 * within any one tenant — granted purely via app_metadata.permissions (see
 * services/superadmin/scripts/grant-superadmin.ts), independent of
 * tenant_id/role. This nil UUID stands in for "no tenant" so such a token
 * can still pass the tenantId-mandatory check below without being treated
 * as belonging to a real tenant anywhere else in the cluster: no row in
 * `tenants` will ever have this id, so resolveTenantStatus() reports it
 * ACTIVE (safe default), and any tenant-scoped query using it as a WHERE
 * clause returns zero rows rather than leaking another tenant's data.
 */
export const PLATFORM_SENTINEL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Stands in for `performed_by`/`status_changed_by` (both `NOT NULL UUID`,
 * no FK — same shape as the sentinel above) when a system process, not a
 * human superadmin, makes the change — e.g. services/realtime's daily
 * expiration cron auto-suspending a tenant whose trial/period lapsed. Never
 * a real Supabase user id; distinguishable at a glance from any genuine
 * actor id in `platform_audit_logs`/`tenants.status_changed_by`.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Resolves a tenant's current lifecycle status, Redis-first with a Postgres
 * fallback. Never throws — a Redis or Postgres outage fails toward ACTIVE
 * (availability) rather than locking out every tenant on the platform
 * because of an infrastructure blip; genuine suspensions/deletions are a
 * deliberate, low-frequency write that will be reflected as soon as either
 * store is reachable again.
 */
async function resolveTenantStatus(tenantId: string): Promise<TenantStatus> {
  const cacheKey = tenantStatusCacheKey(tenantId);

  try {
    const cached = await redis.get(cacheKey);
    if (isTenantStatus(cached)) return cached;
  } catch (err) {
    console.error('[tenant-context] Redis unavailable for status check, falling back to Postgres', (err as Error).message);
  }

  try {
    const client = await getClient();
    try {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM tenants WHERE id = $1 LIMIT 1',
        [tenantId],
      );
      const status = isTenantStatus(result.rows[0]?.status) ? result.rows[0].status : 'ACTIVE';
      redis.set(cacheKey, status, 'EX', TENANT_STATUS_CACHE_TTL_SECONDS).catch(() => {});
      return status;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[tenant-context] Postgres unavailable for status check — failing open (ACTIVE)', (err as Error).message);
    return 'ACTIVE';
  }
}

// ─── Platform maintenance mode ─────────────────────────────────────────────────
//
// A platform-wide halt (see platform_settings.maintenance_mode, toggled via
// services/superadmin/src/routes/settings-router.ts) that every service
// checks the same way tenant status is checked — Redis-cached, Postgres
// fallback, write-through on toggle. Superadmins (not platform:support or
// platform:billing — this is for the ops team doing the actual maintenance,
// not for support/billing staff) bypass it so they can verify things during
// the halt.

/** Redis key holding the current maintenance-mode flag ('true'/'false'). */
export const MAINTENANCE_MODE_CACHE_KEY = 'platform:maintenance_mode';
/** Same rationale as TENANT_STATUS_CACHE_TTL_SECONDS — safety net only. */
export const MAINTENANCE_MODE_CACHE_TTL_SECONDS = 60;

async function resolveMaintenanceMode(): Promise<boolean> {
  try {
    const cached = await redis.get(MAINTENANCE_MODE_CACHE_KEY);
    if (cached === 'true' || cached === 'false') return cached === 'true';
  } catch (err) {
    console.error('[tenant-context] Redis unavailable for maintenance-mode check, falling back to Postgres', (err as Error).message);
  }

  try {
    const client = await getClient();
    try {
      const result = await client.query<{ maintenance_mode: boolean }>(
        'SELECT maintenance_mode FROM platform_settings WHERE id = TRUE LIMIT 1',
      );
      const on = result.rows[0]?.maintenance_mode ?? false;
      redis.set(MAINTENANCE_MODE_CACHE_KEY, String(on), 'EX', MAINTENANCE_MODE_CACHE_TTL_SECONDS).catch(() => {});
      return on;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[tenant-context] Postgres unavailable for maintenance-mode check — failing open (off)', (err as Error).message);
    return false;
  }
}

// ─── Live per-user override (role/permission changes, deactivation) ───────────
//
// The JWT's app_metadata is a point-in-time snapshot from whenever this user
// last logged in or last had their token refreshed — Supabase does not
// retroactively rewrite an already-issued, unexpired access token when an
// Admin changes that user's role/permissions/active-status afterward (see
// services/auth-tenant's seats-handler.ts: updateSeatHandler,
// deactivateSeatHandler). Banning in Supabase (also done by those handlers)
// only blocks *new* token issuance (login/refresh) — it does not invalidate
// a still-valid signed JWT for a relying party that only verifies the
// signature, which is exactly what this middleware does above. Without a
// live check, a worker whose ledger-access was just revoked (or who was
// just deactivated) keeps their old permissions/access for up to their
// JWT's remaining lifetime.
//
// This mirrors resolveTenantStatus() exactly (Redis-cached, Postgres
// fallback, write-through on mutation) but scoped to one user's row instead
// of one tenant's — same reasoning, same trade-offs (fails open on infra
// outage; a superadmin/support-token identity with no `users` row simply
// gets an empty override and falls through to JWT-derived defaults, which
// is correct since those aren't tenant-scoped `users` rows at all).

export interface UserOverride {
  isActive:    boolean;
  /** NULL = no override; use ROLE_PERMISSIONS[role] as before. */
  permissions: Permission[] | null;
}

export function userOverrideCacheKey(userId: string): string {
  return `user:override:${userId}`;
}

/** Same rationale as TENANT_STATUS_CACHE_TTL_SECONDS — safety-net TTL only;
 *  seats-handler.ts writes through this cache as part of every role/
 *  permissions/active-status mutation, so this bounds staleness to a missed
 *  write-through, not the normal case. */
export const USER_OVERRIDE_CACHE_TTL_SECONDS = 60;

function isUserOverride(value: unknown): value is UserOverride {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as UserOverride).isActive === 'boolean'
  );
}

async function resolveUserOverride(userId: string): Promise<UserOverride> {
  const cacheKey = userOverrideCacheKey(userId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed: unknown = JSON.parse(cached);
      if (isUserOverride(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[tenant-context] Redis unavailable for user-override check, falling back to Postgres', (err as Error).message);
  }

  try {
    const client = await getClient();
    try {
      const result = await client.query<{ is_active: boolean; permissions: Permission[] | null }>(
        'SELECT is_active, permissions FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
        [userId],
      );
      // No row (superadmin/support-token identity, or a users row not
      // provisioned in this tenant-scoped table at all) → no override,
      // caller falls through to JWT-derived role/permissions untouched.
      const override: UserOverride = result.rows[0]
        ? { isActive: result.rows[0].is_active, permissions: result.rows[0].permissions }
        : { isActive: true, permissions: null };
      redis.set(cacheKey, JSON.stringify(override), 'EX', USER_OVERRIDE_CACHE_TTL_SECONDS).catch(() => {});
      return override;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[tenant-context] Postgres unavailable for user-override check — failing open (active, no override)', (err as Error).message);
    return { isActive: true, permissions: null };
  }
}

/** Write-through the user-override cache immediately — called by
 *  seats-handler.ts's updateSeatHandler/deactivateSeatHandler as part of
 *  every mutation, exactly like setTenantStatusCache is called by the
 *  superadmin tenant-lifecycle routes. This, not TTL expiry, is what makes
 *  a role/permissions/active-status change reach the affected worker's very
 *  next request instead of "eventually, within USER_OVERRIDE_CACHE_TTL_SECONDS". */
export async function setUserOverrideCache(userId: string, override: UserOverride): Promise<void> {
  try {
    await redis.set(userOverrideCacheKey(userId), JSON.stringify(override), 'EX', USER_OVERRIDE_CACHE_TTL_SECONDS);
  } catch (err) {
    console.error('[tenant-context] Failed to write-through user-override cache', (err as Error).message);
  }
}

// ─── Read-only support-impersonation tokens ───────────────────────────────────
//
// An X-Support-Token header is an ALTERNATIVE to a Bearer JWT, not an
// addition to it — see services/superadmin's support-token issuance route.
// It authenticates a request as a read-only viewer of exactly one tenant,
// without that tenant's OWNER ever having to share credentials. Deliberately
// bypasses the SUSPENDED/DELETED gate below (support staff investigating why
// a tenant is suspended need to be able to look at it), but can never carry
// more than VIEWER permissions, and every issuance/revocation is logged to
// platform_audit_logs (see the issuing route) — this file does not log
// per-request use, only validates the token.

interface SupportTokenRow {
  tenant_id:       string;
  issued_by:       string;
  issued_by_email: string | null;
  expires_at:      string;
  revoked_at:      string | null;
}

async function resolveSupportToken(rawToken: string): Promise<SupportTokenRow | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const client = await getClient();
  try {
    const result = await client.query<SupportTokenRow>(
      `SELECT tenant_id, issued_by, issued_by_email, expires_at, revoked_at
       FROM platform_support_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    // Best-effort — a failed timestamp update must never block the request
    // it's trying to record.
    client
      .query('UPDATE platform_support_tokens SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash])
      .catch(() => {});

    return row;
  } finally {
    client.release();
  }
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
 *   - A SUSPENDED or DELETED tenant is rejected here, on every request, even
 *     though the JWT itself is still validly signed and unexpired — this is
 *     what makes a superadmin's suspend/delete action take effect
 *     immediately for every cashier/manager/owner of that tenant, cluster-wide.
 *   - TenantContext is propagated via AsyncLocalStorage so repository functions
 *     never need `res` passed in — tenant isolation is automatic.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header.
 *   2. Verify signature + iss + aud against Supabase JWKS.
 *   3. Resolve tenantId (required) and role (defaults to VIEWER when absent).
 *   4. Check the tenant's lifecycle status (Redis-cached, Postgres-backed) —
 *      423 Locked if SUSPENDED, 404 if DELETED.
 *   5. Resolve permissions — explicit app_metadata.permissions if present, else
 *      derive from the ROLE_PERMISSIONS matrix.
 *   6. Build TenantContext, set on res.locals AND AsyncLocalStorage.
 *   7. Call next() inside the ALS run callback — all downstream code inherits it.
 *
 * NEVER skip this middleware on any route that touches tenant data.
 */
export async function tenantContextMiddleware(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  // ── Support-token path (alternative to a Bearer JWT entirely) ────────────
  const supportTokenHeader = req.headers['x-support-token'];
  if (typeof supportTokenHeader === 'string' && supportTokenHeader.length > 0) {
    let tokenRow: SupportTokenRow | null;
    try {
      tokenRow = await resolveSupportToken(supportTokenHeader);
    } catch (err) {
      // Unlike resolveTenantStatus/resolveMaintenanceMode, this is an auth
      // DECISION, not a secondary policy check layered on top of an already-
      // verified identity — it must fail CLOSED. A Postgres outage rejecting
      // support-token requests (while normal JWT auth keeps working, since
      // that path doesn't need a DB round-trip) is the safe direction to fail.
      console.error('[tenant-context] Postgres unavailable for support-token check — rejecting', (err as Error).message);
      sendError(res, Errors.serviceUnavailable('Unable to verify support token right now'));
      return;
    }
    if (!tokenRow) {
      sendError(res, Errors.unauthorized('Support token is invalid, expired, or revoked'));
      return;
    }

    const ctx: TenantContext = {
      tenantId:        tokenRow.tenant_id,
      userId:          tokenRow.issued_by,
      email:           tokenRow.issued_by_email ?? 'support@nerva.internal',
      role:            'VIEWER',
      workerTag:       `SUPPORT:${tokenRow.issued_by.slice(0, 8)}`,
      permissions:     ROLE_PERMISSIONS.VIEWER,
      viaSupportToken: true,
    };
    res.locals['tenant'] = ctx;
    tenantStore.run(ctx, next);
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, Errors.unauthorized('Missing or malformed Authorization header'));
    return;
  }

  const token = authHeader.slice(7);

  let claims: SupabaseClaims;
  try {
    claims = await verifySupabaseJwt(token);
  } catch (err) {
    if (err instanceof JwtVerificationError && err.reason === 'expired') {
      sendError(res, Errors.unauthorized('Token has expired. Please refresh.'));
    } else {
      sendError(res, Errors.unauthorized('Invalid token format or signature'));
    }
    return;
  }

  // ── Identity extraction ───────────────────────────────────────────────────
  // tenantId and role are resolved EXCLUSIVELY from app_metadata. Never fall
  // back to user_metadata here — it is client-writable, and doing so would
  // let any authenticated user grant themselves an arbitrary tenant_id/role
  // via a plain supabase.auth.updateUser() call (cross-tenant privilege
  // escalation). A user whose app_metadata was never provisioned is expected
  // to be rejected below, not silently trusted from their own claims.
  const meta = claims.app_metadata ?? {};

  const userId   = claims.sub;
  const email    = claims.email;
  let   tenantId = meta.tenant_id;

  if (!userId || !email) {
    sendError(res, Errors.unauthorized('Token is missing required claims (sub/email)'));
    return;
  }

  const isSuperadminToken =
    Array.isArray(meta.permissions) && (meta.permissions as string[]).includes('superadmin:access');

  // ── Platform maintenance mode ─────────────────────────────────────────────
  // Checked before any tenant-specific work — a platform-wide halt affects
  // every tenant identically, so there's nothing tenant-scoped to look up
  // yet. Superadmins bypass it so ops can verify things during the halt.
  if (!isSuperadminToken && await resolveMaintenanceMode()) {
    sendError(res, Errors.serviceUnavailable(
      'The platform is temporarily down for maintenance. Please try again shortly.',
    ));
    return;
  }

  // tenantId is mandatory for a normal tenant user — a token without one
  // cannot be scoped to any data. A superadmin token is the one deliberate
  // exception: it isn't scoped to any tenant by design, so it gets the
  // sentinel instead of being rejected here.
  if (!tenantId) {
    if (isSuperadminToken) {
      tenantId = PLATFORM_SENTINEL_TENANT_ID;
    } else {
      sendError(res, Errors.forbidden('Token has no tenant assignment (app_metadata.tenant_id)'));
      return;
    }
  }

  // ── Tenant lifecycle gate ─────────────────────────────────────────────────
  // A superadmin-suspended/deleted tenant must be rejected here, even with a
  // perfectly valid, unexpired JWT — this is the ONLY point every request
  // across every service passes through, so it's the only place this can be
  // enforced universally without relying on every route remembering to add
  // an extra middleware.
  const tenantStatus = await resolveTenantStatus(tenantId);
  if (tenantStatus === 'SUSPENDED') {
    sendError(res, Errors.locked(
      'This account has been suspended. Contact support to resolve this.',
      { status: 'SUSPENDED' },
    ));
    return;
  }
  if (tenantStatus === 'PENDING_APPROVAL') {
    // A newly self-registered tenant that a superadmin hasn't approved yet
    // (see services/superadmin's POST /tenants/:id/approve). Same 423 shape
    // as SUSPENDED so existing "locked" client handling covers it too, but
    // the `details.status` lets a client distinguish the two messages if it
    // wants to (e.g. "pending approval" vs "suspended").
    sendError(res, Errors.locked(
      'This workspace is pending approval. You will be notified once it is activated.',
      { status: 'PENDING_APPROVAL' },
    ));
    return;
  }
  if (tenantStatus === 'DELETED') {
    // Treat exactly like a tenant that never existed — don't confirm to a
    // caller with a stale token that this tenant id ever was real.
    sendError(res, Errors.notFound('Tenant not found'));
    return;
  }

  // ── Live per-user override (role/permissions/active-status) ──────────────
  // Checked even though the JWT already carries its own app_metadata
  // snapshot — see the userOverride block above for why that snapshot can
  // be stale. A deactivated worker is rejected here immediately, the same
  // way a SUSPENDED tenant is rejected above.
  const userOverride = await resolveUserOverride(userId);
  if (!userOverride.isActive) {
    sendError(res, Errors.locked(
      'This account has been deactivated. Contact your store admin.',
      { status: 'DEACTIVATED' },
    ));
    return;
  }

  // Role from app_metadata; default to read-only VIEWER when unset.
  const role = toUserRole(meta.role) ?? 'VIEWER';

  // ── Permission resolution ─────────────────────────────────────────────────
  // A live per-user override (see above) wins outright — it reflects an
  // Admin's most recent seats-handler.ts change. Otherwise prefer explicit
  // permissions provisioned in app_metadata; otherwise derive from the role
  // matrix. Same three-tier precedence GRANTABLE_EXTRA_PERMISSIONS-style
  // overrides have always conceptually had, just no longer gated on the
  // JWT's staleness.
  const permissions: Permission[] =
    userOverride.permissions ??
    (Array.isArray(meta.permissions) && meta.permissions.length > 0
      ? meta.permissions
      : ROLE_PERMISSIONS[role]);

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
