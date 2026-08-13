import { Router, Request, Response, NextFunction } from 'express';
import { z }                from 'zod';
import { getClient, query } from '@retail/db';
import { getTenantContext, Errors, requirePermission } from '@retail/middleware';

/**
 * Batch / expiry / markdown routes for the inventory service.
 *
 * All routes sit under /api/v1/inventory and inherit the
 * tenantContextMiddleware applied in app.ts.
 *
 * DB tables used (from 001_initial_schema.sql):
 *   inventories  — products (tenant_id + product_sku unique)
 *   audit_logs   — append-only change trail
 *
 * Note: there is no dedicated `product_batches` table in the current schema.
 * Batch / expiry tracking is modelled as a JSONB column on `inventories`
 * (`config` JSONB on the tenant row is available too, but per-product batch
 * data lives inline on the inventory row until a dedicated migration adds it).
 * The markdown endpoint updates `unit_price` directly on `inventories`.
 */

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Record a batch against an existing inventory item.
 * Stored as a JSONB entry in inventories.config['batches'].
 */
const batchSchema = z.object({
  product_id:     z.string().uuid('product_id must be a UUID'),
  batch_number:   z.string().min(1).max(100),
  expiry_date:    z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'expiry_date must be a valid ISO date' }),
  stock_quantity: z.number().int().nonnegative(),
});

/**
 * Apply a markdown (price reduction) to an existing inventory item.
 * Updates unit_price on `inventories` and writes an audit entry.
 */
