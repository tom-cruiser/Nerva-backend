import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '@retail/db';
import { getTenantContext, requirePermission, Errors, sendError } from '@retail/middleware';

const router = Router();

/**
 * The pg driver returns DECIMAL/NUMERIC/COUNT(*) columns as strings (they
 * don't round-trip losslessly through JS `number` at arbitrary precision) —
 * coerce the known-numeric fields listed in `keys` on `row` before sending it
 * over the wire so clients always see real JSON numbers.
 */
function coerceNumeric<T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    if (value !== null && value !== undefined) {
      out[key] = Number(value) as T[keyof T];
    }
  }
  return out;
}

const closeSchema = z.object({
  shift_id: z.string().uuid(),
  reported_cash: z.number().nonnegative(),
});

const openSchema = z.object({
  opening_balance: z.number().nonnegative().default(0),
});

/**
 * Open a new cash drawer shift.
 *
 * There is at most one open shift per tenant (enforced by a partial unique
 * index on cash_drawer_shifts(tenant_id) WHERE closed_at IS NULL) — this
 * models a single shared till, not per-worker clock-in/out. Opening a new
 * shift force-closes any shift left open by a previous worker so the
 * invariant always holds before the INSERT below.
 */
router.post(
  '/open',
  requirePermission('shifts:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = openSchema.parse(req.body);
      const ctx = getTenantContext(res);
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        await client.query(
          `UPDATE cash_drawer_shifts
           SET closed_at = NOW(), status = 'FORCE_CLOSED', closed_by_worker_tag = $2
           WHERE tenant_id = $1 AND closed_at IS NULL`,
          [ctx.tenantId, ctx.workerTag],
        );

        const shiftId = uuidv4();
        await client.query(
          `INSERT INTO cash_drawer_shifts (id, tenant_id, worker_tag, opened_at, opening_balance, status)
           VALUES ($1, $2, $3, NOW(), $4, 'OPEN')`,
          [shiftId, ctx.tenantId, ctx.workerTag, body.opening_balance],
        );

        await client.query('COMMIT');
        res.json({
          shift_id: shiftId,
          opened_at: new Date().toISOString(),
          worker_tag: ctx.workerTag,
          opening_balance: body.opening_balance,
          status: 'OPEN',
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Close a cash drawer shift with cash reconciliation.
 *
 * Expected cash is the opening float plus CASH-only PAID sales rung up during
 * the shift window — MOMO/CARD sales never touch the physical drawer, so they
 * must NOT count toward the cash reconciliation.
 */
router.post(
  '/close',
  requirePermission('shifts:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = closeSchema.parse(req.body);
      const ctx = getTenantContext(res);
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        const shiftQ = await client.query(
          `SELECT id, worker_tag, opened_at, closed_at, status, opening_balance
           FROM cash_drawer_shifts
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE
           LIMIT 1`,
          [body.shift_id, ctx.tenantId],
        );
        if (shiftQ.rows.length === 0) {
          await client.query('ROLLBACK');
          sendError(res, Errors.notFound('Shift not found'));
          return;
        }

        const shift = shiftQ.rows[0];
        if (shift.closed_at) {
          await client.query('ROLLBACK');
          sendError(res, Errors.conflict('Shift already closed'));
          return;
        }

        const openedAt = shift.opened_at;
        const openingBalance = Number(shift.opening_balance || 0);

        // CASH-only, PAID sales rung up since the shift opened.
        const salesQ = await client.query<{ cash_total: string }>(
          `SELECT COALESCE(SUM(total_amount), 0) AS cash_total
           FROM sales
           WHERE tenant_id = $1
             AND sale_timestamp >= $2
             AND payment_status = 'PAID'
             AND payment_method = 'CASH'`,
          [ctx.tenantId, openedAt],
        );

        const salesTotal = Number(salesQ.rows[0]?.cash_total ?? 0);
        const expectedCash = openingBalance + salesTotal;
        const reportedCash = body.reported_cash;
        const discrepancy = Number((reportedCash - expectedCash).toFixed(2));
        const status = Math.abs(discrepancy) > 0.01 ? 'ANOMALY' : 'CLOSED';

        await client.query(
          `UPDATE cash_drawer_shifts
           SET closed_at = NOW(),
               expected_cash = $1,
               reported_cash = $2,
               discrepancy = $3,
               status = $4,
               sales_total = $5,
               closed_by_worker_tag = $6
           WHERE id = $7 AND tenant_id = $8`,
          [expectedCash, reportedCash, discrepancy, status, salesTotal, ctx.workerTag, body.shift_id, ctx.tenantId],
        );

        await client.query(
          `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
           VALUES ($1, 'cash_drawer_shift', $2, 'RECONCILE', $3, $4::jsonb, $5::jsonb)`,
          [
            ctx.tenantId,
            body.shift_id,
            ctx.workerTag,
            JSON.stringify(shift),
            JSON.stringify({ expectedCash, reportedCash, discrepancy, status, salesTotal }),
          ],
        );

        await client.query('COMMIT');
        res.json({
          shift_id: body.shift_id,
          worker_tag: shift.worker_tag,
          opened_at: shift.opened_at,
          opening_balance: openingBalance,
          expected_cash: expectedCash,
          reported_cash: reportedCash,
          discrepancy,
          status,
          sales_total: salesTotal,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Get the current open shift, if any, with a live running CASH-sales total.
 */
router.get(
  '/current',
  requirePermission('shifts:read'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getTenantContext(res);
      const client = await getClient();
      try {
        const result = await client.query(
          `SELECT id AS shift_id, worker_tag, opened_at, opening_balance, status,
                  COALESCE((
                    SELECT SUM(total_amount)
                    FROM sales
                    WHERE tenant_id = $1
                      AND sale_timestamp >= cash_drawer_shifts.opened_at
                      AND payment_status = 'PAID'
                      AND payment_method = 'CASH'
                  ), 0) AS cash_sales_total,
                  COALESCE((
                    SELECT SUM(total_amount)
                    FROM sales
                    WHERE tenant_id = $1
                      AND sale_timestamp >= cash_drawer_shifts.opened_at
                      AND payment_status = 'PAID'
                  ), 0) AS all_sales_total,
                  COALESCE((
                    SELECT COUNT(*)
                    FROM sales
                    WHERE tenant_id = $1
                      AND sale_timestamp >= cash_drawer_shifts.opened_at
                      AND payment_status = 'PAID'
                  ), 0) AS sales_count
           FROM cash_drawer_shifts
           WHERE tenant_id = $1 AND closed_at IS NULL
           ORDER BY opened_at DESC
           LIMIT 1`,
          [ctx.tenantId],
        );

        if (result.rows.length === 0) {
          res.json({ status: 'NO_OPEN_SHIFT' });
          return;
        }

        res.json(coerceNumeric(result.rows[0], [
          'opening_balance', 'cash_sales_total', 'all_sales_total', 'sales_count',
        ]));
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Recent shift history (most recent first) — for reviewing past
 * reconciliations, catching repeat discrepancies, etc.
 */
router.get(
  '/history',
  requirePermission('shifts:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getTenantContext(res);
      const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? 20), 10) || 20, 1), 100);
      const client = await getClient();
      try {
        const result = await client.query(
          `SELECT id AS shift_id, worker_tag, closed_by_worker_tag, opened_at, closed_at,
                  opening_balance, sales_total, expected_cash, reported_cash, discrepancy, status
           FROM cash_drawer_shifts
           WHERE tenant_id = $1 AND closed_at IS NOT NULL
           ORDER BY opened_at DESC
           LIMIT $2`,
          [ctx.tenantId, limit],
        );
        res.json({
          shifts: result.rows.map((row) => coerceNumeric(row, [
            'opening_balance', 'sales_total', 'expected_cash', 'reported_cash', 'discrepancy',
          ])),
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Per-worker sales breakdown for the active shift window (or, when no shift
 * is currently open, the most recently closed shift's window) — powers the
 * "Staff Performance" view without requiring a separate per-worker
 * clock-in/out subsystem.
 */
router.get(
  '/staff-performance',
  requirePermission('shifts:read'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getTenantContext(res);
      const client = await getClient();
      try {
        const windowQ = await client.query<{ opened_at: string; is_open: boolean }>(
          `SELECT opened_at, (closed_at IS NULL) AS is_open
           FROM cash_drawer_shifts
           WHERE tenant_id = $1
           ORDER BY opened_at DESC
           LIMIT 1`,
          [ctx.tenantId],
        );

        if (windowQ.rows.length === 0) {
          res.json({ window_start: null, is_open: false, staff: [] });
          return;
        }

        const { opened_at: windowStart, is_open: isOpen } = windowQ.rows[0];

        const staffQ = await client.query(
          `SELECT u.id, u.full_name, u.role, u.worker_tag, u.is_active,
                  COALESCE(COUNT(s.id), 0)          AS sales_count,
                  COALESCE(SUM(s.total_amount), 0)  AS revenue
           FROM users u
           LEFT JOIN sales s
             ON s.tenant_id = u.tenant_id
            AND s.worker_tag = u.worker_tag
            AND s.sale_timestamp >= $2
            AND s.payment_status = 'PAID'
           WHERE u.tenant_id = $1 AND u.deleted_at IS NULL
           GROUP BY u.id, u.full_name, u.role, u.worker_tag, u.is_active
           ORDER BY revenue DESC`,
          [ctx.tenantId, windowStart],
        );

        res.json({
          window_start: windowStart,
          is_open: isOpen,
          staff: staffQ.rows.map((row) => coerceNumeric(row, ['sales_count', 'revenue'])),
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

export { router as shiftsRouter };
