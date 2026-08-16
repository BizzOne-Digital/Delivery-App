import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Order } from '../../models/Order';
import { Pharmacy } from '../../models/Pharmacy';
import { User } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { haversineKm, isValidCoordinate } from '../../utils/geo';
import { endOfDay, startOfDay } from '../../utils/dates';
import { requireUser } from '../../middleware/auth';
import {
  appendTimeline,
  buildDriverReadyFilter,
  claimOrderAtomically,
  saveAndPublish,
} from '../../services/order.service';
import {
  notifyOrderStakeholders,
  notifyUsers,
  pharmacyRecipients,
} from '../../services/notification/notification.service';
import { recordAudit } from '../../services/audit.service';
import type { PaymentMethod } from '../../constants/enums';

function driverOnly(req: Request) {
  const user = requireUser(req);
  if (user.role !== 'DRIVER') throw ApiError.forbidden('This endpoint is for drivers');
  return user;
}

function readCoords(body: Record<string, unknown>) {
  const latitude = body.latitude === null || body.latitude === undefined ? null : Number(body.latitude);
  const longitude = body.longitude === null || body.longitude === undefined ? null : Number(body.longitude);
  return isValidCoordinate({ latitude: latitude ?? undefined, longitude: longitude ?? undefined })
    ? { latitude: latitude as number, longitude: longitude as number }
    : null;
}

/**
 * Ready screen feed: orders grouped by pharmacy, respecting each pharmacy's
 * assignment mode. Distances are measured from the driver's supplied position.
 */
export const readyFeed = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const query = req.query as Record<string, string | undefined>;
  const from = readCoords(query as Record<string, unknown>);

  const filter = await buildDriverReadyFilter(driver);
  const orders = await Order.find(filter)
    .select(
      'referenceNumber pharmacyId orderType priority deliveryDate timeWindowStart timeWindowEnd amountDue packageCount deliveryAddress deliveryCoordinates customerSnapshot orderNotes customerNotesSnapshot manifestItems assignedDriverId status distanceKm proofConfigSnapshot',
    )
    .sort({ priority: 1, deliveryDate: 1 })
    .limit(400)
    .lean();

  const pharmacies = await Pharmacy.find({
    _id: { $in: [...new Set(orders.map((o) => String(o.pharmacyId)))] },
  })
    .select('name code address city postalCode latitude longitude pickupInstructions logo deliveryStartTime')
    .lean();

  const pharmacyMap = new Map(pharmacies.map((p) => [String(p._id), p]));

  const grouped = pharmacies
    .map((pharmacy) => {
      const pharmacyOrders = orders
        .filter((o) => String(o.pharmacyId) === String(pharmacy._id))
        .map((order) => ({
          ...order,
          preAssignedToMe: String(order.assignedDriverId ?? '') === String(driver._id),
          hasNotes: Boolean(order.orderNotes || order.customerNotesSnapshot),
          distanceKm:
            from && isValidCoordinate(order.deliveryCoordinates)
              ? Math.round(haversineKm(from, order.deliveryCoordinates!) * 10) / 10
              : order.distanceKm,
        }));

      return {
        pharmacy: {
          ...pharmacy,
          distanceKm: from
            ? Math.round(
                haversineKm(from, { latitude: pharmacy.latitude, longitude: pharmacy.longitude }) * 10,
              ) / 10
            : null,
        },
        readyCount: pharmacyOrders.length,
        urgentCount: pharmacyOrders.filter((o) => o.priority === 'URGENT').length,
        orders: pharmacyOrders,
      };
    })
    .filter((group) => group.readyCount > 0)
    .sort((a, b) => {
      const da = a.pharmacy.distanceKm;
      const db = b.pharmacy.distanceKm;
      if (da !== null && db !== null) return da - db;
      return b.readyCount - a.readyCount;
    });

  sendSuccess(res, grouped, {
    meta: {
      totalOrders: orders.length,
      totalPharmacies: grouped.length,
      pharmaciesWithoutOrders: [...pharmacyMap.keys()].length - grouped.length,
    },
  });
});

