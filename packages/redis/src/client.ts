import Redis from 'ioredis';

/**
 * Singleton Redis client.
 *
 * Connection source priority:
 *   1. REDIS_URL env var (set by @retail/config validation)
 *   2. Discrete REDIS_HOST / REDIS_PORT / REDIS_PASSWORD (legacy / local dev)
 *
 * lazyConnect: true — defers the TCP handshake until the first command,
 * so importing this module during startup does not block the event loop.
 */
const redisUrl = process.env['REDIS_URL'];

export const redis = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect:          true,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      retryStrategy(times: number): number | null {
        if (times > 10) return null;
        return Math.min(1000 * 2 ** times, 10_000);
      },
    })
  : new Redis({
      host:                 process.env['REDIS_HOST']     ?? 'localhost',
      port:                 Number(process.env['REDIS_PORT'] ?? 6379),
      password:             process.env['REDIS_PASSWORD'] ?? undefined,
      db:                   Number(process.env['REDIS_DB']  ?? 0),
      lazyConnect:          true,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      retryStrategy(times: number): number | null {
        if (times > 10) return null;
        return Math.min(1000 * 2 ** times, 10_000);
      },
    });

redis.on('error', (err: Error) => {
  console.error('[redis:client] Connection error', err.message);
});

redis.on('ready', () => {
  console.log('[redis:client] Connected');
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
