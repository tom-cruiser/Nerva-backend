# Skill: Mobile Money Operations & Ledger Accounts

Use this blueprint when touching calculations on money transactions, customer financial balances, or vendor tracking.

## 1. Ledger Balance Execution
- Core Schemas: `customer_ledgers` (id, tenant_id, customer_id, balance)
- **FIFO Enforcement:** Incoming credit applications or repayments must systematically zero down balances utilizing a First-In, First-Out sequence structure.
- **Audit Requirement:** Log state tracking data down to `audit_logs` before resolving.

## 2. Mobile Money Triggers
- Targets: MTN, Airtel, Vodafone, Tigo.
- Schema verification: `mobile_money_receipts` (id, tenant_id, transaction_id, status)
- Never directly modify money balances without checking for verifiable processing hooks or callback receipts first.