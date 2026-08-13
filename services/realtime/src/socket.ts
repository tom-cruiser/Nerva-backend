import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { verifySupabaseJwt, JwtVerificationError } from '@retail/middleware';
import { tenantRoom, PLATFORM_STAFF_ROOM } from '@retail/redis';

const PLATFORM_STAFF_PERMISSIONS = ['platform:support', 'platform:billing', 'superadmin:access'];

/**
 * Creates the Socket.IO server and wires up handshake authentication + room
 * membership. There is no `req`/`res` here (unlike a normal Express route),
 * so authentication reuses verifySupabaseJwt() directly — the same real
 * signature/issuer/audience check tenantContextMiddleware runs, just called
 * from a WS handshake instead of an HTTP request.
 *
 * Room membership is decided once, at connect time, from the verified JWT's
 * own claims — never from anything the client sends outside the token:
 *   - `tenant:{tenantId}`  — any authenticated tenant user (app_metadata.tenant_id)
 *   - `platform:staff`     — any token carrying a platform-staff or superadmin:access permission
 * A token can hold both (none of today's tokens do, but nothing prevents it).
 */
export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.['token'];
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('Missing auth token'));
      return;
    }

    try {
      const claims = await verifySupabaseJwt(token);
      const meta = claims.app_metadata ?? {};
      const permissions = Array.isArray(meta.permissions) ? (meta.permissions as string[]) : [];

      const rooms: string[] = [];
      if (meta.tenant_id) rooms.push(tenantRoom(meta.tenant_id));
      if (permissions.some((p) => PLATFORM_STAFF_PERMISSIONS.includes(p))) rooms.push(PLATFORM_STAFF_ROOM);

      if (rooms.length === 0) {
        next(new Error('Token has no tenant assignment or platform-staff permission'));
        return;
      }

      socket.data['rooms'] = rooms;
      next();
    } catch (err) {
      const message = err instanceof JwtVerificationError ? err.message : 'Invalid token';
      next(new Error(message));
    }
  });

  io.on('connection', (socket: Socket) => {
    const rooms = (socket.data['rooms'] as string[] | undefined) ?? [];
    rooms.forEach((room) => void socket.join(room));
  });

  return io;
}
