import { Router } from 'express';
import type { Request, Response } from 'express';
import { Order } from '../../models/Order';
import { User } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { verifyTrackingToken } from '../../utils/tokens';
import { authLimiter } from '../../middleware/rateLimit';

const router = Router();

/**
 * PUBLIC patient tracking endpoint.
 *
 * Reached with a signed, expiring token. The projection below is deliberately
 * narrow: status, coarse ETA, driver first name and pharmacy name only.
 *
 * Explicitly NOT exposed: order notes, customer notes, manifest/prescription
 * contents, amounts, other customers, the customer's own contact details, exact
 * driver coordinates, or anything about other orders.
 */
const publicTracking = asyncHandler(async (req: Request, res: Response) => {
  const orderId = verifyTrackingToken(String(req.params.token));

  const order = await Order.findById(orderId)
    .select(
      'referenceNumber status orderType deliveryDate timeWindowStart timeWindowEnd etaAt assignedDriverId pharmacyId onTheWayAt completedAt deliveryAddress.city proofOfDelivery.capturedAt',
    )
    .lean();
  if (!order) throw ApiError.notFound('We could not find that delivery');

  const [driver, pharmacy] = await Promise.all([
    order.assignedDriverId ? User.findById(order.assignedDriverId).select('firstName driverStatus').lean() : null,
    Pharmacy.findById(order.pharmacyId).select('name phone').lean(),
  ]);

  const publicStatus: Record<string, string> = {
    ACTION_REQUIRED: 'Being prepared',
    PREPARING: 'Being prepared',
    READY: 'Ready for collection by a driver',
    ON_THE_WAY: 'Out for delivery',
    RETURNING: 'Delivery attempt unsuccessful — returning to pharmacy',
    COMPLETED: 'Delivered',
    CANCELLED: 'Cancelled',
  };

  sendSuccess(res, {
    reference: order.referenceNumber,
    status: order.status,
    statusLabel: publicStatus[order.status] ?? 'In progress',
    orderType: order.orderType,
    deliveryDate: order.deliveryDate,
    timeWindow:
      order.timeWindowStart && order.timeWindowEnd
        ? `${order.timeWindowStart} – ${order.timeWindowEnd}`
        : null,
    estimatedArrival: order.etaAt ?? null,
    outForDeliveryAt: order.onTheWayAt ?? null,
    deliveredAt: order.completedAt ?? null,
    // First name only — never a full name, phone number or live coordinates.
    driverFirstName: driver?.firstName ?? null,
    pharmacy: { name: pharmacy?.name ?? null, phone: pharmacy?.phone ?? null },
    area: order.deliveryAddress?.city ?? null,
  });
});

router.get('/:token', authLimiter, publicTracking);

export default router;
