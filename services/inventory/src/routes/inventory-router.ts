import { Router, Request, Response, NextFunction } from 'express';
import { z }                              from 'zod';
import { query, getClient }              from '@retail/db';
import { getTenantContext, requirePermission, Errors } from '@retail/middleware';

const inventoryRouter = Router();

// ─── DB row shape ─────────────────────────────────────────────────────────────

interface InventoryRow {
  id:             string;
  product_sku:    string;
  barcode:        string | null;
  name:           string;
  description:    string | null;
  unit_price:     string; // DECIMAL comes back as string from the pg driver
  stock_quantity: number;
  reorder_level:  number;
  category:       string | null;
  updated_at:     string;
  deleted_at:     string | null;
}

/** Coerce Postgres DECIMAL string → number so the frontend Product type is satisfied. */
function toProduct(row: InventoryRow) {
  return {
    id:             row.id,
    product_sku:    row.product_sku,
    barcode:        row.barcode,
    name:           row.name,
    description:    row.description,
    unit_price:     parseFloat(row.unit_price),
    stock_quantity: row.stock_quantity,
    reorder_level:  row.reorder_level,
    category:       row.category,
    updated_at:     row.updated_at,
    deleted_at:     row.deleted_at,
  };
}

// ─── SELECT columns reused in every query ────────────────────────────────────

const PRODUCT_COLS = `
  id, product_sku, barcode, name, description,
  unit_price, stock_quantity, reorder_level, category,
  updated_at, deleted_at
`;

// ─── GET /api/v1/inventory/products ──────────────────────────────────────────

/**
 * List active products for the authenticated tenant.
 *
 * Query params:
 *   q         — case-insensitive search on name or SKU
 *   category  — exact category filter
 *   low_stock — "true" to return only products at or below reorder_level
 *   limit     — page size 1-500 (default 200)
 *   offset    — pagination offset (default 0)
 *
 * Response: { products, total, limit, offset }
 */
inventoryRouter.get(
  '/products',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);

      const search   = typeof req.query['q']        === 'string' ? req.query['q'].trim()        : '';
      const category = typeof req.query['category'] === 'string' ? req.query['category'].trim() : '';
      const lowStock = req.query['low_stock'] === 'true';
      const limit    = Math.min(Math.max(parseInt(String(req.query['limit']  ?? 200), 10), 1), 500);
      const offset   = Math.max(parseInt(String(req.query['offset'] ?? 0), 10), 0);

      // Build WHERE dynamically; $1 is always tenant_id
      const conditions: string[] = ['tenant_id = $1', 'deleted_at IS NULL'];
      const params: unknown[]    = [ctx.tenantId];

      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const n = params.length;
        conditions.push(`(LOWER(name) LIKE $${n} OR LOWER(product_sku) LIKE $${n})`);
      }

      if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }

      if (lowStock) {
        conditions.push('stock_quantity <= reorder_level');
      }

      const where = conditions.join(' AND ');

      // Total count for pagination metadata (same WHERE, no LIMIT/OFFSET)
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM inventories WHERE ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      // Data page
      params.push(limit, offset);
      const dataResult = await query<InventoryRow>(
        `SELECT ${PRODUCT_COLS}
         FROM inventories
         WHERE ${where}
         ORDER BY name ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      res.status(200).json({
        products: dataResult.rows.map(toProduct),
        total,
        limit,
        offset,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/inventory/products/:id ──────────────────────────────────────

/**
 * Fetch a single product by UUID. Returns 404 when not found or soft-deleted.
 * Requires: inventory:read
 */
inventoryRouter.get(
  '/products/:id',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { id } = req.params;

      const result = await query<InventoryRow>(
        `SELECT ${PRODUCT_COLS}
         FROM inventories
         WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [ctx.tenantId, id],
      );

      if (!result.rows[0]) {
        return next(Errors.notFound('Product not found'));
      }

      res.status(200).json(toProduct(result.rows[0]));
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/inventory/products ─────────────────────────────────────────

const createSchema = z.object({
  product_sku:    z.string().min(1).max(50),
  name:           z.string().min(1).max(255),
  unit_price:     z.number().nonnegative(),
  stock_quantity: z.number().int().nonnegative().default(0),
  reorder_level:  z.number().int().nonnegative().default(0),
  barcode:        z.string().max(100).nullable().optional(),
  description:    z.string().nullable().optional(),
  category:       z.string().max(100).nullable().optional(),
});

/**
 * Create a new product for the tenant.
 * Idempotent: duplicate (tenant_id, product_sku) returns 409.
 * Requires: inventory:create
 */
