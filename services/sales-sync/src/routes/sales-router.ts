import { Router, Request, Response, NextFunction } from 'express';
import { getTenantContext, Errors, requirePermission } from '@retail/middleware';
import { refundRequestSchema } from '../types/sync-types';
import { processRefund, computeRefundableLines } from '../services/refund-service';

const salesRouter = Router();

// Reused by both the list and detail routes below — a plain LEFT JOIN on the
// (tenant_id, customer_id) business key: sales.customer_id has no FK to
// customer_ledger (there's no separate `customers` table in this schema —
// see 001_initial_schema.sql), so this is the only way to attach a display
// name to a sale without the caller doing a second round trip per row.
const SALE_COLUMNS_WITH_CUSTOMER = `
  s.id, s.transaction_id, s.customer_id, cl.customer_name,
  s.items_sold, s.total_amount, s.discount_amount, s.tax_amount,
  s.payment_method, s.payment_status, s.refunded_amount,
  s.worker_tag, s.sale_timestamp, s.voided_at, s.void_reason, s.updated_at
`;
const SALE_FROM_CLAUSE = `
  FROM sales s
  LEFT JOIN customer_ledger cl
    ON cl.tenant_id = s.tenant_id AND cl.customer_id = s.customer_id AND cl.deleted_at IS NULL
`;

interface SaleRow {
  id: string; transaction_id: string; customer_id: string | null; customer_name: string | null;
  items_sold: unknown; total_amount: string; discount_amount: string; tax_amount: string;
  payment_method: string; payment_status: string; refunded_amount: string;
  worker_tag: string; sale_timestamp: string; voided_at: string | null;
  void_reason: string | null; updated_at: string;
}

/** DECIMAL columns come back as strings from the pg driver (no numeric type
 *  parser is registered — see inventory-router.ts's toProduct() for the
 *  same coercion on the inventory side). items_sold is JSONB, which pg does
 *  parse natively, so it's passed through as-is. */
function toSaleJson(row: SaleRow) {
  return {
    ...row,
    total_amount:    parseFloat(row.total_amount),
    discount_amount: parseFloat(row.discount_amount),
    tax_amount:      parseFloat(row.tax_amount),
    refunded_amount: parseFloat(row.refunded_amount),
  };
}

interface RefundRow {
  id: string; items_refunded: unknown; refund_amount: string; reason: string;
  restocked: boolean; ledger_entry_id: string | null; worker_tag: string;
  refunded_by: string | null; created_at: string;
}

function toRefundJson(row: RefundRow) {
  return { ...row, refund_amount: parseFloat(row.refund_amount) };
}

