-- ROLLBACK: 023_starter_whatsapp_reporting.sql

DELETE FROM plan_feature_flags WHERE plan_code = 'starter' AND flag_key = 'whatsapp_reporting';
