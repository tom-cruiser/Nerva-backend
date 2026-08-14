import { Router, Request, Response, NextFunction } from 'express';
import { query } from '@retail/db';
import { getTenantContext, requirePermission, Errors } from '@retail/middleware';

/**
 * Tenant-scoped sales analytics — backs the Admin dashboard's real metrics
 * and the WhatsApp "Send Report" feature's report payload (both previously
 * fabricated placeholder data on the frontend). Read-only, so plain query()
 * is used throughout — no transaction needed.
 *
 * Lives in sales-sync (not a new service) because it reads directly off the
 * `sales` table this service already owns, and mounting it under the
 * existing `/api/v1/sync` prefix avoids any nginx/dev-gateway route changes.
 */
const analyticsRouter = Router();

// ─── Shared: resolve a [start, end) window from ?date=&period= ──────────────

// 'custom' added for the Admin Reports page's "Custom Date Range" filter
// (whatsapp-report.md §1) — Today/Yesterday/This Week/This Month are all
// already expressible via the existing date+period semantics (the caller
// just picks the right anchor date), so only an arbitrary start/end pair
// was a genuine gap.
type Period = 'daily' | 'weekly' | 'monthly' | 'custom';

/**
 * Resolves the report window in UTC day boundaries. A known simplification:
 * this does not consult `tenants.timezone` — a store whose local day doesn't
 * align with UTC midnight will see slightly shifted "daily" boundaries. Good
 * enough for now; revisit if that mismatch turns out to matter in practice.
 */
