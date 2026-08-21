import { Router, Request, Response, NextFunction } from 'express';
import { z }                              from 'zod';
import Papa                               from 'papaparse';
import ExcelJS                            from 'exceljs';
import multer                             from 'multer';
import { query, getClient }              from '@retail/db';
import { getTenantContext, requirePermission, requireAnyPermission, Errors } from '@retail/middleware';

const inventoryRouter = Router();

// ─── DB row shape ─────────────────────────────────────────────────────────────

interface InventoryRow {
  id:               string;
  product_sku:      string;
  barcode:          string | null;
  name:             string;
  description:      string | null;
  unit_price:       string; // DECIMAL comes back as string from the pg driver
  // stock_quantity is DECIMAL(12,3) as of migration 019 (was INTEGER) — also
  // comes back as a string, same reason. Fractional selling-unit deductions
  // (1.5 kg, 0.5 L) require this; see product_units/reserveStockForSale.
  stock_quantity:   string;
  reorder_level:    number;
  reorder_quantity: string | null; // DECIMAL, nullable — no default recommended reorder size until set
  base_unit:        string;
  category:         string | null;
  // Nullable cost basis (021_whatsapp_reports.sql) — powers the Reports
  // page's Net Profit metric. No default: a product with no cost set is
  // excluded from profit calcs rather than assumed to cost 0.
  cost_price:       string | null;
  // Percentage tax rate the owner sets per product (025_inventory_tax_rate.sql)
  // — NOT NULL, unlike cost_price, since "unset" and "0% tax" mean the same
  // thing here and a product should never be excluded from a tax total for
  // lack of one.
  tax_rate:         string;
  version:          number;
  updated_at:       string;
  deleted_at:       string | null;
}

/** Coerce Postgres DECIMAL strings → numbers so the frontend Product type is satisfied. */
function toProduct(row: InventoryRow) {
  return {
    id:               row.id,
    product_sku:      row.product_sku,
    barcode:          row.barcode,
    name:             row.name,
    description:      row.description,
    unit_price:       parseFloat(row.unit_price),
    stock_quantity:   parseFloat(row.stock_quantity),
    reorder_level:    row.reorder_level,
    reorder_quantity: row.reorder_quantity === null ? null : parseFloat(row.reorder_quantity),
    base_unit:        row.base_unit,
    category:         row.category,
    cost_price:       row.cost_price === null ? null : parseFloat(row.cost_price),
    tax_rate:         parseFloat(row.tax_rate),
    // Confirmed-broken bug fix: the product response never included
    // `version` even though PATCH /products/:id has always required it for
    // its optimistic lock — the frontend had no way to send back a value it
    // was never given. Now included on every product response.
    version:          row.version,
    updated_at:       row.updated_at,
    deleted_at:       row.deleted_at,
  };
}

// ─── SELECT columns reused in every query ────────────────────────────────────

