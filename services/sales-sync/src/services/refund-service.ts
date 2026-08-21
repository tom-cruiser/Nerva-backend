import { getClient }  from '@retail/db';
import { Errors }     from '@retail/middleware';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { writeAuditLog } from './sync-service';
import type { RefundRequestInput } from '../types/sync-types';

// ─── Goods refund ───────────────────────────────────────────────────────────
//
// Processes a full or partial return of goods against an already-completed
// sale:
//   1. Locks the sale row and validates it's actually refundable.
//   2. Validates every requested line against what was sold minus what's
//      already been refunded on prior (partial) refunds of the same sale.
//   3. Optionally restocks the returned quantities back into `inventories`
//      (skipped when the goods came back damaged/unsellable).
//   4. Rolls back a customer-ledger CREDIT if the original sale was bought
//      on account, so the customer owes less afterward.
//   5. Records the refund, bumps `sales.refunded_amount`, and flips
//      `payment_status` to REFUNDED / PARTIALLY_REFUNDED.
//
// Everything above runs inside one transaction under READ COMMITTED,
// serialized per-sale by a `SELECT ... FOR UPDATE` on the sale row — a
// second refund request for the same sale (e.g. a double-submitted click)
// simply waits for the first to commit, then sees its updated
// refunded_amount before validating its own lines against it.

export interface SoldLine {
  product_sku: string;
  quantity:    number;
  unit?:       string;
  unit_price:  number;
  total:       number;
}

/** `{sku}::{unit}` — the same (SKU, selling-unit) pairing items_sold and a
 *  refund's items_refunded are always keyed by. An absent unit normalizes to
 *  '' so "no unit" (base_unit) lines from either side match each other. */
