### File 1: `.agent/skills/1-tenant-safety.md`
```markdown
# Skill: Tenant Isolation & Database Safety

Use this checklist whenever creating migrations, querying PostgreSQL tables, or generating database layers.

## 1. Database Mapping Check
Ensure your SQL or repository access maps to these core relations:
- `tenants` (id, business_name, billing_tier)
- `users` (id, tenant_id, email, password_hash, role)
- `inventories` (id, tenant_id, product_sku, barcode, stock, reorder_level)
- `sales` (id, tenant_id, worker_tag, total, created_at)
- `sale_items` (id, sale_id, product_sku, quantity, unit_price)
- `audit_logs` (id, tenant_id, user_id, action, payload, created_at)

## 2. SQL Requirements
- **Indices:** Every new table tracking transaction data must have:
  `CREATE INDEX idx_[table]_tenant ON [table_name](tenant_id);`
- **Queries:** Inject `WHERE tenant_id = $1` into *every* single read/write routine. Never assume execution context.
- **Transactions:** Multi-table mutations must be wrapped using explicit `BEGIN` and `COMMIT` block architectures under a `READ_COMMITTED` isolation tier.