inventoryRouter.post(
  '/products',
  requirePermission('inventory:create'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const parsed = createSchema.safeParse(req.body);

      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Product validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const d      = parsed.data;
      const sku    = d.product_sku.toUpperCase();
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const result = await client.query<InventoryRow>(
          `INSERT INTO inventories
             (tenant_id, product_sku, barcode, name, description,
              unit_price, stock_quantity, reorder_level, category,
              created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
           RETURNING ${PRODUCT_COLS}`,
          [
            ctx.tenantId,
            sku,
            d.barcode        ?? null,
            d.name,
            d.description    ?? null,
            d.unit_price,
            d.stock_quantity,
            d.reorder_level,
            d.category       ?? null,
            ctx.userId,
          ],
        );

        const created = result.rows[0]!;

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'inventory', $2, 'CREATE', $3, $4::jsonb)`,
          [ctx.tenantId, created.id, ctx.workerTag, JSON.stringify(d)],
        );

        await client.query('COMMIT');
        res.status(201).json(toProduct(created));
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        // Postgres unique constraint violation
        if ((err as { code?: string }).code === '23505') {
          return next(Errors.conflict(`A product with SKU "${sku}" already exists`));
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /api/v1/inventory/products/:id ────────────────────────────────────

const patchSchema = z.object({
  name:           z.string().min(1).max(255).optional(),
  unit_price:     z.number().nonnegative().optional(),
  stock_quantity: z.number().int().nonnegative().optional(),
  reorder_level:  z.number().int().nonnegative().optional(),
  barcode:        z.string().max(100).nullable().optional(),
  description:    z.string().nullable().optional(),
  category:       z.string().max(100).nullable().optional(),
  /** Optimistic lock — send the version you last read. */
  version:        z.number().int().positive(),
}).refine(
  (d) => Object.keys(d).some((k) => k !== 'version'),
  'At least one field besides version must be provided',
);

/**
 * Partially update a product.
 * Uses optimistic locking: the `version` field is required and must match the
 * current DB version (fn_bump_version trigger increments it on every UPDATE).
 * Requires: inventory:update
 */
inventoryRouter.patch(
  '/products/:id',
  requirePermission('inventory:update'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const { id } = req.params;
      const parsed = patchSchema.safeParse(req.body);

      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Update validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const { version, ...fields } = parsed.data;

      // Build SET clause from whatever fields were provided
      const setClauses: string[] = [`version = $3`, `updated_by = $4`, `updated_at = NOW()`];
      const params: unknown[]    = [ctx.tenantId, id, version + 1, ctx.userId];

      const updatableFields = [
        'name', 'unit_price', 'stock_quantity', 'reorder_level',
        'barcode', 'description', 'category',
      ] as const;

      for (const field of updatableFields) {
        if (field in fields && fields[field] !== undefined) {
          params.push(fields[field as keyof typeof fields]);
          setClauses.push(`${field} = $${params.length}`);
        }
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');

        // Read old values for audit log
        const before = await client.query<InventoryRow>(
          `SELECT ${PRODUCT_COLS}, version
           FROM inventories
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [ctx.tenantId, id],
        );

        if (!before.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Product not found'));
        }

        const currentVersion = (before.rows[0] as InventoryRow & { version: number }).version;
        if (currentVersion !== version) {
          await client.query('ROLLBACK');
          return next(
            Errors.conflict('Optimistic lock conflict — product was modified by another request', {
              expected: version,
              current:  currentVersion,
            }),
          );
        }

        const result = await client.query<InventoryRow>(
          `UPDATE inventories
           SET ${setClauses.join(', ')}
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING ${PRODUCT_COLS}`,
          params,
        );

        if (!result.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Product not found'));
        }

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
           VALUES ($1, 'inventory', $2, 'UPDATE', $3, $4::jsonb, $5::jsonb)`,
          [
            ctx.tenantId,
            id,
            ctx.workerTag,
            JSON.stringify(toProduct(before.rows[0])),
            JSON.stringify(fields),
          ],
        );

        await client.query('COMMIT');
        res.status(200).json(toProduct(result.rows[0]));
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

// ─── DELETE /api/v1/inventory/products/:id ───────────────────────────────────

/**
 * Soft-delete a product (sets deleted_at = NOW()).
 * The record is retained for audit trails and offline-sync tombstone propagation.
 * Requires: inventory:delete
 */
inventoryRouter.delete(
  '/products/:id',
  requirePermission('inventory:delete'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const { id } = req.params;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const result = await client.query<{ id: string; product_sku: string }>(
          `UPDATE inventories
           SET deleted_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING id, product_sku`,
          [ctx.tenantId, id],
        );

        if (!result.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Product not found'));
        }

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'inventory', $2, 'SOFT_DELETE', $3, $4::jsonb)`,
          [
            ctx.tenantId,
            id,
            ctx.workerTag,
            JSON.stringify({ product_sku: result.rows[0].product_sku }),
          ],
        );

        await client.query('COMMIT');
        res.status(204).end();
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

export { inventoryRouter };
