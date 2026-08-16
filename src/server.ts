import http from 'node:http';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './config/db';
import { createApp } from './app';
import { closeRealtime, initRealtime } from './realtime/io';
import { ensureUploadRoot } from './services/storage/storage.adapter';

async function bootstrap() {
  await ensureUploadRoot();

  // Fail fast and loudly if MongoDB is unreachable or misconfigured.
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);

  /**
   * A busy port is the most common start-up failure in development (a previous
   * `npm run dev` still running, or macOS AirPlay Receiver on 5000). Node's
   * default behaviour is an unhandled 'error' event and a stack trace, which
   * says nothing useful — catch it and print the fix instead.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${env.port} is already in use.`);
      console.error(
        [
          '',
          `Something is already listening on port ${env.port} — usually another`,
          '`npm run dev` you left running in a different terminal.',
          '',
          'Free the port:',
          `  lsof -ti:${env.port} | xargs kill -9`,
          '',
          'Or run this server on a different port:',
          `  PORT=${env.port + 1} npm run dev`,
          '',
          'On macOS, port 5000 is permanently held by Control Centre (AirPlay',
          'Receiver) — that is why this project defaults to 5001.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(env.port, () => {
    logger.info(`Delivery App API listening on http://localhost:${env.port} (${env.nodeEnv})`);
    logger.info(`Health check: http://localhost:${env.port}/api/v1/health`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    server.close();
    await closeRealtime();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  logger.error('Failed to start the server');
   
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
