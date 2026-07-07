import { z } from 'zod';

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const SyncAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
} as const;
export type SyncAction = (typeof SyncAction)[keyof typeof SyncAction];

export const SyncCollection = {
  SALES:         'sales',
  INVENTORIES:   'inventories',
  CUSTOMERS:     'customers',
  LEDGER_ENTRIES:'ledger_entries',
} as const;
export type SyncCollection = (typeof SyncCollection)[keyof typeof SyncCollection];

// ─── Zod schemas ──────────────────────────────────────────────────────────────

/**
 * A single offline change record emitted by WatermelonDB.
 * `data` is collection-specific — validated per-collection in the service layer.
 */
export const syncChangeSchema = z.object({
  id:               z.string().uuid('change.id must be a UUID'),
  collection:       z.enum(['sales', 'inventories', 'customers', 'ledger_entries']),
  action:           z.enum(['CREATE', 'UPDATE', 'DELETE']),
  data:             z.record(z.unknown()),
  updated_at:       z.string().datetime({ offset: true, message: 'updated_at must be ISO-8601' }),
  client_created_at:z.string().datetime({ offset: true, message: 'client_created_at must be ISO-8601' }),
  device_id:        z.string().min(1, 'device_id is required'),
});

export const syncPayloadSchema = z.object({
  client_mutation_id: z.string().uuid('client_mutation_id must be a UUID'),
  // tenant_id from body is only used for validation against the JWT — the JWT value wins
  tenant_id:          z.string().uuid('tenant_id must be a UUID'),
  device_id:          z.string().min(1, 'device_id is required'),
  changes:            z
    .array(syncChangeSchema)
    .min(1,   'changes array must not be empty')
    .max(500, 'Batch exceeds 500 transaction limit'),
  last_sync_token:    z.string().optional(),
  timestamp:          z.string().datetime({ offset: true }),
  client_version:     z.string().optional(),
});

// ─── Derived types ────────────────────────────────────────────────────────────

export type SyncChangeInput  = z.infer<typeof syncChangeSchema>;
export type SyncPayloadInput = z.infer<typeof syncPayloadSchema>;

// ─── Per-collection data shapes (validated inside the service) ────────────────

export const saleDataSchema = z.object({
  transaction_id:  z.string().min(1),
  customer_id:     z.string().uuid().optional(),
  items_sold:      z.array(z.object({
    product_sku: z.string().min(1),
    quantity:    z.number().int().positive(),
    unit_price:  z.number().nonnegative(),
    total:       z.number().nonnegative(),
  })).min(1),
  total_amount:    z.number().nonnegative(),
  discount_amount: z.number().nonnegative().default(0),
  tax_amount:      z.number().nonnegative().default(0),
  payment_method:  z.enum(['CASH', 'MOMO', 'CREDIT', 'CARD']),
  payment_status:  z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDED']).default('PENDING'),
  sale_timestamp:  z.string().datetime({ offset: true }),
});

export const inventoryDataSchema = z.object({
  product_sku:    z.string().min(1),
  name:           z.string().min(1),
  barcode:        z.string().optional(),
  description:    z.string().optional(),
  unit_price:     z.number().nonnegative(),
  stock_quantity: z.number().int().nonnegative(),
  reorder_level:  z.number().int().nonnegative().default(0),
  category:       z.string().optional(),
});

export const customerDataSchema = z.object({
  customer_name:  z.string().min(1),
  customer_phone: z.string().optional(),
  credit_limit:   z.number().nonnegative().default(0),
});

export const ledgerEntryDataSchema = z.object({
  customer_ledger_id: z.string().uuid(),
  entry_type:         z.enum(['CREDIT', 'PAYMENT', 'ADJUSTMENT']),
  amount:             z.number().positive(),
  balance_after:      z.number().nonnegative(),
  sale_id:            z.string().uuid().optional(),
  payment_reference:  z.string().optional(),
  description:        z.string().optional(),
});

// ─── Response types ───────────────────────────────────────────────────────────

export interface AcceptedChange {
  id:         string;   // client UUID
  server_id:  string;   // server UUID (upserted row)
  action:     SyncAction;
  collection: SyncCollection;
}

export interface RejectedChange {
  id:         string;
  reason:     string;
  collection: SyncCollection;
  action:     SyncAction;
}

export interface ConflictRecord {
  id:          string;
  collection:  SyncCollection;
  client_data: Record<string, unknown>;
  server_data: Record<string, unknown>;
  resolution:  'CLIENT_WINS' | 'SERVER_WINS' | 'MANUAL_REQUIRED';
  message:     string;
}

export interface SyncStats {
  total_received:     number;
  accepted:           number;
  rejected:           number;
  conflicts:          number;
  processing_time_ms: number;
}

export interface SyncResponse {
  sync_token:       string;
  accepted_changes: AcceptedChange[];
  rejected_changes: RejectedChange[];
  conflicts:        ConflictRecord[];
  stats:            SyncStats;
  timestamp:        string;  // ISO-8601
}

/** Shape stored in BullMQ queue */
export interface SyncJobPayload {
  tenantId:         string;
  userId:           string;
  workerTag:        string;
  clientMutationId: string;
  deviceId:         string;
  changes:          SyncChangeInput[];
  lastSyncToken:    string | undefined;
  receivedAt:       string;  // ISO-8601
}
