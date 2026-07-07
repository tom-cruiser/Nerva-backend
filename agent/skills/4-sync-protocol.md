# Skill: Offline-First Synchronization Architecture

Use this checklist for managing interactions between the local WatermelonDB database client application and the `sales-sync` service.

## 1. Batch Payload Requirements
- Processing Target: `sales-sync` (Port 3003).
- Enforcement Cap: Maximum file system load limits batch handling routines to exactly 500 actions or transactions per ingestion sequence.

## 2. Conflict Handling Pattern
- **LWW Paradigm:** Always analyze timestamps (`updated_at` / `created_at`). The platform runs a strict Last-Write-Wins logic path. Local mutations matching earlier timestamps are updated by the incoming newer remote record payload automatically.