/** Take Ownership — single order. Atomic; loser of a race gets a 409. */
export const claimOrder = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const order = await claimOrderAtomically(String(req.params.id), driver);

  if (driver.driverStatus === 'AVAILABLE' || driver.driverStatus === 'PICKING_UP') {
    await User.updateOne({ _id: driver._id }, { $set: { driverStatus: 'DELIVERING' } });
  }

  await recordAudit({
    actorId: driver._id,
    actorRole: 'DRIVER',
    entityType: 'Order',
    entityId: order._id,
    action: 'CLAIM',
    metadata: { referenceNumber: order.referenceNumber },
  });

  await notifyOrderStakeholders(order, {
    type: 'ORDER_CLAIMED',
    title: 'Driver took ownership',
    message: `${driver.firstName} ${driver.lastName} collected ${order.referenceNumber}.`,
    ruleKey: 'notifyOnClaimed',
  });

  sendSuccess(res, order.toJSON(), { message: 'Order added to your route' });
});

/**
 * Take Ownership — batch. Each order is claimed independently so a conflict on
 * one does not lose the others.
 */
export const claimBatch = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const { orderIds } = req.body as { orderIds: string[] };

  const claimed: unknown[] = [];
  const conflicts: { orderId: string; reason: string; referenceNumber?: string }[] = [];

  for (const orderId of orderIds) {
    try {
      const order = await claimOrderAtomically(orderId, driver);
      claimed.push(order.toJSON());
      await recordAudit({
        actorId: driver._id,
        actorRole: 'DRIVER',
        entityType: 'Order',
        entityId: order._id,
        action: 'CLAIM',
        metadata: { referenceNumber: order.referenceNumber, batch: true },
      });
      await notifyOrderStakeholders(order, {
        type: 'ORDER_CLAIMED',
        title: 'Driver took ownership',
        message: `${driver.firstName} ${driver.lastName} collected ${order.referenceNumber}.`,
        ruleKey: 'notifyOnClaimed',
      });
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { referenceNumber?: string } | undefined) : undefined;
      conflicts.push({
        orderId,
        reason: error instanceof ApiError ? error.message : 'Could not claim this order',
        referenceNumber: details?.referenceNumber,
      });
    }
  }

  if (claimed.length > 0 && (driver.driverStatus === 'AVAILABLE' || driver.driverStatus === 'PICKING_UP')) {
    await User.updateOne({ _id: driver._id }, { $set: { driverStatus: 'DELIVERING' } });
  }

  sendSuccess(
    res,
    { claimed, conflicts, claimedCount: claimed.length, conflictCount: conflicts.length },
    {
      status: claimed.length === 0 && conflicts.length > 0 ? 409 : 200,
      message:
        conflicts.length === 0
          ? `${claimed.length} order(s) added to your route`
          : `${claimed.length} claimed, ${conflicts.length} were taken by someone else.`,
    },
  );
});

/** Orders currently in this driver's possession. */
export const onTheWayFeed = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const from = readCoords(req.query as Record<string, unknown>);

  const orders = await Order.find({ assignedDriverId: driver._id, status: 'ON_THE_WAY' })
    .populate('pharmacyId', 'name address phone latitude longitude')
    .sort({ priority: 1, deliveryDate: 1 })
    .lean();

  const withDistance = orders.map((order) => ({
    ...order,
    distanceKm:
      from && isValidCoordinate(order.deliveryCoordinates)
        ? Math.round(haversineKm(from, order.deliveryCoordinates!) * 10) / 10
        : order.distanceKm,
  }));

  const remainingDistance = withDistance.reduce((sum, o) => sum + (o.distanceKm ?? 0), 0);

  sendSuccess(res, withDistance, {
    meta: {
      stops: withDistance.length,
      remainingDistanceKm: Math.round(remainingDistance * 10) / 10,
      totalToCollect: withDistance.reduce((sum, o) => sum + (o.amountDue ?? 0), 0),
    },
  });
});

/** Failed deliveries, collected pickups and transfers heading back. */
export const returningFeed = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const orders = await Order.find({ assignedDriverId: driver._id, status: 'RETURNING' })
    .populate('pharmacyId', 'name address phone latitude longitude')
    .populate('destinationPharmacyId', 'name address phone latitude longitude')
    .sort({ returningAt: 1 })
    .lean();

  sendSuccess(res, orders, { meta: { stops: orders.length } });
});

