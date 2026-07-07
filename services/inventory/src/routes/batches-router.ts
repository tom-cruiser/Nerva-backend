import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getClient } from '@retail/db';
import { getTenantContext } from '@retail/middleware';
import { Errors, sendError } from '@retail/middleware';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const batchSchema = z.object({
  product_id: z.string().uuid(),
  batch_number: z.string().min(1),
  expiry_date: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  stock_quantity: z.number().int().nonnegative(),
});

const markdownSchema = z.object({
  product_id: z.string().uuid(),
  selling_price: z.number().positive(),
  clientMutationId: z.string().uuid(),
});

// helper to get org id
function getOrgId(res: Response) {
  const ctx = getTenantContext(res);
  return ctx.tenantId;
}

router.post('/batches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = batchSchema.parse(req.body);
    const orgId = getOrgId(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");

      const id = uuidv4();
      await client.query(
        `INSERT INTO product_batches
          (id, organization_id, product_id, batch_number, expiry_date, stock_quantity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, orgId, parsed.product_id, parsed.batch_number, parsed.expiry_date, parsed.stock_quantity],
      );

      // write audit log
      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1,'product_batch',$2,'CREATE',$3,$4::jsonb)`,
        [orgId, id, (res.locals['tenant'] as any)?.workerTag ?? 'system', JSON.stringify(parsed)],
      );

      await client.query('COMMIT');
      res.status(201).json({ id, organization_id: orgId });
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

router.get('/expired-alerts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(res);
    const client = await getClient();
    try {
      const rows = await client.query(
        `SELECT id, product_id, batch_number, expiry_date, stock_quantity
         FROM product_batches
         WHERE organization_id = $1
           AND stock_quantity > 0
           AND expiry_date <= (NOW() + INTERVAL '30 days')
         ORDER BY expiry_date ASC`,
        [orgId],
      );
      res.json({ expiring_batches: rows.rows, timestamp: new Date().toISOString() });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/markdown', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = markdownSchema.parse(req.body);
    const orgId = getOrgId(res);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      // Ensure product exists and fetch buying_price
      const p = await client.query(
        `SELECT id, buying_price, selling_price FROM products WHERE id = $1 AND organization_id = $2 LIMIT 1`,
        [body.product_id, orgId],
      );
      if (p.rows.length === 0) {
        await client.query('ROLLBACK');
        sendError(res, Errors.notFound('Product not found'));
        return;
      }

      const existing = p.rows[0];

      // Update only selling_price (markdown), keep buying_price intact
      await client.query(
        `UPDATE products SET selling_price = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
        [body.selling_price, body.product_id, orgId],
      );

      // Audit record showing markdown change
      await client.query(
        `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
         VALUES ($1,'product',$2,'MARKDOWN',$3,$4::jsonb,$5::jsonb)`,
        [orgId, body.product_id, (res.locals['tenant'] as any)?.workerTag ?? 'system', JSON.stringify({ selling_price: existing.selling_price }), JSON.stringify({ selling_price: body.selling_price })],
      );

      await client.query('COMMIT');
      res.json({ product_id: body.product_id, selling_price: body.selling_price });
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

export { router as batchesRouter };
