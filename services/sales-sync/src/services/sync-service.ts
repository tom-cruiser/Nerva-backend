import { getClient }        from '@retail/db';
import { checkResourceLimit } from '@retail/middleware';
import { PoolClient }   from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  SyncAction,
  SyncCollection,
  saleDataSchema,
  inventoryDataSchema,
  customerDataSchema,
  ledgerEntryDataSchema,
} from '../types/sync-types';
import type {
  SyncChangeInput,
  SyncJobPayload,
  SyncResponse,
  AcceptedChange,
  RejectedChange,
  ConflictRecord,
} from '../types/sync-types';

// ─── LWW helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when the incoming client timestamp is strictly NEWER than the
 * server record — CLIENT_WINS under Last-Write-Wins.
 */
function clientIsNewer(clientTs: string, serverTs: Date | string | null): boolean {
  if (!serverTs) return true;
  const client = new Date(clientTs).getTime();
  const server = new Date(serverTs).getTime();
  return client > server;
}

// ─── Clock-skew protection ─────────────────────────────────────────────────────
//
// LWW trusts the client-supplied `updated_at` as the logical clock for every
// collection above. A device with a wrong system clock (drifted, or a clock
// deliberately set far in the future/past) can otherwise permanently win — or
// permanently lose — every LWW comparison against that record, regardless of
// which side actually happened later in real time. Reject the record instead
// of ever letting a wildly-skewed timestamp reach a `clientIsNewer` check.

/** Client timestamps more than 2 hours ahead of the server clock are rejected. */
const MAX_FUTURE_DRIFT_MS = 2 * 60 * 60 * 1000;
/** Client timestamps more than 30 days behind the server clock are rejected. */
const MAX_PAST_DRIFT_MS = 30 * 24 * 60 * 60 * 1000;

interface ClockDriftCheck {
  withinBounds: boolean;
  /** Positive = client is ahead of the server; negative = client is behind. */
  driftMs: number;
}

/**
 * Compares a client-supplied ISO timestamp against the server's own clock.
 * Does NOT compare against any other record's timestamp — this catches a
 * broken device clock even on that device's very first sync.
 */
function checkClockDrift(clientTs: string, now: number = Date.now()): ClockDriftCheck {
  const clientMs = new Date(clientTs).getTime();
  const driftMs = clientMs - now;

  if (Number.isNaN(clientMs)) {
    // Already rejected by zod's z.string().datetime() before reaching here in
    // practice, but treat an unparseable timestamp as maximally suspect.
    return { withinBounds: false, driftMs: Number.POSITIVE_INFINITY };
  }

  if (driftMs > MAX_FUTURE_DRIFT_MS || driftMs < -MAX_PAST_DRIFT_MS) {
    return { withinBounds: false, driftMs };
  }
  return { withinBounds: true, driftMs };
}

/**
 * Persists a per-device clock-drift flag (so the next pull can tell the
 * client "your clock looks wrong") and writes a durable audit trail entry.
 * Runs inside the same transaction as the batch it was detected in.
 */
async function flagDeviceClockDrift(
  client:   PoolClient,
  tenantId: string,
  deviceId: string,
  syncToken: string,
  worstDriftMs: number,
  affectedChangeCount: number,
  workerTag: string,
): Promise<void> {
  const cursorRow = await client.query<{ id: string }>(
    `INSERT INTO sync_cursors (tenant_id, device_id, sync_token, clock_drift_flagged_at, clock_drift_count)
     VALUES ($1, $2, $3, NOW(), 1)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET clock_drift_flagged_at = NOW(),
           clock_drift_count      = sync_cursors.clock_drift_count + 1
     RETURNING id`,
    [tenantId, deviceId, syncToken],
  );

  const driftDirection = worstDriftMs > 0 ? 'ahead of' : 'behind';
  const driftHuman = `${Math.round(Math.abs(worstDriftMs) / 1000)}s`;

  // Immediate operational visibility (log aggregation / alerting), in
  // addition to the durable audit_logs row below.
  console.error(
    `[sync-service] Clock drift detected for tenant=${tenantId} device=${deviceId}: ` +
    `${affectedChangeCount} change(s) rejected, worst drift ${driftHuman} ${driftDirection} server clock.`,
  );

  await writeAuditLog(
    client, tenantId, 'sync_device', cursorRow.rows[0].id, 'CLOCK_DRIFT', workerTag,
    null,
    {
      device_id: deviceId,
      worst_drift_ms: worstDriftMs,
      affected_change_count: affectedChangeCount,
      detected_at: new Date().toISOString(),
    },
  );
}

