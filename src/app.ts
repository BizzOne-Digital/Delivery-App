import path from 'node:path';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase } from './config/db';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/error';
import apiRoutes from './routes';
import { sendSuccess } from './utils/response';

export function createApp(options: { connectOnRequest?: boolean } = {}): Application {
  const app = express();

  // Behind Vercel/nginx, trust the proxy so rate limiting sees real client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and images to a native app / separate web origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: env.isProduction ? undefined : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Native apps and server-to-server calls send no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        // Expo dev servers use ephemeral LAN ports; allow them outside production.
        if (!env.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  if (!env.isTest) {
    app.use(
      morgan(env.isProduction ? 'combined' : 'dev', {
        stream: { write: (message) => logger.debug(message.trim()) },
        // Health checks would otherwise flood the log.
        skip: (req) => req.originalUrl.includes('/health'),
      }),
    );
  }

  /**
   * On serverless, each invocation may start cold. Ensure a database connection
   * exists before any route runs. Locally, server.ts connects once at boot.
   */
  if (options.connectOnRequest) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      connectDatabase()
        .then(() => next())
        .catch(next);
    });
  }

  // Locally-stored proof images. Read-only; no directory listing.
  app.use(
    '/uploads',
    express.static(path.resolve(__dirname, '../uploads'), {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
    }),
  );

  app.get('/', (_req, res) => {
    sendSuccess(res, {
      name: 'Delivery App API',
      version: 'v1',
      documentation: '/api/v1/health',
    });
  });

  app.use('/api/v1', apiLimiter, apiRoutes);

  // Convenience alias so a misconfigured client hitting /api still works.
  app.use('/api', apiLimiter, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
