import { env } from '@retail/config';
import { app } from './app';
import { closePool }      from '@retail/db';
import { closeRedis }     from '@retail/redis';
import { closeSyncQueue } from './queue/sync-queue';
import { closeSyncWorker } from './workers/sync-worker';

const PORT = Number(env.PORT ?? 3003);

const server = app.listen(PORT, () =>
  console.log(`[sales-sync] Listening on port ${PORT} (${env.NODE_ENV})`),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[sales-sync] ${signal} — shutting down`);
  server.close(async () => {
    await Promise.all([
      closeSyncWorker(),   // drain in-flight jobs first
      closeSyncQueue(),
      closePool(),
      closeRedis(),
    ]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
