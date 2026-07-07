# Skill: Idempotency & Resilient API Design

Use this checklist for writing controllers, API endpoints, middle-layers, and queue routines.

## 1. Idempotency Flow (Redis 7)
Before performing any structural data change execution (POST/PUT/PATCH):
1. Extract the `client_mutation_id` and `tenant_id`.
2. Evaluate presence of key: `idempotency:{tenantId}:{mutationId}`.
3. If Key Exists: Reject processing or yield the previously cached transaction signature.
4. If Key Misses: Initialize a temporary lock, execute operation, store final response hash with a strict 7-day TTL expiration.

## 2. Resiliency Protocol
- **Exponential Backoff:** Third-party networks need retry sequences using randomized jitter rules: `1s -> 2s -> 4s -> 8s -> 16s` (Max limit: 3 retries).
- **Circuit Breaker Rule:** Set tracking metrics to open failing dependencies if downstream drops out or logs 5 consecutive runtime failures in a single 60-second window.