/**
 * Guided completion flow. Enforces the pharmacy's proof configuration
 * server-side — the mobile UI mirrors these rules but cannot bypass them.
 */
export const completeOrder = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const body = req.body as Record<string, unknown>;

  const order = await Order.findOne({ _id: req.params.id, assignedDriverId: driver._id });
  if (!order) throw ApiError.notFound('This order is not on your route');
  if (order.status !== 'ON_THE_WAY' && order.status !== 'RETURNING') {
    throw ApiError.unprocessable(`An order in ${order.status} cannot be completed`, 'INVALID_STATE');
  }

  const config = order.proofConfigSnapshot;
  const photoUrls = (body.photoUrls as string[]) ?? [];

  if (config.signatureRequired && !body.signatureUrl) {
    throw ApiError.unprocessable('A signature is required for this pharmacy', 'SIGNATURE_REQUIRED');
  }
  if (config.photoRequired && photoUrls.length === 0) {
    throw ApiError.unprocessable('A delivery photo is required for this pharmacy', 'PHOTO_REQUIRED');
  }
  if (config.receiverIdentityRequired && !String(body.receiverName ?? '').trim()) {
    throw ApiError.unprocessable('The receiver name is required for this pharmacy', 'RECEIVER_REQUIRED');
  }
  if (config.manifestConfirmationRequired && body.manifestConfirmed !== true) {
    throw ApiError.unprocessable('Confirm the manifest items before completing', 'MANIFEST_REQUIRED');
  }
  if (config.authorizedRecipientRequired && body.receiverType !== 'CUSTOMER') {
    const allowed = order.customerSnapshot?.authorizedRecipients ?? [];
    const name = String(body.receiverName ?? '').trim().toLowerCase();
    const match = allowed.some((r) => r.name.trim().toLowerCase() === name);
    if (!match) {
      throw ApiError.unprocessable(
        'This pharmacy only allows handover to the customer or a named authorised recipient.',
        'AUTHORIZED_RECIPIENT_REQUIRED',
        { authorizedRecipients: allowed.map((r) => r.name) },
      );
    }
  }

  const amountCollected = Number(body.amountCollected ?? 0);
  const paymentMethod = body.paymentMethod as PaymentMethod;
  if (paymentMethod === 'NO_PAYMENT' && amountCollected > 0) {
    throw ApiError.badRequest('Amount collected must be zero when no payment was taken');
  }

  const coordinates = readCoords(body);
  const now = new Date();

  order.status = 'COMPLETED';
  order.completedAt = now;
  order.amountCollected = amountCollected;
  order.paymentMethod = paymentMethod;
  order.proofOfDelivery = {
    receiverType: body.receiverType as never,
    receiverName: (body.receiverName as string) ?? undefined,
    receiverRelationship: (body.receiverRelationship as string) ?? undefined,
    authorizedRecipientId: body.authorizedRecipientId
      ? new Types.ObjectId(String(body.authorizedRecipientId))
      : null,
    signatureUrl: (body.signatureUrl as string) ?? null,
    signatureCapturedAt: body.signatureUrl ? now : null,
    photoUrls,
    photoMeta: photoUrls.map((url) => ({
      url,
      mimeType: 'image/jpeg',
      sizeBytes: 0,
      capturedAt: now,
    })),
    manifestConfirmed: body.manifestConfirmed === true,
    note: (body.note as string) ?? undefined,
    // Proof coordinates live on the order and are exempt from the location TTL.
    coordinates,
    capturedAt: now,
    capturedByDriverId: driver._id,
  };
  order.manifestItems = order.manifestItems.map((item) => ({ ...item, confirmed: true }));

  appendTimeline(order, {
    action: 'DELIVERY_COMPLETED',
    status: 'COMPLETED',
    byUserId: driver._id,
    byRole: 'DRIVER',
    note: `Received by ${body.receiverName ?? 'customer'} — ${paymentMethod}`,
  });

  await saveAndPublish(
    order,
    driver,
    {
      action: 'COMPLETE',
      newValues: { status: 'COMPLETED', amountCollected, paymentMethod },
      metadata: { receiverType: body.receiverType },
    },
    'order:completed',
  );

  await notifyOrderStakeholders(order, {
    type: 'ORDER_COMPLETED',
    title: 'Delivery completed',
    message: `${order.referenceNumber} delivered to ${body.receiverName ?? 'the customer'}.`,
    ruleKey: 'notifyOnCompleted',
  });

  const remaining = await Order.countDocuments({
    assignedDriverId: driver._id,
    status: { $in: ['ON_THE_WAY', 'RETURNING'] },
  });
  if (remaining === 0 && driver.driverStatus === 'DELIVERING') {
    await User.updateOne({ _id: driver._id }, { $set: { driverStatus: 'AVAILABLE' } });
  }

  sendSuccess(res, order.toJSON(), { message: 'Delivery completed' });
});

