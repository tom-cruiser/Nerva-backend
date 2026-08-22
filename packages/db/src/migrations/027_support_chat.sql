-- =============================================================================
-- MIGRATION: 027_support_chat.sql
-- PURPOSE:   Real-time tenant ↔ Super Admin support chat. One thread per
--            tenant (support_threads), append-only messages
--            (support_messages). Unread state is derived from a per-side
--            "last read" timestamp rather than a counter column, so it can
--            never drift out of sync with the actual message history —
--            read state is just `COUNT(*) WHERE created_at > last_read_at`.
--            Delivery to connected sockets happens over the existing
--            tenant:<id> / platform:staff rooms (@retail/redis's
--            publishRealtimeEvent) — no new rooms or socket wiring needed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS support_threads (
  tenant_id             UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status                VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  last_message_at       TIMESTAMPTZ,
  last_message_preview  TEXT,
  tenant_last_read_at   TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  staff_last_read_at    TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_messages (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_type    VARCHAR(10) NOT NULL CHECK (sender_type IN ('TENANT', 'STAFF')),
  sender_user_id UUID        NOT NULL,
  sender_email   VARCHAR(255),
  body           TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "give me tenant X's thread in order" (both the tenant's own GET
-- and the Super Admin thread-detail view).
CREATE INDEX IF NOT EXISTS idx_support_messages_tenant_created
  ON support_messages(tenant_id, created_at);

-- Support inbox list, ordered by most recently active thread.
CREATE INDEX IF NOT EXISTS idx_support_threads_last_message
  ON support_threads(last_message_at DESC NULLS LAST);

ANALYZE support_threads;
ANALYZE support_messages;
