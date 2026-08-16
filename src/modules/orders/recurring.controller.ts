import type { Request, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { RecurringOrder, type IRecurringOrder } from '../../models/RecurringOrder';
import { Order } from '../../models/Order';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { addDays, startOfDay, toDateKey } from '../../utils/dates';
import { requireUser } from '../../middleware/auth';
import { assertPharmacyAccess, isPharmacyUser, pharmacyScopeFor } from '../../middleware/rbac';
import { recordAudit } from '../../services/audit.service';
import {
  appendTimeline,
  buildOrderSnapshots,
  computeOrderDistanceKm,
  generateUniqueReference,
  saveAndPublish,
} from '../../services/order.service';

/** Occurrence dates a schedule produces inside a window. */
export function occurrencesBetween(schedule: IRecurringOrder, from: Date, to: Date): Date[] {
  const results: Date[] = [];
  const start = startOfDay(schedule.startDate);
  const end = schedule.endDate ? startOfDay(schedule.endDate) : null;

  let cursor = startOfDay(from < start ? start : from);
  const limit = startOfDay(to);
  let guard = 0;

  while (cursor <= limit && guard < 400) {
    guard += 1;
    if (end && cursor > end) break;

    let matches = false;
    switch (schedule.frequency) {
      case 'DAILY':
        matches = true;
        break;
      case 'WEEKLY':
        matches = cursor.getUTCDay() === start.getUTCDay();
        break;
      case 'SELECTED_WEEKDAYS':
        matches = schedule.weekdays.includes(cursor.getUTCDay());
        break;
      case 'MONTHLY':
        matches = cursor.getUTCDate() === (schedule.dayOfMonth ?? start.getUTCDate());
        break;
      case 'CUSTOM_INTERVAL': {
        const interval = schedule.intervalDays ?? 1;
        const days = Math.round((cursor.getTime() - start.getTime()) / 86_400_000);
        matches = days >= 0 && days % interval === 0;
        break;
      }
    }

    if (matches && !schedule.skippedDates.includes(toDateKey(cursor))) results.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }

  return results;
}

export const listRecurring = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const filter: FilterQuery<IRecurringOrder> = {};
  const scope = pharmacyScopeFor(actor);
  if (scope !== null) filter.pharmacyId = { $in: scope };

  const query = req.query as Record<string, string | undefined>;
  if (query.customerId) filter.customerId = new Types.ObjectId(query.customerId);
  if (query.active) filter.active = query.active === 'true';

  const schedules = await RecurringOrder.find(filter)
    .populate('customerId', 'firstName lastName phone')
    .sort({ createdAt: -1 })
    .lean();

  const horizon = addDays(new Date(), 30);
  sendSuccess(
    res,
    schedules.map((schedule) => ({
      ...schedule,
      upcomingOccurrences: occurrencesBetween(schedule as IRecurringOrder, new Date(), horizon)
        .slice(0, 10)
        .map((d) => toDateKey(d)),
    })),
  );
});

export const createRecurring = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, unknown>;

  const pharmacyId = isPharmacyUser(actor) ? String(actor.pharmacyId) : String(body.pharmacyId ?? '');
  if (!pharmacyId) throw ApiError.badRequest('pharmacyId is required');
  assertPharmacyAccess(actor, pharmacyId);

  if (body.frequency === 'SELECTED_WEEKDAYS' && (body.weekdays as number[])?.length === 0) {
    throw ApiError.badRequest('Select at least one weekday');
  }
  if (body.frequency === 'CUSTOM_INTERVAL' && !body.intervalDays) {
    throw ApiError.badRequest('Provide an interval in days');
  }

  const schedule = await RecurringOrder.create({
    ...body,
    pharmacyId: new Types.ObjectId(pharmacyId),
    createdBy: actor._id,
  });

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'RecurringOrder',
    entityId: schedule._id,
    action: 'CREATE',
    newValues: { frequency: schedule.frequency },
  });

  sendSuccess(res, schedule.toJSON(), { status: 201, message: 'Recurring schedule created' });
});

export const updateRecurring = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const schedule = await RecurringOrder.findById(req.params.id);
  if (!schedule) throw ApiError.notFound('Recurring schedule not found');
  assertPharmacyAccess(actor, schedule.pharmacyId);

  const body = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || key === 'pharmacyId') continue;
    (schedule as unknown as Record<string, unknown>)[key] = value;
  }
  await schedule.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'RecurringOrder',
    entityId: schedule._id,
    action: 'UPDATE',
  });

  sendSuccess(res, schedule.toJSON(), { message: 'Future occurrences updated' });
});

