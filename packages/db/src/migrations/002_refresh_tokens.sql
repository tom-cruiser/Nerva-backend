-- =============================================================================
-- MIGRATION: 002_refresh_tokens.sql
-- PURPOSE:   Persistent refresh token store for RS256 JWT revocation
-- =============================================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  jti        UUID         PRIMARY KEY,                          -- JWT ID claim
  user_id    UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  tenant_id  UUID         NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  expires_at TIMESTAMPTZ  NOT NULL,
  revoked_at TIMESTAMPTZ,                                       -- NULL = active
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Active tokens by user (refresh flow)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON refresh_tokens(tenant_id, user_id)
  WHERE revoked_at IS NULL;

-- Single-token lookup by JTI (validation fast path)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti_active
  ON refresh_tokens(tenant_id, jti)
  WHERE revoked_at IS NULL;

-- Cleanup job: expired tokens (cron DELETE WHERE expires_at < NOW())
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON refresh_tokens(expires_at)
  WHERE revoked_at IS NULL;

ANALYZE refresh_tokens;
