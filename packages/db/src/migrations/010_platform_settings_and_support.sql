-- =============================================================================
-- MIGRATION: 010_platform_settings_and_support.sql
-- PURPOSE:   Global settings/maintenance mode, announcements, read-only
--            support-impersonation tokens
-- =============================================================================

-- Singleton row — the classic boolean-primary-key trick guarantees exactly
-- one row can ever exist (id=TRUE is the only legal primary key value).
CREATE TABLE IF NOT EXISTS platform_settings (
  id                    BOOLEAN      PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  default_currency      VARCHAR(3)   NOT NULL DEFAULT 'XAF',
  default_timezone      VARCHAR(50)  NOT NULL DEFAULT 'UTC',
  maintenance_mode      BOOLEAN      NOT NULL DEFAULT FALSE,
  maintenance_message   TEXT,
  updated_by            UUID,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_announcements (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  message     TEXT         NOT NULL,
  level       VARCHAR(10)  NOT NULL DEFAULT 'INFO' CHECK (level IN ('INFO', 'WARNING', 'CRITICAL')),
  starts_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ends_at     TIMESTAMPTZ,
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  UUID         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: "what should be shown right now" — active flag plus the time
-- window, used by the public GET /announcements/active endpoint that every
-- tenant frontend polls unauthenticated.
CREATE INDEX IF NOT EXISTS idx_platform_announcements_active
  ON platform_announcements(active, starts_at, ends_at)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS platform_support_tokens (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash       VARCHAR(128) NOT NULL UNIQUE,  -- SHA-256 hex of the raw token — the raw value is returned once, at issuance, and never stored
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issued_by        UUID         NOT NULL,
  issued_by_email  VARCHAR(255),
  reason           TEXT         NOT NULL,
  issued_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  revoked_at       TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ
);

-- Hot path: validating an incoming X-Support-Token header on every request
-- that carries one — partial index keeps it small (only live, unexpired-ish
-- tokens matter; the WHERE clause can't reference NOW() in an index
-- predicate, so expiry itself is still checked in the query, not the index).
CREATE INDEX IF NOT EXISTS idx_platform_support_tokens_active
  ON platform_support_tokens(token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR',
     'SETTINGS_UPDATE', 'ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_DEACTIVATE',
     'SUPPORT_TOKEN_ISSUE', 'SUPPORT_TOKEN_REVOKE'));

ANALYZE platform_settings;
ANALYZE platform_announcements;
ANALYZE platform_support_tokens;
