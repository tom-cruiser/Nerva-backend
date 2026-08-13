/**
 * API Contract Types — Request & Response shapes for all mutating endpoints.
 *
 * These are the single source of truth consumed by:
 *   - Backend route handlers (parameter validation)
 *   - Frontend Zustand form stores (field typing, optimistic updates)
 *
 * Convention:
 *   - *Request  = inbound POST/PUT/PATCH body shape
 *   - *Response = successful 2xx payload shape
 *   - All mutation requests carry `clientMutationId` for idempotency
 */

// NOTE: this file used to also declare LoginRequest/LoginResponse/
// RefreshTokenRequest/RefreshTokenResponse for the custom RS256 auth path
// (services/auth-tenant's old /login, /refresh handlers). That path was
// removed — real auth is Supabase's signInWithPassword() — so those types
// were deleted as unused rather than left describing a route that no longer
// exists.

// ─── Inventory ────────────────────────────────────────────────────────────────

export interface CreateProductRequest {
  clientMutationId: string;
  productSku:       string;
  barcode?:         string;
  name:             string;
  stock:            number;  // must be >= 0
  reorderLevel:     number;
}

export interface UpdateStockRequest {
  clientMutationId: string;
  delta:            number;  // positive = restock, negative = adjustment
  reason:           string;  // audit note
}

export interface ProductResponse {
  id:           string;
  tenantId:     string;
  productSku:   string;
  barcode:      string | null;
  name:         string;
  stock:        number;
  reorderLevel: number;
  updatedAt:    string; // ISO-8601
}

// ─── Sales / Sync ─────────────────────────────────────────────────────────────

export interface SaleItem {
  productSku: string;
  quantity:   number;
  unitPrice:  number;
}

export interface CreateSaleRequest {
  clientMutationId: string;
  items:            SaleItem[];
  paymentProvider:  'mtn' | 'airtel' | 'vodafone' | 'tigo' | 'cash';
  providerTxnId?:   string; // MoMo transaction reference
}

export interface SaleResponse {
  id:              string;
  tenantId:        string;
  workerTag:       string;
  total:           number;
  paymentProvider: string;
  providerTxnId:   string | null;
  createdAt:       string;
}

/** WatermelonDB batch sync payload — max 500 items (skill-4) */
export interface SyncBatchRequest {
  clientMutationId: string;
  changes: {
    inventories?: {
      created: CreateProductRequest[];
      updated: Array<Partial<CreateProductRequest> & { id: string }>;
      deleted: string[]; // soft-delete IDs only — backend sets deleted_at
    };
    sales?: {
      created: CreateSaleRequest[];
    };
  };
  lastPulledAt: string | null; // ISO-8601 — null on first sync
}

export interface SyncBatchResponse {
  changes: {
    inventories: ProductResponse[];
    sales:       SaleResponse[];
  };
  timestamp: string; // server pull checkpoint
}

// ─── Ledger / Payments ────────────────────────────────────────────────────────

export interface RecordCreditRequest {
  clientMutationId: string;
  customerId:       string;
  amount:           number;  // positive = credit extended to customer
  note?:            string;
}

export interface RecordPaymentRequest {
  clientMutationId:  string;
  customerId:        string;
  amount:            number;  // amount being repaid
  paymentProvider:   'mtn' | 'airtel' | 'vodafone' | 'tigo' | 'cash';
  providerTxnId?:    string;
}

export interface LedgerBalanceResponse {
  customerId:     string;
  tenantId:       string;
  balance:        number;  // outstanding debt (positive = owes money)
  lastActivityAt: string;
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

export interface SendNotificationRequest {
  clientMutationId: string;
  recipientPhone:   string;  // E.164 format e.g. +233241234567
  templateName:     string;  // Twilio content template SID or name
  variables:        Record<string, string>;
}

export interface NotificationStatusResponse {
  messageId: string;
  status:    'queued' | 'sent' | 'delivered' | 'failed';
  sentAt:    string | null;
}
