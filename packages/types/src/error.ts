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
  | 'INTERNAL_ERROR';

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
