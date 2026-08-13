-- ROLLBACK: 016_users_permission_overrides.sql

ALTER TABLE users DROP COLUMN IF EXISTS permissions;
