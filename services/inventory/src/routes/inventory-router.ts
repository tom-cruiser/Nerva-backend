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

// =============================================================================
// PRODUCT VARIANTS  (packages/db/src/migrations/015_inventory_variants_and_suppliers.sql)
// =============================================================================

interface VariantRow {
  id:             string;
  product_id:     string;
  variant_sku:    string;
  variant_name:   string;
  unit_price:     string | null; // DECIMAL comes back as string; NULL = inherits parent price
  stock_quantity: number;
  version:        number;
  created_at:     string;
  updated_at:     string;
  deleted_at:     string | null;
}

function toVariant(row: VariantRow) {
  return {
    id:             row.id,
    product_id:     row.product_id,
    variant_sku:    row.variant_sku,
    variant_name:   row.variant_name,
    unit_price:     row.unit_price === null ? null : parseFloat(row.unit_price),
    stock_quantity: row.stock_quantity,
    version:        row.version,
    created_at:     row.created_at,
    updated_at:     row.updated_at,
    deleted_at:     row.deleted_at,
  };
}

const VARIANT_COLS = `
  id, product_id, variant_sku, variant_name,
  unit_price, stock_quantity, version, created_at, updated_at, deleted_at
`;

/** Confirm the parent product exists for this tenant (404s otherwise). */
async function requireProduct(tenantId: string, productId: string): Promise<{ id: string; product_sku: string } | null> {
  const result = await query<{ id: string; product_sku: string }>(
    `SELECT id, product_sku FROM inventories WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
    [tenantId, productId],
  );
  return result.rows[0] ?? null;
}

// ─── GET /api/v1/inventory/products/:id/variants ─────────────────────────────

inventoryRouter.get(
  '/products/:id/variants',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const product = await requireProduct(ctx.tenantId, req.params.id);
      if (!product) return next(Errors.notFound('Product not found'));

      const result = await query<VariantRow>(
        `SELECT ${VARIANT_COLS}
         FROM product_variants
         WHERE tenant_id = $1 AND product_id = $2 AND deleted_at IS NULL
         ORDER BY variant_name ASC`,
        [ctx.tenantId, req.params.id],
      );

      res.status(200).json({ variants: result.rows.map(toVariant) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/inventory/products/:id/variants ────────────────────────────

const createVariantSchema = z.object({
  variant_sku:    z.string().min(1).max(50),
  variant_name:   z.string().min(1).max(255),
  unit_price:     z.number().nonnegative().nullable().optional(),
  stock_quantity: z.number().int().nonnegative().default(0),
});

inventoryRouter.post(
  '/products/:id/variants',
  requirePermission('inventory:create'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const parsed = createVariantSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Variant validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const product = await requireProduct(ctx.tenantId, req.params.id);
      if (!product) return next(Errors.notFound('Product not found'));

      const d   = parsed.data;
      const sku = d.variant_sku.toUpperCase();
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const result = await client.query<VariantRow>(
          `INSERT INTO product_variants
             (tenant_id, product_id, variant_sku, variant_name,
              unit_price, stock_quantity, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           RETURNING ${VARIANT_COLS}`,
          [ctx.tenantId, req.params.id, sku, d.variant_name, d.unit_price ?? null, d.stock_quantity, ctx.userId],
        );

        const created = result.rows[0]!;

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'product_variant', $2, 'CREATE', $3, $4::jsonb)`,
          [ctx.tenantId, created.id, ctx.workerTag, JSON.stringify(d)],
        );

        await client.query('COMMIT');
        res.status(201).json(toVariant(created));
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        if ((err as { code?: string }).code === '23505') {
          return next(Errors.conflict(`A variant with SKU "${sku}" already exists`));
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

// ─── PATCH /api/v1/inventory/variants/:id ────────────────────────────────────

const patchVariantSchema = z.object({
  variant_name:   z.string().min(1).max(255).optional(),
  unit_price:     z.number().nonnegative().nullable().optional(),
  stock_quantity: z.number().int().nonnegative().optional(),
  /** Optimistic lock — send the version you last read. */
  version:        z.number().int().positive(),
}).refine(
  (d) => Object.keys(d).some((k) => k !== 'version'),
  'At least one field besides version must be provided',
);

inventoryRouter.patch(
  '/variants/:id',
  requirePermission('inventory:update'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { id } = req.params;
      const parsed = patchVariantSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Update validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const { version, ...fields } = parsed.data;
      const setClauses: string[] = ['version = $3', 'updated_by = $4', 'updated_at = NOW()'];
      const params: unknown[] = [ctx.tenantId, id, version + 1, ctx.userId];

      const updatableFields = ['variant_name', 'unit_price', 'stock_quantity'] as const;
      for (const field of updatableFields) {
        if (field in fields && fields[field] !== undefined) {
          params.push(fields[field as keyof typeof fields]);
          setClauses.push(`${field} = $${params.length}`);
        }
      }

      const client = await getClient();
      try {
        await client.query('BEGIN');

        const before = await client.query<VariantRow>(
          `SELECT ${VARIANT_COLS}
           FROM product_variants
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [ctx.tenantId, id],
        );

        if (!before.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Variant not found'));
        }

        if (before.rows[0].version !== version) {
          await client.query('ROLLBACK');
          return next(
            Errors.conflict('Optimistic lock conflict — variant was modified by another request', {
              expected: version,
              current:  before.rows[0].version,
            }),
          );
        }

        const result = await client.query<VariantRow>(
          `UPDATE product_variants
           SET ${setClauses.join(', ')}
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING ${VARIANT_COLS}`,
          params,
        );

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
           VALUES ($1, 'product_variant', $2, 'UPDATE', $3, $4::jsonb, $5::jsonb)`,
          [ctx.tenantId, id, ctx.workerTag, JSON.stringify(toVariant(before.rows[0])), JSON.stringify(fields)],
        );

        await client.query('COMMIT');
        res.status(200).json(toVariant(result.rows[0]!));
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

// ─── DELETE /api/v1/inventory/variants/:id ───────────────────────────────────

inventoryRouter.delete(
  '/variants/:id',
  requirePermission('inventory:delete'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { id } = req.params;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const result = await client.query<{ id: string; variant_sku: string }>(
          `UPDATE product_variants
           SET deleted_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING id, variant_sku`,
          [ctx.tenantId, id],
        );

        if (!result.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Variant not found'));
        }

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'product_variant', $2, 'SOFT_DELETE', $3, $4::jsonb)`,
          [ctx.tenantId, id, ctx.workerTag, JSON.stringify({ variant_sku: result.rows[0].variant_sku })],
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

// =============================================================================
// SUPPLIER LOGS  (packages/db/src/migrations/015_inventory_variants_and_suppliers.sql)
// =============================================================================

interface SupplierLogRow {
  id:                string;
  product_id:        string;
  product_sku:       string;
  supplier_name:     string;
  supplier_contact:  string | null;
  quantity_received: number;
  unit_cost:         string | null;
  received_at:       string;
  notes:             string | null;
  created_at:        string;
}

function toSupplierLog(row: SupplierLogRow) {
  return {
    id:                row.id,
    product_id:        row.product_id,
    product_sku:       row.product_sku,
    supplier_name:     row.supplier_name,
    supplier_contact:  row.supplier_contact,
    quantity_received: row.quantity_received,
    unit_cost:         row.unit_cost === null ? null : parseFloat(row.unit_cost),
    received_at:       row.received_at,
    notes:             row.notes,
    created_at:        row.created_at,
  };
}

const SUPPLIER_LOG_COLS = `
  id, product_id, product_sku, supplier_name, supplier_contact,
  quantity_received, unit_cost, received_at, notes, created_at
`;

// ─── GET /api/v1/inventory/products/:id/supplier-logs ────────────────────────

inventoryRouter.get(
  '/products/:id/supplier-logs',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const product = await requireProduct(ctx.tenantId, req.params.id);
      if (!product) return next(Errors.notFound('Product not found'));

      const limit  = Math.min(Math.max(parseInt(String(req.query['limit']  ?? 50), 10), 1), 200);
      const offset = Math.max(parseInt(String(req.query['offset'] ?? 0), 10), 0);

      const result = await query<SupplierLogRow>(
        `SELECT ${SUPPLIER_LOG_COLS}
         FROM supplier_logs
         WHERE tenant_id = $1 AND product_id = $2 AND deleted_at IS NULL
         ORDER BY received_at DESC
         LIMIT $3 OFFSET $4`,
        [ctx.tenantId, req.params.id, limit, offset],
      );

      res.status(200).json({ supplier_logs: result.rows.map(toSupplierLog) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/inventory/products/:id/supplier-logs ───────────────────────
//
// Recording a delivery also moves the needle on-hand: this is a *receiving*
// log, not a passive note, so it atomically bumps inventories.stock_quantity
// by quantity_received in the same transaction as the log insert. The
// resulting stock change is captured on the same audit_logs row as the log
// entry (details.stock_quantity_delta) rather than a second row, since it's
// one logical event.

const createSupplierLogSchema = z.object({
  supplier_name:     z.string().min(1).max(255),
  supplier_contact:  z.string().max(255).nullable().optional(),
  quantity_received: z.number().int().positive(),
  unit_cost:         z.number().nonnegative().nullable().optional(),
  received_at:       z.string().datetime().optional(),
  notes:             z.string().nullable().optional(),
});

inventoryRouter.post(
  '/products/:id/supplier-logs',
  requirePermission('inventory:create'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const parsed = createSupplierLogSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Supplier log validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const d = parsed.data;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const product = await client.query<{ id: string; product_sku: string }>(
          `SELECT id, product_sku FROM inventories
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [ctx.tenantId, req.params.id],
        );
        if (!product.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Product not found'));
        }

        const inserted = await client.query<SupplierLogRow>(
          `INSERT INTO supplier_logs
             (tenant_id, product_id, product_sku, supplier_name, supplier_contact,
              quantity_received, unit_cost, received_at, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), $9, $10)
           RETURNING ${SUPPLIER_LOG_COLS}`,
          [
            ctx.tenantId, req.params.id, product.rows[0].product_sku,
            d.supplier_name, d.supplier_contact ?? null,
            d.quantity_received, d.unit_cost ?? null,
            d.received_at ?? null, d.notes ?? null, ctx.userId,
          ],
        );

        await client.query(
          `UPDATE inventories
           SET stock_quantity = stock_quantity + $3, version = version + 1, updated_at = NOW(), updated_by = $4
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, req.params.id, d.quantity_received, ctx.userId],
        );

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'supplier_log', $2, 'CREATE', $3, $4::jsonb)`,
          [
            ctx.tenantId, inserted.rows[0]!.id, ctx.workerTag,
            JSON.stringify({ ...d, stock_quantity_delta: d.quantity_received, product_id: req.params.id }),
          ],
        );

        await client.query('COMMIT');
        res.status(201).json(toSupplierLog(inserted.rows[0]!));
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
