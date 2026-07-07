// env validation MUST be the first import — exits process on misconfiguration
import { env } from '@retail/config';
import { app } from './app';
import { closePool } from '@retail/db';
import { closeRedis } from '@retail/redis';

const PORT = Number(env.PORT ?? 3001);

const server = app.listen(PORT, () => {
  console.log(`[auth-tenant] Listening on port ${PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[auth-tenant] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    await Promise.all([closePool(), closeRedis()]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
