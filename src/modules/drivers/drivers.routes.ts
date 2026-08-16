import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User } from '../../models/User';
import { Order } from '../../models/Order';
import { Route } from '../../models/Route';
import { PaymentReconciliation } from '../../models/PaymentReconciliation';
import { authenticate } from '../../middleware/auth';
import { denyReadOnlyWrites, requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { requireUser } from '../../middleware/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { startOfDay } from '../../utils/dates';
import { idParamSchema, objectId } from '../users/users.validation';
import { ACTIVE_ORDER_STATUSES } from '../../constants/enums';

const router = Router();
router.use(authenticate, denyReadOnlyWrites);

const companyStaff = requireRoles('COMPANY_ADMIN', 'DISPATCHER', 'FINANCE', 'READ_ONLY');

/** Fleet list with live availability and workload. */
const listDrivers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const filter: Record<string, unknown> = { role: 'DRIVER', archivedAt: null };
  if (query.active) filter.active = query.active === 'true';
  if (query.pharmacyId) filter.assignedPharmacyIds = new Types.ObjectId(query.pharmacyId);
  if (query.status) filter.driverStatus = { $in: query.status.split(',') };

  const drivers = await User.find(filter)
    .select('firstName lastName email phone driverStatus active assignedPharmacyIds lastKnownLocation shiftStartedAt lastLoginAt employeeCode')
    .sort({ firstName: 1 })
    .lean();

  const counts = await Order.aggregate<{ _id: Types.ObjectId; active: number }>([
    { $match: { assignedDriverId: { $ne: null }, status: { $in: ACTIVE_ORDER_STATUSES } } },
    { $group: { _id: '$assignedDriverId', active: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.active]));

  sendSuccess(
    res,
    drivers.map((d) => ({ ...d, activeOrderCount: countMap.get(String(d._id)) ?? 0 })),
  );
});

/** Full driver profile: current route, live orders, performance and cash balance. */
const getDriver = asyncHandler(async (req: Request, res: Response) => {
  const driver = await User.findOne({ _id: req.params.id, role: 'DRIVER' }).lean();
  if (!driver) throw ApiError.notFound('Driver not found');

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const [activeOrders, route, completed, failed, reconciliations] = await Promise.all([
    Order.find({ assignedDriverId: driver._id, status: { $in: ACTIVE_ORDER_STATUSES } })
      .select('referenceNumber status priority deliveryAddress deliveryCoordinates amountDue etaAt')
      .lean(),
    Route.findOne({ driverId: driver._id, active: true }).lean(),
    Order.countDocuments({ assignedDriverId: driver._id, status: 'COMPLETED', completedAt: { $gte: thirtyDaysAgo } }),
    Order.countDocuments({ assignedDriverId: driver._id, failedAt: { $gte: thirtyDaysAgo } }),
    PaymentReconciliation.find({ driverId: driver._id }).sort({ date: -1 }).limit(14).lean(),
  ]);

  const attempts = completed + failed;
  const outstanding = reconciliations
    .filter((r) => r.status !== 'APPROVED' && r.status !== 'LOCKED')
    .reduce((sum, r) => sum + (r.expectedAmount - r.submittedAmount), 0);

  sendSuccess(res, {
    ...driver,
    activeOrders,
    currentRoute: route,
    performance: {
      windowDays: 30,
      completed,
      failed,
      attempts,
      successRate: attempts > 0 ? Math.round((completed / attempts) * 1000) / 10 : null,
    },
    cash: {
      outstandingBalance: Math.round(outstanding * 100) / 100,
      recentReconciliations: reconciliations,
    },
  });
});

/** Live positions of every on-shift driver, for the fleet map. */
const liveFleet = asyncHandler(async (_req: Request, res: Response) => {
  const drivers = await User.find({
    role: 'DRIVER',
    active: true,
    driverStatus: { $ne: 'OFFLINE' },
  })
    .select('firstName lastName driverStatus lastKnownLocation phone')
    .lean();

  const now = Date.now();
  sendSuccess(
    res,
    drivers.map((d) => {
      const recordedAt = d.lastKnownLocation?.recordedAt
        ? new Date(d.lastKnownLocation.recordedAt).getTime()
        : null;
      return {
        ...d,
        // Anything older than 10 minutes is treated as a stale GPS signal.
        gpsStale: recordedAt === null || now - recordedAt > 10 * 60_000,
        lastSeenMinutesAgo: recordedAt === null ? null : Math.round((now - recordedAt) / 60_000),
      };
    }),
  );
});

/** Assign a driver to a set of pharmacies (keeps both sides of the link in sync). */
const assignPharmacies = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { pharmacyIds } = req.body as { pharmacyIds: string[] };

  const driver = await User.findOne({ _id: req.params.id, role: 'DRIVER' });
  if (!driver) throw ApiError.notFound('Driver not found');

  const { Pharmacy } = await import('../../models/Pharmacy');
  const previous = [...(driver.assignedPharmacyIds ?? [])];

  driver.assignedPharmacyIds = pharmacyIds.map((id) => new Types.ObjectId(id));
  await driver.save();

  await Pharmacy.updateMany({ _id: { $in: previous } }, { $pull: { linkedDriverIds: driver._id } });
  await Pharmacy.updateMany(
    { _id: { $in: driver.assignedPharmacyIds } },
    { $addToSet: { linkedDriverIds: driver._id } },
  );

  const { recordAudit } = await import('../../services/audit.service');
  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: driver._id,
    action: 'UPDATE',
    oldValues: { assignedPharmacyIds: previous },
    newValues: { assignedPharmacyIds: driver.assignedPharmacyIds },
  });

  sendSuccess(res, driver.toJSON(), { message: 'Pharmacy assignments updated' });
});

/** Today's cash position for one driver — used by finance and the driver app. */
const driverCashSummary = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const driverId = req.params.id === 'me' ? String(actor._id) : req.params.id;

  if (actor.role === 'DRIVER' && driverId !== String(actor._id)) {
    throw ApiError.forbidden('You can only view your own cash report');
  }

  const date = startOfDay((req.query as { date?: string }).date);
  const nextDay = new Date(date.getTime() + 86_400_000);

  const orders = await Order.find({
    assignedDriverId: new Types.ObjectId(driverId),
    status: 'COMPLETED',
    completedAt: { $gte: date, $lt: nextDay },
  })
    .select('referenceNumber amountDue amountCollected paymentMethod completedAt')
    .lean();

  const expected = orders.reduce((sum, o) => sum + (o.amountDue ?? 0), 0);
  const collected = orders.reduce((sum, o) => sum + (o.amountCollected ?? 0), 0);

  const reconciliation = await PaymentReconciliation.findOne({
    driverId: new Types.ObjectId(driverId),
    date,
  }).lean();

  sendSuccess(res, {
    date: date.toISOString().slice(0, 10),
    orderCount: orders.length,
    expectedAmount: Math.round(expected * 100) / 100,
    collectedAmount: Math.round(collected * 100) / 100,
    difference: Math.round((collected - expected) * 100) / 100,
    orders,
    reconciliation,
  });
});

router.get('/', companyStaff, listDrivers);
router.get('/live', companyStaff, liveFleet);
router.get('/:id/cash', validate({ params: z.object({ id: z.union([objectId, z.literal('me')]) }) }), driverCashSummary);
router.get('/:id', companyStaff, validate({ params: idParamSchema }), getDriver);
router.post(
  '/:id/pharmacies',
  requireRoles('COMPANY_ADMIN'),
  validate({ params: idParamSchema, body: z.object({ pharmacyIds: z.array(objectId).max(100) }) }),
  assignPharmacies,
);

export default router;