/** Cancels the whole schedule from now on (past orders are untouched). */
export const cancelRecurring = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const schedule = await RecurringOrder.findById(req.params.id);
  if (!schedule) throw ApiError.notFound('Recurring schedule not found');
  assertPharmacyAccess(actor, schedule.pharmacyId);

  schedule.active = false;
  schedule.endDate = new Date();
  await schedule.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'RecurringOrder',
    entityId: schedule._id,
    action: 'CANCEL',
  });

  sendSuccess(res, { cancelled: true }, { message: 'Future occurrences cancelled' });
});

/** Skips exactly one occurrence, leaving the rest of the schedule intact. */
export const skipOccurrence = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const schedule = await RecurringOrder.findById(req.params.id);
  if (!schedule) throw ApiError.notFound('Recurring schedule not found');
  assertPharmacyAccess(actor, schedule.pharmacyId);

  const date = String((req.body as { date?: string }).date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('Provide a date as YYYY-MM-DD');

  if (!schedule.skippedDates.includes(date)) schedule.skippedDates.push(date);
  await schedule.save();

  // Remove an already-generated, not-yet-started order for that date.
  await Order.deleteOne({
    recurringOrderId: schedule._id,
    recurrenceOccurrenceDate: startOfDay(date),
    status: 'ACTION_REQUIRED',
    claimedAt: null,
  });

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'RecurringOrder',
    entityId: schedule._id,
    action: 'UPDATE',
    metadata: { skippedDate: date },
  });

  sendSuccess(res, schedule.toJSON(), { message: `Occurrence on ${date} cancelled` });
});

/**
 * Materialises due occurrences into real orders. New occurrences always land in
 * ACTION_REQUIRED so pharmacy staff review them before they go out.
 *
 * Called on demand from the pharmacy portal; in production, run the same handler
 * from a scheduled job (cron / Vercel Cron) once per day.
 */
export const generateDueOrders = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const daysAhead = Math.min(14, Math.max(1, Number((req.body as { daysAhead?: number }).daysAhead ?? 1)));

  const filter: FilterQuery<IRecurringOrder> = { active: true };
  const scope = pharmacyScopeFor(actor);
  if (scope !== null) filter.pharmacyId = { $in: scope };

  const schedules = await RecurringOrder.find(filter);
  const created: string[] = [];

  for (const schedule of schedules) {
    const dates = occurrencesBetween(schedule, new Date(), addDays(new Date(), daysAhead));

    for (const date of dates) {
      const exists = await Order.exists({
        recurringOrderId: schedule._id,
        recurrenceOccurrenceDate: date,
      });
      if (exists) continue;

      try {
        const snapshots = await buildOrderSnapshots({
          pharmacyId: String(schedule.pharmacyId),
          customerId: String(schedule.customerId),
          addressId: schedule.addressId ? String(schedule.addressId) : undefined,
          orderType: schedule.orderType,
        });

        const order = new Order({
          referenceNumber: await generateUniqueReference(),
          pharmacyId: schedule.pharmacyId,
          customerId: schedule.customerId,
          orderType: schedule.orderType,
          status: 'ACTION_REQUIRED',
          deliveryDate: date,
          timeWindowStart: schedule.timeWindowStart,
          timeWindowEnd: schedule.timeWindowEnd,
          priority: schedule.priority,
          amountDue: schedule.amountDue,
          packageCount: schedule.packageCount,
          orderNotes: schedule.orderNotes,
          manifestItems: schedule.manifestItems,
          pickupAddress: snapshots.pickupAddress,
          deliveryAddress: snapshots.deliveryAddress,
          pickupCoordinates: snapshots.pickupCoordinates,
          deliveryCoordinates: snapshots.deliveryCoordinates,
          customerSnapshot: snapshots.customerSnapshot,
          customerNotesSnapshot: snapshots.customerNotesSnapshot,
          proofConfigSnapshot: snapshots.proofConfig,
          recurringOrderId: schedule._id,
          recurrenceOccurrenceDate: date,
          createdBy: actor._id,
        });
        order.distanceKm = computeOrderDistanceKm(order);
        appendTimeline(order, {
          action: 'RECURRING_OCCURRENCE_CREATED',
          status: 'ACTION_REQUIRED',
          byUserId: actor._id,
          byRole: actor.role,
          note: `From schedule ${schedule._id}`,
        });

        await saveAndPublish(order, actor, { action: 'CREATE', metadata: { recurring: true } }, 'order:created');
        created.push(order.referenceNumber);
      } catch {
        // A schedule whose customer/address was archived is skipped rather than
        // failing the whole generation run.
        continue;
      }
    }

    schedule.lastGeneratedDate = new Date();
    await schedule.save();
  }

  sendSuccess(res, { created, count: created.length }, {
    message:
      created.length > 0
        ? `${created.length} recurring order(s) created in Action Required`
        : 'No new recurring orders were due',
  });
});