// ─── Per-collection processors ────────────────────────────────────────────────

class InsufficientStockError extends Error {
  constructor(public readonly sku: string) {
    super(`Insufficient stock for ${sku}`);
  }
}

/** A sale line item named a selling unit that isn't the product's base_unit
 *  and has no matching (non-deleted) product_units row — rejected outright
 *  rather than silently deducted at conversion factor 1, which would
 *  under/over-deduct stock without anyone noticing. */
class UnknownUnitError extends Error {
  constructor(public readonly sku: string, public readonly unit: string) {
    super(`Unknown selling unit "${unit}" for ${sku}`);
  }
}

/** One line item's post-deduction stock landed at/below its reorder_level —
 *  returned to the caller so processSale() can log it to
 *  inventory_reorder_logs once the sale row itself exists (see the
 *  FK-sequencing note on that call site). */
interface ReorderCrossing {
  productId:                string;
  productSku:               string;
  stockAtTrigger:           number;
  reorderLevelAtTrigger:    number;
  reorderQuantityAtTrigger: number | null;
}

/**
 * Atomically decrement stock for every line item of a sale. All-or-nothing:
 * if any SKU is missing, names an unrecognized selling unit, or doesn't have
 * enough stock, every decrement already applied in this call is rolled back
 * via a savepoint so the sale itself is never inserted with only some of its
 * items reserved.
 *
 * Each item's `quantity` is always in the SELLING unit named by `unit`
 * (omitted = the product's own base_unit, matching every sale payload that
 * predates unit-of-measure support — fully backward compatible). The actual
 * deduction against `inventories.stock_quantity` always happens in base-unit
 * terms, computed in SQL (`numeric` arithmetic) rather than JS floats, to
 * avoid float-precision drift against the DECIMAL(12,3) column.
 */