export function lineKey(sku: string, unit: string | undefined): string {
  return `${sku}::${unit ?? ''}`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Tolerance for decimal-quantity comparisons — guards against float noise
 *  (e.g. 1.1 * 3 !== 3.3000000000000003), matching decimalQuantity's own
 *  tolerance in sync-types.ts. */
const QTY_EPSILON = 1e-6;

export function parseSoldLines(itemsSold: unknown): SoldLine[] {
  if (!Array.isArray(itemsSold)) return [];
  return itemsSold
    .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
    .map((it) => ({
      product_sku: String(it['product_sku'] ?? ''),
      quantity:    Number(it['quantity'] ?? 0),
      unit:        typeof it['unit'] === 'string' ? it['unit'] : undefined,
      unit_price:  Number(it['unit_price'] ?? 0),
      total:       Number(it['total'] ?? 0),
    }))
    .filter((it) => it.product_sku.length > 0);
}

/**
 * Adds refunded quantities back to `inventories.stock_quantity`, converting
 * through `product_units` exactly like reserveStockForSale does for a sale —
 * just in the opposite direction, and without an "insufficient stock" guard
 * (there's no upper bound on putting stock back).
 *
 * Matches by (tenant_id, product_sku) with no `deleted_at IS NULL` filter:
 * inventories.product_sku is unique per tenant even across a soft-deleted
 * row (see processInventory in sync-service.ts), so a discontinued product
 * still gets its physical stock accounted for correctly.
 *
 * Fails closed (throws) if a sold SKU has no matching inventories row at
 * all — that should be impossible (reserveStockForSale requires the row to
 * exist before a sale can even be created) and signals data corruption
 * rather than something safe to silently skip past.
 */
async function restockForRefund(
  client:   PoolClient,
  tenantId: string,
  items:    { product_sku: string; quantity: number; unit?: string }[],
): Promise<void> {
  for (const item of items) {
    if (!item.unit) {
      const result = await client.query(
        `UPDATE inventories
         SET stock_quantity = stock_quantity + $3,
             version        = version + 1,
             updated_at     = NOW()
         WHERE tenant_id = $1 AND product_sku = $2
         RETURNING id`,
        [tenantId, item.product_sku, item.quantity],
      );
      if (!result.rowCount) {
        throw Errors.internal(
          `Cannot restock unknown product "${item.product_sku}" — no matching inventory record`,
        );
      }
      continue;
    }

    const productResult = await client.query<{ id: string; base_unit: string }>(
      `SELECT id, base_unit FROM inventories
       WHERE tenant_id = $1 AND product_sku = $2
       FOR UPDATE`,
      [tenantId, item.product_sku],
    );
    if (!productResult.rowCount) {
      throw Errors.internal(
        `Cannot restock unknown product "${item.product_sku}" — no matching inventory record`,
      );
    }
    const product = productResult.rows[0];

    let conversionFactor = '1';
    if (item.unit !== product.base_unit) {
      const unitResult = await client.query<{ conversion_factor: string }>(
        `SELECT conversion_factor FROM product_units
         WHERE tenant_id = $1 AND product_id = $2 AND unit_name = $3 AND deleted_at IS NULL`,
        [tenantId, product.id, item.unit],
      );
      if (!unitResult.rowCount) {
        throw Errors.internal(
          `Cannot restock "${item.product_sku}" — unknown selling unit "${item.unit}"`,
        );
      }
      conversionFactor = unitResult.rows[0].conversion_factor;
    }

    await client.query(
      `UPDATE inventories
       SET stock_quantity = stock_quantity + ($3::numeric * $4::numeric),
           version        = version + 1,
           updated_at     = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [product.id, tenantId, item.quantity, conversionFactor],
    );
  }
}

export interface RefundableLine {
  product_sku:   string;
  unit?:         string;
  unit_price:    number;
  quantitySold:  number;
  quantityRefunded: number;
  quantityRemaining: number;
}

/**
 * Combines a sale's own items_sold with every sale_refunds row already
 * recorded against it, returning per-line how much has been sold, how much
 * has already been refunded, and how much is still refundable. Shared by
 * processRefund (to validate a new request) and the sale-detail route (to
 * show a cashier what's still returnable) so the two can never drift apart.
 */
export function computeRefundableLines(
  itemsSold: unknown,
  refundRows: { items_refunded: unknown }[],
): RefundableLine[] {
  const soldLines = parseSoldLines(itemsSold);

  const refundedSoFar = new Map<string, number>();
  for (const row of refundRows) {
    for (const line of parseSoldLines(row.items_refunded)) {
      const key = lineKey(line.product_sku, line.unit);
      refundedSoFar.set(key, (refundedSoFar.get(key) ?? 0) + line.quantity);
    }
  }

  return soldLines.map((sold) => {
    const key = lineKey(sold.product_sku, sold.unit);
    const quantityRefunded = refundedSoFar.get(key) ?? 0;
    return {
      product_sku:       sold.product_sku,
      unit:               sold.unit,
      unit_price:         sold.unit_price,
      quantitySold:       sold.quantity,
      quantityRefunded,
      quantityRemaining:  round2(Math.max(0, sold.quantity - quantityRefunded)),
    };
  });
}

export interface ProcessRefundParams {
  tenantId:   string;
  userId:     string;
  workerTag:  string;
  saleId:     string;
  request:    RefundRequestInput;
}

export interface ProcessRefundResult {
  refund: {
    id:             string;
    saleId:         string;
    itemsRefunded:  SoldLine[];
    refundAmount:   number;
    reason:         string;
    restocked:      boolean;
    createdAt:      string;
  };
  sale: {
    id:             string;
    paymentStatus:  string;
    refundedAmount: number;
    totalAmount:    number;
  };
  /** True when this call replayed an existing refund via client_reference
   *  rather than creating a new one — lets the router distinguish 200 vs 201. */
  idempotentReplay: boolean;
}

export async function processRefund(params: ProcessRefundParams): Promise<ProcessRefundResult> {
  const { tenantId, userId, workerTag, saleId, request } = params;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

    // ── Lock the sale row — serializes concurrent refund attempts on the
    //    same sale so a double-submit can't both read the same
    //    refunded_amount and each think their lines still fit. ────────────
    const saleResult = await client.query<{
      id: string; items_sold: unknown; total_amount: string; refunded_amount: string;
      payment_status: string; payment_method: string; customer_id: string | null;
      transaction_id: string; voided_at: Date | null; deleted_at: Date | null;
    }>(
      `SELECT id, items_sold, total_amount, refunded_amount, payment_status,
              payment_method, customer_id, transaction_id, voided_at, deleted_at
       FROM sales
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, saleId],
    );

    if (!saleResult.rowCount || saleResult.rows[0].deleted_at) {
      throw Errors.notFound('Sale not found');
    }
    const sale = saleResult.rows[0];

    // ── Idempotency: a retried request with the same client_reference
    //    replays the original refund rather than double-processing it. ────
    if (request.client_reference) {
      const existing = await client.query<{
        id: string; items_refunded: unknown; refund_amount: string; reason: string;
        restocked: boolean; created_at: Date;
      }>(
        `SELECT id, items_refunded, refund_amount, reason, restocked, created_at
         FROM sale_refunds
         WHERE tenant_id = $1 AND sale_id = $2 AND client_reference = $3`,
        [tenantId, saleId, request.client_reference],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        const r = existing.rows[0];
        return {
          refund: {
            id: r.id, saleId, itemsRefunded: parseSoldLines(r.items_refunded),
            refundAmount: Number(r.refund_amount), reason: r.reason,
            restocked: r.restocked, createdAt: r.created_at.toISOString(),
          },
          sale: {
            id: sale.id, paymentStatus: sale.payment_status,
            refundedAmount: Number(sale.refunded_amount), totalAmount: Number(sale.total_amount),
          },
          idempotentReplay: true,
        };
      }
    }

    // ── State checks ───────────────────────────────────────────────────────
    if (sale.voided_at) {
      throw Errors.conflict('Cannot refund a voided sale');
    }
    if (sale.payment_status === 'PENDING' || sale.payment_status === 'FAILED') {
      throw Errors.conflict(`Cannot refund a sale with payment_status ${sale.payment_status} — nothing was collected`);
    }
    if (sale.payment_status === 'REFUNDED') {
      throw Errors.conflict('This sale has already been fully refunded');
    }

    // ── Validate requested lines against what's actually still refundable ──
    const priorRefunds = await client.query<{ items_refunded: unknown }>(
      `SELECT items_refunded FROM sale_refunds WHERE tenant_id = $1 AND sale_id = $2`,
      [tenantId, saleId],
    );
    const refundable = computeRefundableLines(sale.items_sold, priorRefunds.rows);
    const refundableByKey = new Map(refundable.map((l) => [lineKey(l.product_sku, l.unit), l]));

    const itemsRefunded: SoldLine[] = [];
    let refundAmount = 0;

    for (const requested of request.items) {
      const key = lineKey(requested.product_sku, requested.unit);
      const line = refundableByKey.get(key);
      if (!line) {
        throw Errors.invalidRequest(
          `"${requested.product_sku}"${requested.unit ? ` (${requested.unit})` : ''} was not part of this sale`,
        );
      }
      if (requested.quantity > line.quantityRemaining + QTY_EPSILON) {
        throw Errors.invalidRequest(
          `Cannot refund ${requested.quantity} of "${requested.product_sku}" — only ${line.quantityRemaining} remains refundable `
          + `(sold ${line.quantitySold}, already refunded ${round2(line.quantityRefunded)})`,
        );
      }

      const lineAmount = round2(line.unit_price * requested.quantity);
      refundAmount += lineAmount;
      itemsRefunded.push({
        product_sku: requested.product_sku, quantity: requested.quantity,
        unit: requested.unit, unit_price: line.unit_price, total: lineAmount,
      });
    }
    refundAmount = round2(refundAmount);

    if (refundAmount <= 0) {
      throw Errors.invalidRequest('Refund amount must be greater than zero');
    }

    // ── Restock (unless the goods are being written off) ───────────────────
    if (request.restock) {
      await restockForRefund(client, tenantId, itemsRefunded);
    }

    // ── Roll back a customer-ledger credit, if this was a credit sale ──────
    // NOTE: if the customer has already made payments against this sale such
    // that their outstanding balance is less than refundAmount, the ledger
    // adjustment is capped at the current balance (a debt can't go negative
    // here — see customer_ledger.balance's CHECK constraint). The remainder
    // of the refund is still money-back to the customer; reconciling that as
    // store credit is out of scope for this pass.
    let ledgerEntryId: string | null = null;
    if (sale.payment_method === 'CREDIT' && sale.customer_id) {
      const ledgerResult = await client.query<{ id: string; balance: string }>(
        `SELECT id, balance FROM customer_ledger
         WHERE tenant_id = $1 AND customer_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [tenantId, sale.customer_id],
      );
      if (ledgerResult.rowCount) {
        const ledger = ledgerResult.rows[0];
        const balance = Number(ledger.balance);
        const applied = Math.min(refundAmount, balance);
        if (applied > 0) {
          const newBalance = round2(balance - applied);
          ledgerEntryId = uuidv4();
          await client.query(
            `INSERT INTO ledger_entries
               (id, tenant_id, customer_ledger_id, entry_type, amount,
                balance_after, sale_id, description, worker_tag)
             VALUES ($1,$2,$3,'ADJUSTMENT',$4,$5,$6,$7,$8)`,
            [
              ledgerEntryId, tenantId, ledger.id, applied, newBalance, sale.id,
              `Refund adjustment for sale ${sale.transaction_id}: ${request.reason}`,
              workerTag,
            ],
          );
          await client.query(
            `UPDATE customer_ledger
             SET balance = $3, version = version + 1, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, ledger.id, newBalance],
          );
        }
      }
    }

    // ── Record the refund itself ────────────────────────────────────────────
    const refundId = uuidv4();
    await client.query(
      `INSERT INTO sale_refunds
         (id, tenant_id, sale_id, items_refunded, refund_amount, reason,
          restocked, ledger_entry_id, client_reference, worker_tag, refunded_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
      [
        refundId, tenantId, saleId, JSON.stringify(itemsRefunded), refundAmount,
        request.reason, request.restock, ledgerEntryId,
        request.client_reference ?? null, workerTag, userId,
      ],
    );

    // ── Update the sale's running total + payment_status ────────────────────
    const newRefundedAmount = round2(Number(sale.refunded_amount) + refundAmount);
    const totalAmount = Number(sale.total_amount);
    const newPaymentStatus = newRefundedAmount >= totalAmount - 0.005 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    await client.query(
      `UPDATE sales
       SET refunded_amount = $3, payment_status = $4, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, saleId, newRefundedAmount, newPaymentStatus],
    );

    await writeAuditLog(
      client, tenantId, 'sale', saleId, 'REFUND', workerTag,
      { payment_status: sale.payment_status, refunded_amount: Number(sale.refunded_amount) },
      { refund_id: refundId, items_refunded: itemsRefunded, refund_amount: refundAmount, reason: request.reason, restocked: request.restock },
    );

    await client.query('COMMIT');

    return {
      refund: {
        id: refundId, saleId, itemsRefunded, refundAmount, reason: request.reason,
        restocked: request.restock, createdAt: new Date().toISOString(),
      },
      sale: {
        id: saleId, paymentStatus: newPaymentStatus,
        refundedAmount: newRefundedAmount, totalAmount,
      },
      idempotentReplay: false,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
