import type { NextFunction, Request, Response } from 'express';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/tokens';

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies the access token and loads the *current* user record on every request.
 * Loading from the database (rather than trusting the JWT claims) means a user
 * who is deactivated mid-session is blocked immediately, without waiting for the
 * access token to expire.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req);
    if (!token) throw ApiError.unauthorized('Authentication required');

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);

    if (!user) throw ApiError.unauthorized('Account no longer exists', 'ACCOUNT_MISSING');
    if (!user.active || user.archivedAt) {
      throw ApiError.forbidden('This account has been deactivated. Contact your administrator.', 'ACCOUNT_DISABLED');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches the user when a valid token is present, but never rejects. */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req);
    if (!token) return next();
    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);
    if (user?.active && !user.archivedAt) req.user = user;
    next();
  } catch {
    next();
  }
}

/** Narrowing helper for handlers that run behind `authenticate`. */
export function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized('Authentication required');
  return req.user;
}