async function reserveStockForSale(
  client:   PoolClient,
  tenantId: string,
  items:    { product_sku: string; quantity: number; unit?: string }[],
): Promise<ReorderCrossing[]> {
  const crossings: ReorderCrossing[] = [];

  await client.query('SAVEPOINT sale_stock_reservation');
  try {
    for (const item of items) {
      if (!item.unit) {
        // Fast path — identical behavior to before unit-of-measure support.
        const result = await client.query<{
          id: string; stock_quantity: string; reorder_level: number; reorder_quantity: string | null;
        }>(
          `UPDATE inventories
           SET stock_quantity = stock_quantity - $3,
               version        = version + 1,
               updated_at     = NOW()
           WHERE tenant_id = $1 AND product_sku = $2 AND deleted_at IS NULL
             AND stock_quantity >= $3
           RETURNING id, stock_quantity, reorder_level, reorder_quantity`,
          [tenantId, item.product_sku, item.quantity],
        );
        if (!result.rowCount) {
          throw new InsufficientStockError(item.product_sku);
        }
        const row = result.rows[0];
        if (Number(row.stock_quantity) <= row.reorder_level) {
          crossings.push({
            productId: row.id, productSku: item.product_sku,
            stockAtTrigger: Number(row.stock_quantity), reorderLevelAtTrigger: row.reorder_level,
            reorderQuantityAtTrigger: row.reorder_quantity !== null ? Number(row.reorder_quantity) : null,
          });
        }
        continue;
      }

      // Unit-of-measure path — lock the product row first so the base_unit
      // comparison and the eventual deduction see a consistent snapshot.
      const productResult = await client.query<{
        id: string; base_unit: string; reorder_level: number; reorder_quantity: string | null;
      }>(
        `SELECT id, base_unit, reorder_level, reorder_quantity
         FROM inventories
         WHERE tenant_id = $1 AND product_sku = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [tenantId, item.product_sku],
      );
      if (!productResult.rowCount) {
        throw new InsufficientStockError(item.product_sku);
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
          throw new UnknownUnitError(item.product_sku, item.unit);
        }
        conversionFactor = unitResult.rows[0].conversion_factor;
      }

      const result = await client.query<{ stock_quantity: string }>(
        `UPDATE inventories
         SET stock_quantity = stock_quantity - ($3::numeric * $4::numeric),
             version        = version + 1,
             updated_at     = NOW()
         WHERE id = $1 AND tenant_id = $2
           AND stock_quantity >= ($3::numeric * $4::numeric)
         RETURNING stock_quantity`,
        [product.id, tenantId, item.quantity, conversionFactor],
      );
      if (!result.rowCount) {
        throw new InsufficientStockError(item.product_sku);
      }
      const newStock = Number(result.rows[0].stock_quantity);
      if (newStock <= product.reorder_level) {
        crossings.push({
          productId: product.id, productSku: item.product_sku,
          stockAtTrigger: newStock, reorderLevelAtTrigger: product.reorder_level,
          reorderQuantityAtTrigger: product.reorder_quantity !== null ? Number(product.reorder_quantity) : null,
        });
      }
    }
    await client.query('RELEASE SAVEPOINT sale_stock_reservation');
    return crossings;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sale_stock_reservation');
    throw err;
  }
}

async function processSale(
  client:    PoolClient,
  change:    SyncChangeInput,
  tenantId:  string,
  workerTag: string,
  accepted:  AcceptedChange[],
  rejected:  RejectedChange[],
  conflicts: ConflictRecord[],
): Promise<void> {
  const parse = saleDataSchema.safeParse(change.data);
  if (!parse.success) {
    rejected.push({
      id:         change.id,
      reason:     `Invalid sale data: ${parse.error.issues.map(i => i.message).join('; ')}`,
      collection: SyncCollection.SALES,
      action:     change.action,
    });
    return;
  }
  const d = parse.data;

  if (change.action === SyncAction.DELETE) {
    // Sales are never hard-deleted — soft-delete only
    rejected.push({
      id:         change.id,
      reason:     'Sales cannot be deleted. Use void instead.',
      collection: SyncCollection.SALES,
      action:     SyncAction.DELETE,
    });
    return;
  }

  // Check if this transaction already exists (idempotency at DB level)
  const existing = await client.query<{
    id: string; updated_at: Date; worker_tag: string;
  }>(
    `SELECT id, updated_at, worker_tag
     FROM sales
     WHERE tenant_id = $1 AND transaction_id = $2
     LIMIT 1`,
    [tenantId, d.transaction_id],
  );

  if (change.action === SyncAction.CREATE) {
    if (existing.rows.length > 0) {
      // Already exists — idempotent: report as accepted with the existing server_id
      accepted.push({
        id: change.id, server_id: existing.rows[0].id,
        action: SyncAction.CREATE, collection: SyncCollection.SALES,
      });
      return;
    }

    // ── Plan resource-limit gate ──────────────────────────────────────────
    // Runs BEFORE stock reservation so a sale rejected for being over the
    // plan's monthly transaction limit never reserves stock it will never
    // consume.
    const limitCheck = await checkResourceLimit(tenantId, 'max_monthly_transactions');
    if (!limitCheck.allowed) {
      rejected.push({
        id: change.id,
        reason: `Monthly transaction limit reached (${limitCheck.current}/${limitCheck.limit} this month). `
          + 'Upgrade the subscription plan to record more sales this month.',
        collection: SyncCollection.SALES, action: SyncAction.CREATE,
      });
      return;
    }

    // Generated BEFORE reserveStockForSale (not after, as before this
    // change) — inventory_reorder_logs.triggered_by_sale_id needs a real
    // sales.id to reference, and Postgres checks FK constraints immediately,
    // not deferred. The reorder-log rows themselves are only written once
    // the `sales` INSERT below actually succeeds.
    const serverId = uuidv4();

    let reorderCrossings: Awaited<ReturnType<typeof reserveStockForSale>>;
    try {
      reorderCrossings = await reserveStockForSale(client, tenantId, d.items_sold);
    } catch (err) {
      const reason = (err instanceof InsufficientStockError || err instanceof UnknownUnitError)
        ? err.message
        : 'Failed to reserve stock for this sale';
      rejected.push({
        id: change.id, reason,
        collection: SyncCollection.SALES, action: SyncAction.CREATE,
      });
      return;
    }

    await client.query(
      `INSERT INTO sales
         (id, tenant_id, transaction_id, customer_id, items_sold, total_amount,
          discount_amount, tax_amount, payment_method, payment_status,
          worker_tag, sale_timestamp)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
      [
        serverId, tenantId, d.transaction_id,
        d.customer_id ?? null,
        JSON.stringify(d.items_sold),
        d.total_amount, d.discount_amount, d.tax_amount,
        d.payment_method, d.payment_status,
            workerTag, d.sale_timestamp,
      ],
    );
    await writeAuditLog(client, tenantId, 'sale', serverId, 'CREATE', workerTag, null, d);

    // Now that the sale row exists, log any reorder-threshold crossings from
    // this sale's deductions — an append-only event log, not a mutable
    // status column (see inventory_reorder_logs's migration comment for why).
    for (const crossing of reorderCrossings) {
      await client.query(
        `INSERT INTO inventory_reorder_logs
           (tenant_id, product_id, product_sku, stock_at_trigger,
            reorder_level_at_trigger, reorder_quantity_at_trigger, triggered_by_sale_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId, crossing.productId, crossing.productSku, crossing.stockAtTrigger,
          crossing.reorderLevelAtTrigger, crossing.reorderQuantityAtTrigger, serverId,
        ],
      );
    }

    accepted.push({
      id: change.id, server_id: serverId,
      action: SyncAction.CREATE, collection: SyncCollection.SALES,
    });
    return;
  }

  // UPDATE — LWW check
  if (existing.rows.length === 0) {
    rejected.push({
      id:     change.id,
      reason: `Sale ${d.transaction_id} not found for UPDATE`,
      collection: SyncCollection.SALES,
      action: SyncAction.UPDATE,
    });
    return;
  }

  const row = existing.rows[0];
  if (!clientIsNewer(change.updated_at, row.updated_at)) {
    conflicts.push({
      id:          change.id,
      collection:  SyncCollection.SALES,
      client_data: change.data,
      server_data: row,
      resolution:  'SERVER_WINS',
      message:     'Server record is newer. Client change discarded (LWW).',
    });
    return;
  }

  await client.query(
    `UPDATE sales
     SET payment_status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, row.id, d.payment_status],
  );
  await writeAuditLog(client, tenantId, 'sale', row.id, 'UPDATE', workerTag, row, d);
  accepted.push({
    id: change.id, server_id: row.id,
    action: SyncAction.UPDATE, collection: SyncCollection.SALES,
  });
}

async function processInventory(
  client:    PoolClient,
  change:    SyncChangeInput,
  tenantId:  string,
  workerTag: string,
  userId:    string,
  accepted:  AcceptedChange[],
  rejected:  RejectedChange[],
  conflicts: ConflictRecord[],
): Promise<void> {
  const parse = inventoryDataSchema.safeParse(change.data);
  if (!parse.success) {
    rejected.push({
      id:         change.id,
      reason:     `Invalid inventory data: ${parse.error.issues.map(i => i.message).join('; ')}`,
      collection: SyncCollection.INVENTORIES,
      action:     change.action,
    });
    return;
  }
  const d = parse.data;

  const existing = await client.query<{
    id: string; updated_at: Date; client_updated_at: Date | null;
    stock_quantity: number; version: number;
  }>(
    `SELECT id, updated_at, client_updated_at, stock_quantity, version
     FROM inventories
     WHERE tenant_id = $1 AND product_sku = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, d.product_sku],
  );

  if (change.action === SyncAction.DELETE) {
    if (existing.rows.length === 0) {
      // Nothing to delete — idempotent success
      accepted.push({
        id: change.id, server_id: change.id,
        action: SyncAction.DELETE, collection: SyncCollection.INVENTORIES,
      });
      return;
    }
    const row = existing.rows[0];
    await client.query(
      `UPDATE inventories
       SET deleted_at  = NOW(),
           updated_by  = $3,
           updated_at  = NOW(),
           version     = version + 1
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row.id, userId],
    );
    await writeAuditLog(client, tenantId, 'inventory', row.id, 'SOFT_DELETE', workerTag, row, null);
    accepted.push({
      id: change.id, server_id: row.id,
      action: SyncAction.DELETE, collection: SyncCollection.INVENTORIES,
    });
    return;
  }

  if (existing.rows.length === 0) {
    // Genuinely new row — CREATE or first-time push of an item that doesn't
    // exist yet. Nothing to compare against, so the unconditional INSERT is
    // correct here.
    const serverId = uuidv4();
    await client.query(
      `INSERT INTO inventories
         (id, tenant_id, product_sku, barcode, name, description,
          unit_price, stock_quantity, reorder_level, category,
          client_updated_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (tenant_id, product_sku) DO UPDATE
         SET name              = EXCLUDED.name,
             barcode           = EXCLUDED.barcode,
             description       = EXCLUDED.description,
             unit_price        = EXCLUDED.unit_price,
             stock_quantity    = EXCLUDED.stock_quantity,
             reorder_level     = EXCLUDED.reorder_level,
             category          = EXCLUDED.category,
             client_updated_at = EXCLUDED.client_updated_at,
             updated_by        = EXCLUDED.updated_by,
             version           = inventories.version + 1,
             updated_at        = NOW()`,
      [
        serverId, tenantId, d.product_sku, d.barcode ?? null,
        d.name, d.description ?? null,
        d.unit_price, d.stock_quantity, d.reorder_level,
        d.category ?? null, change.updated_at,
        userId,
      ],
    );
    await writeAuditLog(client, tenantId, 'inventory', serverId, 'CREATE', workerTag, null, d);
    accepted.push({
      id: change.id, server_id: serverId,
      action: change.action, collection: SyncCollection.INVENTORIES,
    });
    return;
  }

  if (change.action === SyncAction.CREATE) {
    // A row already exists for this tenant+SKU (e.g. a device replaying a
    // stale local CREATE, or two devices creating the same SKU under
    // different clocks). Apply the same LWW check the UPDATE branch below
    // uses before allowing this CREATE to overwrite the existing row —
    // otherwise the ON CONFLICT DO UPDATE would blindly clobber newer
    // server data regardless of which side is actually newer.
    const row = existing.rows[0];
    const serverLogical = row.client_updated_at ?? row.updated_at;
    if (!clientIsNewer(change.updated_at, serverLogical)) {
      conflicts.push({
        id:          change.id,
        collection:  SyncCollection.INVENTORIES,
        client_data: change.data,
        server_data: { ...row },
        resolution:  'SERVER_WINS',
        message:     'Server record is newer. Client change discarded (LWW).',
      });
      return;
    }

    await client.query(
      `INSERT INTO inventories
         (id, tenant_id, product_sku, barcode, name, description,
          unit_price, stock_quantity, reorder_level, category,
          client_updated_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (tenant_id, product_sku) DO UPDATE
         SET name              = EXCLUDED.name,
             barcode           = EXCLUDED.barcode,
             description       = EXCLUDED.description,
             unit_price        = EXCLUDED.unit_price,
             stock_quantity    = EXCLUDED.stock_quantity,
             reorder_level     = EXCLUDED.reorder_level,
             category          = EXCLUDED.category,
             client_updated_at = EXCLUDED.client_updated_at,
             updated_by        = EXCLUDED.updated_by,
             version           = inventories.version + 1,
             updated_at        = NOW()`,
      [
        row.id, tenantId, d.product_sku, d.barcode ?? null,
        d.name, d.description ?? null,
        d.unit_price, d.stock_quantity, d.reorder_level,
        d.category ?? null, change.updated_at,
        userId,
      ],
    );
    await writeAuditLog(client, tenantId, 'inventory', row.id, 'CREATE', workerTag, row, d);
    accepted.push({
      id: change.id, server_id: row.id,
      action: change.action, collection: SyncCollection.INVENTORIES,
    });
    return;
  }

  // UPDATE — LWW check using client_updated_at as the logical clock
  const row = existing.rows[0];
  const serverLogical = row.client_updated_at ?? row.updated_at;
  if (!clientIsNewer(change.updated_at, serverLogical)) {
    conflicts.push({
      id:          change.id,
      collection:  SyncCollection.INVENTORIES,
      client_data: change.data,
      server_data: { ...row },
      resolution:  'SERVER_WINS',
      message:     'Server record is newer. Client change discarded (LWW).',
    });
    return;
  }

  await client.query(
    `UPDATE inventories
     SET name              = $3,
         barcode           = $4,
         description       = $5,
         unit_price        = $6,
         stock_quantity    = $7,
         reorder_level     = $8,
         category          = $9,
         client_updated_at = $10,
         updated_by        = $11,
         version           = version + 1,
         updated_at        = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId, row.id,
      d.name, d.barcode ?? null, d.description ?? null,
      d.unit_price, d.stock_quantity, d.reorder_level,
      d.category ?? null, change.updated_at, userId,
    ],
  );
  await writeAuditLog(client, tenantId, 'inventory', row.id, 'UPDATE', workerTag, row, d);
  accepted.push({
    id: change.id, server_id: row.id,
    action: SyncAction.UPDATE, collection: SyncCollection.INVENTORIES,
  });
}

async function processCustomer(
  client:    PoolClient,
  change:    SyncChangeInput,
  tenantId:  string,
  _workerTag: string,
  accepted:  AcceptedChange[],
  rejected:  RejectedChange[],
  conflicts: ConflictRecord[],
): Promise<void> {
  const parse = customerDataSchema.safeParse(change.data);
  if (!parse.success) {
    rejected.push({
      id:         change.id,
      reason:     `Invalid customer data: ${parse.error.issues.map(i => i.message).join('; ')}`,
      collection: SyncCollection.CUSTOMERS,
      action:     change.action,
    });
    return;
  }
  const d = parse.data;

  // Customers are keyed by client-generated UUID passed as change.id
  const existing = await client.query<{
    id: string; updated_at: Date; version: number;
  }>(
    `SELECT id, updated_at, version
     FROM customer_ledger
     WHERE tenant_id = $1 AND customer_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [tenantId, change.id],
  );

  if (change.action === SyncAction.DELETE) {
    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE customer_ledger SET deleted_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, existing.rows[0].id],
      );
    }
    accepted.push({
      id: change.id, server_id: existing.rows[0]?.id ?? change.id,
      action: SyncAction.DELETE, collection: SyncCollection.CUSTOMERS,
    });
    return;
  }

  if (existing.rows.length === 0) {
    const serverId = uuidv4();
    await client.query(
      `INSERT INTO customer_ledger
         (id, tenant_id, customer_id, customer_name, customer_phone, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [serverId, tenantId, change.id, d.customer_name, d.customer_phone ?? null, d.credit_limit],
    );
    accepted.push({
      id: change.id, server_id: serverId,
      action: SyncAction.CREATE, collection: SyncCollection.CUSTOMERS,
    });
    return;
  }

  const row = existing.rows[0];
  if (!clientIsNewer(change.updated_at, row.updated_at)) {
    conflicts.push({
      id:          change.id,
      collection:  SyncCollection.CUSTOMERS,
      client_data: change.data,
      server_data: row,
      resolution:  'SERVER_WINS',
      message:     'Server record is newer. Client change discarded (LWW).',
    });
    return;
  }

  await client.query(
    `UPDATE customer_ledger
     SET customer_name  = $3,
         customer_phone = $4,
         credit_limit   = $5,
         version        = version + 1,
         updated_at     = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, row.id, d.customer_name, d.customer_phone ?? null, d.credit_limit],
  );
  accepted.push({
    id: change.id, server_id: row.id,
    action: SyncAction.UPDATE, collection: SyncCollection.CUSTOMERS,
  });
}

