import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';

mongoose.set('strictQuery', true);

/**
 * Serverless platforms (Vercel) reuse the Node process between invocations but
 * may run many concurrent lambdas. Cache the connection promise on globalThis so
 * a warm lambda reuses its socket instead of opening a new pool each request.
 */
type MongooseCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

const globalWithCache = globalThis as typeof globalThis & { __justDeliveryMongoose?: MongooseCache };
const cache: MongooseCache = globalWithCache.__justDeliveryMongoose ?? { conn: null, promise: null };
globalWithCache.__justDeliveryMongoose = cache;

/** Strips credentials so we can log *where* we connected without leaking secrets. */
function safeTarget(uri: string): string {
  try {
    const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
    const hostPart = withoutScheme.split('@').pop() ?? '';
    return hostPart.split('/')[0] ?? 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

export async function connectDatabase(uriOverride?: string): Promise<typeof mongoose> {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;

  const uri = uriOverride ?? env.mongoUri;

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, {
        // Always land in `delivery-app` even if the URI omits a database path.
        dbName: env.mongoDbName,
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: env.isProduction ? 10 : 20,
        autoIndex: !env.isProduction,
      })
      .then((m) => {
        logger.info(
          `MongoDB connected (host=${safeTarget(uri)} db=${m.connection.name ?? env.mongoDbName})`,
        );
        return m;
      })
      .catch((error: unknown) => {
        cache.promise = null;
        throw enrichConnectionError(error);
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectDatabase(): Promise<void> {
  if (cache.conn) {
    await mongoose.disconnect();
    cache.conn = null;
    cache.promise = null;
  }
}

/** Turn opaque driver failures into instructions the developer can act on. */
function enrichConnectionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (/ENOTFOUND|querySrv|getaddrinfo/i.test(message)) {
    return new Error(
      'MongoDB connection failed: the cluster hostname could not be resolved. ' +
        'Check the cluster address in MONGODB_URI and your internet/DNS connection.',
    );
  }
  if (/Authentication failed|bad auth/i.test(message)) {
    return new Error(
      'MongoDB authentication failed. Verify the database username/password in MONGODB_URI. ' +
        'Special characters in the password must be percent-encoded (@ -> %40, # -> %23).',
    );
  }
  if (/IP that isn.t whitelisted|not allowed to connect|ServerSelectionError|timed out/i.test(message)) {
    return new Error(
      [
        'MongoDB Atlas refused or timed out the connection — your IP is probably not whitelisted.',
        '',
        'To whitelist it:',
        '  1. Open https://cloud.mongodb.com and select your project.',
        '  2. Go to Security → Network Access.',
        '  3. Click "ADD IP ADDRESS".',
        '  4. Choose "ADD CURRENT IP ADDRESS" (or enter 0.0.0.0/0 for open access — dev only,',
        '     and required when deploying to Vercel because its function IPs are dynamic).',
        '  5. Wait for the entry to become "Active", then restart the backend.',
        '',
      ].join('\n'),
    );
  }
  return new Error(`MongoDB connection failed: ${message}`);
}
