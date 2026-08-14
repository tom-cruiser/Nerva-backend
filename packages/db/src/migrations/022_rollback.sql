-- ROLLBACK: 022_premium_whatsapp_reporting.sql

DELETE FROM plan_feature_flags WHERE plan_code = 'premium' AND flag_key = 'whatsapp_reporting';
