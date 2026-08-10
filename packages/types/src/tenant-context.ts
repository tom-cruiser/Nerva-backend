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
  | 'shifts:manage';

/**
 * Permission matrix — what each role is allowed to do.
 * OWNER inherits everything; VIEWER is read-only.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: [
    'inventory:read', 'inventory:create', 'inventory:update', 'inventory:delete',
    'sales:read', 'sales:create', 'sales:void',
    'ledger:read', 'ledger:credit', 'ledger:payment',
    'users:read', 'users:create', 'users:update', 'users:delete',
    'reports:read',
    'whatsapp:send',
    'shifts:read', 'shifts:manage',
  ],
  MANAGER: [
    'inventory:read', 'inventory:create', 'inventory:update',
    'sales:read', 'sales:create', 'sales:void',
    'ledger:read', 'ledger:credit', 'ledger:payment',
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
}
