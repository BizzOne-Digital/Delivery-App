import type { Request, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { User, type IUser } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { Order } from '../../models/Order';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { escapeRegex, resolvePagination } from '../../utils/pagination';
import { randomPassword } from '../../utils/reference';
import { recordAudit } from '../../services/audit.service';
import { revokeAllSessions } from '../auth/auth.service';
import { requireUser } from '../../middleware/auth';
import { isCompanyUser, isPharmacyUser } from '../../middleware/rbac';
import { PHARMACY_ROLES } from '../../constants/enums';

/**
 * Pharmacy admins may only manage staff inside their own pharmacy, and may only
 * create pharmacy roles. Company admins may manage everyone.
 */
function assertCanManage(actor: ReturnType<typeof requireUser>, target: Partial<IUser>): void {
  if (actor.role === 'COMPANY_ADMIN') return;

  if (actor.role === 'PHARMACY_ADMIN') {
    if (!target.role || !PHARMACY_ROLES.includes(target.role)) {
      throw ApiError.forbidden('Pharmacy admins can only manage pharmacy staff accounts');
    }
    if (String(target.pharmacyId ?? '') !== String(actor.pharmacyId ?? '')) {
      throw ApiError.forbidden('You can only manage staff in your own pharmacy');
    }
    return;
  }
  throw ApiError.forbidden('Your role does not permit user management');
}

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip, sort } = resolvePagination(req.query, { sort: 'createdAt' });
  const query = req.query as Record<string, string | undefined>;

  const filter: FilterQuery<IUser> = { archivedAt: null };

  if (query.role) filter.role = { $in: query.role.split(',') } as FilterQuery<IUser>['role'];
  if (query.active) filter.active = query.active === 'true';

  // Pharmacy users can only ever list their own pharmacy's staff.
  if (isPharmacyUser(actor)) {
    filter.pharmacyId = actor.pharmacyId;
    filter.role = { $in: PHARMACY_ROLES } as FilterQuery<IUser>['role'];
  } else if (query.pharmacyId) {
    filter.$or = [
      { pharmacyId: new Types.ObjectId(query.pharmacyId) },
      { assignedPharmacyIds: new Types.ObjectId(query.pharmacyId) },
    ];
  }

  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$and = [{ $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }] }];
  }

  const [items, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  sendSuccess(res, items, { meta: buildPaginationMeta(page, limit, total) });
});

export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const user = await User.findById(req.params.id).lean();
  if (!user || user.archivedAt) throw ApiError.notFound('User not found');

  if (isPharmacyUser(actor) && String(user.pharmacyId ?? '') !== String(actor.pharmacyId ?? '')) {
    throw ApiError.forbidden('You do not have access to this user');
  }
  sendSuccess(res, user);
});

export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    password: string;
    role: IUser['role'];
    pharmacyId?: string | null;
    assignedPharmacyIds?: string[];
    employeeCode?: string;
    active?: boolean;
  };

  assertCanManage(actor, { role: body.role, pharmacyId: body.pharmacyId ? new Types.ObjectId(body.pharmacyId) : null });

  const existing = await User.findOne({ email: body.email });
  if (existing) throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');

  if (PHARMACY_ROLES.includes(body.role) && !body.pharmacyId) {
    throw ApiError.badRequest('Pharmacy accounts must be linked to a pharmacy');
  }
  if (body.pharmacyId) {
    const pharmacy = await Pharmacy.findById(body.pharmacyId);
    if (!pharmacy) throw ApiError.notFound('Pharmacy not found');
  }

  const user = await User.create({
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
    passwordHash: await User.hashPassword(body.password),
    role: body.role,
    pharmacyId: body.pharmacyId ?? null,
    assignedPharmacyIds: body.role === 'DRIVER' ? (body.assignedPharmacyIds ?? []) : [],
    employeeCode: body.employeeCode,
    active: body.active ?? true,
  });

  // Drivers are also linked from the pharmacy side so the Ready screen can find them.
  if (user.role === 'DRIVER' && user.assignedPharmacyIds.length > 0) {
    await Pharmacy.updateMany(
      { _id: { $in: user.assignedPharmacyIds } },
      { $addToSet: { linkedDriverIds: user._id } },
    );
  }

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: user._id,
    action: 'CREATE',
    newValues: { email: user.email, role: user.role, pharmacyId: user.pharmacyId },
  });

  sendSuccess(res, user.toJSON(), { status: 201, message: 'Account created' });
});

