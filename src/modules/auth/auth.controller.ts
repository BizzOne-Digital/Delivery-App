import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { User } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { generatePharmacyCode } from '../../utils/reference';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { recordAudit } from '../../services/audit.service';
import { requireUser } from '../../middleware/auth';
import {
  createPasswordResetToken,
  issueTokens,
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyPasswordResetToken,
} from './auth.service';
import { verifyRefreshToken } from '../../utils/tokens';

/** Shape returned to the client for the signed-in user. */
async function presentUser(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('Account not found');

  const pharmacyIds = [
    ...(user.pharmacyId ? [user.pharmacyId] : []),
    ...(user.assignedPharmacyIds ?? []),
  ];
  const pharmacies = pharmacyIds.length
    ? await Pharmacy.find({ _id: { $in: pharmacyIds } })
        .select('name code address latitude longitude active assignmentMode proofConfig logo')
        .lean()
    : [];

  return {
    id: String(user._id),
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    pharmacyId: user.pharmacyId ? String(user.pharmacyId) : null,
    assignedPharmacyIds: (user.assignedPharmacyIds ?? []).map(String),
    pharmacies,
    active: user.active,
    driverStatus: user.driverStatus,
    shiftStartedAt: user.shiftStartedAt ?? null,
    employeeCode: user.employeeCode ?? null,
    preferredMapApp: user.preferredMapApp,
    themePreference: user.themePreference,
    languagePreference: user.languagePreference,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  const user = await User.findOne({ email }).select('+passwordHash');

  // Identical response for "no such user" and "wrong password" — no enumeration.
  const invalid = ApiError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  if (!user) throw invalid;

  const matches = await user.comparePassword(password);
  if (!matches) throw invalid;

  if (!user.active || user.archivedAt) {
    throw ApiError.forbidden(
      'This account has been deactivated. Please contact your administrator.',
      'ACCOUNT_DISABLED',
    );
  }

  user.lastLoginAt = new Date();
  await user.save();

  const tokens = await issueTokens(user, { userAgent: req.headers['user-agent'] });

  await recordAudit({
    actorId: user._id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user._id,
    action: 'LOGIN',
    metadata: { role: user.role },
  });

  sendSuccess(res, { ...tokens, user: await presentUser(String(user._id)) }, { message: 'Signed in' });
});

/**
 * Public self-registration.
 *
 * Two account types only:
 *   PHARMACY — creates a PHARMACY_ADMIN plus their own pharmacy, so the account
 *              has a workspace to put orders in from the first sign-in.
 *   DRIVER   — creates a DRIVER with no linked pharmacies. Their Ready screen is
 *              empty until a company admin links them to pharmacies, which is
 *              the correct operational gate: a driver must not see a pharmacy's
 *              patients simply by signing up.
 *
 * Company roles (admin, dispatcher, finance, read-only) can never be created
 * here — the schema rejects them, so privilege escalation via signup is not
 * possible.
 */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    accountType: 'PHARMACY' | 'DRIVER';
    fullName: string;
    email: string;
    phone: string;
    password: string;
    pharmacyName?: string;
  };

  const existing = await User.findOne({ email: body.email });
  if (existing) {
    throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
  }

  const [firstName, ...rest] = body.fullName.trim().split(/\s+/);
  const lastName = rest.join(' ') || firstName;

  let pharmacy = null;
  if (body.accountType === 'PHARMACY') {
    const code = generatePharmacyCode(body.pharmacyName ?? 'PHARMACY');
    pharmacy = await Pharmacy.create({
      name: body.pharmacyName,
      code,
      email: body.email,
      phone: body.phone,
      contactPerson: body.fullName.trim(),
      // Placeholders the pharmacy completes in Settings; coordinates default to
      // the middle of London so distance sorting has something to work with
      // until a real address is saved.
      address: 'Address not set — update in Settings',
      latitude: 51.5074,
      longitude: -0.1278,
      active: true,
    });
  }

  const user = await User.create({
    firstName,
    lastName,
    email: body.email,
    phone: body.phone,
    passwordHash: await User.hashPassword(body.password),
    role: body.accountType === 'PHARMACY' ? 'PHARMACY_ADMIN' : 'DRIVER',
    pharmacyId: pharmacy?._id ?? null,
    assignedPharmacyIds: [],
    active: true,
    lastLoginAt: new Date(),
  });

  await recordAudit({
    actorId: user._id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user._id,
    action: 'CREATE',
    metadata: { selfRegistered: true, accountType: body.accountType },
  });

  const tokens = await issueTokens(user, { userAgent: req.headers['user-agent'] });

  sendSuccess(
    res,
    {
      ...tokens,
      user: await presentUser(String(user._id)),
      // The client shows this so a new driver understands why Ready is empty.
      nextStep:
        body.accountType === 'DRIVER'
          ? 'Your account is ready. A dispatcher must link you to a pharmacy before orders appear on your Ready screen.'
          : 'Your pharmacy has been created. Add your address in Settings, then start adding customers and orders.',
    },
    { status: 201, message: 'Account created' },
  );
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken: string };

  const payload = verifyRefreshToken(refreshToken);
  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'ACCOUNT_MISSING');
  if (!user.active || user.archivedAt) {
    throw ApiError.forbidden('This account has been deactivated.', 'ACCOUNT_DISABLED');
  }

  const tokens = await rotateRefreshToken(refreshToken, user, req.headers['user-agent']);
  sendSuccess(res, { ...tokens, user: await presentUser(String(user._id)) });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken, allDevices } = req.body as { refreshToken?: string; allDevices?: boolean };
  const user = req.user;

  if (allDevices && user) await revokeAllSessions(String(user._id));
  else if (refreshToken) await revokeRefreshToken(refreshToken);

  if (user) {
    await recordAudit({
      actorId: user._id,
      actorRole: user.role,
      entityType: 'User',
      entityId: user._id,
      action: 'LOGOUT',
      metadata: { allDevices: Boolean(allDevices) },
    });
  }

  sendSuccess(res, { loggedOut: true }, { message: 'Signed out' });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  sendSuccess(res, await presentUser(String(user._id)));
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const authUser = requireUser(req);
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };

  const user = await User.findById(authUser._id).select('+passwordHash');
  if (!user) throw ApiError.notFound('Account not found');

  const matches = await user.comparePassword(currentPassword);
  if (!matches) throw ApiError.badRequest('Your current password is incorrect', 'INVALID_PASSWORD');

  user.passwordHash = await User.hashPassword(newPassword);
  await user.save();

  // Changing a password invalidates every existing session.
  await revokeAllSessions(String(user._id));

  await recordAudit({
    actorId: user._id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user._id,
    action: 'PASSWORD_CHANGE',
  });

  sendSuccess(
    res,
    { changed: true },
    { message: 'Password updated. Please sign in again on your other devices.' },
  );
});

