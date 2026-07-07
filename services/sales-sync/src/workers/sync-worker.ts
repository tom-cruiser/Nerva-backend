import { Worker, Job }   from 'bullmq';
import { env }           from '@retail/config';
import { redis }         from '@retail/redis';
import { processSync }   from '../services/sync-service';
import { SYNC_QUEUE_NAME } from '../queue/sync-queue';
import type { SyncJobPayload, SyncResponse } from '../types/sync-types';

const SYNC_RESULT_TTL = 24 * 60 * 60; // 24 hours — per skill-2 spec

const connection = {
  host:     new URL(env.BULLMQ_REDIS_URL).hostname,
  port:     Number(new URL(env.BULLMQ_REDIS_URL).port || 6379),
  password: new URL(env.BULLMQ_REDIS_URL).password || undefined,
};

/**
 * BullMQ Worker — processes sync batch jobs off the HTTP hot path.
 *
 * Concurrency: 5 — allows parallel processing across tenants while
 * keeping per-tenant DB connection pressure manageable (5 × 1 conn).
 *
 * On failure BullMQ applies exponential backoff: 1 s → 2 s → 4 s (3 attempts).
 * After exhausting retries the job moves to the failed set for manual inspection.
 */
export const syncWorker = new Worker<SyncJobPayload, SyncResponse>(
  SYNC_QUEUE_NAME,
  async (job: Job<SyncJobPayload, SyncResponse>) => {
    console.log(
      `[sync-worker] Processing job ${job.id} | tenant=${job.data.tenantId} | ` +
      `changes=${job.data.changes.length} | mutation=${job.data.clientMutationId}`,
    );

    const result = await processSync(job.data);

    // ── Persist result in Redis for idempotency replay ────────────────────────
    // Key mirrors the HTTP-layer lock key so a replayed HTTP request
    // will get the cached result without re-queuing.
    const redisKey = `sync:result:${job.data.tenantId}:${job.data.clientMutationId}`;
    await redis.set(redisKey, JSON.stringify(result), 'EX', SYNC_RESULT_TTL);

    console.log(
      `[sync-worker] Completed job ${job.id} | ` +
      `accepted=${result.stats.accepted} rejected=${result.stats.rejected} ` +
      `conflicts=${result.stats.conflicts} took=${result.stats.processing_time_ms}ms`,
    );

    return result;
  },
  {
    connection,
    concurrency: 5,
  },
);

syncWorker.on('failed', (job: Job<SyncJobPayload> | undefined, err: Error) => {
  console.error(
    `[sync-worker] Job ${job?.id ?? 'unknown'} failed after all retries`,
    { tenantId: job?.data.tenantId, error: err.message },
  );
});

syncWorker.on('error', (err: Error) => {
  console.error('[sync-worker] Worker error', err.message);
});

export async function closeSyncWorker(): Promise<void> {
  await syncWorker.close();
}
