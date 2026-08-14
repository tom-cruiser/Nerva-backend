-- ROLLBACK: 021_whatsapp_reports.sql

DROP INDEX IF EXISTS idx_whatsapp_report_logs_tenant;
DROP TABLE IF EXISTS whatsapp_report_logs;
DROP TABLE IF EXISTS whatsapp_report_schedules;

ALTER TABLE inventories
  DROP COLUMN IF EXISTS cost_price;
