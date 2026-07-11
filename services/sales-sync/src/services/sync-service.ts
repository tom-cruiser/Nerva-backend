import { getClient }    from '@retail/db';
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

// ─── Per-collection processors ────────────────────────────────────────────────

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

    const serverId = uuidv4();
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

  if (change.action === SyncAction.CREATE || existing.rows.length === 0) {
    // CREATE or first-time push of an item that doesn't exist yet
    const serverId = existing.rows[0]?.id ?? uuidv4();
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
  | 'CREDIT' | 'PAYMENT';

async function writeAuditLog(
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

  const accepted:  AcceptedChange[]  = [];
  const rejected:  RejectedChange[]  = [];
  const conflicts: ConflictRecord[]  = [];

  const syncToken = `${job.tenantId}:${job.deviceId}:${Date.now()}`;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

    for (const change of job.changes) {
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

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    sync_token:       syncToken,
    accepted_changes: accepted,
    rejected_changes: rejected,
    conflicts,
    stats: {
      total_received:     job.changes.length,
      accepted:           accepted.length,
      rejected:           rejected.length,
      conflicts:          conflicts.length,
      processing_time_ms: Date.now() - startTime,
    },
    timestamp: new Date().toISOString(),
  };
}