async function processLedgerEntry(
  client:    PoolClient,
  change:    SyncChangeInput,
  tenantId:  string,
  workerTag: string,
  accepted:  AcceptedChange[],
  rejected:  RejectedChange[],
): Promise<void> {
  // Ledger entries are append-only financial records — only CREATE is allowed
  if (change.action !== SyncAction.CREATE) {
    rejected.push({
      id:         change.id,
      reason:     'Ledger entries are append-only. Only CREATE is permitted.',
      collection: SyncCollection.LEDGER_ENTRIES,
      action:     change.action,
    });
    return;
  }

  const parse = ledgerEntryDataSchema.safeParse(change.data);
  if (!parse.success) {
    rejected.push({
      id:         change.id,
      reason:     `Invalid ledger entry data: ${parse.error.issues.map(i => i.message).join('; ')}`,
      collection: SyncCollection.LEDGER_ENTRIES,
      action:     change.action,
    });
    return;
  }
  const d = parse.data;

  // Idempotency: check if already inserted by checking for a matching sale_id + entry_type
  if (d.sale_id) {
    const dup = await client.query<{ id: string }>(
      `SELECT id FROM ledger_entries
       WHERE tenant_id = $1 AND sale_id = $2 AND entry_type = $3 AND deleted_at IS NULL
       LIMIT 1`,
      [tenantId, d.sale_id, d.entry_type],
    );
    if (dup.rows.length > 0) {
      accepted.push({
        id: change.id, server_id: dup.rows[0].id,
        action: SyncAction.CREATE, collection: SyncCollection.LEDGER_ENTRIES,
      });
      return;
    }
  }

  const serverId = uuidv4();
  await client.query(
    `INSERT INTO ledger_entries
       (id, tenant_id, customer_ledger_id, entry_type, amount,
        balance_after, sale_id, payment_reference, description, worker_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      serverId, tenantId, d.customer_ledger_id, d.entry_type, d.amount,
      d.balance_after, d.sale_id ?? null, d.payment_reference ?? null,
      d.description ?? null, workerTag,
    ],
  );

  // Update the parent ledger balance
  await client.query(
    `UPDATE customer_ledger
     SET balance       = $3,
         version       = version + 1,
         updated_at    = NOW(),
         last_credit_date = CASE WHEN $4 = 'CREDIT' THEN NOW() ELSE last_credit_date END,
         last_payment_date = CASE WHEN $4 = 'PAYMENT' THEN NOW() ELSE last_payment_date END
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, d.customer_ledger_id, d.balance_after, d.entry_type],
  );

  await writeAuditLog(
    client, tenantId, 'ledger', serverId,
    d.entry_type === 'CREDIT' ? 'CREDIT' : 'PAYMENT',
    workerTag, null, d,
  );
  accepted.push({
    id: change.id, server_id: serverId,
    action: SyncAction.CREATE, collection: SyncCollection.LEDGER_ENTRIES,
  });
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

