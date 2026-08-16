import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Route } from '../../models/Route';
import { Order } from '../../models/Order';
import { User } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { authenticate, requireUser } from '../../middleware/auth';
import { denyReadOnlyWrites, canDispatch } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { isValidCoordinate } from '../../utils/geo';
import { getRouteProvider } from '../../services/routing/route.provider';
import { emitTo, rooms } from '../../realtime/io';
import { idParamSchema, objectId } from '../users/users.validation';

const router = Router();
router.use(authenticate, denyReadOnlyWrites);

const optimizeSchema = z.object({
  driverId: objectId.optional(),
  orderIds: z.array(objectId).max(80).optional(),
  startLatitude: z.coerce.number().min(-90).max(90).optional(),
  startLongitude: z.coerce.number().min(-180).max(180).optional(),
  persist: z.boolean().optional().default(true),
});

const reorderSchema = z.object({
  orderIds: z.array(objectId).min(1).max(80),
});

/** Resolves which driver a route request targets, enforcing permissions. */
function resolveDriverId(req: Request, requested?: string): string {
  const actor = requireUser(req);
  if (actor.role === 'DRIVER') {
    if (requested && requested !== String(actor._id)) {
      throw ApiError.forbidden('You can only manage your own route');
    }
    return String(actor._id);
  }
  if (!canDispatch(actor)) throw ApiError.forbidden('Only dispatchers can manage routes');
  if (!requested) throw ApiError.badRequest('driverId is required');
  return requested;
}

/**
 * Builds (and optionally persists) an optimised route for a driver's current
 * ON_THE_WAY orders. The provider is pluggable — see route.provider.ts.
 */
const optimizeRoute = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, unknown>;
  const driverId = resolveDriverId(req, body.driverId as string | undefined);

  const driver = await User.findById(driverId).select('firstName lastName lastKnownLocation assignedPharmacyIds');
  if (!driver) throw ApiError.notFound('Driver not found');

  const filter: Record<string, unknown> = {
    assignedDriverId: new Types.ObjectId(driverId),
    status: { $in: ['ON_THE_WAY', 'RETURNING'] },
  };
  if (Array.isArray(body.orderIds) && body.orderIds.length > 0) {
    filter._id = { $in: (body.orderIds as string[]).map((id) => new Types.ObjectId(id)) };
  }

  const orders = await Order.find(filter)
    .select('referenceNumber deliveryCoordinates deliveryAddress priority timeWindowStart status pharmacyId')
    .lean();

  // Determine the starting point: explicit → last known GPS → first pharmacy.
  let start = { latitude: 0, longitude: 0 };
  if (
    isValidCoordinate({
      latitude: Number(body.startLatitude),
      longitude: Number(body.startLongitude),
    })
  ) {
    start = { latitude: Number(body.startLatitude), longitude: Number(body.startLongitude) };
  } else if (isValidCoordinate(driver.lastKnownLocation)) {
    start = {
      latitude: driver.lastKnownLocation!.latitude,
      longitude: driver.lastKnownLocation!.longitude,
    };
  } else {
    const pharmacy = await Pharmacy.findById(driver.assignedPharmacyIds?.[0]).select('latitude longitude').lean();
    if (pharmacy) start = { latitude: pharmacy.latitude, longitude: pharmacy.longitude };
  }

  const stops = orders
    .filter((o) => isValidCoordinate(o.deliveryCoordinates))
    .map((o) => ({
      orderId: String(o._id),
      latitude: o.deliveryCoordinates!.latitude,
      longitude: o.deliveryCoordinates!.longitude,
      label: `${o.referenceNumber} — ${o.deliveryAddress?.line1 ?? ''}`,
      priority: o.priority,
    }));

  const skipped = orders.length - stops.length;
  const optimized = await getRouteProvider().optimize(start, stops);

  let saved = null;
  if (body.persist !== false) {
    saved = await Route.findOneAndUpdate(
      { driverId: new Types.ObjectId(driverId), active: true },
      {
        $set: {
          driverId: new Types.ObjectId(driverId),
          orderIds: stops.map((s) => new Types.ObjectId(s.orderId)),
          orderedStops: optimized.stops.map((s) => ({
            orderId: new Types.ObjectId(s.orderId),
            sequence: s.sequence,
            latitude: s.latitude,
            longitude: s.longitude,
            label: s.label,
            legDistanceKm: s.legDistanceKm,
            etaAt: new Date(Date.now() + s.etaMinutesFromStart * 60_000),
          })),
          startingLocation: start,
          totalDistance: optimized.totalDistanceKm,
          estimatedDuration: optimized.estimatedDurationMinutes,
          optimized: true,
          optimizerProvider: optimized.provider,
          active: true,
          createdBy: actor._id,
        },
      },
      { new: true, upsert: true },
    );
    emitTo([rooms.driver(driverId), rooms.company()], 'route:updated', saved?.toJSON());
  }

  sendSuccess(res, {
    route: saved,
    optimization: optimized,
    skippedWithoutCoordinates: skipped,
    capabilities: {
      provider: optimized.provider,
      usesLiveTraffic: optimized.usesLiveTraffic,
      usesRoadNetwork: optimized.usesRoadNetwork,
      notes: optimized.notes,
    },
  });
});

