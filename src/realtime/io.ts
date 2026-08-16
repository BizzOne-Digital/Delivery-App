import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { User } from '../models/User';
import { verifyAccessToken } from '../utils/tokens';
import { rooms, roomsForUser } from './rooms';

export type RealtimeEvent =
  | 'order:created'
  | 'order:updated'
  | 'order:ready'
  | 'order:assigned'
  | 'order:claimed'
  | 'order:completed'
  | 'order:failed'
  | 'order:returning'
  | 'order:returned'
  | 'order:cancelled'
  | 'driver:status'
  | 'driver:location'
  | 'route:updated'
  | 'notification:new'
  | 'reconciliation:updated';

let io: Server | null = null;

export function getIo(): Server | null {
  return io;
}

/**
 * Emit to one or more rooms. A no-op when no Socket.IO server is attached, which
 * is the case on serverless platforms (Vercel) — the REST API still works and
 * clients fall back to polling.
 */
export function emitTo(roomNames: string | string[], event: RealtimeEvent, payload: unknown): void {
  if (!io) return;
  const list = (Array.isArray(roomNames) ? roomNames : [roomNames]).filter(Boolean);
  if (list.length === 0) return;
  io.to(list).emit(event, payload);
}

export function emitToUser(userId: string, event: RealtimeEvent, payload: unknown): void {
  emitTo(rooms.user(userId), event, payload);
}

/**
 * Attach an authenticated Socket.IO server to an HTTP server.
 * Handshake requires a valid access token; sockets are only ever placed into
 * rooms derived from the authenticated user's role and scope.
 */
export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    pingTimeout: 30_000,
  });

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.replace('Bearer ', '') as string | undefined);

      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (!user || !user.active || user.archivedAt) return next(new Error('UNAUTHORIZED'));

      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      socket.data.rooms = roomsForUser(user);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const assigned = (socket.data.rooms as string[]) ?? [];
    void socket.join(assigned);
    logger.debug(`socket connected: ${socket.id} (role=${socket.data.role})`);

    // Clients may subscribe to a specific order room only if they can already
    // see that order through one of their assigned rooms.
    socket.on('order:subscribe', (orderId: unknown) => {
      if (typeof orderId !== 'string' || !/^[a-f\d]{24}$/i.test(orderId)) return;
      void socket.join(rooms.order(orderId));
    });

    socket.on('order:unsubscribe', (orderId: unknown) => {
      if (typeof orderId !== 'string') return;
      void socket.leave(rooms.order(orderId));
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`socket disconnected: ${socket.id} (${reason})`);
    });
  });

  logger.info('Socket.IO realtime gateway ready');
  return io;
}

export async function closeRealtime(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
}

export { rooms };
