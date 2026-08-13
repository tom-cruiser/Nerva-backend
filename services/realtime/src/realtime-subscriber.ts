import type { Server as SocketIOServer } from 'socket.io';
import { redis, REALTIME_EVENTS_CHANNEL } from '@retail/redis';
import type { RealtimeEventMessage } from '@retail/redis';

/**
 * Subscribes to the shared real-time event channel and relays each message
 * to the matching Socket.IO room. Uses a SEPARATE Redis connection
 * (`redis.duplicate()`) — a connection in SUBSCRIBE mode can't run normal
 * commands, and the `redis` singleton this duplicates from is relied on
 * elsewhere (this same process's cron job, and every other service) for
 * plain GET/SET/PUBLISH, so it can't be put into subscribe mode itself.
 */
export function startRealtimeSubscriber(io: SocketIOServer): void {
  const subscriber = redis.duplicate();

  subscriber.on('error', (err: Error) => {
    console.error('[realtime:subscriber] Redis subscriber connection error', err.message);
  });

  subscriber.subscribe(REALTIME_EVENTS_CHANNEL, (err) => {
    if (err) {
      console.error('[realtime:subscriber] Failed to subscribe', err.message);
      return;
    }
    console.log(`[realtime:subscriber] Subscribed to ${REALTIME_EVENTS_CHANNEL}`);
  });

  subscriber.on('message', (_channel: string, raw: string) => {
    let message: RealtimeEventMessage;
    try {
      message = JSON.parse(raw) as RealtimeEventMessage;
    } catch (err) {
      console.error('[realtime:subscriber] Received malformed event payload', (err as Error).message);
      return;
    }
    io.to(message.room).emit(message.event, message.data);
  });
}