type AuditAction =
  | 'CREATE' | 'UPDATE' | 'SOFT_DELETE' | 'VOID'
  | 'CREDIT' | 'PAYMENT' | 'CLOCK_DRIFT' | 'REFUND';

// Exported for refund-service.ts, which writes its own 'REFUND' audit
// entries under the same append-only audit_logs table/format rather than
// duplicating this helper.
export async function writeAuditLog(
  client:     PoolClient,
  tenantId:   string,
  entityType: string,
  entityId:   string,
  action:     AuditAction,
  workerTag:  string,
  oldValues:  Record<string, unknown> | null,
  newValues:  unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (tenant_id, entity_type, entity_id, action, worker_tag, old_values, new_values)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      tenantId, entityType, entityId, action, workerTag,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ],
  );
}

// ─── Sync cursor ──────────────────────────────────────────────────────────────

async function updateSyncCursor(
  client:   PoolClient,
  tenantId: string,
  deviceId: string,
  token:    string,
): Promise<void> {
  await client.query(
    `INSERT INTO sync_cursors (tenant_id, device_id, sync_token, last_synced_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET sync_token    = EXCLUDED.sync_token,
           last_synced_at = NOW()`,
    [tenantId, deviceId, token],
  );
}

// ─── Main reconciliation function ─────────────────────────────────────────────

