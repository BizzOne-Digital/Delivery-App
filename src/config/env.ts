import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the backend root regardless of the process working directory.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PLACEHOLDER_PATTERN = /^<.*>$/;

const isTest = process.env.NODE_ENV === 'test';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB_NAME: z.string().min(1).default('delivery-app'),

  JWT_ACCESS_SECRET: z.string().min(16).default('test_access_secret_change_me_please'),
  JWT_REFRESH_SECRET: z.string().min(16).default('test_refresh_secret_change_me_please'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  CLIENT_URL: z.string().default('http://localhost:8081'),

  UPLOAD_BASE_URL: z.string().default('http://localhost:5000'),
  STORAGE_DRIVER: z.enum(['local', 'memory']).default('local'),
  UPLOAD_MAX_FILE_SIZE_MB: z.coerce.number().positive().default(8),

  SEED_PASSWORD: z.string().optional(),

  PUSH_PROVIDER: z.string().default('dev'),
  SMS_PROVIDER: z.string().default('dev'),
  EMAIL_PROVIDER: z.string().default('dev'),

  TRACKING_TOKEN_SECRET: z.string().min(16).default('test_tracking_secret_change_me_ok'),
  TRACKING_TOKEN_TTL_HOURS: z.coerce.number().positive().default(48),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().positive().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().positive().default(25),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Never echo values here — only key names and messages.
  throw new Error(`Invalid backend environment configuration:\n${issues}`);
}

const raw = parsed.data;

/**
 * MONGODB_URI is required everywhere except the test runner, which spins up an
 * in-memory MongoDB instance. Fail loudly and early with an actionable message.
 */
function resolveMongoUri(): string {
  const value = raw.MONGODB_URI?.trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    if (isTest) return '';
    throw new Error(
      [
        '',
        'MONGODB_URI is missing or still set to the placeholder value.',
        '',
        'Fix it in backend/.env:',
        '  MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/delivery-app?retryWrites=true&w=majority',
        '',
        'Notes:',
        '  • The database name must be `delivery-app`.',
        '  • Percent-encode special characters in the password (@ -> %40, # -> %23, etc).',
        '  • In MongoDB Atlas, add your current IP under Network Access before connecting.',
        '',
      ].join('\n'),
    );
  }
  return value;
}

const corsOrigins = raw.CLIENT_URL.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,

  get mongoUri(): string {
    return resolveMongoUri();
  },
  mongoDbName: raw.MONGODB_DB_NAME,

  jwt: {
    accessSecret: raw.JWT_ACCESS_SECRET,
    refreshSecret: raw.JWT_REFRESH_SECRET,
    accessExpiresIn: raw.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: raw.JWT_REFRESH_EXPIRES_IN,
  },

  corsOrigins,

  uploads: {
    baseUrl: raw.UPLOAD_BASE_URL.replace(/\/+$/, ''),
    driver: raw.STORAGE_DRIVER,
    maxFileSizeBytes: raw.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  },

  seedPassword: raw.SEED_PASSWORD,

  providers: {
    push: raw.PUSH_PROVIDER,
    sms: raw.SMS_PROVIDER,
    email: raw.EMAIL_PROVIDER,
  },

  tracking: {
    secret: raw.TRACKING_TOKEN_SECRET,
    ttlHours: raw.TRACKING_TOKEN_TTL_HOURS,
  },

  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: raw.RATE_LIMIT_MAX,
    authMax: raw.AUTH_RATE_LIMIT_MAX,
  },
} as const;

export type Env = typeof env;
