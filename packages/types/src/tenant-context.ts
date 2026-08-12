/**
 * RBAC roles — uppercase to match the database CHECK constraint in the schema.
 */
export type UserRole = 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER';

/**
 * Granular permission strings used by the RBAC middleware.
 * Format: "resource:action"
 */
export type Permission =
  // Inventory
  | 'inventory:read'
  | 'inventory:create'
  | 'inventory:update'
  | 'inventory:delete'
  // Sales
  | 'sales:read'
  | 'sales:create'
  | 'sales:void'
  // Ledger
  | 'ledger:read'
  | 'ledger:create'
  | 'ledger:update'
  | 'ledger:credit'
  | 'ledger:payment'
  // Users / Admin
  | 'users:read'
  | 'users:create'
  | 'users:update'
  | 'users:delete'
  // Reports
  | 'reports:read'
  // WhatsApp
  | 'whatsapp:send'
  // Cash drawer shifts
  | 'shifts:read'
  | 'shifts:manage'
  // Cluster-level superadmin (see @retail/middleware requireSuperadmin()).
  // Deliberately NOT granted by ROLE_PERMISSIONS below — no tenant role
  // (including OWNER) implies it. It only ever reaches a token via
  // app_metadata.permissions set directly through the Supabase Admin API
  // (see services/superadmin/scripts/grant-superadmin.ts) — a superadmin is
  // a platform operator, not a role within any one tenant.
  | 'superadmin:access'
  // Platform-staff RBAC, finer-grained than the single 'superadmin:access'
  // permission above — same deliberately-not-granted-by-ROLE_PERMISSIONS
  // rule applies. 'platform:support' is read-only across every tenant
  // (health/analytics/error-log/tenant list); 'platform:billing' additionally
  // covers subscriptions/feature-flags/billing-event writes. Neither implies
  // 'superadmin:access' — tenant lifecycle (suspend/delete/purge), platform
  // settings, staff management, and support-token issuance stay
  // superadmin-only. See requirePlatformPermission() in @retail/middleware
  // and services/superadmin/src/routes/platform-ops-router.ts (grant/revoke).
  | 'platform:support'
  | 'platform:billing';

/**
 * Permission matrix — what each role is allowed to do.
 * OWNER inherits everything; VIEWER is read-only.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: [
    'inventory:read', 'inventory:create', 'inventory:update', 'inventory:delete',
    'sales:read', 'sales:create', 'sales:void',
    'ledger:read', 'ledger:create', 'ledger:update', 'ledger:credit', 'ledger:payment',
    'users:read', 'users:create', 'users:update', 'users:delete',
    'reports:read',
    'whatsapp:send',
    'shifts:read', 'shifts:manage',
  ],
  MANAGER: [
    'inventory:read', 'inventory:create', 'inventory:update',
    'sales:read', 'sales:create', 'sales:void',
    'ledger:read', 'ledger:create', 'ledger:update', 'ledger:credit', 'ledger:payment',
    'users:read',
    'reports:read',
    'whatsapp:send',
    'shifts:read', 'shifts:manage',
  ],
  STAFF: [
    'inventory:read',
    'sales:read', 'sales:create',
    'ledger:read',
    'reports:read',
    'shifts:read', 'shifts:manage',
  ],
  VIEWER: [
    'inventory:read',
    'sales:read',
    'ledger:read',
    'shifts:read',
    'reports:read',
  ],
};

/**
 * Decoded, validated claims attached to every authenticated request.
 * Populated by tenantContextMiddleware; consumed by all route handlers.
 */
export interface TenantContext {
  /** UUID of the resolved tenant — injected as $1 in every SQL query. */
  tenantId:    string;
  /** UUID of the authenticated user. */
  userId:      string;
  /** User's email address (from JWT claims). */
  email:       string;
  /** RBAC role — uppercase to match DB schema CHECK constraint. */
  role:        UserRole;
  /**
   * Immutable tag persisted on every inventory alteration and sale mutation.
   * Format: "<role>:<userId[:8]>"  e.g. "STAFF:a3f9b21c"
   */
  workerTag:   string;
  /** Resolved permission set for the request lifecycle. */
  permissions: Permission[];
  /**
   * Set when this request was authenticated via a short-lived, read-only
   * support-impersonation token (X-Support-Token) rather than a real
   * Supabase-issued JWT — see tenant-context.ts and
   * services/superadmin/src/routes/settings-router.ts (issuance). Route
   * handlers that mutate data should treat this as an additional signal to
   * refuse, on top of the fact that such a context always carries only
   * VIEWER-level permissions.
   */
  viaSupportToken?: boolean;
}
