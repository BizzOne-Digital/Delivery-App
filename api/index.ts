/**
 * Vercel serverless entrypoint.
 *
 * Vercel runs each request in a short-lived function, so:
 *   • the database connection is established lazily and cached on globalThis
 *     (see src/config/db.ts);
 *   • Socket.IO is NOT attached — it needs a long-lived server. The REST API is
 *     fully functional and the mobile app falls back to polling. To get realtime
 *     in production, deploy src/server.ts to a persistent host (Render, Railway,
 *     Fly.io) or use a hosted socket service.
 *   • the filesystem is read-only apart from /tmp, so set STORAGE_DRIVER=memory
 *     (demo) or plug in an S3/Cloudinary adapter (production).
 */
import { createApp } from '../src/app';

const app = createApp({ connectOnRequest: true });

export default app;