/**
 * processSync
 * ──────────────────────────────────────────────────────────────────────────────
 * Core LWW reconciliation engine. All changes run inside a single database
 * transaction under READ COMMITTED isolation (per skill-1 requirements).
 *
 * On any unrecoverable DB error the transaction is rolled back and the error
 * re-thrown — the BullMQ worker applies its retry/backoff policy above this.
 */
export async function processSync(job: SyncJobPayload): Promise<SyncResponse> {
  const startTime = Date.now();
  const serverNow = Date.now();

  const accepted:  AcceptedChange[]  = [];
  const rejected:  RejectedChange[]  = [];
  const conflicts: ConflictRecord[]  = [];

  // Worst (largest-magnitude) drift observed across the batch, and how many
  // changes were rejected for it — used to flag the device once, not once
  // per offending change.
  let worstDriftMs = 0;
  let clockDriftRejectionCount = 0;

  const syncToken = `${job.tenantId}:${job.deviceId}:${Date.now()}`;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

    for (const change of job.changes) {
      // ── Clock-skew gate ─────────────────────────────────────────────────
      // Every collection below trusts `change.updated_at` as the LWW logical
      // clock. Validate it against the SERVER's clock before it ever reaches
      // a clientIsNewer() comparison — a device with a badly wrong clock
      // must never silently win (or lose) a conflict, it must be rejected
      // and flagged so the client can be told to fix its system time.
      const drift = checkClockDrift(change.updated_at, serverNow);
      if (!drift.withinBounds) {
        rejected.push({
          id:          change.id,
          reason:      `Rejected: client timestamp (${change.updated_at}) drifts ` +
                       `${Math.round(drift.driftMs / 1000)}s from the server clock, ` +
                       `outside the allowed window (+${MAX_FUTURE_DRIFT_MS / 1000}s / ` +
                       `-${MAX_PAST_DRIFT_MS / 1000}s). Check this device's system clock.`,
          collection:  change.collection,
          action:      change.action,
          clock_drift: true,
        });
        clockDriftRejectionCount += 1;
        if (Math.abs(drift.driftMs) > Math.abs(worstDriftMs)) {
          worstDriftMs = drift.driftMs;
        }
        continue; // Do NOT apply or overwrite anything for this change.
      }

      switch (change.collection) {
        case SyncCollection.SALES:
          await processSale(
            client, change, job.tenantId, job.workerTag,
            accepted, rejected, conflicts,
          );
          break;

        case SyncCollection.INVENTORIES:
          await processInventory(
            client, change, job.tenantId, job.workerTag, job.userId,
            accepted, rejected, conflicts,
          );
          break;

        case SyncCollection.CUSTOMERS:
          await processCustomer(
            client, change, job.tenantId, job.workerTag,
            accepted, rejected, conflicts,
          );
          break;

        case SyncCollection.LEDGER_ENTRIES:
          await processLedgerEntry(
            client, change, job.tenantId, job.workerTag,
            accepted, rejected,
          );
          break;

        default:
          rejected.push({
            id:         change.id,
            reason:     `Unknown collection: ${String((change as SyncChangeInput).collection)}`,
            collection: change.collection,
            action:     change.action,
          });
      }
    }

    await updateSyncCursor(client, job.tenantId, job.deviceId, syncToken);

    if (clockDriftRejectionCount > 0) {
      await flagDeviceClockDrift(
        client, job.tenantId, job.deviceId, syncToken,
        worstDriftMs, clockDriftRejectionCount, job.workerTag,
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    sync_token:           syncToken,
    clock_drift_detected: clockDriftRejectionCount > 0,
    server_time:          new Date(serverNow).toISOString(),
    accepted_changes:     accepted,
    rejected_changes:     rejected,
    conflicts,
    stats: {
      total_received:         job.changes.length,
      accepted:               accepted.length,
      rejected:               rejected.length,
      conflicts:              conflicts.length,
      clock_drift_rejections: clockDriftRejectionCount,
      processing_time_ms:     Date.now() - startTime,
    },
    timestamp: new Date().toISOString(),
  };
}
