-- ROLLBACK: 018_subscription_lifecycle_extras.sql

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_event_type_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN
    ('INVOICE_PAID', 'INVOICE_FAILED', 'PLAN_CHANGED',
     'TRIAL_STARTED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_REACTIVATED'));

ALTER TABLE platform_audit_logs DROP CONSTRAINT IF EXISTS platform_audit_logs_action_check;
ALTER TABLE platform_audit_logs ADD CONSTRAINT platform_audit_logs_action_check
  CHECK (action IN
    ('SUSPEND', 'UNBLOCK', 'SOFT_DELETE', 'PURGE', 'TIER_CHANGE',
     'KILL_SESSIONS', 'GRANT_STAFF', 'REVOKE_STAFF',
     'RATE_LIMIT_SET', 'RATE_LIMIT_CLEAR',
     'SETTINGS_UPDATE', 'ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_DEACTIVATE',
     'SUPPORT_TOKEN_ISSUE', 'SUPPORT_TOKEN_REVOKE',
     'PLAN_EDIT', 'PLAN_CHANGE', 'SUB_CANCEL', 'SUB_REACTIVATE',
     'FEATURE_FLAG_SET', 'FEATURE_FLAG_RESET', 'APPROVE'));

ALTER TABLE subscriptions DROP COLUMN IF EXISTS billing_cycle;
