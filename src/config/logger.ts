/* eslint-disable no-console */
import { env } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = env.isTest ? 'error' : env.isProduction ? 'info' : 'debug';

/** Keys whose values must never reach the logs. */
const REDACTED_KEYS = [
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'mongodb_uri',
  'mongodburi',
  'uri',
  'secret',
  'jwt_access_secret',
  'jwt_refresh_secret',
  'signature',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.includes(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && /mongodb(\+srv)?:\/\//i.test(value)) return '[redacted-uri]';
  return value;
}

function emit(level: Level, message: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  if (meta === undefined) console[level === 'debug' ? 'log' : level](`${prefix} ${message}`);
  else console[level === 'debug' ? 'log' : level](`${prefix} ${message}`, redact(meta));
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
