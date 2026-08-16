import { Router } from 'express';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../../config/env';
import { getIo } from '../../realtime/io';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { usingSimulatedProviders } from '../../services/notification/adapters';
import { getStorage } from '../../services/storage/storage.adapter';
import { getRouteProvider } from '../../services/routing/route.provider';

const router = Router();

const READY_STATES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

/**
 * Liveness + capability report. Deliberately exposes no secrets: no URIs,
 * no credentials, no hostnames.
 */
const health = asyncHandler(async (_req: Request, res: Response) => {
  const state = mongoose.connection.readyState;
  const dbConnected = state === 1;

  sendSuccess(
    res,
    {
      status: dbConnected ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      environment: env.nodeEnv,
      database: {
        connected: dbConnected,
        state: READY_STATES[state] ?? 'unknown',
        name: dbConnected ? mongoose.connection.name : null,
      },
      realtime: {
        // Socket.IO needs a long-lived server; on serverless this is false and
        // clients fall back to polling the REST API.
        socketsEnabled: getIo() !== null,
      },
      storage: { driver: getStorage().name },
      routing: { provider: getRouteProvider().name, usesLiveTraffic: false },
      notifications: { externalChannelsSimulated: usingSimulatedProviders() },
      timestamp: new Date().toISOString(),
    },
    { status: dbConnected ? 200 : 503 },
  );
});

router.get('/', health);

export default router;