export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const user = await User.findById(req.params.id);
  if (!user || user.archivedAt) throw ApiError.notFound('User not found');

  assertCanManage(actor, { role: user.role, pharmacyId: user.pharmacyId });

  const body = req.body as Record<string, unknown>;
  const before = {
    role: user.role,
    active: user.active,
    pharmacyId: user.pharmacyId,
    assignedPharmacyIds: [...(user.assignedPharmacyIds ?? [])],
    email: user.email,
  };

  // An admin must not lock themselves out.
  if (String(user._id) === String(actor._id) && body.active === false) {
    throw ApiError.badRequest('You cannot deactivate your own account');
  }
  if (body.role && actor.role !== 'COMPANY_ADMIN') {
    throw ApiError.forbidden('Only a company admin can change roles');
  }

  if (body.email && body.email !== user.email) {
    const clash = await User.findOne({ email: body.email });
    if (clash) throw ApiError.conflict('An account with that email already exists', 'EMAIL_TAKEN');
  }

  const previousPharmacies = [...(user.assignedPharmacyIds ?? [])];

  for (const key of [
    'firstName',
    'lastName',
    'email',
    'phone',
    'role',
    'employeeCode',
    'active',
    'driverStatus',
  ] as const) {
    if (body[key] !== undefined) (user as unknown as Record<string, unknown>)[key] = body[key];
  }
  if (body.pharmacyId !== undefined) {
    user.pharmacyId = body.pharmacyId ? new Types.ObjectId(String(body.pharmacyId)) : null;
  }
  if (Array.isArray(body.assignedPharmacyIds)) {
    user.assignedPharmacyIds = body.assignedPharmacyIds.map((id) => new Types.ObjectId(String(id)));
  }

  await user.save();

  // Keep Pharmacy.linkedDriverIds consistent with User.assignedPharmacyIds.
  if (user.role === 'DRIVER' && Array.isArray(body.assignedPharmacyIds)) {
    await Pharmacy.updateMany(
      { _id: { $in: previousPharmacies } },
      { $pull: { linkedDriverIds: user._id } },
    );
    await Pharmacy.updateMany(
      { _id: { $in: user.assignedPharmacyIds } },
      { $addToSet: { linkedDriverIds: user._id } },
    );
  }

  // Deactivating a user immediately terminates their sessions.
  if (body.active === false) await revokeAllSessions(String(user._id));

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: user._id,
    action: body.active === false ? 'STATUS_CHANGE' : 'UPDATE',
    oldValues: before,
    newValues: {
      role: user.role,
      active: user.active,
      pharmacyId: user.pharmacyId,
      assignedPharmacyIds: user.assignedPharmacyIds,
      email: user.email,
    },
  });

  sendSuccess(res, user.toJSON(), { message: 'Account updated' });
});

/**
 * Users are archived, never hard-deleted — audit history and past orders must
 * keep resolving to a real person.
 */
export const archiveUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (actor.role !== 'COMPANY_ADMIN') throw ApiError.forbidden('Only a company admin can archive accounts');

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (String(user._id) === String(actor._id)) throw ApiError.badRequest('You cannot archive your own account');

  if (user.role === 'DRIVER') {
    const openOrders = await Order.countDocuments({
      assignedDriverId: user._id,
      status: { $in: ['ON_THE_WAY', 'RETURNING'] },
    });
    if (openOrders > 0) {
      throw ApiError.unprocessable(
        `This driver still holds ${openOrders} active order(s). Reassign them before archiving.`,
        'DRIVER_HAS_ACTIVE_ORDERS',
        { openOrders },
      );
    }
  }

  user.active = false;
  user.archivedAt = new Date();
  user.driverStatus = 'OFFLINE';
  await user.save();
  await revokeAllSessions(String(user._id));

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: user._id,
    action: 'ARCHIVE',
  });

  sendSuccess(res, { archived: true }, { message: 'Account archived' });
});

export const restoreUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (actor.role !== 'COMPANY_ADMIN') throw ApiError.forbidden('Only a company admin can restore accounts');

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  user.archivedAt = null;
  user.active = true;
  await user.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: user._id,
    action: 'RESTORE',
  });

  sendSuccess(res, user.toJSON(), { message: 'Account restored' });
});

/**
 * Credential reset performed by an administrator. Returns the generated password
 * once so it can be handed over; it is never stored or logged in plaintext.
 */
export const resetCredentials = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  assertCanManage(actor, { role: user.role, pharmacyId: user.pharmacyId });

  const { newPassword } = req.body as { newPassword?: string };
  const password = newPassword ?? randomPassword(14);

  user.passwordHash = await User.hashPassword(password);
  await user.save();
  await revokeAllSessions(String(user._id));

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: user._id,
    action: 'CREDENTIALS_RESET',
    metadata: { generated: !newPassword },
  });

  sendSuccess(
    res,
    { temporaryPassword: password, mustChange: true },
    { message: 'Credentials reset. Share this password securely — it will not be shown again.' },
  );
});

export const updatePreferences = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, string | undefined>;

  const user = await User.findById(actor._id);
  if (!user) throw ApiError.notFound('Account not found');

  for (const key of ['themePreference', 'preferredMapApp', 'languagePreference', 'phone'] as const) {
    if (body[key] !== undefined) (user as unknown as Record<string, unknown>)[key] = body[key];
  }
  await user.save();

  sendSuccess(res, user.toJSON(), { message: 'Preferences saved' });
});

export const listRoles = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const assignable = isCompanyUser(actor)
    ? ['COMPANY_ADMIN', 'DISPATCHER', 'FINANCE', 'PHARMACY_ADMIN', 'PHARMACY_STAFF', 'DRIVER', 'READ_ONLY']
    : PHARMACY_ROLES;
  sendSuccess(res, { assignableRoles: assignable });
});
