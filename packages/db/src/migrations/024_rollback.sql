-- ROLLBACK: 024_sale_refunds.sql

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN
    ('CREATE','UPDATE','SOFT_DELETE','VOID','RECONCILE',
     'LOGIN','LOGIN_FAIL','LOCK','CREDIT','PAYMENT','CLOCK_DRIFT'));

-- NOTE: will FAIL if any row currently has payment_status = 'PARTIALLY_REFUNDED'
-- — by design; a rollback should not silently corrupt existing sales data.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_status_check
  CHECK (payment_status IN ('PENDING','PAID','FAILED','REFUNDED'));

ALTER TABLE sales DROP COLUMN IF EXISTS refunded_amount;

DROP TABLE IF EXISTS sale_refunds;
