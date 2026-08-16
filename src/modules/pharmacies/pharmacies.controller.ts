import type { Request, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { Pharmacy, type IPharmacy } from '../../models/Pharmacy';
import { User } from '../../models/User';
import { Order } from '../../models/Order';
import { ACTIVE_ORDER_STATUSES } from '../../constants/enums';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { escapeRegex, resolvePagination } from '../../utils/pagination';
import { generatePharmacyCode } from '../../utils/reference';
import { recordAudit } from '../../services/audit.service';
import { requireUser } from '../../middleware/auth';
import { assertPharmacyAccess, isCompanyUser, pharmacyScopeFor } from '../../middleware/rbac';
import { haversineKm } from '../../utils/geo';

export const listPharmacies = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip, sort } = resolvePagination(req.query, { sort: 'name', order: 'asc' });
  const query = req.query as Record<string, string | undefined>;

  const filter: FilterQuery<IPharmacy> = {};
  const scope = pharmacyScopeFor(actor);
  if (scope !== null) filter._id = { $in: scope };

  if (query.includeArchived !== 'true') filter.archivedAt = null;
  if (query.active) filter.active = query.active === 'true';
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { address: rx }, { city: rx }];
  }

  const [items, total] = await Promise.all([
    Pharmacy.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Pharmacy.countDocuments(filter),
  ]);

  sendSuccess(res, items, { meta: buildPaginationMeta(page, limit, total) });
});

export const getPharmacy = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const pharmacy = await Pharmacy.findById(req.params.id).lean();
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');
  assertPharmacyAccess(actor, pharmacy._id);

  const [drivers, activeOrders] = await Promise.all([
    User.find({ _id: { $in: pharmacy.linkedDriverIds ?? [] } })
      .select('firstName lastName email phone driverStatus active')
      .lean(),
    Order.countDocuments({ pharmacyId: pharmacy._id, status: { $in: ACTIVE_ORDER_STATUSES } }),
  ]);

  sendSuccess(res, { ...pharmacy, linkedDrivers: drivers, activeOrderCount: activeOrders });
});

export const createPharmacy = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, unknown>;

  const code = String(body.code ?? generatePharmacyCode(String(body.name))).toUpperCase();
  const clash = await Pharmacy.findOne({ code });
  if (clash) throw ApiError.conflict('That pharmacy code is already in use', 'CODE_TAKEN');

  const pharmacy = await Pharmacy.create({
    ...body,
    email: body.email || undefined,
    code,
    createdBy: actor._id,
  });

  if (Array.isArray(body.linkedDriverIds) && body.linkedDriverIds.length > 0) {
    await User.updateMany(
      { _id: { $in: body.linkedDriverIds }, role: 'DRIVER' },
      { $addToSet: { assignedPharmacyIds: pharmacy._id } },
    );
  }

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Pharmacy',
    entityId: pharmacy._id,
    action: 'CREATE',
    newValues: { name: pharmacy.name, code: pharmacy.code },
  });

  sendSuccess(res, pharmacy.toJSON(), { status: 201, message: 'Pharmacy created' });
});

export const updatePharmacy = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const pharmacy = await Pharmacy.findById(req.params.id);
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');
  assertPharmacyAccess(actor, pharmacy._id);

  const body = req.body as Record<string, unknown>;
  const before = pharmacy.toObject();

  // Pharmacy admins may only tune operational settings, not company-level config.
  const restricted = ['assignmentMode', 'linkedDriverIds', 'serviceZones', 'active', 'code'];
  if (!isCompanyUser(actor)) {
    for (const key of restricted) {
      if (body[key] !== undefined) {
        throw ApiError.forbidden(`Only the delivery company can change '${key}'`);
      }
    }
  }

  const previousDrivers = [...(pharmacy.linkedDriverIds ?? [])];

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'proofConfig' || key === 'notificationRules') {
      Object.assign(
        (pharmacy as unknown as Record<string, Record<string, unknown>>)[key],
        value as Record<string, unknown>,
      );
      continue;
    }
    if (key === 'code') {
      const nextCode = String(value).toUpperCase();
      if (nextCode !== pharmacy.code) {
        const clash = await Pharmacy.findOne({ code: nextCode });
        if (clash) throw ApiError.conflict('That pharmacy code is already in use', 'CODE_TAKEN');
      }
      pharmacy.code = nextCode;
      continue;
    }
    (pharmacy as unknown as Record<string, unknown>)[key] = value;
  }

  await pharmacy.save();

  if (Array.isArray(body.linkedDriverIds)) {
    await User.updateMany(
      { _id: { $in: previousDrivers } },
      { $pull: { assignedPharmacyIds: pharmacy._id } },
    );
    await User.updateMany(
      { _id: { $in: pharmacy.linkedDriverIds }, role: 'DRIVER' },
      { $addToSet: { assignedPharmacyIds: pharmacy._id } },
    );
  }

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Pharmacy',
    entityId: pharmacy._id,
    action: 'UPDATE',
    oldValues: { name: before.name, active: before.active, assignmentMode: before.assignmentMode },
    newValues: { name: pharmacy.name, active: pharmacy.active, assignmentMode: pharmacy.assignmentMode },
  });

  sendSuccess(res, pharmacy.toJSON(), { message: 'Pharmacy updated' });
});

/**
 * Global activate/deactivate. This is the *company admin* control — it is not
 * the same thing as the driver-side expand/collapse toggle on the Ready screen.
 *
 * Deactivation is blocked while unresolved active orders exist, unless an admin
 * explicitly forces it (which is recorded in the audit log).
 */
