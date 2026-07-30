import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { getTenantContext } from '@retail/middleware';
import { Errors, sendError } from '@retail/middleware';

const router = Router();

const closeSchema = z.object({
  shift_id: z.string().uuid(),
  reported_cash: z.number().nonnegative(),
});

const openSchema = z.object({
  opening_balance: z.number().nonnegative().default(0),
});

/**
 * Open a new cash drawer shift
 */
router.post('/open', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = openSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Close any open shift first
      await client.query(
        `UPDATE cash_drawer_shifts
         SET closed_at = NOW(), status = 'FORCE_CLOSED'
         WHERE organization_id = $1 AND closed_at IS NULL`,
        [orgId],
      );

      // Open new shift
      const shiftId = crypto.randomUUID();
      await client.query(
        `INSERT INTO cash_drawer_shifts (id, organization_id, worker_tag, opened_at, opening_balance, status)
         VALUES ($1, $2, $3, NOW(), $4, 'OPEN')`,
        [shiftId, orgId, ctx.workerTag, body.opening_balance],
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
});

/**
 * Close a cash drawer shift with reconciliation
 */
router.post('/close', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = closeSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      // Fetch shift with correct column names
      const shiftQ = await client.query(
        `SELECT id, worker_tag, opened_at, closed_at, status, opening_balance
         FROM cash_drawer_shifts
         WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [body.shift_id, orgId],
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
      const workerTag = shift.worker_tag;
      const openingBalance = Number(shift.opening_balance || 0);

      // Compute expected cash: sum of paid sales by worker_tag in shift window
      const salesQ = await client.query(
        `SELECT COALESCE(SUM(total_amount),0) AS expected_cash
         FROM sales
         WHERE tenant_id = $1
           AND worker_tag = $2
           AND sale_timestamp >= $3
           AND sale_timestamp <= NOW()
           AND payment_status = 'PAID'`,
        [orgId, workerTag, openedAt],
      );

      const salesTotal = Number(salesQ.rows[0]?.expected_cash ?? 0);
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
             sales_total = $5
         WHERE id = $6 AND organization_id = $7`,
        [expectedCash, reportedCash, discrepancy, status, salesTotal, body.shift_id, orgId],
      );

      // Audit log with proper JSON handling
      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
         VALUES ($1, 'cash_drawer_shift', $2, 'CLOSE_SHIFT', $3, $4::jsonb, $5::jsonb)`,
        [
          orgId,
          body.shift_id,
          ctx.workerTag,
          JSON.stringify(shift),
          JSON.stringify({ expectedCash, reportedCash, discrepancy, status, salesTotal })
        ],
      );

      await client.query('COMMIT');
      res.json({
        shift_id: body.shift_id,
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
});

/**
 * Get current shift status
 */
router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext(res);
    const client = await getClient();
    try {
      const result = await client.query(
        `SELECT id, worker_tag, opened_at, opening_balance, status,
                COALESCE((
                  SELECT SUM(total_amount)
                  FROM sales
                  WHERE tenant_id = $1
                    AND worker_tag = cash_drawer_shifts.worker_tag
                    AND sale_timestamp >= cash_drawer_shifts.opened_at
                    AND payment_status = 'PAID'
                ), 0) AS current_sales
         FROM cash_drawer_shifts
         WHERE organization_id = $1 AND closed_at IS NULL
         ORDER BY opened_at DESC
         LIMIT 1`,
        [ctx.tenantId],
      );
      
      if (result.rows.length === 0) {
        res.json({ status: 'NO_OPEN_SHIFT' });
        return;
      }
      
      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export { router as shiftsRouter };