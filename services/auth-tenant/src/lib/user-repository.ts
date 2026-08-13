import { query, getClient } from '@retail/db';
import type { UserRole } from '@retail/types';

/**
 * Full user row — hashed_password ONLY exists here, never leaves this module.
 */
export interface UserRow {
  id:                    string;
  tenant_id:             string;
  email:                 string;
  hashed_password:       string;
  full_name:             string | null;
  role:                  UserRole;
  worker_tag:            string;
  is_active:             boolean;
  failed_login_attempts: number;
  locked_until:          Date | null;
  version:               number;
}

export type SafeUserRow = Omit<UserRow, 'hashed_password'>;

/**
 * Tenant row — used to confirm a tenant exists and is active before credential check.
 */
export interface TenantRow {
  id:        string;
  name:      string;
  slug:      string;
  is_active: boolean;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Find an active user by email within a specific tenant.
 * tenant_id is always $1 per skill-1 requirements.
 */
export async function findUserByEmail(
  tenantId: string,
  email:    string,
): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, tenant_id, email, hashed_password, full_name, role,
            worker_tag, is_active, failed_login_attempts, locked_until, version
     FROM users
     WHERE tenant_id = $1
       AND email     = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, email.toLowerCase().trim()],
  );
  return result.rows[0] ?? null;
}

/**
 * Find an active user by ID — used during token refresh.
 */
export async function findUserById(
  tenantId: string,
  userId:   string,
): Promise<SafeUserRow | null> {
  const result = await query<SafeUserRow>(
    `SELECT id, tenant_id, email, full_name, role,
            worker_tag, is_active, failed_login_attempts, locked_until, version
     FROM users
     WHERE tenant_id = $1
       AND id        = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Confirm a tenant exists and is usable for provisioning.
 * Called by user-provisioning.ts::provisionUser() right after a tenant row is
 * created/looked up — no user context available yet.
 *
 * Deliberately allows PENDING_APPROVAL alongside ACTIVE (not just
 * `is_active = TRUE`): a freshly self-registered tenant defaults to
 * PENDING_APPROVAL (see register-handler.ts) and its owner/seats must still
 * be provisionable while awaiting superadmin approval — only SUSPENDED/
 * DELETED tenants (both `is_active = FALSE`, same as PENDING_APPROVAL) should
 * block provisioning.
 */
export async function findTenantById(tenantId: string): Promise<TenantRow | null> {
  const result = await query<TenantRow>(
    `SELECT id, name, slug, is_active
     FROM tenants
     WHERE id = $1 AND status IN ('ACTIVE', 'PENDING_APPROVAL')
     LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Increment failed_login_attempts.
 * Locks the account for 30 minutes on the 5th consecutive failure.
 *
 * BEGIN/COMMIT per skill-1: multi-table mutation (users + audit_logs).
 */
export async function recordFailedLogin(
  tenantId: string,
  userId:   string,
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1,
           locked_until = CASE
             WHEN failed_login_attempts + 1 >= 5
             THEN NOW() + INTERVAL '30 minutes'
             ELSE locked_until
           END,
           updated_at = NOW()
       WHERE tenant_id = $1
         AND id        = $2`,
      [tenantId, userId],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, worker_tag, new_values)
       VALUES ($1, $2, 'LOGIN_FAIL', 'AUTH', $2, 'system', '{}')`,
      [tenantId, userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reset failed_login_attempts and clear any lockout on successful login.
 * BEGIN/COMMIT: users UPDATE + audit_logs INSERT.
 */
export async function recordSuccessfulLogin(
  tenantId: string,
  userId:   string,
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until          = NULL,
           last_login_at         = NOW(),
           updated_at            = NOW()
       WHERE tenant_id = $1
         AND id        = $2`,
      [tenantId, userId],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, worker_tag, new_values)
       VALUES ($1, $2, 'LOGIN', 'AUTH', $2, 'system', '{}')`,
      [tenantId, userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}