const PRODUCT_COLS = `
  id, product_sku, barcode, name, description,
  unit_price, stock_quantity, reorder_level, reorder_quantity, base_unit, category, cost_price, tax_rate,
  version, updated_at, deleted_at
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

// ─── GET /api/v1/inventory/products/low-stock ────────────────────────────────
//
// IMPORTANT: registered here, BEFORE the /products/:id route below. Express
// matches routes in registration order and `:id` matches any single path
// segment — if this were appended at the end of the file (the naive place
// to add a new /products/* route), a request to /products/low-stock would
// be swallowed by /products/:id with id='low-stock' instead of ever
// reaching this handler. Same reasoning applies to /export and /import
// immediately below.

interface LowStockRow {
  id:                        string;
  product_sku:               string;
  name:                      string;
  category:                  string | null;
  unit_price:                string;
  stock_quantity:            string;
  reorder_level:             number;
  reorder_quantity:          string | null;
  base_unit:                 string;
  supplier_name:             string | null;
  supplier_contact:          string | null;
  unit_cost:                 string | null;
  last_reorder_triggered_at: string | null;
}

/**
 * Aggregates every low-stock item for the tenant and groups them into draft
 * purchase orders by preferred supplier. There is no suppliers directory in
 * this schema (inventories.supplier_id is a bare UUID with no FK) — the
 * "preferred supplier" is honestly derived as the most recent supplier_logs
 * receiving-event per product, grouped under 'Unassigned' when a product has
 * no receiving history at all, rather than a fabricated field.
 *
 * Capped at 500 rows, matching the discipline the existing
 * ?low_stock=true list-route filter already applies.
 */
inventoryRouter.get(
  '/products/low-stock',
  requirePermission('inventory:read'),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);

      const result = await query<LowStockRow>(
        `SELECT i.id, i.product_sku, i.name, i.category, i.unit_price, i.stock_quantity,
                i.reorder_level, i.reorder_quantity, i.base_unit,
                sl.supplier_name, sl.supplier_contact, sl.unit_cost,
                rl.last_reorder_triggered_at
         FROM inventories i
         LEFT JOIN LATERAL (
           SELECT supplier_name, supplier_contact, unit_cost
           FROM supplier_logs
           WHERE tenant_id = i.tenant_id AND product_id = i.id AND deleted_at IS NULL
           ORDER BY received_at DESC
           LIMIT 1
         ) sl ON true
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_reorder_triggered_at
           FROM inventory_reorder_logs
           WHERE product_id = i.id
         ) rl ON true
         WHERE i.tenant_id = $1 AND i.deleted_at IS NULL AND i.stock_quantity <= i.reorder_level
         ORDER BY i.name ASC
         LIMIT 500`,
        [ctx.tenantId],
      );

      const products = result.rows.map((row) => ({
        id:                       row.id,
        product_sku:              row.product_sku,
        name:                     row.name,
        category:                 row.category,
        unit_price:               parseFloat(row.unit_price),
        stock_quantity:           parseFloat(row.stock_quantity),
        reorder_level:            row.reorder_level,
        reorder_quantity:         row.reorder_quantity === null ? null : parseFloat(row.reorder_quantity),
        base_unit:                row.base_unit,
        supplier_name:            row.supplier_name,
        last_reorder_triggered_at: row.last_reorder_triggered_at,
      }));

      // Group into draft purchase orders by preferred supplier.
      const groups = new Map<string, {
        supplierName: string; supplierContact: string | null;
        items: Array<{ product_sku: string; name: string; reorder_quantity: number | null; unit_cost: number | null }>;
        estimatedTotal: number;
      }>();

      for (const row of result.rows) {
        const key = row.supplier_name ?? 'Unassigned';
        if (!groups.has(key)) {
          groups.set(key, {
            supplierName: key,
            supplierContact: row.supplier_contact,
            items: [],
            estimatedTotal: 0,
          });
        }
        const group = groups.get(key)!;
        const reorderQty = row.reorder_quantity === null ? null : parseFloat(row.reorder_quantity);
        const unitCost = row.unit_cost === null ? null : parseFloat(row.unit_cost);
        group.items.push({ product_sku: row.product_sku, name: row.name, reorder_quantity: reorderQty, unit_cost: unitCost });
        if (reorderQty !== null && unitCost !== null) {
          group.estimatedTotal += reorderQty * unitCost;
        }
      }

      res.status(200).json({
        products,
        draftPurchaseOrders: Array.from(groups.values()),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/inventory/products/export ───────────────────────────────────
// Registered before /products/:id — see the route-shadowing note above.

interface ExportRow {
  product_sku:    string;
  name:           string;
  category:       string | null;
  base_unit:      string;
  selling_units:  string;
  unit_price:     string;
  stock_quantity: string;
  reorder_level:  number;
  supplier_name:  string | null;
}

/**
 * Streams every non-deleted product as a .csv or .xlsx download. Uses
 * papaparse for CSV (handles comma/quote/newline escaping correctly —
 * hand-rolled `join(',')` would silently corrupt a product name containing
 * a comma) and exceljs for XLSX, so both formats share the same column set.
 */
inventoryRouter.get(
  '/products/export',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const format = (typeof req.query['format'] === 'string' ? req.query['format'] : 'csv').toLowerCase();
      if (format !== 'csv' && format !== 'xlsx') {
        return next(Errors.invalidRequest('format must be "csv" or "xlsx"'));
      }

      const result = await query<ExportRow>(
        `SELECT i.product_sku, i.name, i.category, i.base_unit, i.unit_price,
                i.stock_quantity, i.reorder_level,
                sl.supplier_name,
                COALESCE(
                  (SELECT string_agg(pu.unit_name, ', ' ORDER BY pu.unit_name)
                   FROM product_units pu
                   WHERE pu.product_id = i.id AND pu.deleted_at IS NULL),
                  ''
                ) AS selling_units
         FROM inventories i
         LEFT JOIN LATERAL (
           SELECT supplier_name FROM supplier_logs
           WHERE tenant_id = i.tenant_id AND product_id = i.id AND deleted_at IS NULL
           ORDER BY received_at DESC LIMIT 1
         ) sl ON true
         WHERE i.tenant_id = $1 AND i.deleted_at IS NULL
         ORDER BY i.name ASC`,
        [ctx.tenantId],
      );

      const columns = ['SKU', 'Name', 'Category', 'Base Unit', 'Selling Units', 'Unit Price', 'Current Stock', 'Min Stock Level', 'Supplier'];
      const rows = result.rows.map((r) => ({
        SKU: r.product_sku,
        Name: r.name,
        Category: r.category ?? '',
        'Base Unit': r.base_unit,
        'Selling Units': r.selling_units,
        'Unit Price': parseFloat(r.unit_price),
        'Current Stock': parseFloat(r.stock_quantity),
        'Min Stock Level': r.reorder_level,
        Supplier: r.supplier_name ?? '',
      }));

      const filenameBase = `inventory-export-${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        const csv = Papa.unparse(rows.length > 0 ? rows : { fields: columns, data: [] });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
        res.status(200).send(csv);
        return;
      }

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Inventory');
      sheet.columns = columns.map((header) => ({ header, key: header }));
      sheet.addRows(rows);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
      res.status(200).send(Buffer.from(buffer));
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/inventory/products/import ──────────────────────────────────
// Registered before /products/:id — see the route-shadowing note above.

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_IMPORT_ROWS = 5000;

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_BYTES },
});

