import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { DriverLocation } from '../../models/DriverLocation';
import { User } from '../../models/User';
import { Order } from '../../models/Order';
import { authenticate, requireUser } from '../../middleware/auth';
import { denyReadOnlyWrites, isCompanyUser, isPharmacyUser } from '../../middleware/rbac';
import { locationLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { emitTo, rooms } from '../../realtime/io';
import { objectId } from '../users/users.validation';
import { ACTIVE_ORDER_STATUSES } from '../../constants/enums';

const router = Router();
router.use(authenticate, denyReadOnlyWrites);

const pingSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(10000).optional(),
  heading: z.coerce.number().min(-1).max(360).optional(),
  speed: z.coerce.number().min(-1).max(400).optional(),
  batteryLevel: z.coerce.number().min(0).max(1).optional(),
  orderId: objectId.nullable().optional(),
  recordedAt: z.coerce.date().optional(),
});

/**
 * Driver location ping.
 *
 * The app throttles these client-side; the rate limiter caps them at 120/min as
 * a backstop. Each ping updates the driver's denormalised `lastKnownLocation`
 * (cheap to read) and appends to the TTL-expiring breadcrumb collection.
 */
const recordLocation = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (actor.role !== 'DRIVER') throw ApiError.forbidden('Only drivers report location');

  const body = req.body as z.infer<typeof pingSchema>;
  const recordedAt = body.recordedAt ?? new Date();

  await DriverLocation.create({
    driverId: actor._id,
    orderId: body.orderId ? new Types.ObjectId(body.orderId) : null,
    latitude: body.latitude,
    longitude: body.longitude,
    accuracy: body.accuracy,
    heading: body.heading,
    speed: body.speed,
    batteryLevel: body.batteryLevel,
    recordedAt,
  });

  await User.updateOne(
    { _id: actor._id },
    { $set: { lastKnownLocation: { latitude: body.latitude, longitude: body.longitude, recordedAt } } },
  );

  // Broadcast to the company desk and to the pharmacies this driver serves.
  const payload = {
    driverId: String(actor._id),
    latitude: body.latitude,
    longitude: body.longitude,
    heading: body.heading ?? null,
    speed: body.speed ?? null,
    recordedAt,
  };
  const targets = [
    rooms.company(),
    ...(actor.assignedPharmacyIds ?? []).map((id) => rooms.pharmacy(String(id))),
  ];
  emitTo(targets, 'driver:location', payload);

  sendSuccess(res, { recorded: true, recordedAt });
});

/** Latest known position of a driver, subject to the caller's visibility. */
const getDriverLocation = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const driverId = req.params.driverId!;

  if (!isCompanyUser(actor)) {
    if (isPharmacyUser(actor)) {
      // A pharmacy may only see a driver who is currently handling one of its orders.
      const handlesOurOrder = await Order.exists({
        assignedDriverId: new Types.ObjectId(driverId),
        pharmacyId: actor.pharmacyId,
        status: { $in: ACTIVE_ORDER_STATUSES },
      });
      if (!handlesOurOrder) {
        throw ApiError.forbidden('This driver is not handling any of your orders');
      }
    } else if (String(actor._id) !== driverId) {
      throw ApiError.forbidden('You cannot view another driver’s location');
    }
  }

  const driver = await User.findById(driverId).select('firstName lastName driverStatus lastKnownLocation').lean();
  if (!driver) throw ApiError.notFound('Driver not found');

  const recordedAt = driver.lastKnownLocation?.recordedAt
    ? new Date(driver.lastKnownLocation.recordedAt).getTime()
    : null;

  sendSuccess(res, {
    driverId,
    name: `${driver.firstName} ${driver.lastName}`,
    driverStatus: driver.driverStatus,
    location: driver.lastKnownLocation ?? null,
    gpsStale: recordedAt === null || Date.now() - recordedAt > 10 * 60_000,
  });
});

/** Recent breadcrumb trail (company only) — expires automatically after 14 days. */
const getTrail = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!isCompanyUser(actor)) throw ApiError.forbidden('Location history is company-only');

  const points = await DriverLocation.find({ driverId: new Types.ObjectId(req.params.driverId) })
    .sort({ recordedAt: -1 })
    .limit(300)
    .select('latitude longitude recordedAt speed heading')
    .lean();

  sendSuccess(res, points.reverse());
});

router.post('/ping', locationLimiter, validate({ body: pingSchema }), recordLocation);
router.get('/driver/:driverId', validate({ params: z.object({ driverId: objectId }) }), getDriverLocation);
router.get('/driver/:driverId/trail', validate({ params: z.object({ driverId: objectId }) }), getTrail);

export default router;
