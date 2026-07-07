import { env } from '@retail/config';
import { app } from './app';
import { closePool } from '@retail/db';

const PORT = Number(env.PORT ?? 3002);
const server = app.listen(PORT, () =>
  console.log(`[inventory] Listening on port ${PORT} (${env.NODE_ENV})`),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[inventory] ${signal} — shutting down`);
  server.close(async () => { await closePool(); process.exit(0); });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
