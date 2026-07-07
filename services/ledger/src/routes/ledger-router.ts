import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { getTenantContext } from '@retail/middleware';
import { Errors, sendError } from '@retail/middleware';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const settleSchema = z.object({
  ledger_id: z.string().uuid(),
  amount: z.number().positive(),
  clientMutationId: z.string().uuid(),
});

/**
 * Settle a customer's balance using a FIFO allocation against historic credit
 * extension records. Writes immutable ledger_transactions and updates
 * customer_ledgers.total_debt.
 */
router.post('/settle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = settleSchema.parse(req.body);
    const ctx = getTenantContext(res);
    const orgId = ctx.tenantId;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      const ledgerQ = await client.query(
        `SELECT id, total_debt FROM customer_ledgers WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [body.ledger_id, orgId],
      );
      if (ledgerQ.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Customer ledger not found'));
        return;
      }

      const ledger = ledgerQ.rows[0];
      if (body.amount > Number(ledger.total_debt)) {
        await client.query('ROLLBACK');
        sendError(res, Errors.invalidRequest('Payment exceeds outstanding debt'));
        return;
      }

      // Fetch historical credits to allocate against (FIFO)
      const credits = await client.query(
        `SELECT id, amount_mutated, created_at
         FROM ledger_transactions
         WHERE ledger_id = $1 AND organization_id = $2 AND transaction_type = 'credit_extension'
         ORDER BY created_at ASC`,
        [body.ledger_id, orgId],
      );

      // Build allocation map (best-effort using historical amounts)
      let remaining = body.amount;
      const allocations: Array<{ credit_id: string; applied: number }> = [];
      for (const row of credits.rows) {
        if (remaining <= 0) break;
        const creditAmount = Number(row.amount_mutated);
        if (creditAmount <= 0) continue;
        const applied = Math.min(creditAmount, remaining);
        allocations.push({ credit_id: row.id, applied });
        remaining -= applied;
      }

      if (remaining > 0) {
        // Shouldn't happen because we checked total_debt, but guard anyway
        await client.query('ROLLBACK');
        sendError(res, Errors.internal('Allocation failed — insufficient credit records'));
        return;
      }

      // Create a payment transaction record
      const txId = uuidv4();
      await client.query(
        `INSERT INTO ledger_transactions (id, organization_id, ledger_id, amount_mutated, transaction_type, metadata)
         VALUES ($1,$2,$3,$4,'payment',$5::jsonb)`,
        [txId, orgId, body.ledger_id, body.amount, JSON.stringify({ allocations, clientMutationId: body.clientMutationId })],
      );

      // Decrement customer_ledgers.total_debt
      await client.query(
        `UPDATE customer_ledgers SET total_debt = total_debt - $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
        [body.amount, body.ledger_id, orgId],
      );

      // Immutable audit entry describing allocations
      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1,'ledger',$2,'SETTLE_PAYMENT',$3,$4::jsonb)`,
        [orgId, body.ledger_id, ctx.workerTag, JSON.stringify({ payment_tx: txId, amount: body.amount, allocations })],
      );

      await client.query('COMMIT');
      res.json({ ledger_id: body.ledger_id, settled: body.amount, payment_tx: txId, allocations });
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

export { router as ledgerRouter };