function resolveWindow(dateParam: string, period: Period): { start: Date; end: Date } {
  const anchor = new Date(`${dateParam}T00:00:00.000Z`);

  if (period === 'daily') {
    const start = anchor;
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  if (period === 'weekly') {
    // 7 days ending on (and including) the anchor date.
    const end = new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { start, end };
  }

  // monthly — the calendar month containing the anchor date.
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return { start, end };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

// ─── GET /api/v1/sync/analytics/sales-report ─────────────────────────────────

analyticsRouter.get(
  '/sales-report',
  requirePermission('reports:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);

      const dateParam = typeof req.query['date'] === 'string' ? req.query['date'] : '';
      const period = (typeof req.query['period'] === 'string' ? req.query['period'] : 'daily') as Period;
      const startParam = typeof req.query['start'] === 'string' ? req.query['start'] : '';
      const endParam = typeof req.query['end'] === 'string' ? req.query['end'] : '';

      if (!['daily', 'weekly', 'monthly', 'custom'].includes(period)) {
        return next(Errors.invalidRequest('period must be daily, weekly, monthly, or custom'));
      }

      let start: Date;
      let end: Date;
      if (period === 'custom') {
        if (!DATE_RE.test(startParam) || !DATE_RE.test(endParam)) {
          return next(Errors.invalidRequest('start and end are required in YYYY-MM-DD format when period=custom'));
        }
        start = new Date(`${startParam}T00:00:00.000Z`);
        // Inclusive of the end date — the window is [start, end + 1 day).
        end = new Date(new Date(`${endParam}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
        if (end <= start) {
          return next(Errors.invalidRequest('end must be on or after start'));
        }
      } else {
        if (!DATE_RE.test(dateParam)) {
          return next(Errors.invalidRequest('date is required in YYYY-MM-DD format'));
        }
        ({ start, end } = resolveWindow(dateParam, period));
      }
      const params = [ctx.tenantId, start.toISOString(), end.toISOString()];

      const totalsResult = await query<{
        total_sales: string | null;
        total_orders: string;
        total_discount: string | null;
      }>(
        `SELECT COALESCE(SUM(total_amount), 0) AS total_sales, COUNT(*) AS total_orders,
                COALESCE(SUM(discount_amount), 0) AS total_discount
         FROM sales
         WHERE tenant_id = $1 AND payment_status = 'PAID'
           AND sale_timestamp >= $2 AND sale_timestamp < $3
           AND deleted_at IS NULL`,
        params,
      );
      const totalSales = Number(totalsResult.rows[0]?.total_sales ?? 0);
      const totalOrders = Number(totalsResult.rows[0]?.total_orders ?? 0);
      const totalDiscountAmount = Number(totalsResult.rows[0]?.total_discount ?? 0);
      const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;

      // Net Profit needs a cost basis per product — inventories.cost_price
      // (021_whatsapp_reports.sql), nullable by design: a product with no
      // cost set is excluded from the calc rather than assumed to cost 0,
      // which would silently overstate profit. If ANY sold line item in the
      // window has no matching cost_price, netProfit comes back `null`
      // (not a number that looks trustworthy but is actually a floor) —
      // productsWithoutCost tells the UI how many line items are missing it.
      const profitResult = await query<{
        total_cost: string | null;
        line_items_missing_cost: string;
      }>(
        `SELECT SUM((item->>'quantity')::numeric * COALESCE(i.cost_price, 0)) AS total_cost,
                COUNT(*) FILTER (WHERE i.cost_price IS NULL) AS line_items_missing_cost
         FROM sales s
         CROSS JOIN jsonb_array_elements(s.items_sold) item
         LEFT JOIN inventories i
           ON i.tenant_id = s.tenant_id AND i.product_sku = item->>'product_sku'
         WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
           AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3
           AND s.deleted_at IS NULL`,
        params,
      );
      const productsWithoutCost = Number(profitResult.rows[0]?.line_items_missing_cost ?? 0);
      const netProfit = productsWithoutCost > 0
        ? null
        : totalSales - Number(profitResult.rows[0]?.total_cost ?? 0);

      // Cashier performance for THIS date range — deliberately separate from
      // GET /api/v1/shifts/staff-performance, which is scoped to the
      // current/most-recent shift window, not an arbitrary range. The two
      // can legitimately disagree for the same worker/day; that's expected,
      // not a bug (they answer different questions).
      const cashierResult = await query<{
        worker_tag: string;
        full_name: string | null;
        role: string | null;
        sales_count: string;
        revenue: string;
        register_status: string | null;
      }>(
        `SELECT s.worker_tag,
                MAX(u.full_name) AS full_name,
                MAX(u.role) AS role,
                COUNT(*) AS sales_count,
                SUM(s.total_amount) AS revenue,
                (SELECT cds.status FROM cash_drawer_shifts cds
                 WHERE cds.tenant_id = $1 AND cds.worker_tag = s.worker_tag
                 ORDER BY cds.opened_at DESC LIMIT 1) AS register_status
         FROM sales s
         LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.worker_tag = s.worker_tag
         WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
           AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3
           AND s.deleted_at IS NULL
         GROUP BY s.worker_tag
         ORDER BY revenue DESC`,
        params,
      );

      // Low-stock count is a point-in-time fact about current inventory, not
      // scoped to the report's date range.
      const lowStockResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM inventories
         WHERE tenant_id = $1 AND deleted_at IS NULL AND stock_quantity <= reorder_level`,
        [ctx.tenantId],
      );
      const lowStockCount = Number(lowStockResult.rows[0]?.count ?? 0);

      // Line items are denormalized JSONB on `sales.items_sold` (no separate
      // sale_items table — see 001_initial_schema.sql), so top-products and
      // revenue-by-category both expand it with jsonb_array_elements.
      const topProductsResult = await query<{
        product_sku: string;
        name: string | null;
        quantity: string;
        revenue: string;
      }>(
        `SELECT item->>'product_sku' AS product_sku,
                MAX(i.name) AS name,
                SUM((item->>'quantity')::numeric) AS quantity,
                SUM((item->>'total')::numeric) AS revenue
         FROM sales s
         CROSS JOIN jsonb_array_elements(s.items_sold) item
         LEFT JOIN inventories i
           ON i.tenant_id = s.tenant_id AND i.product_sku = item->>'product_sku'
         WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
           AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3
           AND s.deleted_at IS NULL
         GROUP BY item->>'product_sku'
         ORDER BY revenue DESC
         LIMIT 5`,
        params,
      );

      const revenueByCategoryResult = await query<{
        category: string | null;
        revenue: string;
      }>(
        `SELECT COALESCE(i.category, 'Uncategorized') AS category,
                SUM((item->>'total')::numeric) AS revenue
         FROM sales s
         CROSS JOIN jsonb_array_elements(s.items_sold) item
         LEFT JOIN inventories i
           ON i.tenant_id = s.tenant_id AND i.product_sku = item->>'product_sku'
         WHERE s.tenant_id = $1 AND s.payment_status = 'PAID'
           AND s.sale_timestamp >= $2 AND s.sale_timestamp < $3
           AND s.deleted_at IS NULL
         GROUP BY COALESCE(i.category, 'Uncategorized')
         ORDER BY revenue DESC`,
        params,
      );

      const paymentMethodsResult = await query<{
        payment_method: string;
        amount: string;
        count: string;
      }>(
        `SELECT payment_method, SUM(total_amount) AS amount, COUNT(*) AS count
         FROM sales
         WHERE tenant_id = $1 AND payment_status = 'PAID'
           AND sale_timestamp >= $2 AND sale_timestamp < $3
           AND deleted_at IS NULL
         GROUP BY payment_method
         ORDER BY amount DESC`,
        params,
      );

      // Hourly breakdown is only meaningful for a single-day window.
      let hourlySales: Array<{ hour: string; orders: number; revenue: number }> = [];
      if (period === 'daily') {
        const hourlyResult = await query<{ hour: string; orders: string; revenue: string }>(
          `SELECT to_char(date_trunc('hour', sale_timestamp), 'HH24:MI') AS hour,
                  COUNT(*) AS orders, SUM(total_amount) AS revenue
           FROM sales
           WHERE tenant_id = $1 AND payment_status = 'PAID'
             AND sale_timestamp >= $2 AND sale_timestamp < $3
             AND deleted_at IS NULL
           GROUP BY date_trunc('hour', sale_timestamp)
           ORDER BY date_trunc('hour', sale_timestamp) ASC`,
          params,
        );
        hourlySales = hourlyResult.rows.map((r) => ({
          hour: r.hour,
          orders: Number(r.orders),
          revenue: Number(r.revenue),
        }));
      }

      // A small raw-sale sample for a "recent transactions" UI table —
      // capped so the response stays small regardless of window size.
      const recentSalesResult = await query<{
        id: string;
        worker_tag: string;
        items_sold: unknown;
        total_amount: string;
        payment_method: string;
        payment_status: string;
        sale_timestamp: string;
      }>(
        `SELECT id, worker_tag, items_sold, total_amount, payment_method, payment_status, sale_timestamp
         FROM sales
         WHERE tenant_id = $1 AND sale_timestamp >= $2 AND sale_timestamp < $3
           AND deleted_at IS NULL
         ORDER BY sale_timestamp DESC
         LIMIT 10`,
        params,
      );

      res.status(200).json({
        date: period === 'custom' ? undefined : dateParam,
        start: period === 'custom' ? startParam : undefined,
        end: period === 'custom' ? endParam : undefined,
        period,
        totalSales,
        totalOrders,
        averageOrderValue,
        totalDiscountAmount,
        netProfit,
        productsWithoutCost,
        lowStockCount,
        cashierPerformance: cashierResult.rows.map((r) => ({
          workerTag: r.worker_tag,
          fullName: r.full_name ?? r.worker_tag,
          role: r.role,
          salesCount: Number(r.sales_count),
          revenue: Number(r.revenue),
          registerStatus: r.register_status,
        })),
        topSellingProducts: topProductsResult.rows.map((r) => ({
          sku: r.product_sku,
          name: r.name ?? r.product_sku,
          quantity: Number(r.quantity),
          revenue: Number(r.revenue),
        })),
        revenueByCategory: revenueByCategoryResult.rows.map((r) => ({
          category: r.category ?? 'Uncategorized',
          revenue: Number(r.revenue),
        })),
        paymentMethods: paymentMethodsResult.rows.map((r) => ({
          method: r.payment_method,
          amount: Number(r.amount),
          count: Number(r.count),
        })),
        hourlySales,
        recentSales: recentSalesResult.rows.map((r) => ({
          id: r.id,
          workerTag: r.worker_tag,
          itemCount: Array.isArray(r.items_sold) ? r.items_sold.length : 0,
          totalAmount: Number(r.total_amount),
          paymentMethod: r.payment_method,
          paymentStatus: r.payment_status,
          saleTimestamp: r.sale_timestamp,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/sync/analytics/registers ────────────────────────────────────

analyticsRouter.get(
  '/registers',
  requirePermission('reports:read'),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);

      const result = await query<{ active: string; total: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE last_synced_at > NOW() - INTERVAL '24 hours') AS active,
           COUNT(*) AS total
         FROM sync_cursors
         WHERE tenant_id = $1`,
        [ctx.tenantId],
      );

      res.status(200).json({
        active: Number(result.rows[0]?.active ?? 0),
        total: Number(result.rows[0]?.total ?? 0),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

export { analyticsRouter };
