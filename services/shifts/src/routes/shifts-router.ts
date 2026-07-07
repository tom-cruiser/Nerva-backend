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

router.post('/close', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = closeSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      // Fetch shift
      const shiftQ = await client.query(
        `SELECT id, worker_tag, opened_at, closed_at, status
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

      const expectedCash = Number(salesQ.rows[0]?.expected_cash ?? 0);
      const reportedCash = body.reported_cash;
      const discrepancy = Number((reportedCash - expectedCash).toFixed(2));
      const status = discrepancy !== 0 ? 'ANOMALY' : 'CLOSED';

      await client.query(
        `UPDATE cash_drawer_shifts
         SET closed_at = NOW(), expected_cash = $1, reported_cash = $2, discrepancy = $3, status = $4
         WHERE id = $5 AND organization_id = $6`,
        [expectedCash, reportedCash, discrepancy, status, body.shift_id, orgId],
      );

      // Audit log
      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
         VALUES ($1,'cash_drawer_shift',$2,'CLOSE_SHIFT',$3,$4::jsonb,$5::jsonb)`,
        [orgId, body.shift_id, ctx.workerTag, JSON.stringify(shift), JSON.stringify({ expectedCash, reportedCash, discrepancy, status })],
      );

      await client.query('COMMIT');
      res.json({ shift_id: body.shift_id, expected_cash: expectedCash, reported_cash: reportedCash, discrepancy, status });
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

export { router as shiftsRouter };
