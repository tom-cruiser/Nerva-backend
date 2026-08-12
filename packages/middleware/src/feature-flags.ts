import { getClient } from '@retail/db';

/**
 * Feature-flag + resource-limit resolution  (see packages/db/src/migrations/
 * 008_subscriptions_and_features.sql for the underlying tables).
 *
 * Deliberately NOT cached (contrast with tenant-context.ts's Redis-backed
 * tenant-status check) — feature-flag/limit checks are far less hot than the
 * per-request tenant-status gate, so a plain Postgres round-trip per call
 * keeps this simple and always-consistent with the latest superadmin edit.
 */

// ─── Feature flags ────────────────────────────────────────────────────────────

interface FeatureFlagResolutionRow {
  resolved_enabled: boolean;
}

/**
 * Resolves whether `flagKey` is enabled for `tenantId`.
 *
 * Resolution order (first match wins):
 *   1. `tenant_feature_flags` row for (tenantId, flagKey), if one exists — its
 *      `enabled` value wins outright (a superadmin override).
 *   2. Else the tenant's plan's default via `plan_feature_flags`, joined
 *      through `tenants.billing_tier = plan_feature_flags.plan_code`.
 *   3. Else `feature_flags.default_enabled`.
 *   4. Else `false` if the flag key doesn't exist at all.
 *
 * Expressed as a single query so the three fallback layers are evaluated
 * atomically against one snapshot of the data (no risk of a flag being
 * edited between two round-trips producing an inconsistent answer).
 */
export async function resolveFeatureFlag(tenantId: string, flagKey: string): Promise<boolean> {
  const client = await getClient();
  try {
    const result = await client.query<FeatureFlagResolutionRow>(
      `SELECT COALESCE(
                tff.enabled,
                pff.enabled,
                ff.default_enabled,
                FALSE
              ) AS resolved_enabled
       FROM feature_flags ff
       LEFT JOIN tenants t
         ON t.id = $1
       LEFT JOIN tenant_feature_flags tff
         ON tff.tenant_id = $1 AND tff.flag_key = ff.key
       LEFT JOIN plan_feature_flags pff
         ON pff.plan_code = t.billing_tier AND pff.flag_key = ff.key
       WHERE ff.key = $2
       LIMIT 1`,
      [tenantId, flagKey],
    );
    return result.rows[0]?.resolved_enabled ?? false;
  } finally {
    client.release();
  }
}

// ─── Resource limits ──────────────────────────────────────────────────────────

export interface ResourceLimitCheck {
  allowed: boolean;
  limit: number | null;
  current: number;
}

export type ResourceLimitType = 'max_cashiers' | 'max_monthly_transactions';

const LIMIT_COLUMNS: Record<ResourceLimitType, string> = {
  max_cashiers: 'max_cashiers',
  max_monthly_transactions: 'max_monthly_transactions',
};

/**
 * Looks up the tenant's plan limit for `limitType` (NULL column = unlimited)
 * and the tenant's current usage against it, then reports whether there is
 * room for ONE MORE unit (a new seat / a new sale) — callers must call this
 * BEFORE creating the resource, not after.
 */
export async function checkResourceLimit(
  tenantId: string,
  limitType: ResourceLimitType,
): Promise<ResourceLimitCheck> {
  const client = await getClient();
  try {
    const column = LIMIT_COLUMNS[limitType];
    const planResult = await client.query<{ limit_value: number | null }>(
      `SELECT sp.${column} AS limit_value
       FROM tenants t
       JOIN subscription_plans sp ON sp.code = t.billing_tier
       WHERE t.id = $1
       LIMIT 1`,
      [tenantId],
    );

    const limit = planResult.rows[0]?.limit_value ?? null;

    let current: number;
    if (limitType === 'max_cashiers') {
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId],
      );
      current = parseInt(countResult.rows[0]?.count ?? '0', 10);
    } else {
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM sales
         WHERE tenant_id = $1 AND sale_timestamp >= date_trunc('month', NOW())`,
        [tenantId],
      );
      current = parseInt(countResult.rows[0]?.count ?? '0', 10);
    }

    if (limit === null) {
      return { allowed: true, limit: null, current };
    }
    return { allowed: current < limit, limit, current };
  } finally {
    client.release();
  }
}