interface ImportRowError {
  row:     number;
  sku?:    string;
  message: string;
}

interface ParsedImportRow {
  /** 1-based, matching the spreadsheet's own row numbering (row 1 = header). */
  rowNumber: number;
  fields:    Record<string, string>;
}

/**
 * Normalizes a raw spreadsheet header to one of the canonical field keys
 * below — case/whitespace-insensitive, tolerates a handful of common
 * synonyms. A user-authored import file isn't guaranteed to use the exact
 * header text this service's own /products/export produces.
 */
const HEADER_ALIASES: Record<string, string> = {
  sku: 'product_sku', 'product sku': 'product_sku', product_sku: 'product_sku', barcode: 'product_sku',
  name: 'name', 'product name': 'name',
  price: 'unit_price', 'unit price': 'unit_price', unit_price: 'unit_price',
  'base unit': 'base_unit', base_unit: 'base_unit', unit: 'base_unit',
  stock: 'stock_quantity', 'current stock': 'stock_quantity', stock_quantity: 'stock_quantity', quantity: 'stock_quantity',
  'min stock level': 'reorder_level', 'reorder level': 'reorder_level', reorder_level: 'reorder_level',
  'reorder quantity': 'reorder_quantity', reorder_quantity: 'reorder_quantity',
  category: 'category',
};

function normalizeHeader(raw: string): string | null {
  return HEADER_ALIASES[raw.trim().toLowerCase()] ?? null;
}

function parseImportCsv(buffer: Buffer): ParsedImportRow[] {
  const parsed = Papa.parse<Record<string, string>>(buffer.toString('utf-8'), {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((raw, i) => {
    const fields: Record<string, string> = {};
    for (const [header, value] of Object.entries(raw)) {
      const key = normalizeHeader(header);
      if (key) fields[key] = String(value ?? '').trim();
    }
    return { rowNumber: i + 2, fields }; // +2: 1-based data row, after the header row
  });
}

async function parseImportXlsx(buffer: Buffer): Promise<ParsedImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled Buffer type and this workspace's resolved @types/node
  // Buffer are two structurally-incompatible declarations of the same
  // runtime type (a duplicate-@types/node hoisting artifact, not a real
  // type error — both are genuine Node.js Buffers at runtime). Routed
  // through `unknown` rather than `any` to keep the cast narrowly scoped to
  // this one known-safe mismatch.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerByColumn: Record<number, string> = {};
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const key = normalizeHeader(String(cell.value ?? ''));
    if (key) headerByColumn[colNumber] = key;
  });

  const rows: ParsedImportRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const fields: Record<string, string> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headerByColumn[colNumber];
      if (key) fields[key] = String(cell.value ?? '').trim();
    });
    if (Object.values(fields).some((v) => v !== '')) {
      rows.push({ rowNumber, fields });
    }
  });
  return rows;
}