/** Manual stop ordering — the driver or dispatcher overrides the optimiser. */
const reorderRoute = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const driverId = resolveDriverId(req, (req.query as { driverId?: string }).driverId);
  const { orderIds } = req.body as { orderIds: string[] };

  const route = await Route.findOne({ driverId: new Types.ObjectId(driverId), active: true });
  if (!route) throw ApiError.notFound('No active route for this driver');

  const byOrderId = new Map(route.orderedStops.map((s) => [String(s.orderId), s]));
  const reordered = orderIds
    .map((id, index) => {
      const stop = byOrderId.get(id);
      return stop ? { ...stop, sequence: index + 1 } : null;
    })
    .filter(Boolean) as typeof route.orderedStops;

  if (reordered.length === 0) throw ApiError.badRequest('None of the supplied orders are on this route');

  route.orderedStops = reordered;
  route.orderIds = reordered.map((s) => s.orderId);
  route.optimized = false;
  route.optimizerProvider = 'manual';
  route.createdBy = actor._id;
  await route.save();

  emitTo([rooms.driver(driverId), rooms.company()], 'route:updated', route.toJSON());
  sendSuccess(res, route.toJSON(), { message: 'Stop order updated' });
});

const getActiveRoute = asyncHandler(async (req: Request, res: Response) => {
  const driverId = resolveDriverId(req, (req.query as { driverId?: string }).driverId);
  const route = await Route.findOne({ driverId: new Types.ObjectId(driverId), active: true })
    .populate('orderIds', 'referenceNumber status priority deliveryAddress amountDue etaAt')
    .lean();
  sendSuccess(res, route);
});

const startRoute = asyncHandler(async (req: Request, res: Response) => {
  const route = await Route.findById(req.params.id);
  if (!route) throw ApiError.notFound('Route not found');
  resolveDriverId(req, String(route.driverId));

  route.startedAt = new Date();
  await route.save();
  emitTo([rooms.driver(String(route.driverId)), rooms.company()], 'route:updated', route.toJSON());
  sendSuccess(res, route.toJSON(), { message: 'Route started' });
});

const completeRoute = asyncHandler(async (req: Request, res: Response) => {
  const route = await Route.findById(req.params.id);
  if (!route) throw ApiError.notFound('Route not found');
  resolveDriverId(req, String(route.driverId));

  route.completedAt = new Date();
  route.active = false;
  await route.save();
  emitTo([rooms.driver(String(route.driverId)), rooms.company()], 'route:updated', route.toJSON());
  sendSuccess(res, route.toJSON(), { message: 'Route completed' });
});

router.get('/active', getActiveRoute);
router.post('/optimize', validate({ body: optimizeSchema }), optimizeRoute);
router.post('/reorder', validate({ body: reorderSchema }), reorderRoute);
router.post('/:id/start', validate({ params: idParamSchema }), startRoute);
router.post('/:id/complete', validate({ params: idParamSchema }), completeRoute);

export default router;
