import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock @retail/supabase-admin so this test never makes a real Supabase Admin
// API call — it asserts the REVOCATION CALL happens (the right args, the
// right number of times), not that Supabase itself works, which is out of
// scope for a unit test of this job's own transition logic.
vi.mock('@retail/supabase-admin', () => ({
  setTenantUsersBanned: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
}));

import { getClient, closePool } from '@retail/db';
import { closeRedis } from '@retail/redis';
import { setTenantUsersBanned } from '@retail/supabase-admin';
import { runExpirationCheck } from './expiration-check';

/**
 * Runs against the real dev Postgres/Redis (this repo has no separate test
 * DB — see .env), using a throwaway tenant created and torn down around the
 * test, same pattern as every other live-verification script this session.
 * Only Supabase itself is mocked (see above).
 */
describe('runExpirationCheck', () => {
  let tenantId: string;

  beforeAll(async () => {
    const client = await getClient();
    try {
      const tenantResult = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, currency, timezone, status)
         VALUES ('Vitest Expiration Fixture', 'vitest-expiration-fixture', 'XAF', 'UTC', 'ACTIVE')
         RETURNING id`,
      );
      tenantId = tenantResult.rows[0].id;

      await client.query(
        `INSERT INTO subscriptions (tenant_id, plan_code, status, trial_ends_at)
         VALUES ($1, 'starter', 'TRIALING', NOW() - INTERVAL '1 day')`,
        [tenantId],
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (tenantId) {
      const client = await getClient();
      try {
        await client.query('DELETE FROM billing_events WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM platform_audit_logs WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM subscriptions WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      } finally {
        client.release();
      }
    }
    await closePool();
    await closeRedis();
  });

  it('suspends an ACTIVE tenant whose trial has expired, and revokes its users\' access', async () => {
    const result = await runExpirationCheck();
    expect(result.suspended).toContain(tenantId);
    expect(result.failed).toEqual([]);

    const client = await getClient();
    try {
      const tenantRow = await client.query<{ status: string; status_reason: string | null }>(
        'SELECT status, status_reason FROM tenants WHERE id = $1',
        [tenantId],
      );
      expect(tenantRow.rows[0].status).toBe('SUSPENDED');
      expect(tenantRow.rows[0].status_reason).toBe('Trial/subscription period expired');

      const subRow = await client.query<{ status: string }>(
        'SELECT status FROM subscriptions WHERE tenant_id = $1',
        [tenantId],
      );
      // A TRIALING subscription that expired transitions to CANCELLED (never
      // converted to paid) — an ACTIVE one past its period would go PAST_DUE.
      expect(subRow.rows[0].status).toBe('CANCELLED');

      const auditRow = await client.query<{ action: string; performed_by: string }>(
        `SELECT action, performed_by FROM platform_audit_logs WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(auditRow.rows[0].action).toBe('SUSPEND');
      expect(auditRow.rows[0].performed_by).toBe('00000000-0000-0000-0000-000000000001'); // SYSTEM_ACTOR_ID

      const billingRow = await client.query<{ event_type: string }>(
        `SELECT event_type FROM billing_events WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(billingRow.rows[0].event_type).toBe('SUBSCRIPTION_EXPIRED');
    } finally {
      client.release();
    }

    expect(setTenantUsersBanned).toHaveBeenCalledWith(expect.any(Array), true);
  });

  it('is a no-op the second time it runs — the tenant is no longer ACTIVE', async () => {
    const result = await runExpirationCheck();
    expect(result.suspended).not.toContain(tenantId);
  });
});