/** Not delivered → RETURNING, with a mandatory reason. */
export const failOrder = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const body = req.body as Record<string, unknown>;

  const order = await Order.findOne({ _id: req.params.id, assignedDriverId: driver._id });
  if (!order) throw ApiError.notFound('This order is not on your route');
  if (order.status !== 'ON_THE_WAY') {
    throw ApiError.unprocessable(`An order in ${order.status} cannot be marked as failed`, 'INVALID_STATE');
  }

  const now = new Date();
  const coordinates = readCoords(body);

  order.status = 'RETURNING';
  order.returningAt = now;
  order.failedAt = now;
  order.failureDetails = {
    reason: body.reason as never,
    note: (body.note as string) ?? undefined,
    photoUrl: (body.photoUrl as string) ?? null,
    callAttempted: body.callAttempted === true,
    requestedRescheduleAt: body.requestedRescheduleAt ? new Date(String(body.requestedRescheduleAt)) : null,
    coordinates,
    failedAt: now,
    failedByDriverId: driver._id,
    attemptNumber: order.retryCount + 1,
  };
  order.returnDetails = {
    ...(order.returnDetails ?? { exceptionStatus: 'NONE', dispatcherNotes: [] }),
    destinationPharmacyId: order.pharmacyId,
    exceptionStatus: 'OPEN',
    dispatcherNotes: order.returnDetails?.dispatcherNotes ?? [],
  };

  appendTimeline(order, {
    action: 'DELIVERY_FAILED',
    status: 'RETURNING',
    byUserId: driver._id,
    byRole: 'DRIVER',
    note: `${String(body.reason).replace(/_/g, ' ').toLowerCase()}${body.note ? ` — ${body.note}` : ''}`,
  });

  await saveAndPublish(
    order,
    driver,
    { action: 'FAIL', newValues: { status: 'RETURNING', reason: body.reason } },
    'order:failed',
  );

  await User.updateOne({ _id: driver._id }, { $set: { driverStatus: 'RETURNING' } });

  await notifyOrderStakeholders(order, {
    type: 'ORDER_FAILED',
    title: 'Delivery failed',
    message: `${order.referenceNumber} could not be delivered (${String(body.reason).replace(/_/g, ' ').toLowerCase()}). Returning to pharmacy.`,
    ruleKey: 'notifyOnFailed',
  });

  sendSuccess(res, order.toJSON(), { message: 'Marked as not delivered — moved to Returning' });
});

/** Returning → back on the road for another attempt today. */
export const backToDelivery = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const order = await Order.findOne({ _id: req.params.id, assignedDriverId: driver._id });
  if (!order) throw ApiError.notFound('This order is not on your route');
  if (order.status !== 'RETURNING') {
    throw ApiError.unprocessable('Only returning orders can go back out for delivery', 'INVALID_STATE');
  }
  if (order.cancellationDetails?.requiredReturn) {
    throw ApiError.unprocessable(
      'This order was cancelled by the pharmacy and must be returned.',
      'CANCELLED_MUST_RETURN',
    );
  }

  order.status = 'ON_THE_WAY';
  order.onTheWayAt = new Date();
  order.retryCount += 1;

  appendTimeline(order, {
    action: 'BACK_TO_DELIVERY',
    status: 'ON_THE_WAY',
    byUserId: driver._id,
    byRole: 'DRIVER',
    note: `Retry attempt #${order.retryCount + 1}`,
  });

  await saveAndPublish(
    order,
    driver,
    { action: 'STATUS_CHANGE', newValues: { status: 'ON_THE_WAY', retryCount: order.retryCount } },
    'order:updated',
  );

  await User.updateOne({ _id: driver._id }, { $set: { driverStatus: 'DELIVERING' } });

  await notifyOrderStakeholders(order, {
    type: 'ORDER_ON_THE_WAY',
    title: 'Re-attempting delivery',
    message: `${order.referenceNumber} is going back out for another attempt.`,
    ruleKey: 'notifyOnOnTheWay',
  });

  sendSuccess(res, order.toJSON(), { message: 'Back on your delivery list' });
});

