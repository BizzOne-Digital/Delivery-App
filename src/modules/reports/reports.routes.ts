import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Order } from '../../models/Order';
import { authenticate, requireUser } from '../../middleware/auth';
import { pharmacyScopeFor } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { csvFileName, toCsv } from '../../utils/csv';
import { addDays, endOfDay, startOfDay } from '../../utils/dates';
import { recordAudit } from '../../services/audit.service';
import { ApiError } from '../../utils/ApiError';
import { objectId } from '../users/users.validation';
import {
  buildDriverPerformance,
  buildOrderExportRows,
  buildPharmacyVolume,
  buildRecurringSummary,
  buildSummary,
  buildTimeSeries,
  buildWorkload,
  type ReportScope,
} from './reports.service';
import { ACTIVE_ORDER_STATUSES } from '../../constants/enums';

const router = Router();
router.use(authenticate);

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  pharmacyId: objectId.optional(),
  driverId: objectId.optional(),
  format: z.enum(['json', 'csv']).optional(),
  compare: z.enum(['true', 'false']).optional(),
});

function resolveScope(req: Request): ReportScope {
  const actor = requireUser(req);
  const query = req.query as z.infer<typeof rangeSchema>;

  const to = query.to ? endOfDay(query.to) : endOfDay();
  const from = query.from ? startOfDay(query.from) : startOfDay(addDays(to, -29));
  if (from > to) throw ApiError.badRequest('The start date must be before the end date');

  let pharmacyIds = pharmacyScopeFor(actor);
  // A company user may narrow to one pharmacy; a pharmacy user cannot widen.
  if (pharmacyIds === null && query.pharmacyId) {
    pharmacyIds = [new Types.ObjectId(query.pharmacyId)];
  }

  return { pharmacyIds, from, to, driverId: query.driverId, pharmacyId: query.pharmacyId };
}

const summary = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveScope(req);
  const query = req.query as z.infer<typeof rangeSchema>;

  const current = await buildSummary(scope);

  // Optional previous-period comparison of equal length.
  let previous = null;
  if (query.compare === 'true') {
    const spanMs = scope.to.getTime() - scope.from.getTime();
    previous = await buildSummary({
      ...scope,
      from: new Date(scope.from.getTime() - spanMs - 1),
      to: new Date(scope.from.getTime() - 1),
    });
  }

  sendSuccess(res, { current, previous });
});

const series = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await buildTimeSeries(resolveScope(req)));
});

const workload = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await buildWorkload(resolveScope(req)));
});

const driverPerformance = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await buildDriverPerformance(resolveScope(req)));
});

const pharmacyVolume = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await buildPharmacyVolume(resolveScope(req)));
});

const recurringSummary = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await buildRecurringSummary(resolveScope(req)));
});

/** Live dashboard counters (not window-scoped) for the portals' home screens. */
const dashboard = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const scope = pharmacyScopeFor(actor);
  const match: Record<string, unknown> = {};
  if (scope !== null) match.pharmacyId = { $in: scope };

  const todayStart = startOfDay();
  const todayEnd = endOfDay();

  const [statusRows, todayRows, drivers] = await Promise.all([
    Order.aggregate<{ _id: string; count: number }>([
      { $match: { ...match, status: { $in: ACTIVE_ORDER_STATUSES } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.aggregate<{
      _id: null;
      completed: number;
      cancelled: number;
      failed: number;
      collected: number;
      expected: number;
      totalMinutes: number;
      timed: number;
    }>([
      { $match: { ...match, updatedAt: { $gte: todayStart, $lte: todayEnd } } },
      {
        $group: {
          _id: null,
          completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $ne: ['$failedAt', null] }, 1, 0] } },
          collected: { $sum: '$amountCollected' },
          expected: {
            $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, '$amountDue', 0] },
          },
          totalMinutes: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$onTheWayAt', null] }, { $ne: ['$completedAt', null] }] },
                { $divide: [{ $subtract: ['$completedAt', '$onTheWayAt'] }, 60000] },
                0,
              ],
            },
          },
          timed: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$onTheWayAt', null] }, { $ne: ['$completedAt', null] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Order.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ...match, status: { $in: ['ON_THE_WAY', 'RETURNING'] }, assignedDriverId: { $ne: null } } },
      { $group: { _id: '$assignedDriverId', count: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = Object.fromEntries(statusRows.map((r) => [r._id, r.count]));
  const today = todayRows[0];

  const { User } = await import('../../models/User');
  const driverDocs = await User.find({ _id: { $in: drivers.map((d) => d._id) } })
    .select('firstName lastName driverStatus phone lastKnownLocation')
    .lean();

  sendSuccess(res, {
    active: {
      actionRequired: byStatus.ACTION_REQUIRED ?? 0,
      preparing: byStatus.PREPARING ?? 0,
      ready: byStatus.READY ?? 0,
      onTheWay: byStatus.ON_THE_WAY ?? 0,
      returning: byStatus.RETURNING ?? 0,
    },
    today: {
      completed: today?.completed ?? 0,
      cancelled: today?.cancelled ?? 0,
      failed: today?.failed ?? 0,
      amountCollected: Math.round((today?.collected ?? 0) * 100) / 100,
      cashDiscrepancy: Math.round(((today?.collected ?? 0) - (today?.expected ?? 0)) * 100) / 100,
      averageDeliveryMinutes:
        today && today.timed > 0 ? Math.round((today.totalMinutes / today.timed) * 10) / 10 : null,
    },
    drivers: driverDocs.map((d) => ({
      ...d,
      activeOrderCount: drivers.find((x) => String(x._id) === String(d._id))?.count ?? 0,
    })),
  });
});

/** CSV export of the order log for the selected window. */
const exportOrders = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const scope = resolveScope(req);
  const rows = await buildOrderExportRows(scope);

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Report',
    action: 'EXPORT',
    metadata: { rows: rows.length, from: scope.from, to: scope.to },
  });

  const format = (req.query as { format?: string }).format ?? 'csv';
  if (format === 'json') {
    sendSuccess(res, rows, { meta: { count: rows.length } });
    return;
  }

  const csv = toCsv(rows as unknown as Record<string, unknown>[]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFileName('orders')}"`);
  // BOM so Excel opens UTF-8 correctly.
  res.status(200).send(`﻿${csv}`);
});

const exportDriverPerformance = asyncHandler(async (req: Request, res: Response) => {
  const scope = resolveScope(req);
  const rows = await buildDriverPerformance(scope);
  const csv = toCsv(rows as unknown as Record<string, unknown>[]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFileName('driver-performance')}"`);
  res.status(200).send(`﻿${csv}`);
});

router.get('/dashboard', dashboard);
router.get('/summary', validate({ query: rangeSchema }), summary);
router.get('/series', validate({ query: rangeSchema }), series);
router.get('/workload', validate({ query: rangeSchema }), workload);
router.get('/drivers', validate({ query: rangeSchema }), driverPerformance);
router.get('/pharmacies', validate({ query: rangeSchema }), pharmacyVolume);
router.get('/recurring', validate({ query: rangeSchema }), recurringSummary);
router.get('/export/orders', validate({ query: rangeSchema }), exportOrders);
router.get('/export/drivers', validate({ query: rangeSchema }), exportDriverPerformance);

export default router;
