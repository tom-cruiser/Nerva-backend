-- ROLLBACK: 013_seed_whatsapp_reporting_flag.sql

DELETE FROM plan_feature_flags
WHERE flag_key = 'whatsapp_reporting'
  AND plan_code IN ('business', 'business_premium');
