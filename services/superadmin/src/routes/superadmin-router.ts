import { Router, Request, Response, NextFunction } from 'express';
import { getClient } from '@retail/db';
import { redis } from '@retail/redis';
import { requireSuperadmin, Errors, sendError } from '@retail/middleware';

const router = Router();

router.use(requireSuperadmin());

router.get('/health-metrics', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const totalTx = await client.query<{ count: string }>('SELECT COUNT(*) FROM sales');
    const lowStock = await client.query<{ count: string }>(
      'SELECT COUNT(*) FROM inventories WHERE stock_quantity <= reorder_level',
    );

    // Attempt to estimate BullMQ wait list length for sales-sync
    let syncBacklog = 0;
    try {
      const keys = await redis.keys('bull:sales-sync:batch*');
      for (const k of keys) {
        // look for wait list
        if (k.endsWith(':wait')) {
          const l = await redis.llen(k);
          syncBacklog += Number(l || 0);
        }
      }
    } catch (err) {
      // best-effort: ignore redis errors
    }

    res.json({
      total_transactions: Number(totalTx.rows[0].count || 0),
      global_low_stock_triggers: Number(lowStock.rows[0].count || 0),
      sync_pipeline_backlog: syncBacklog,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/anomalies', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id, tenant_id, entity_type, action, worker_tag, old_values, new_values, created_at
       FROM audit_logs
       WHERE (COALESCE(old_values::text, '') ILIKE '%ANOMALY-%' OR COALESCE(new_values::text, '') ILIKE '%ANOMALY-%'
         OR action ILIKE 'ANOMALY-%')
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    res.json({ anomalies: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.get('/tenants', async (_req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const rows = await client.query(
      `SELECT id AS organization_id, subscription_tier, owner_phone FROM organizations WHERE deleted_at IS NULL`,
    );
    res.json({ tenants: rows.rows, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

export { router as superadminRouter };
