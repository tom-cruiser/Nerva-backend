import { query, getClient } from '@retail/db';

/**
 * Refresh token records stored in `refresh_tokens` table.
 *
 * Table DDL (add to a migration):
 *
 *   CREATE TABLE IF NOT EXISTS refresh_tokens (
 *     jti        UUID         PRIMARY KEY,
 *     user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *     tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 *     expires_at TIMESTAMPTZ  NOT NULL,
 *     revoked_at TIMESTAMPTZ,
 *     created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
 *   );
 *   CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens(tenant_id, user_id);
 *   CREATE INDEX idx_refresh_tokens_active ON refresh_tokens(tenant_id, jti)
 *     WHERE revoked_at IS NULL;
 */

interface RefreshTokenRow {
  jti:        string;
  user_id:    string;
  tenant_id:  string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Persist a new refresh token JTI after successful login.
 * Runs inside the same transaction as recordSuccessfulLogin.
 */
export async function storeRefreshToken(
  jti:      string,
  userId:   string,
  tenantId: string,
  ttlSec:   number,
): Promise<void> {
  await query(
    `INSERT INTO refresh_tokens (jti, user_id, tenant_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::INTERVAL)`,
    [jti, userId, tenantId, String(ttlSec)],
  );
}

/**
 * Validate that a JTI exists, belongs to the correct tenant/user,
 * has not been revoked, and has not expired.
 */
export async function validateRefreshJti(
  jti:      string,
  tenantId: string,
): Promise<RefreshTokenRow | null> {
  const result = await query<RefreshTokenRow>(
    `SELECT jti, user_id, tenant_id, expires_at, revoked_at
     FROM refresh_tokens
     WHERE jti = $1
       AND tenant_id = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [jti, tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Revoke a single refresh token (logout, password change).
 */
export async function revokeRefreshToken(jti: string, tenantId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE jti = $1
       AND tenant_id = $2`,
    [jti, tenantId],
  );
}

/**
 * Revoke ALL active refresh tokens for a user (force logout everywhere).
 * Called on: password reset, account lock, role change.
 */
export async function revokeAllUserRefreshTokens(
  userId:   string,
  tenantId: string,
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE user_id  = $1
         AND tenant_id = $2
         AND revoked_at IS NULL`,
      [userId, tenantId],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, new_values)
       VALUES ($1, $2, 'LOGOUT_ALL', '{}')`,
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