export const setActive = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { active, force } = req.body as { active: boolean; force?: boolean };

  const pharmacy = await Pharmacy.findById(req.params.id);
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');

  if (!active) {
    const activeOrders = await Order.countDocuments({
      pharmacyId: pharmacy._id,
      status: { $in: ACTIVE_ORDER_STATUSES },
    });
    if (activeOrders > 0 && !force) {
      throw ApiError.unprocessable(
        `${pharmacy.name} still has ${activeOrders} unresolved order(s). ` +
          'Resolve or transfer them first, or repeat this request with force = true to override.',
        'PHARMACY_HAS_ACTIVE_ORDERS',
        { activeOrders },
      );
    }
  }

  const wasActive = pharmacy.active;
  pharmacy.active = active;
  await pharmacy.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Pharmacy',
    entityId: pharmacy._id,
    action: 'STATUS_CHANGE',
    oldValues: { active: wasActive },
    newValues: { active },
    metadata: { forced: Boolean(force) },
  });

  sendSuccess(res, pharmacy.toJSON(), {
    message: active ? 'Pharmacy activated' : 'Pharmacy deactivated',
  });
});

export const archivePharmacy = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const pharmacy = await Pharmacy.findById(req.params.id);
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');

  const activeOrders = await Order.countDocuments({
    pharmacyId: pharmacy._id,
    status: { $in: ACTIVE_ORDER_STATUSES },
  });
  if (activeOrders > 0) {
    throw ApiError.unprocessable(
      `Cannot archive: ${activeOrders} order(s) are still in progress.`,
      'PHARMACY_HAS_ACTIVE_ORDERS',
      { activeOrders },
    );
  }

  pharmacy.active = false;
  pharmacy.archivedAt = new Date();
  await pharmacy.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Pharmacy',
    entityId: pharmacy._id,
    action: 'ARCHIVE',
  });

  sendSuccess(res, { archived: true }, { message: 'Pharmacy archived' });
});

export const linkDrivers = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { driverIds } = req.body as { driverIds: string[] };

  const pharmacy = await Pharmacy.findById(req.params.id);
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');

  const drivers = await User.find({ _id: { $in: driverIds }, role: 'DRIVER' }).select('_id');
  if (drivers.length !== driverIds.length) {
    throw ApiError.badRequest('One or more of the selected users is not a driver');
  }

  const previous = [...(pharmacy.linkedDriverIds ?? [])];
  pharmacy.linkedDriverIds = drivers.map((d) => d._id);
  await pharmacy.save();

  await User.updateMany({ _id: { $in: previous } }, { $pull: { assignedPharmacyIds: pharmacy._id } });
  await User.updateMany(
    { _id: { $in: pharmacy.linkedDriverIds } },
    { $addToSet: { assignedPharmacyIds: pharmacy._id } },
  );

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Pharmacy',
    entityId: pharmacy._id,
    action: 'UPDATE',
    oldValues: { linkedDriverIds: previous },
    newValues: { linkedDriverIds: pharmacy.linkedDriverIds },
  });

  sendSuccess(res, pharmacy.toJSON(), { message: 'Linked drivers updated' });
});

/**
 * The pharmacy list a driver sees on the Ready screen: only active pharmacies
 * they are linked to, with live ready/urgent counts and distance from the driver.
 */
export const driverPharmacyBoard = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (actor.role !== 'DRIVER') throw ApiError.forbidden('Drivers only');

  const query = req.query as Record<string, string | undefined>;
  const driverLat = query.latitude ? Number(query.latitude) : null;
  const driverLng = query.longitude ? Number(query.longitude) : null;

  const pharmacies = await Pharmacy.find({
    _id: { $in: actor.assignedPharmacyIds ?? [] },
    active: true,
    archivedAt: null,
  })
    .select('name code address city postalCode latitude longitude pickupInstructions deliveryStartTime logo assignmentMode')
    .lean();

  const counts = await Order.aggregate<{
    _id: Types.ObjectId;
    readyCount: number;
    urgentCount: number;
  }>([
    {
      $match: {
        pharmacyId: { $in: pharmacies.map((p) => p._id) },
        status: 'READY',
        claimedAt: null,
        $or: [{ assignedDriverId: null }, { assignedDriverId: actor._id }],
      },
    },
    {
      $group: {
        _id: '$pharmacyId',
        readyCount: { $sum: 1 },
        urgentCount: { $sum: { $cond: [{ $eq: ['$priority', 'URGENT'] }, 1, 0] } },
      },
    },
  ]);

  const countMap = new Map(counts.map((c) => [String(c._id), c]));

  const board = pharmacies
    .map((pharmacy) => {
      const stats = countMap.get(String(pharmacy._id));
      const distanceKm =
        driverLat !== null && driverLng !== null && Number.isFinite(driverLat) && Number.isFinite(driverLng)
          ? Math.round(
              haversineKm(
                { latitude: driverLat, longitude: driverLng },
                { latitude: pharmacy.latitude, longitude: pharmacy.longitude },
              ) * 10,
            ) / 10
          : null;
      return {
        ...pharmacy,
        readyCount: stats?.readyCount ?? 0,
        urgentCount: stats?.urgentCount ?? 0,
        distanceKm,
      };
    })
    .sort((a, b) => {
      if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
      return b.readyCount - a.readyCount;
    });

  sendSuccess(res, board);
});
