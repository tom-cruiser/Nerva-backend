import { getClient } from '@retail/db';
import { setTenantUsersBanned } from '@retail/supabase-admin';
import { setTenantStatusCache, SYSTEM_ACTOR_ID } from '@retail/middleware';
import { publishRealtimeEvent, tenantRoom } from '@retail/redis';

/**
 * Daily automated lifecycle enforcement — the "Automated Store Account
 * Lifecycle Engine" cron. Finds every ACTIVE tenant whose trial or paid
 * period has lapsed and suspends it, mirroring services/superadmin's
 * POST /tenants/:id/suspend handler exactly (same transaction shape, same
 * revocation call, same audit trail), except the actor is SYSTEM_ACTOR_ID
 * instead of an authenticated superadmin's ctx.userId.
 *
 * Exported as a standalone function (not just a cron.schedule callback) so
 * it's directly callable from a test or a one-off manual run — see
 * expiration-check.test.ts and this session's live-verification script.
 */

interface ExpiredSubscriptionRow {
  subscription_id: string;
  tenant_id:       string;
  sub_status:      'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  tenant_slug:     string;
  tenant_name:     string;
}

export interface ExpirationCheckResult {
  suspended: string[];
  failed:    Array<{ tenantId: string; error: string }>;
}

export async function runExpirationCheck(): Promise<ExpirationCheckResult> {
  const suspended: string[] = [];
  const failed: Array<{ tenantId: string; error: string }> = [];

  const listClient = await getClient();
  let candidates: ExpiredSubscriptionRow[];
  try {
    // FOR UPDATE SKIP LOCKED — safe to overlap with a manually-triggered run
    // (e.g. the test/verification path below) without deadlocking.
    const result = await listClient.query<ExpiredSubscriptionRow>(
      `SELECT s.id AS subscription_id, s.tenant_id, s.status AS sub_status,
              t.slug AS tenant_slug, t.name AS tenant_name
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       WHERE t.status = 'ACTIVE'
         AND (
           (s.status = 'TRIALING' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at < NOW())
           OR (s.status = 'ACTIVE' AND s.current_period_end IS NOT NULL AND s.current_period_end < NOW())
         )
       FOR UPDATE OF s SKIP LOCKED`,
    );
    candidates = result.rows;
  } finally {
    listClient.release();
  }

  console.log(`[realtime:expiration-check] ${candidates.length} tenant(s) past trial/period end`);

  for (const row of candidates) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      const newSubStatus = row.sub_status === 'TRIALING' ? 'CANCELLED' : 'PAST_DUE';

      await client.query(
        `UPDATE tenants
         SET status = 'SUSPENDED', status_reason = $2,
             status_changed_at = NOW(), status_changed_by = $3
         WHERE id = $1`,
        [row.tenant_id, 'Trial/subscription period expired', SYSTEM_ACTOR_ID],
      );

      await client.query(
        `UPDATE subscriptions SET status = $2 WHERE id = $1`,
        [row.subscription_id, newSubStatus],
      );

      const usersResult = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE tenant_id = $1 AND deleted_at IS NULL',
        [row.tenant_id],
      );
      const banResult = await setTenantUsersBanned(usersResult.rows.map((u) => u.id), true);

      await client.query(
        `INSERT INTO billing_events (tenant_id, subscription_id, event_type, notes)
         VALUES ($1, $2, 'SUBSCRIPTION_EXPIRED', $3)`,
        [row.tenant_id, row.subscription_id, 'Auto-suspended by the daily expiration cron: trial/period ended'],
      );

      await client.query(
        `INSERT INTO platform_audit_logs
           (tenant_id, tenant_slug, tenant_name, action, reason, performed_by, performed_by_email, details)
         VALUES ($1,$2,$3,'SUSPEND',$4,$5,$6,$7::jsonb)`,
        [
          row.tenant_id, row.tenant_slug, row.tenant_name,
          'Trial/subscription period expired', SYSTEM_ACTOR_ID, 'system@nerva.internal',
          JSON.stringify({ banned_user_count: banResult.succeeded.length, ban_failures: banResult.failed, previous_sub_status: row.sub_status }),
        ],
      );

      await client.query('COMMIT');

      await setTenantStatusCache(row.tenant_id, 'SUSPENDED');
      await publishRealtimeEvent(tenantRoom(row.tenant_id), 'tenant:status_changed', {
        status: 'SUSPENDED', reason: 'EXPIRED',
      });

      suspended.push(row.tenant_id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[realtime:expiration-check] Failed to suspend tenant ${row.tenant_id}`, message);
      failed.push({ tenantId: row.tenant_id, error: message });
      // One tenant's failure must not abort the batch — continue to the next.
    } finally {
      client.release();
    }
  }

  console.log(`[realtime:expiration-check] Done — suspended ${suspended.length}, failed ${failed.length}`);
  return { suspended, failed };
}
