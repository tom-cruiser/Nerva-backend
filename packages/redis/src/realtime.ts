import { redis } from './client';

/**
 * The single Redis Pub/Sub channel every service publishes real-time events
 * to. services/realtime is the only subscriber (on a dedicated `redis.
 * duplicate()` connection — a connection in SUBSCRIBE mode can't run normal
 * commands, so it can't share the `redis` singleton every other service
 * relies on for plain GET/SET). One shared channel carrying a `room` field
 * in the payload (rather than one Redis channel per room) keeps this to a
 * single subscribe call regardless of how many tenant/staff rooms exist.
 */
export const REALTIME_EVENTS_CHANNEL = 'realtime:events';

/** Socket.IO room every authenticated tenant user's socket joins. */
export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/** Socket.IO room every platform-staff socket (platform:support /
 *  platform:billing / superadmin:access) joins, regardless of tenant. */
export const PLATFORM_STAFF_ROOM = 'platform:staff';

/** Socket.IO room every authenticated tenant-user socket joins, in addition
 *  to its own tenant room — for platform-wide broadcasts that aren't
 *  specific to one tenant (e.g. superadmin announcements). See
 *  services/superadmin's settings-router.ts (publishes here on
 *  create/deactivate) and services/realtime's socket.ts (joins it). */
export const ALL_TENANTS_ROOM = 'tenants:all';

export interface RealtimeEventMessage {
  room:  string;
  event: string;
  data:  unknown;
}

/**
 * Publishes a real-time event for services/realtime to relay to connected
 * WebSocket clients in `room`. A plain `redis.publish()` on the shared
 * singleton — publishing is a normal command, not a mode switch, so any
 * service can call this with zero extra connection setup. Best-effort: a
 * missed real-time push is a UX inconvenience (the client's next
 * poll/refresh still sees the correct state), never a correctness issue, so
 * this never throws into the caller's transaction.
 */
export async function publishRealtimeEvent(room: string, event: string, data: unknown): Promise<void> {
  try {
    const message: RealtimeEventMessage = { room, event, data };
    await redis.publish(REALTIME_EVENTS_CHANNEL, JSON.stringify(message));
  } catch (err) {
    console.error('[redis:realtime] Failed to publish real-time event', (err as Error).message);
  }
}
