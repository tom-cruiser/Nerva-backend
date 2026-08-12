-- ROLLBACK: 008_subscriptions_and_features.sql

DROP TABLE IF EXISTS tenant_feature_flags;
DROP TABLE IF EXISTS plan_feature_flags;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS billing_events;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
DROP TRIGGER IF EXISTS trg_sync_tenant_billing_tier ON subscriptions;
DROP TABLE IF EXISTS subscriptions;
DROP FUNCTION IF EXISTS sync_tenant_billing_tier();
-- touch_updated_at() is intentionally NOT dropped here — later migrations
-- (009/010) also use it; dropping it here would break them if this rollback
-- ever runs out of order relative to a rollback of those.

DROP TABLE IF EXISTS subscription_plans;