/**
 * Development forgot-password flow.
 *
 * No email provider is wired up, so in non-production the reset token is
 * returned in the response body for testing. In production the response is
 * always a generic acknowledgement and the token is only logged as metadata —
 * plug a real email adapter in before relying on this.
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  const user = await User.findOne({ email }).select('+passwordHash');

  const genericMessage =
    'If an account exists for that email address, a password reset link has been created.';

  if (!user || !user.active) {
    sendSuccess(res, { requested: true, deliveryMode: 'simulated' }, { message: genericMessage });
    return;
  }

  const token = createPasswordResetToken(user);

  await recordAudit({
    actorId: user._id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user._id,
    action: 'CREDENTIALS_RESET',
    metadata: { requested: true, simulated: true },
  });

  if (env.isProduction) {
    logger.info('Password reset requested', { userId: String(user._id), simulated: true });
    sendSuccess(res, { requested: true, deliveryMode: 'simulated' }, { message: genericMessage });
    return;
  }

  sendSuccess(
    res,
    {
      requested: true,
      deliveryMode: 'development',
      // DEV ONLY — a real deployment must deliver this out-of-band by email.
      resetToken: token,
      expiresInMinutes: 30,
    },
    { message: `${genericMessage} (development mode: token returned inline)` },
  );
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  const { sub, pv } = verifyPasswordResetToken(token);

  const user = await User.findById(sub).select('+passwordHash');
  if (!user || !user.active) throw ApiError.badRequest('This reset link is no longer valid');

  // The token embeds a fingerprint of the old hash, so it works exactly once.
  if (user.passwordHash.slice(-12) !== pv) {
    throw ApiError.badRequest('This reset link has already been used', 'RESET_TOKEN_USED');
  }

  user.passwordHash = await User.hashPassword(newPassword);
  await user.save();
  await revokeAllSessions(String(user._id));

  await recordAudit({
    actorId: user._id,
    actorRole: user.role,
    entityType: 'User',
    entityId: user._id,
    action: 'PASSWORD_CHANGE',
    metadata: { viaReset: true },
  });

  sendSuccess(res, { reset: true }, { message: 'Password reset. You can now sign in.' });
});

export const registerPushToken = asyncHandler(async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { pushToken } = req.body as { pushToken: string | null };
  await User.updateOne({ _id: user._id }, { $set: { pushToken } });
  sendSuccess(res, { registered: pushToken !== null });
});
