-- =============================================================================
-- MIGRATION: 003_sync_cursors.sql
-- PURPOSE:   Per-device sync cursor table for WatermelonDB pull checkpointing
-- =============================================================================

CREATE TABLE IF NOT EXISTS sync_cursors (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id      VARCHAR(255) NOT NULL,
  sync_token     TEXT         NOT NULL,
  last_synced_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sync_cursors_tenant_device UNIQUE (tenant_id, device_id)
);

-- Fast lookup: per-device cursor fetch (called on every pull)
CREATE INDEX IF NOT EXISTS idx_sync_cursors_tenant_device
  ON sync_cursors(tenant_id, device_id);

-- Cleanup: stale device cursors older than 90 days
CREATE INDEX IF NOT EXISTS idx_sync_cursors_last_synced
  ON sync_cursors(last_synced_at);

ANALYZE sync_cursors;
