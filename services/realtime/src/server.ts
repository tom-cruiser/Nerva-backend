import * as cron from 'node-cron';
import { env } from '@retail/config';
import { closePool } from '@retail/db';
import { closeRedis } from '@retail/redis';
import { app } from './app';
import { createSocketServer } from './socket';
import { startRealtimeSubscriber } from './realtime-subscriber';
import { runExpirationCheck } from './jobs/expiration-check';

const PORT = Number(env.PORT ?? 3008);

const server = app.listen(PORT, () =>
  console.log(`[realtime] Listening on port ${PORT} (${env.NODE_ENV})`),
);

const io = createSocketServer(server);
startRealtimeSubscriber(io);

// Daily at 00:00 (host/container local time — deploy this service on a UTC
// host, same known-simplification documented on the sales-report analytics
// endpoint's resolveWindow(), rather than reading tenants.timezone per row).
cron.schedule('0 0 * * *', () => {
  console.log('[realtime] Running scheduled expiration check');
  runExpirationCheck().catch((err) => {
    console.error('[realtime] Scheduled expiration check failed', err);
  });
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[realtime] ${signal} — shutting down`);
  io.close();
  server.close(async () => {
    await closePool();
    await closeRedis();
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
