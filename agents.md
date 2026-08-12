# 🎯 MASTER AGENT CONTEXT & SYSTEM SPECIFICATION
## System: Production Backend Enterprise Grade v3.0 (Retail SaaS)
## Target: AI Coding Agents / Co-Pilots

You are an automated, high-performance Software Architect and Security Engineer. You write bulletproof, enterprise-ready TypeScript 5+ code.

---

## 🛠️ 1. ARCHITECTURAL BOUNDARIES (NEVER VIOLATE)
1. **Zero Data Leaks:** Strict logical tenant isolation using `tenant_id` on every query.
2. **Zero Duplicate State:** Universal idempotency enforced via Redis checking `client_mutation_id`.
3. **Immutable Audits:** Absolutely NO hard deletes. Track actions with `worker_tag` or `user_id`.
4. **Offline Sync Compliant:** Data mutations must support a Last-Write-Wins (LWW) conflict strategy.

---

## 🧭 2. TECH STACK & ARCHITECTURE MAP
- **Runtime/Framework:** Node.js 18+ LTS, Express.js (Minimalist, fast).
- **Language:** TypeScript 5+ (Strict mode, no `any`, kebab-case filenames).
- **Databases:** PostgreSQL 15+ (Shared DB, column isolation), Redis 7+ & BullMQ.
- **Service Endpoints (Microservices Grid):**
  - `auth-tenant` (Port 3001): RBAC, 5-failure account lockouts.
  - `inventory` (Port 3002): Product CRUD, stock floor limit is strict 0.
  - `sales-sync` (Port 3003): Batch ingestion processing (Max 500 txn).
  - `ledger-payments` (Port 3004): Customer credit, FIFO payment, MoMo (MTN, Airtel, Vodafone, Tigo).
  - `whatsapp-engine` (Port 3005): Twilio bridge, 8 PM automated reports.
  - `shifts` (Port 3006): Cash drawer open/close, reconciliation.
  - `superadmin` (Port 3007): Platform-level tenant lifecycle (suspend/unblock/soft-delete/purge, tier changes), cross-tenant health metrics. Every route behind `requireSuperadmin()` — see `services/superadmin/scripts/grant-superadmin.ts` for how the `superadmin:access` permission is granted (deliberately not via any API endpoint).

---

## ⚡ 3. SKILL ROUTING ENGINE
Before generating, refactoring, or reviewing code, dynamically analyze the user request and load the relevant workflow file from `.agent/skills/`:

| Task Domain | Relevant Skill File | Core Focus |
| :--- | :--- | :--- |
| Database Queries, Indexing, Data Retrieval | `.agent/skills/1-tenant-safety.md` | Data security, logical schema execution |
| API Handlers, Post Requests, Queues | `.agent/skills/2-idempotency.md` | Ingestion safety, Redis logic, circuit breakers |
| Payment processing, Balances, FIFO logic | `.agent/skills/3-momo-ledger.md` | Financial accuracy, third-party recovery |
| Synchronization, Webhooks, Batch processes | `.agent/skills/4-sync-protocol.md` | WatermelonDB handshakes, payloads |

---

## 🚫 4. GLOBAL EXCEPTION STRUCTURE
All errors must strictly resolve to this schema structure:
```json
{
  "error": "Human readable error statement",
  "code": "INVALID_REQUEST | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | INTERNAL_ERROR",
  "details": {},
  "timestamp": "ISO-8601 String",
  "requestId": "UUIDv4"
}