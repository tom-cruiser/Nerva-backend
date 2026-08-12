/**
 * Canonical API error codes for the entire cluster.
 * Every service must map internal errors to one of these codes.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'LOCKED'
  | 'INTERNAL_ERROR'
  // ── whatsapp-engine operation-specific variants ──────────────────────────
  // Distinct from INTERNAL_ERROR so a client can tell which WhatsApp
  // operation failed (connect vs. send vs. admin op, etc.) without parsing
  // the message string. See services/whatsapp-engine/src/routes/*.ts.
  | 'CONNECT_FAILED'
  | 'STATUS_FAILED'
  | 'SEND_FAILED'
  | 'BULK_SEND_FAILED'
  | 'LOGOUT_FAILED'
  | 'ADMIN_ERROR'
  | 'REPORT_FAILED'
  | 'SCHEDULE_FAILED';

/**
 * Wire-format for all error responses (agents.md §4).
 */
export interface ApiErrorPayload {
  error:     string;
  code:      ErrorCode;
  details:   Record<string, unknown>;
  timestamp: string;   // ISO-8601
  requestId: string;   // UUIDv4
}