/**
 * Confirm handover at the pharmacy.
 *
 * A failed delivery becomes ACTION_REQUIRED (the pharmacy decides what next);
 * a collected customer pickup is COMPLETED once the pharmacy has it; a
 * cancelled-while-carried order finally becomes CANCELLED.
 */
export const confirmReturned = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const body = req.body as Record<string, unknown>;

  const order = await Order.findOne({ _id: req.params.id, assignedDriverId: driver._id });
  if (!order) throw ApiError.notFound('This order is not on your route');
  if (order.status !== 'RETURNING') {
    throw ApiError.unprocessable('Only returning orders can be handed back', 'INVALID_STATE');
  }

  const now = new Date();
  const coordinates = readCoords(body);

  order.returnDetails = {
    ...(order.returnDetails ?? { exceptionStatus: 'NONE', dispatcherNotes: [] }),
    receivedByName: String(body.receivedByName),
    receivedByEmployeeCode: (body.receivedByEmployeeCode as string) ?? undefined,
    signatureUrl: (body.signatureUrl as string) ?? null,
    photoUrl: (body.photoUrl as string) ?? null,
    coordinates,
    returnedAt: now,
    destinationPharmacyId: order.destinationPharmacyId ?? order.pharmacyId,
    exceptionStatus: order.returnDetails?.exceptionStatus ?? 'NONE',
    dispatcherNotes: order.returnDetails?.dispatcherNotes ?? [],
  };
  order.returnedAt = now;

  let nextStatus: 'ACTION_REQUIRED' | 'COMPLETED' | 'CANCELLED';
  if (order.cancellationDetails?.requiredReturn) {
    nextStatus = 'CANCELLED';
    order.cancelledAt = now;
    order.cancellationDetails.cancelledAt = now;
  } else if (order.orderType === 'CUSTOMER_PICKUP' || order.orderType === 'PHARMACY_TRANSFER') {
    // The pharmacy is the destination for these types, so handover completes them.
    nextStatus = 'COMPLETED';
    order.completedAt = now;
  } else {
    nextStatus = 'ACTION_REQUIRED';
  }
  order.status = nextStatus;

  appendTimeline(order, {
    action: 'RETURNED_TO_PHARMACY',
    status: nextStatus,
    byUserId: driver._id,
    byRole: 'DRIVER',
    note: `Handed to ${body.receivedByName}`,
  });

  await saveAndPublish(
    order,
    driver,
    { action: 'RETURN', newValues: { status: nextStatus, receivedByName: body.receivedByName } },
    'order:returned',
  );

  const remaining = await Order.countDocuments({
    assignedDriverId: driver._id,
    status: { $in: ['ON_THE_WAY', 'RETURNING'] },
  });
  await User.updateOne(
    { _id: driver._id },
    { $set: { driverStatus: remaining === 0 ? 'AVAILABLE' : 'DELIVERING' } },
  );

  await notifyOrderStakeholders(order, {
    type: 'RETURN_COMPLETED',
    title: 'Package returned to pharmacy',
    message: `${order.referenceNumber} was handed back to ${body.receivedByName}.`,
    ruleKey: 'notifyOnReturn',
  });

  sendSuccess(res, order.toJSON(), { message: 'Return confirmed' });
});

