import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from './ApiError';
import type { Role } from '../constants/enums';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  pharmacyId?: string | null;
  assignedPharmacyIds?: string[];
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  familyId: string;
  /** Unique per token. Without it, two tokens minted in the same second for the
   *  same user+family would be byte-identical and collide on the unique hash index. */
  jti: string;
  type: 'refresh';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
  } as SignOptions);
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, 'type' | 'jti'>): string {
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID(), type: 'refresh' },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpiresIn } as SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret) as AccessTokenPayload;
    if (decoded.type !== 'access') throw new Error('wrong token type');
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid authentication token', 'TOKEN_INVALID');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.refreshSecret) as RefreshTokenPayload;
    if (decoded.type !== 'refresh') throw new Error('wrong token type');
    return decoded;
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token', 'REFRESH_TOKEN_INVALID');
  }
}

/** Refresh tokens are persisted as SHA-256 digests, never in plaintext. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newTokenFamilyId(): string {
  return crypto.randomUUID();
}

/** Milliseconds represented by a `15m` / `30d` / `3600` style duration string. */
export function durationToMs(duration: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(duration.trim());
  if (!match) return 15 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (multipliers[unit] ?? 1000);
}

/**
 * Tokenised, read-only patient tracking link. Signed with a dedicated secret and
 * scoped to one order id; carries no patient data itself.
 */
export function createTrackingToken(orderId: string): string {
  const expiresAt = Date.now() + env.tracking.ttlHours * 3_600_000;
  const payload = `${orderId}.${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', env.tracking.secret)
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

export function verifyTrackingToken(token: string): string {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) throw ApiError.badRequest('Invalid tracking link', 'TRACKING_INVALID');

  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = crypto
    .createHmac('sha256', env.tracking.secret)
    .update(payload)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.badRequest('Invalid tracking link', 'TRACKING_INVALID');
  }

  const [orderId, expiresAt] = payload.split('.');
  if (!orderId || !expiresAt || Number(expiresAt) < Date.now()) {
    throw ApiError.badRequest('This tracking link has expired', 'TRACKING_EXPIRED');
  }
  return orderId;
}
