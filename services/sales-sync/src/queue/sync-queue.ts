import { Queue, QueueEvents } from 'bullmq';
import { env }               from '@retail/config';
import type { SyncJobPayload } from '../types/sync-types';

const connection = {
  host: new URL(env.BULLMQ_REDIS_URL).hostname,
  port: Number(new URL(env.BULLMQ_REDIS_URL).port || 6379),
  password: new URL(env.BULLMQ_REDIS_URL).password || undefined,
};

export const SYNC_QUEUE_NAME = 'sales-sync:batch';

/**
 * BullMQ Queue instance.
 * Enqueue jobs from the HTTP handler — worker picks them up asynchronously.
 *
 * defaultJobOptions:
 *   attempts: 3        — skill-2 exponential backoff (3 retries max)
 *   backoff:  exponential + 1 s base — matches 1→2→4 s jitter pattern
 *   removeOnComplete: 100  — keep last 100 completed jobs for debugging
 *   removeOnFail:     500  — keep failed jobs longer for investigation
 */
export const syncQueue = new Queue<SyncJobPayload>(SYNC_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 1_000,
    },
    removeOnComplete: 100,
    removeOnFail:     500,
  },
});

/** QueueEvents for job-completion polling (used by the wait-for-result path). */
export const syncQueueEvents = new QueueEvents(SYNC_QUEUE_NAME, { connection });

syncQueue.on('error', (err: Error) => {
  console.error('[sync-queue] Queue error', err.message);
});

export async function closeSyncQueue(): Promise<void> {
  await syncQueueEvents.close();
  await syncQueue.close();
}