/** Driver history + today's totals for the Cash Report screen. */
export const driverHistory = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const query = req.query as Record<string, string | undefined>;

  const from = query.dateFrom ? startOfDay(query.dateFrom) : startOfDay();
  const to = query.dateTo ? endOfDay(query.dateTo) : endOfDay();

  const orders = await Order.find({
    assignedDriverId: driver._id,
    $or: [
      { completedAt: { $gte: from, $lte: to } },
      { returnedAt: { $gte: from, $lte: to } },
      { cancelledAt: { $gte: from, $lte: to } },
    ],
  })
    .populate('pharmacyId', 'name address')
    .sort({ completedAt: -1, returnedAt: -1 })
    .lean();

  const completed = orders.filter((o) => o.status === 'COMPLETED');
  const returned = orders.filter((o) => o.returnedAt);
  const pickups = completed.filter((o) => o.orderType === 'CUSTOMER_PICKUP');

  const cashExpected = completed.reduce((sum, o) => sum + (o.amountDue ?? 0), 0);
  const cashCollected = completed.reduce((sum, o) => sum + (o.amountCollected ?? 0), 0);

  const byMethod = completed.reduce<Record<string, { amount: number; count: number }>>((acc, o) => {
    const key = o.paymentMethod ?? 'OTHER';
    acc[key] = acc[key] ?? { amount: 0, count: 0 };
    acc[key].amount += o.amountCollected ?? 0;
    acc[key].count += 1;
    return acc;
  }, {});

  const discrepancies = completed
    .filter((o) => Math.abs((o.amountDue ?? 0) - (o.amountCollected ?? 0)) > 0.009)
    .map((o) => ({
      orderId: String(o._id),
      referenceNumber: o.referenceNumber,
      expected: o.amountDue,
      collected: o.amountCollected,
      difference: Math.round(((o.amountCollected ?? 0) - (o.amountDue ?? 0)) * 100) / 100,
      paymentMethod: o.paymentMethod,
    }));

  sendSuccess(res, {
    orders,
    summary: {
      totalStops: orders.length,
      completed: completed.length,
      returned: returned.length,
      pickups: pickups.length,
      cashExpected: Math.round(cashExpected * 100) / 100,
      cashCollected: Math.round(cashCollected * 100) / 100,
      difference: Math.round((cashCollected - cashExpected) * 100) / 100,
      totalDistanceKm:
        Math.round(orders.reduce((sum, o) => sum + (o.distanceKm ?? 0), 0) * 10) / 10,
      byMethod,
      discrepancies,
    },
  });
});

/** Shift + availability control. */
export const setDriverStatus = asyncHandler(async (req: Request, res: Response) => {
  const driver = driverOnly(req);
  const { driverStatus } = req.body as { driverStatus: string };

  const holding = await Order.countDocuments({
    assignedDriverId: driver._id,
    status: { $in: ['ON_THE_WAY', 'RETURNING'] },
  });
  if (driverStatus === 'OFFLINE' && holding > 0) {
    throw ApiError.unprocessable(
      `You still have ${holding} order(s) in your possession. Complete or return them before ending your shift.`,
      'DRIVER_HAS_ACTIVE_ORDERS',
      { holding },
    );
  }

  const user = await User.findById(driver._id);
  if (!user) throw ApiError.notFound('Account not found');

  const previous = user.driverStatus;
  user.driverStatus = driverStatus as typeof user.driverStatus;
  if (driverStatus === 'OFFLINE') user.shiftStartedAt = null;
  else if (previous === 'OFFLINE') user.shiftStartedAt = new Date();
  await user.save();

  await recordAudit({
    actorId: driver._id,
    actorRole: 'DRIVER',
    entityType: 'User',
    entityId: driver._id,
    action: 'STATUS_CHANGE',
    oldValues: { driverStatus: previous },
    newValues: { driverStatus },
  });

  const recipients = await pharmacyRecipients(driver.assignedPharmacyIds?.[0] ?? new Types.ObjectId());
  if (driverStatus === 'OFFLINE' && recipients.length > 0) {
    await notifyUsers({
      recipientUserIds: recipients,
      type: 'SYSTEM',
      title: 'Driver ended shift',
      message: `${driver.firstName} ${driver.lastName} is now offline.`,
    });
  }

  sendSuccess(res, user.toJSON(), { message: `Status set to ${driverStatus.replace(/_/g, ' ').toLowerCase()}` });
});
