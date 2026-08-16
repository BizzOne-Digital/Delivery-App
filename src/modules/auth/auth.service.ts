import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { RefreshToken } from '../../models/RefreshToken';
import type { UserDocument } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import {
  durationToMs,
  hashToken,
  newTokenFamilyId,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../utils/tokens';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

/** Issues a new access/refresh pair and persists the hashed refresh token. */
export async function issueTokens(
  user: UserDocument,
  options: { familyId?: string; userAgent?: string } = {},
): Promise<TokenPair> {
  const familyId = options.familyId ?? newTokenFamilyId();

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    pharmacyId: user.pharmacyId ? String(user.pharmacyId) : null,
    assignedPharmacyIds: (user.assignedPharmacyIds ?? []).map(String),
  });

  const refreshToken = signRefreshToken({ sub: String(user._id), familyId });

  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + durationToMs(env.jwt.refreshExpiresIn)),
    userAgent: options.userAgent?.slice(0, 300),
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: Math.floor(durationToMs(env.jwt.accessExpiresIn) / 1000),
  };
}

/**
 * Rotates a refresh token.
 *
 * Reuse detection: if the presented token has already been rotated or revoked,
 * every token in its family is revoked — a stolen token cannot be used to keep a
 * parallel session alive.
 */
export async function rotateRefreshToken(
  presented: string,
  user: UserDocument,
  userAgent?: string,
): Promise<TokenPair> {
  const payload = verifyRefreshToken(presented);
  const tokenHash = hashToken(presented);
  const stored = await RefreshToken.findOne({ tokenHash });

  if (!stored) {
    // Unknown but validly signed token — treat the whole family as compromised.
    await RefreshToken.updateMany(
      { familyId: payload.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw ApiError.unauthorized('Session is no longer valid. Please sign in again.', 'REFRESH_REUSED');
  }

  if (stored.revokedAt || stored.replacedByHash) {
    await RefreshToken.updateMany(
      { familyId: stored.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw ApiError.unauthorized(
      'This session was already refreshed elsewhere. Please sign in again.',
      'REFRESH_REUSED',
    );
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized('Session expired. Please sign in again.', 'REFRESH_EXPIRED');
  }

  const next = await issueTokens(user, { familyId: stored.familyId, userAgent });

  stored.revokedAt = new Date();
  stored.replacedByHash = hashToken(next.refreshToken);
  await stored.save();

  return next;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: hashToken(token), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

const RESET_PURPOSE = 'password-reset';

/** Short-lived, single-purpose token for the development password-reset flow. */
export function createPasswordResetToken(user: UserDocument): string {
  return jwt.sign(
    { sub: String(user._id), purpose: RESET_PURPOSE, pv: user.passwordHash.slice(-12) },
    env.jwt.accessSecret,
    { expiresIn: '30m' },
  );
}

export function verifyPasswordResetToken(token: string): { sub: string; pv: string } {
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret) as {
      sub: string;
      purpose?: string;
      pv: string;
    };
    if (decoded.purpose !== RESET_PURPOSE) throw new Error('wrong purpose');
    return { sub: decoded.sub, pv: decoded.pv };
  } catch {
    throw ApiError.badRequest('This reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
  }
}