// ─── GET /api/v1/sync/sales ───────────────────────────────────────────────────
//
// Sales history list — paginated, newest first. Registered BEFORE
// /:saleId below only for readability; Express already tells the two apart
// by segment count (no request path can match both).
//
// Query params: q (transaction id / customer name search), customer_id,
// payment_status, from/to (ISO date, inclusive, matched against
// sale_timestamp), limit (1-200, default 50), offset.
salesRouter.get(
  '/',
  requirePermission('sales:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext(res);
      const { query } = await import('@retail/db');

      const search        = typeof req.query['q']              === 'string' ? req.query['q'].trim()        : '';
      const customerId     = typeof req.query['customer_id']     === 'string' ? req.query['customer_id']     : '';
      const paymentStatus  = typeof req.query['payment_status']  === 'string' ? req.query['payment_status']  : '';
      const fromDate       = typeof req.query['from']            === 'string' ? req.query['from']            : '';
      const toDate         = typeof req.query['to']              === 'string' ? req.query['to']              : '';
      const limit  = Math.min(Math.max(parseInt(String(req.query['limit']  ?? 50), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(String(req.query['offset'] ?? 0), 10) || 0, 0);

      const conditions: string[] = ['s.tenant_id = $1', 's.deleted_at IS NULL'];
      const params: unknown[]    = [ctx.tenantId];

      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        const n = params.length;
        conditions.push(`(LOWER(s.transaction_id) LIKE $${n} OR LOWER(cl.customer_name) LIKE $${n})`);
      }
      if (customerId) {
        params.push(customerId);
        conditions.push(`s.customer_id = $${params.length}`);
      }
      if (paymentStatus) {
        params.push(paymentStatus);
        conditions.push(`s.payment_status = $${params.length}`);
      }
      if (fromDate) {
        params.push(fromDate);
        conditions.push(`s.sale_timestamp >= $${params.length}`);
      }
      if (toDate) {
        params.push(toDate);
        conditions.push(`s.sale_timestamp <= $${params.length}`);
      }

      const where = conditions.join(' AND ');

      // Total count for pagination metadata (same WHERE, no LIMIT/OFFSET) —
      // matches the convention inventory-router.ts's product list uses.
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count ${SALE_FROM_CLAUSE} WHERE ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      params.push(limit, offset);
      const dataResult = await query<SaleRow>(
        `SELECT ${SALE_COLUMNS_WITH_CUSTOMER}
         ${SALE_FROM_CLAUSE}
         WHERE ${where}
         ORDER BY s.sale_timestamp DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      res.status(200).json({ sales: dataResult.rows.map(toSaleJson), total, limit, offset });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/sync/sales/:saleId ───────────────────────────────────────────
//
// Single sale detail — the sale itself, its full refund history, and (via
// computeRefundableLines — the exact same helper processRefund validates
// against) how much of each line item is still refundable right now, so the
// UI can cap a refund form's quantity inputs without duplicating that math.
salesRouter.get(
  '/:saleId',
  requirePermission('sales:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const saleId = req.params['saleId'];
      if (!saleId) {
        return next(Errors.invalidRequest('saleId is required'));
      }

      const { query } = await import('@retail/db');

      const saleResult = await query<SaleRow>(
        `SELECT ${SALE_COLUMNS_WITH_CUSTOMER}
         ${SALE_FROM_CLAUSE}
         WHERE s.tenant_id = $1 AND s.id = $2 AND s.deleted_at IS NULL
         LIMIT 1`,
        [ctx.tenantId, saleId],
      );
      if (!saleResult.rowCount) {
        return next(Errors.notFound('Sale not found'));
      }
      const sale = saleResult.rows[0];

      const refundsResult = await query<RefundRow>(
        `SELECT id, items_refunded, refund_amount, reason, restocked,
                ledger_entry_id, worker_tag, refunded_by, created_at
         FROM sale_refunds
         WHERE tenant_id = $1 AND sale_id = $2
         ORDER BY created_at DESC`,
        [ctx.tenantId, saleId],
      );

      res.status(200).json({
        sale: toSaleJson(sale),
        refunds: refundsResult.rows.map(toRefundJson),
        refundable_lines: computeRefundableLines(sale.items_sold, refundsResult.rows),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/sync/sales/:saleId/refunds ─────────────────────────────────
//
// Processes a goods refund (full or partial) against a completed sale.
// Always-online, synchronous — unlike /sync/batch this is NOT part of the
// offline WatermelonDB queue: a refund needs to see the sale's current
// server-side refund/ledger state to validate against, and is a rarer,
// supervisor-gated action (see 'sales:refund' in @retail/types) rather than
// routine POS traffic.
salesRouter.post(
  '/:saleId/refunds',
  requirePermission('sales:refund'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const saleId = req.params['saleId'];
      if (!saleId) {
        return next(Errors.invalidRequest('saleId is required'));
      }

      const parseResult = refundRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return next(
          Errors.invalidRequest('Refund request validation failed', {
            issues: parseResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
          }),
        );
      }

      const result = await processRefund({
        tenantId:  ctx.tenantId,
        userId:    ctx.userId,
        workerTag: ctx.workerTag,
        saleId,
        request:   parseResult.data,
      });

      // 200 for an idempotent replay of an already-processed refund, 201 for
      // a newly created one — same body shape either way.
      res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/sync/sales/:saleId/refunds ───────────────────────────────────
//
// Refund history for one sale (receipt/detail view) — 'sales:read' is
// sufficient here since this is read-only, unlike issuing a new refund.
salesRouter.get(
  '/:saleId/refunds',
  requirePermission('sales:read'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx    = getTenantContext(res);
      const saleId = req.params['saleId'];
      if (!saleId) {
        return next(Errors.invalidRequest('saleId is required'));
      }

      const { query } = await import('@retail/db');
      const saleCheck = await query<{ id: string }>(
        `SELECT id FROM sales WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
        [ctx.tenantId, saleId],
      );
      if (!saleCheck.rowCount) {
        return next(Errors.notFound('Sale not found'));
      }

      const refunds = await query<RefundRow>(
        `SELECT id, items_refunded, refund_amount, reason, restocked,
                ledger_entry_id, worker_tag, refunded_by, created_at
         FROM sale_refunds
         WHERE tenant_id = $1 AND sale_id = $2
         ORDER BY created_at DESC`,
        [ctx.tenantId, saleId],
      );

      res.status(200).json({ sale_id: saleId, refunds: refunds.rows.map(toRefundJson) });
    } catch (err) {
      next(err);
    }
  },
);

export { salesRouter };