/**
 * Bulk upsert-by-SKU from an uploaded .csv/.xlsx file. Required columns:
 * SKU/Barcode, Name, Price, Base Unit, Stock — a row missing any of these,
 * or with an unparseable numeric value, is skipped and reported in
 * `errors` WITHOUT aborting the rest of the batch (each row's upsert runs
 * inside its own SAVEPOINT, mirroring reserveStockForSale's own per-item
 * isolation in sales-sync — see that file's comment for why). "Selling
 * Units"/"Supplier" columns (present in this service's own /export output)
 * are deliberately NOT re-imported here — that would mean diffing/replacing
 * product_units/supplier_logs rows from a flat re-import, well beyond
 * "verify required columns and upsert the product record" — only the
 * required columns plus the optional Min Stock Level/Reorder Quantity are
 * applied.
 */
inventoryRouter.post(
  '/products/import',
  requireAnyPermission('inventory:create', 'inventory:update'),
  // Wrapped manually (rather than passed directly as router middleware) so
  // a MulterError (e.g. LIMIT_FILE_SIZE) becomes a clean 400 through the
  // normal Errors.invalidRequest() path instead of falling through to
  // globalErrorHandler's generic 500 — express.json()'s 512kb body limit
  // never applies to multipart routes at all, so this is the only size
  // guard this endpoint has.
  (req: Request, res: Response, next: NextFunction) => {
    importUpload.single('file')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          next(Errors.invalidRequest(`File exceeds the ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB import size limit`));
          return;
        }
        next(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const file = req.file;
      if (!file) {
        return next(Errors.invalidRequest('No file uploaded (expected multipart field "file")'));
      }

      const filename = file.originalname.toLowerCase();
      let rows: ParsedImportRow[];
      if (filename.endsWith('.xlsx')) {
        rows = await parseImportXlsx(file.buffer);
      } else if (filename.endsWith('.csv')) {
        rows = parseImportCsv(file.buffer);
      } else {
        return next(Errors.invalidRequest('Unsupported file type — expected .csv or .xlsx'));
      }

      if (rows.length > MAX_IMPORT_ROWS) {
        return next(Errors.invalidRequest(`Import exceeds the ${MAX_IMPORT_ROWS}-row limit (${rows.length} rows found)`));
      }

      const errors: ImportRowError[] = [];
      let created = 0;
      let updated = 0;
      const auditRows: Array<{ productId: string; action: 'CREATE' | 'UPDATE'; sku: string }> = [];

      const client = await getClient();
      try {
        await client.query('BEGIN');

        for (const row of rows) {
          const sku = row.fields['product_sku']?.toUpperCase();
          const name = row.fields['name'];
          const priceRaw = row.fields['unit_price'];
          const baseUnit = row.fields['base_unit'];
          const stockRaw = row.fields['stock_quantity'];

          if (!sku || !name || !priceRaw || !baseUnit || !stockRaw) {
            errors.push({
              row: row.rowNumber, sku,
              message: 'Missing required column(s): SKU/Barcode, Name, Price, Base Unit, Stock',
            });
            continue;
          }

          const price = Number(priceRaw);
          if (!Number.isFinite(price) || price < 0) {
            errors.push({ row: row.rowNumber, sku, message: `Invalid Price "${priceRaw}"` });
            continue;
          }
          const stock = Number(stockRaw);
          if (!Number.isFinite(stock) || stock < 0) {
            errors.push({ row: row.rowNumber, sku, message: `Invalid Stock "${stockRaw}"` });
            continue;
          }

          const reorderLevelRaw = row.fields['reorder_level'];
          const reorderLevel = reorderLevelRaw ? Number(reorderLevelRaw) : 0;
          if (reorderLevelRaw && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
            errors.push({ row: row.rowNumber, sku, message: `Invalid Min Stock Level "${reorderLevelRaw}"` });
            continue;
          }

          const reorderQtyRaw = row.fields['reorder_quantity'];
          const reorderQuantity = reorderQtyRaw ? Number(reorderQtyRaw) : null;
          if (reorderQtyRaw && (reorderQuantity === null || !Number.isFinite(reorderQuantity) || reorderQuantity < 0)) {
            errors.push({ row: row.rowNumber, sku, message: `Invalid Reorder Quantity "${reorderQtyRaw}"` });
            continue;
          }

          const category = row.fields['category'] || null;

          await client.query('SAVEPOINT import_row');
          try {
            const existing = await client.query<{ id: string }>(
              `SELECT id FROM inventories WHERE tenant_id = $1 AND product_sku = $2 AND deleted_at IS NULL`,
              [ctx.tenantId, sku],
            );
            const isUpdate = existing.rows.length > 0;

            const upserted = await client.query<{ id: string }>(
              `INSERT INTO inventories
                 (tenant_id, product_sku, name, unit_price, stock_quantity,
                  reorder_level, reorder_quantity, base_unit, category, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
               ON CONFLICT (tenant_id, product_sku) DO UPDATE
                 SET name             = EXCLUDED.name,
                     unit_price       = EXCLUDED.unit_price,
                     stock_quantity   = EXCLUDED.stock_quantity,
                     reorder_level    = EXCLUDED.reorder_level,
                     reorder_quantity = EXCLUDED.reorder_quantity,
                     base_unit        = EXCLUDED.base_unit,
                     category         = EXCLUDED.category,
                     updated_by       = EXCLUDED.updated_by,
                     version          = inventories.version + 1,
                     updated_at       = NOW()
               RETURNING id`,
              [ctx.tenantId, sku, name, price, stock, reorderLevel, reorderQuantity, baseUnit, category, ctx.userId],
            );

            await client.query('RELEASE SAVEPOINT import_row');
            const productId = upserted.rows[0]!.id;
            auditRows.push({ productId, action: isUpdate ? 'UPDATE' : 'CREATE', sku });
            if (isUpdate) updated += 1; else created += 1;
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT import_row');
            errors.push({
              row: row.rowNumber, sku,
              message: err instanceof Error ? err.message : 'Failed to upsert this row',
            });
          }
        }

        // Batched audit trail — one multi-row INSERT, not N round trips —
        // matching every other inventory mutation path's existing convention
        // of writing to audit_logs, which the import route was the one gap in.
        if (auditRows.length > 0) {
          const valuePlaceholders: string[] = [];
          const params: unknown[] = [];
          auditRows.forEach((a, i) => {
            const base = i * 5;
            valuePlaceholders.push(`($${base + 1}, 'inventory', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`);
            params.push(ctx.tenantId, a.productId, a.action, ctx.workerTag, JSON.stringify({ product_sku: a.sku, source: 'bulk_import' }));
          });
          await client.query(
            `INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
             VALUES ${valuePlaceholders.join(', ')}`,
            params,
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.status(200).json({
        success: errors.length === 0,
        created,
        updated,
        skipped: errors.length,
        errors,
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
  product_sku:      z.string().min(1).max(50),
  name:             z.string().min(1).max(255),
  unit_price:       z.number().nonnegative(),
  // Up to 3 decimal places, matching inventories.stock_quantity's DECIMAL(12,3).
  stock_quantity:   z.number().nonnegative().default(0),
  reorder_level:    z.number().int().nonnegative().default(0),
  reorder_quantity: z.number().nonnegative().nullable().optional(),
  base_unit:        z.string().min(1).max(20).default('pieces'),
  barcode:          z.string().max(100).nullable().optional(),
  description:      z.string().nullable().optional(),
  category:         z.string().max(100).nullable().optional(),
  cost_price:       z.number().nonnegative().nullable().optional(),
  // Owner-set per-product tax rate — no tenant-wide default; a product with
  // none set is 0% (untaxed), not "unknown", so this is a plain default
  // rather than nullable like cost_price.
  tax_rate:         z.number().min(0).max(100).default(0),
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
              unit_price, stock_quantity, reorder_level, reorder_quantity, base_unit, category, cost_price, tax_rate,
              created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
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
            d.reorder_quantity ?? null,
            d.base_unit,
            d.category       ?? null,
            d.cost_price     ?? null,
            d.tax_rate,
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
  name:             z.string().min(1).max(255).optional(),
  unit_price:       z.number().nonnegative().optional(),
  stock_quantity:   z.number().nonnegative().optional(),
  reorder_level:    z.number().int().nonnegative().optional(),
  reorder_quantity: z.number().nonnegative().nullable().optional(),
  base_unit:        z.string().min(1).max(20).optional(),
  barcode:          z.string().max(100).nullable().optional(),
  description:      z.string().nullable().optional(),
  category:         z.string().max(100).nullable().optional(),
  cost_price:       z.number().nonnegative().nullable().optional(),
  tax_rate:         z.number().min(0).max(100).optional(),
  /** Optimistic lock — send the version you last read. */
  version:          z.number().int().positive(),
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
        'name', 'unit_price', 'stock_quantity', 'reorder_level', 'reorder_quantity', 'base_unit',
        'barcode', 'description', 'category', 'cost_price', 'tax_rate',
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

        // Read old values for audit log (PRODUCT_COLS already includes version)
        const before = await client.query<InventoryRow>(
          `SELECT ${PRODUCT_COLS}
           FROM inventories
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [ctx.tenantId, id],
        );

        if (!before.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Product not found'));
        }

        const currentVersion = before.rows[0].version;
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

// =============================================================================
// PRODUCT UNITS (unit-of-measure)  (packages/db/src/migrations/020_inventory_uom_reorder.sql)
// =============================================================================
//
// Holds only the product's NON-base selling units — inventories.base_unit is
// implicit and never gets a row here. conversion_factor: "1 of this unit =
// conversion_factor base_units" (e.g. unit_name='Carton', factor=24 when
// base_unit='pieces'). Mirrors PRODUCT VARIANTS' shape above, minus
// optimistic-lock version fields — units are low-churn lookups, not
// concurrently-edited stock records.

interface ProductUnitRow {
  id:                string;
  product_id:        string;
  unit_name:         string;
  conversion_factor: string; // DECIMAL comes back as string
  is_default:        boolean;
  created_at:        string;
  updated_at:        string;
  deleted_at:        string | null;
}

function toProductUnit(row: ProductUnitRow) {
  return {
    id:                row.id,
    product_id:        row.product_id,
    unit_name:         row.unit_name,
    conversion_factor: parseFloat(row.conversion_factor),
    is_default:        row.is_default,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
    deleted_at:        row.deleted_at,
  };
}

const PRODUCT_UNIT_COLS = `
  id, product_id, unit_name, conversion_factor, is_default, created_at, updated_at, deleted_at
`;

// ─── GET /api/v1/inventory/products/:id/units ────────────────────────────────

inventoryRouter.get(
  '/products/:id/units',
  requirePermission('inventory:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const product = await requireProduct(ctx.tenantId, req.params.id);
      if (!product) return next(Errors.notFound('Product not found'));

      const result = await query<ProductUnitRow>(
        `SELECT ${PRODUCT_UNIT_COLS}
         FROM product_units
         WHERE tenant_id = $1 AND product_id = $2 AND deleted_at IS NULL
         ORDER BY unit_name ASC`,
        [ctx.tenantId, req.params.id],
      );

      res.status(200).json({ units: result.rows.map(toProductUnit) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/inventory/products/:id/units ───────────────────────────────

const createUnitSchema = z.object({
  unit_name:         z.string().min(1).max(30),
  conversion_factor: z.number().positive(),
  is_default:        z.boolean().default(false),
});

inventoryRouter.post(
  '/products/:id/units',
  requirePermission('inventory:create'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const parsed = createUnitSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Unit validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const product = await requireProduct(ctx.tenantId, req.params.id);
      if (!product) return next(Errors.notFound('Product not found'));

      const d = parsed.data;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        // Only one default unit per product (idx_product_units_one_default) —
        // clear any existing default first rather than letting the new
        // insert's unique-index violation surface as an opaque 500.
        if (d.is_default) {
          await client.query(
            `UPDATE product_units SET is_default = FALSE, updated_at = NOW()
             WHERE tenant_id = $1 AND product_id = $2 AND is_default = TRUE AND deleted_at IS NULL`,
            [ctx.tenantId, req.params.id],
          );
        }

        const result = await client.query<ProductUnitRow>(
          `INSERT INTO product_units
             (tenant_id, product_id, unit_name, conversion_factor, is_default, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING ${PRODUCT_UNIT_COLS}`,
          [ctx.tenantId, req.params.id, d.unit_name, d.conversion_factor, d.is_default, ctx.userId],
        );

        const created = result.rows[0]!;

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'product_unit', $2, 'CREATE', $3, $4::jsonb)`,
          [ctx.tenantId, created.id, ctx.workerTag, JSON.stringify(d)],
        );

        await client.query('COMMIT');
        res.status(201).json(toProductUnit(created));
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        if ((err as { code?: string }).code === '23505') {
          return next(Errors.conflict(`Unit "${d.unit_name}" already exists for this product`));
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

// ─── PATCH /api/v1/inventory/units/:id ────────────────────────────────────────

const patchUnitSchema = z.object({
  unit_name:         z.string().min(1).max(30).optional(),
  conversion_factor: z.number().positive().optional(),
  is_default:        z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field must be provided');

inventoryRouter.patch(
  '/units/:id',
  requirePermission('inventory:update'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { id } = req.params;
      const parsed = patchUnitSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(
          Errors.invalidRequest('Update validation failed', {
            issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const d = parsed.data;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const before = await client.query<ProductUnitRow>(
          `SELECT ${PRODUCT_UNIT_COLS} FROM product_units
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [ctx.tenantId, id],
        );
        if (!before.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Unit not found'));
        }

        if (d.is_default === true) {
          await client.query(
            `UPDATE product_units SET is_default = FALSE, updated_at = NOW()
             WHERE tenant_id = $1 AND product_id = $2 AND is_default = TRUE AND deleted_at IS NULL AND id != $3`,
            [ctx.tenantId, before.rows[0].product_id, id],
          );
        }

        const setClauses: string[] = ['updated_at = NOW()'];
        const params: unknown[] = [ctx.tenantId, id];
        (['unit_name', 'conversion_factor', 'is_default'] as const).forEach((field) => {
          if (d[field] !== undefined) {
            params.push(d[field]);
            setClauses.push(`${field} = $${params.length}`);
          }
        });

        const result = await client.query<ProductUnitRow>(
          `UPDATE product_units
           SET ${setClauses.join(', ')}
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING ${PRODUCT_UNIT_COLS}`,
          params,
        );

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
           VALUES ($1, 'product_unit', $2, 'UPDATE', $3, $4::jsonb, $5::jsonb)`,
          [ctx.tenantId, id, ctx.workerTag, JSON.stringify(toProductUnit(before.rows[0])), JSON.stringify(d)],
        );

        await client.query('COMMIT');
        res.status(200).json(toProductUnit(result.rows[0]!));
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        if ((err as { code?: string }).code === '23505') {
          return next(Errors.conflict('A unit with that name already exists for this product'));
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

// ─── DELETE /api/v1/inventory/units/:id ───────────────────────────────────────

inventoryRouter.delete(
  '/units/:id',
  requirePermission('inventory:delete'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { id } = req.params;
      const client = await getClient();

      try {
        await client.query('BEGIN');

        const result = await client.query<{ id: string; unit_name: string }>(
          `UPDATE product_units
           SET deleted_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING id, unit_name`,
          [ctx.tenantId, id],
        );

        if (!result.rows[0]) {
          await client.query('ROLLBACK');
          return next(Errors.notFound('Unit not found'));
        }

        await client.query(
          `INSERT INTO audit_logs
             (tenant_id, entity_type, entity_id, action, worker_tag, new_values)
           VALUES ($1, 'product_unit', $2, 'SOFT_DELETE', $3, $4::jsonb)`,
          [ctx.tenantId, id, ctx.workerTag, JSON.stringify({ unit_name: result.rows[0].unit_name })],
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
