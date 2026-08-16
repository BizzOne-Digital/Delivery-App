import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env';

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // The test suite fires many requests in a tight loop; limits stay on in dev/prod.
  skip: () => env.isTest,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again.' },
  },
};

export const apiLimiter = rateLimit({
  ...shared,
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
});

/** Tighter budget for credential endpoints (login, refresh, password reset). */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts. Please wait a few minutes and try again.',
    },
  },
});

/** Location pings are frequent by design — allow a much higher ceiling. */
export const locationLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  max: 120,
});

export const uploadLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  max: 40,
});