const markdownSchema = z.object({
  product_id:    z.string().uuid('product_id must be a UUID'),
  /** New reduced unit price — must be > 0 and lower than current price. */
  selling_price: z.number().positive('selling_price must be > 0'),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface InventoryRow {
  id:         string;
  unit_price: string;
  config:     Record<string, unknown> | null;
  version:    number;
  product_sku: string;
}

// ─── POST /api/v1/inventory/batches ──────────────────────────────────────────

/**
 * Record a new expiry batch against an inventory item.
 *
 * Batch metadata is stored in inventories.config['batches'] as a JSONB array
 * until a dedicated `inventory_batches` table is added via migration.
 *
 * Requires: inventory:update
 */
router.post(
  '/batches',
  requirePermission('inventory:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        Errors.invalidRequest('Batch validation failed', {
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        }),
      );
    }

    const ctx    = getTenantContext(res);
    const d      = parsed.data;
    const client = await getClient();

    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      // Verify the product belongs to this tenant
      const product = await client.query<InventoryRow>(
        `SELECT id, config, version, product_sku
         FROM inventories
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [ctx.tenantId, d.product_id],
      );

      if (!product.rows[0]) {
        await client.query('ROLLBACK');
        return next(Errors.notFound('Product not found'));
      }

      const row       = product.rows[0];
      const existing  = (row.config ?? {}) as Record<string, unknown>;
      const batches   = Array.isArray(existing['batches']) ? existing['batches'] : [];

      const newBatch = {
        batch_number:   d.batch_number,
        expiry_date:    d.expiry_date,
        stock_quantity: d.stock_quantity,
        recorded_at:    new Date().toISOString(),
        recorded_by:    ctx.workerTag,
      };

      const updatedConfig = { ...existing, batches: [...batches, newBatch] };

      // Also add batch stock to the main stock_quantity, bump version
      await client.query(
        `UPDATE inventories
         SET config         = $1::jsonb,
             stock_quantity = stock_quantity + $2,
             version        = $3,
             updated_by     = $4,
             updated_at     = NOW()
         WHERE tenant_id = $5 AND id = $6`,
        [
          JSON.stringify(updatedConfig),
          d.stock_quantity,
          row.version + 1,
          ctx.userId,
          ctx.tenantId,
          d.product_id,
        ],
      );

      await client.query(
        `INSERT INTO audit_logs
           (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
         VALUES ($1, 'inventory', $2, 'UPDATE', $3, $4::jsonb)`,
        [ctx.tenantId, d.product_id, ctx.workerTag, JSON.stringify(newBatch)],
      );

      await client.query('COMMIT');

      res.status(201).json({
        product_id:  d.product_id,
        tenant_id:   ctx.tenantId,
        batch:       newBatch,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ─── GET /api/v1/inventory/expired-alerts ────────────────────────────────────

/**
 * Return all inventory items that have at least one batch expiring within
 * 30 days and still have stock remaining.
 *
 * Requires: inventory:read
 */
router.get(
  '/expired-alerts',
  requirePermission('inventory:read'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getTenantContext(res);

      // Pull all products with a non-empty batches array in config
      const result = await query<{
        id:          string;
        product_sku: string;
        name:        string;
        config:      Record<string, unknown> | null;
      }>(
        `SELECT id, product_sku, name, config
         FROM inventories
         WHERE tenant_id    = $1
           AND deleted_at   IS NULL
           AND stock_quantity > 0
           AND config->'batches' IS NOT NULL`,
        [ctx.tenantId],
      );

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + 30);

      const expiring: unknown[] = [];

      for (const row of result.rows) {
        const batches = (row.config?.['batches'] as Array<{
          batch_number:   string;
          expiry_date:    string;
          stock_quantity: number;
        }> | undefined) ?? [];

        for (const batch of batches) {
          if (
            batch.stock_quantity > 0 &&
            new Date(batch.expiry_date) <= cutoff
          ) {
            expiring.push({
              product_id:     row.id,
              product_sku:    row.product_sku,
              name:           row.name,
              batch_number:   batch.batch_number,
              expiry_date:    batch.expiry_date,
              stock_quantity: batch.stock_quantity,
            });
          }
        }
      }

      // Sort soonest-expiring first
      (expiring as Array<{ expiry_date: string }>).sort(
        (a, b) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime(),
      );

      res.json({ expiring_batches: expiring, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /api/v1/inventory/markdown ────────────────────────────────────────

/**
 * Apply a markdown (price reduction) to an inventory item.
 * Uses optimistic locking — reads the current version, requires the caller
 * to send it, and rejects concurrent modifications.
 *
 * Requires: inventory:update
 */
const markdownWithVersionSchema = markdownSchema.extend({
  /** Current version of the row (optimistic lock). */
  version: z.number().int().positive(),
});

router.patch(
  '/markdown',
  requirePermission('inventory:update'),
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = markdownWithVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        Errors.invalidRequest('Markdown validation failed', {
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        }),
      );
    }

    const ctx    = getTenantContext(res);
    const d      = parsed.data;
    const client = await getClient();

    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

      const before = await client.query<InventoryRow>(
        `SELECT id, unit_price, version, product_sku
         FROM inventories
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [ctx.tenantId, d.product_id],
      );

      if (!before.rows[0]) {
        await client.query('ROLLBACK');
        return next(Errors.notFound('Product not found'));
      }

      const row = before.rows[0];

      if (row.version !== d.version) {
        await client.query('ROLLBACK');
        return next(
          Errors.conflict('Optimistic lock conflict — product was modified by another request', {
            expected: d.version,
            current:  row.version,
          }),
        );
      }

      const oldPrice = parseFloat(row.unit_price);

      if (d.selling_price >= oldPrice) {
        await client.query('ROLLBACK');
        return next(
          Errors.invalidRequest(
            `selling_price (${d.selling_price}) must be less than current unit_price (${oldPrice})`,
          ),
        );
      }

      await client.query(
        `UPDATE inventories
         SET unit_price  = $1,
             version     = $2,
             updated_by  = $3,
             updated_at  = NOW()
         WHERE tenant_id = $4 AND id = $5`,
        [d.selling_price, row.version + 1, ctx.userId, ctx.tenantId, d.product_id],
      );

      await client.query(
        `INSERT INTO audit_logs
           (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
         VALUES ($1, 'inventory', $2, 'UPDATE', $3, $4::jsonb, $5::jsonb)`,
        [
          ctx.tenantId,
          d.product_id,
          ctx.workerTag,
          JSON.stringify({ unit_price: oldPrice }),
          JSON.stringify({ unit_price: d.selling_price }),
        ],
      );

      await client.query('COMMIT');

      res.json({
        product_id:    d.product_id,
        product_sku:   row.product_sku,
        old_price:     oldPrice,
        selling_price: d.selling_price,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

export { router as batchesRouter };
