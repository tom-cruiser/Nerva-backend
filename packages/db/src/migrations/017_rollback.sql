-- ROLLBACK: 017_subscription_requests.sql

DROP TRIGGER IF EXISTS trg_subscription_requests_updated_at ON subscription_requests;
DROP TABLE IF EXISTS subscription_requests;
