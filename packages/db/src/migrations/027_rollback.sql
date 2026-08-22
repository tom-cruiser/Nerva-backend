-- ROLLBACK: 027_support_chat.sql
DROP INDEX IF EXISTS idx_support_threads_last_message;
DROP INDEX IF EXISTS idx_support_messages_tenant_created;
DROP TABLE IF EXISTS support_messages;
DROP TABLE IF EXISTS support_threads;
