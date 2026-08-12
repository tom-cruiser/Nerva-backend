import { Router, Request, Response, NextFunction } from 'express';
import { getClient } from '@retail/db';
import { requireAnyPermission } from '@retail/middleware';

const router = Router();

// Read-only platform analytics — any platform role (support, billing, or full
// superadmin) may view. Gated per-route rather than via router.use() per the
// task spec, but there is only one route here today.
const canView = requireAnyPermission('platform:support', 'platform:billing', 'superadmin:access');

interface TrendRow {
  date: string;
  count: string;
  amount_cents: string;
}

router.get('/analytics', canView, async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    // ── MRR ───────────────────────────────────────────────────────────────────
    // Every ACTIVE subscription contributes its plan's price_cents normalised
    // to a monthly figure: monthly plans as-is, annual plans divided by 12
    // (rounded to the nearest integer cent — subscription_plans.price_cents
    // is an INTEGER column per migration 008, so we keep the result an
    // integer rather than introduce fractional cents).
    const mrrResult = await client.query<{ mrr_cents: string | null }>(
      `SELECT SUM(
         CASE
           WHEN sp.billing_interval = 'annual' THEN ROUND(sp.price_cents / 12.0)
           ELSE sp.price_cents
         END
       ) AS mrr_cents
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.code = s.plan_code
       WHERE s.status = 'ACTIVE'`,
    );
    const mrrCents = Number(mrrResult.rows[0]?.mrr_cents || 0);

    // ── Active tenants (= ACTIVE subscriptions) ─────────────────────────────
    const activeResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM subscriptions WHERE status = 'ACTIVE'`,
    );
    const activeTenants = Number(activeResult.rows[0]?.count || 0);

    // ── Churn (30d) ──────────────────────────────────────────────────────────
    // There is no point-in-time subscription-status snapshot table, so the
    // "active 30 days ago" denominator is an approximation:
    //   (currently ACTIVE count) + (subscriptions canceled in the last 30 days)
    // i.e. everyone active today, plus everyone who left since — this is only
    // exact if no *new* ACTIVE subscriptions were created in the window to
    // offset the churned ones; treat it as an estimate, not an audited figure.
    const canceledResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM subscriptions
       WHERE canceled_at IS NOT NULL AND canceled_at >= NOW() - INTERVAL '30 days'`,
    );
    const canceled30d = Number(canceledResult.rows[0]?.count || 0);
    const churnDenominator = activeTenants + canceled30d;
    const churnRate30d = churnDenominator > 0 ? canceled30d / churnDenominator : 0;

    // ── GMV (lifetime + 30d) — PAID sales only ──────────────────────────────
    const gmvResult = await client.query<{
      lifetime: string | null;
      last_30d: string | null;
    }>(
      `SELECT
         SUM(total_amount) AS lifetime,
         SUM(total_amount) FILTER (WHERE sale_timestamp >= NOW() - INTERVAL '30 days') AS last_30d
       FROM sales
       WHERE payment_status = 'PAID'`,
    );
    const gmvLifetimeCents = Number(gmvResult.rows[0]?.lifetime || 0);
    const gmv30dCents = Number(gmvResult.rows[0]?.last_30d || 0);

    // ── New signups (30d) ───────────────────────────────────────────────────
    const signupsResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM tenants WHERE created_at >= NOW() - INTERVAL '30 days'`,
    );
    const newSignups30d = Number(signupsResult.rows[0]?.count || 0);

    // ── Transaction volume trend (last 30 days, dense — no gaps) ────────────
    // generate_series() first builds every calendar day in the window, then a
    // LEFT JOIN against PAID sales grouped by day so a day with zero sales
    // still comes back as a row (count 0 / amount_cents 0) instead of being
    // absent — a dashboard chart needs a continuous 30-point series.
    const trendResult = await client.query<TrendRow>(
      `SELECT
         to_char(d.day, 'YYYY-MM-DD') AS date,
         COALESCE(COUNT(s.id), 0) AS count,
         COALESCE(SUM(s.total_amount), 0) AS amount_cents
       FROM generate_series(
              CURRENT_DATE - INTERVAL '29 days',
              CURRENT_DATE,
              INTERVAL '1 day'
            ) AS d(day)
       LEFT JOIN sales s
         ON date_trunc('day', s.sale_timestamp) = d.day
         AND s.payment_status = 'PAID'
       GROUP BY d.day
       ORDER BY d.day ASC`,
    );
    const transactionVolumeTrend = trendResult.rows.map((row) => ({
      date: row.date,
      count: Number(row.count),
      amount_cents: Number(row.amount_cents),
    }));

    res.json({
      mrr_cents: mrrCents,
      arr_cents: mrrCents * 12,
      arpu_cents: activeTenants > 0 ? Math.round(mrrCents / activeTenants) : 0,
      active_tenants: activeTenants,
      churn_rate_30d: churnRate30d,
      gmv_lifetime_cents: gmvLifetimeCents,
      gmv_30d_cents: gmv30dCents,
      new_signups_30d: newSignups30d,
      transaction_volume_trend: transactionVolumeTrend,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

export { router as analyticsRouter };
