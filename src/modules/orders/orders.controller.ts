import type { Request, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { Order, type IOrder } from '../../models/Order';
import { Pharmacy } from '../../models/Pharmacy';
import { User } from '../../models/User';
import { RecurringOrder } from '../../models/RecurringOrder';
import { ACTIVE_ORDER_STATUSES, type OrderStatus } from '../../constants/enums';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { escapeRegex, resolvePagination } from '../../utils/pagination';
import { createTrackingToken } from '../../utils/tokens';
import { requireUser } from '../../middleware/auth';
import {
  assertPharmacyAccess,
  canDispatch,
  isCompanyUser,
  isDriver,
  isPharmacyUser,
  pharmacyScopeFor,
} from '../../middleware/rbac';
import {
  appendTimeline,
  applyEditRules,
  assertOrderReadAccess,
  assertTransition,
  buildOrderSnapshots,
  computeOrderDistanceKm,
  generateUniqueReference,
  saveAndPublish,
  stampStatusTimestamp,
} from '../../services/order.service';
import {
  dispatcherRecipients,
  notifyOrderStakeholders,
  notifyUsers,
  pharmacyRecipients,
} from '../../services/notification/notification.service';

/** Builds the base list filter, always constrained by the caller's data scope. */
function buildListFilter(actor: ReturnType<typeof requireUser>, query: Record<string, unknown>) {
  const filter: FilterQuery<IOrder> = {};

  const scope = pharmacyScopeFor(actor);
  if (scope !== null) {
    if (isDriver(actor)) {
      // Drivers see their own orders plus the open pool of their pharmacies.
      filter.$or = [
        { assignedDriverId: actor._id },
        { pharmacyId: { $in: scope }, status: 'READY', assignedDriverId: null },
      ];
    } else {
      filter.$or = [{ pharmacyId: { $in: scope } }, { destinationPharmacyId: { $in: scope } }];
    }
  } else if (query.pharmacyId) {
    filter.pharmacyId = new Types.ObjectId(String(query.pharmacyId));
  }

  if (query.status) {
    filter.status = { $in: String(query.status).split(',') } as FilterQuery<IOrder>['status'];
  }
  if (query.orderType) {
    filter.orderType = { $in: String(query.orderType).split(',') } as FilterQuery<IOrder>['orderType'];
  }
  if (query.priority) {
    filter.priority = { $in: String(query.priority).split(',') } as FilterQuery<IOrder>['priority'];
  }
  if (query.customerId) filter.customerId = new Types.ObjectId(String(query.customerId));
  if (query.driverId) filter.assignedDriverId = new Types.ObjectId(String(query.driverId));
  if (query.unassigned === 'true') filter.assignedDriverId = null;
  if (query.requiresReview === 'true') filter.requiresDispatcherReview = true;

  if (query.dateFrom || query.dateTo) {
    filter.deliveryDate = {};
    if (query.dateFrom) (filter.deliveryDate as Record<string, Date>).$gte = query.dateFrom as Date;
    if (query.dateTo) (filter.deliveryDate as Record<string, Date>).$lte = query.dateTo as Date;
  }

  if (query.search) {
    const rx = new RegExp(escapeRegex(String(query.search)), 'i');
    const searchClause = [
      { referenceNumber: rx },
      { 'customerSnapshot.firstName': rx },
      { 'customerSnapshot.lastName': rx },
      { 'customerSnapshot.phone': rx },
      { 'deliveryAddress.line1': rx },
    ];
    filter.$and = [...(filter.$and ?? []), { $or: searchClause }];
  }

  return filter;
}

export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip, sort } = resolvePagination(req.query, { sort: 'createdAt' });
  const filter = buildListFilter(actor, req.query as Record<string, unknown>);

  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('assignedDriverId', 'firstName lastName phone driverStatus')
      .populate('pharmacyId', 'name code address latitude longitude')
      .lean(),
    Order.countDocuments(filter),
  ]);

  sendSuccess(res, items, { meta: buildPaginationMeta(page, limit, total) });
});

export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id)
    .populate('assignedDriverId', 'firstName lastName phone driverStatus lastKnownLocation')
    .populate('pharmacyId', 'name code address phone latitude longitude proofConfig');
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  sendSuccess(res, order.toJSON());
});

export const getOrderTimeline = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id).select('timeline referenceNumber status pharmacyId assignedDriverId');
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  const userIds = [...new Set(order.timeline.map((t) => String(t.byUserId ?? '')).filter(Boolean))];
  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName role').lean();
  const nameMap = new Map(users.map((u) => [String(u._id), `${u.firstName} ${u.lastName}`]));

  sendSuccess(
    res,
    order.timeline.map((entry) => ({
      ...entry,
      byName: entry.byUserId ? (nameMap.get(String(entry.byUserId)) ?? 'Unknown user') : 'System',
    })),
  );
});

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, unknown>;

  const pharmacyId = isPharmacyUser(actor)
    ? String(actor.pharmacyId ?? '')
    : String(body.pharmacyId ?? '');
  if (!pharmacyId) throw ApiError.badRequest('pharmacyId is required');
  assertPharmacyAccess(actor, pharmacyId);

  const snapshots = await buildOrderSnapshots({
    pharmacyId,
    customerId: body.customerId as string | undefined,
    addressId: body.addressId as string | undefined,
    destinationPharmacyId: body.destinationPharmacyId as string | undefined,
    orderType: String(body.orderType ?? 'DELIVERY'),
  });

  const initialStatus = String(body.initialStatus ?? 'ACTION_REQUIRED') as OrderStatus;

  const order = new Order({
    referenceNumber: await generateUniqueReference(),
    pharmacyId: new Types.ObjectId(pharmacyId),
    customerId: snapshots.customer?._id ?? null,
    destinationPharmacyId: body.destinationPharmacyId
      ? new Types.ObjectId(String(body.destinationPharmacyId))
      : null,
    orderType: body.orderType ?? 'DELIVERY',
    status: initialStatus,
    deliveryDate: body.deliveryDate,
    timeWindowStart: body.timeWindowStart,
    timeWindowEnd: body.timeWindowEnd,
    priority: body.priority ?? 'NORMAL',
    amountDue: body.amountDue ?? 0,
    packageCount: body.packageCount ?? 1,
    orderNotes: body.orderNotes,
    employeeReference: body.employeeReference,
    manifestItems: body.manifestItems ?? [],
    pickupAddress: snapshots.pickupAddress,
    deliveryAddress: snapshots.deliveryAddress,
    pickupCoordinates: snapshots.pickupCoordinates,
    deliveryCoordinates: snapshots.deliveryCoordinates,
    customerSnapshot: snapshots.customerSnapshot,
    customerNotesSnapshot: snapshots.customerNotesSnapshot,
    proofConfigSnapshot: { ...(snapshots.proofConfig ?? {}), ...((body.proofConfig as object) ?? {}) },
    assignedDriverId: body.assignedDriverId ? new Types.ObjectId(String(body.assignedDriverId)) : null,
    createdBy: actor._id,
    updatedBy: actor._id,
  });

  order.distanceKm = computeOrderDistanceKm(order);
  stampStatusTimestamp(order, initialStatus);
  appendTimeline(order, {
    action: 'ORDER_CREATED',
    status: initialStatus,
    byUserId: actor._id,
    byRole: actor.role,
  });
  if (order.assignedDriverId) order.assignedAt = new Date();

  // Optional recurrence: create the schedule and stamp the first occurrence.
  if (body.recurrence && snapshots.customer) {
    const recurrence = body.recurrence as Record<string, unknown>;
    const schedule = await RecurringOrder.create({
      pharmacyId: order.pharmacyId,
      customerId: snapshots.customer._id,
      orderType: order.orderType,
      frequency: recurrence.frequency,
      weekdays: recurrence.weekdays ?? [],
      dayOfMonth: recurrence.dayOfMonth ?? null,
      intervalDays: recurrence.intervalDays ?? null,
      startDate: recurrence.startDate,
      endDate: recurrence.endDate ?? null,
      timeWindowStart: order.timeWindowStart,
      timeWindowEnd: order.timeWindowEnd,
      priority: order.priority,
      amountDue: order.amountDue,
      packageCount: order.packageCount,
      manifestItems: order.manifestItems,
      orderNotes: order.orderNotes,
      addressId: body.addressId ? new Types.ObjectId(String(body.addressId)) : null,
      createdBy: actor._id,
      lastGeneratedDate: order.deliveryDate,
    });
    order.recurringOrderId = schedule._id;
    order.recurrenceOccurrenceDate = order.deliveryDate;
  }

  await saveAndPublish(order, actor, { action: 'CREATE', newValues: { status: initialStatus } }, 'order:created');

  if (initialStatus === 'READY') {
    await notifyOrderStakeholders(order, {
      type: 'ORDER_READY',
      title: 'New order ready for collection',
      message: `${order.referenceNumber} is ready at ${snapshots.pharmacy.name}.`,
      ruleKey: 'notifyOnReady',
    });
    await notifyLinkedDrivers(order);
  }

  sendSuccess(res, order.toJSON(), { status: 201, message: 'Order created' });
});

/** Tells the pharmacy's linked drivers that a new order entered the pool. */
async function notifyLinkedDrivers(order: { pharmacyId: Types.ObjectId; _id: Types.ObjectId; referenceNumber: string; assignedDriverId?: Types.ObjectId | null }) {
  const pharmacy = await Pharmacy.findById(order.pharmacyId).select('linkedDriverIds name').lean();
  if (!pharmacy) return;

  const recipients = order.assignedDriverId
    ? [String(order.assignedDriverId)]
    : (pharmacy.linkedDriverIds ?? []).map(String);

  await notifyUsers({
    recipientUserIds: recipients,
    type: order.assignedDriverId ? 'ORDER_ASSIGNED' : 'ORDER_READY',
    title: order.assignedDriverId ? 'Order assigned to you' : 'New order available',
    message: `${order.referenceNumber} at ${pharmacy.name}`,
    orderId: order._id,
    pharmacyId: order.pharmacyId,
    channels: ['IN_APP', 'PUSH'],
  });
}

export const updateOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw ApiError.unprocessable('Completed and cancelled orders cannot be edited', 'ORDER_FINALISED');
  }

  const body = req.body as Record<string, unknown>;
  const changed: string[] = [];
  const before: Record<string, unknown> = {};

  // Re-snapshot address/customer when the caller points at a different one.
  if (body.customerId || body.addressId) {
    const snapshots = await buildOrderSnapshots({
      pharmacyId: String(order.pharmacyId),
      customerId: String(body.customerId ?? order.customerId ?? ''),
      addressId: body.addressId as string | undefined,
      orderType: String(body.orderType ?? order.orderType),
    });
    before.deliveryAddress = order.deliveryAddress;
    order.customerId = snapshots.customer?._id ?? order.customerId;
    order.deliveryAddress = snapshots.deliveryAddress;
    order.deliveryCoordinates = snapshots.deliveryCoordinates;
    order.customerSnapshot = snapshots.customerSnapshot;
    order.customerNotesSnapshot = snapshots.customerNotesSnapshot;
    changed.push('deliveryAddress', 'deliveryCoordinates');
  }

  for (const key of [
    'deliveryDate',
    'timeWindowStart',
    'timeWindowEnd',
    'priority',
    'amountDue',
    'packageCount',
    'orderNotes',
    'employeeReference',
    'manifestItems',
    'orderType',
  ] as const) {
    if (body[key] === undefined) continue;
    const current = (order as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(current) === JSON.stringify(body[key])) continue;
    before[key] = current;
    (order as unknown as Record<string, unknown>)[key] = body[key];
    changed.push(key);
  }

  if (changed.length === 0) {
    sendSuccess(res, order.toJSON(), { message: 'No changes' });
    return;
  }

  const rules = applyEditRules(order, changed);
  if (rules.requiresReview) {
    order.requiresDispatcherReview = true;
    order.dispatcherReviewReason = rules.reviewReason;
  }
  order.distanceKm = computeOrderDistanceKm(order);

  appendTimeline(order, {
    action: 'ORDER_EDITED',
    byUserId: actor._id,
    byRole: actor.role,
    note: `Changed: ${changed.join(', ')}`,
  });

  await saveAndPublish(
    order,
    actor,
    { action: 'UPDATE', oldValues: before, newValues: Object.fromEntries(changed.map((k) => [k, (order as unknown as Record<string, unknown>)[k]])) },
    'order:updated',
  );

  // After ownership, changes are announced rather than applied silently.
  if (rules.notifyDriver || rules.requiresReview) {
    await notifyOrderStakeholders(order, {
      type: 'ORDER_EDITED',
      title: 'Order changed after collection',
      message: `${order.referenceNumber} was edited (${changed.join(', ')}).${
        rules.requiresReview ? ' Dispatcher review required — route needs recalculation.' : ''
      }`,
      includeDriver: true,
    });
  }

  sendSuccess(res, order.toJSON(), {
    message: rules.requiresReview
      ? 'Order updated. A dispatcher must review the route change.'
      : 'Order updated',
  });
});

/** ACTION_REQUIRED → PREPARING → READY (or straight to READY). */
export const changeStatus = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { status, note } = req.body as { status: OrderStatus; note?: string };

  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  // Only these transitions are exposed here; driver actions have dedicated routes.
  const allowedHere: OrderStatus[] = ['ACTION_REQUIRED', 'PREPARING', 'READY'];
  if (!allowedHere.includes(status)) {
    throw ApiError.badRequest('Use the dedicated endpoint for this transition', 'USE_SPECIFIC_ENDPOINT');
  }
  if (order.claimedAt) {
    throw ApiError.unprocessable('A driver already has this package', 'ORDER_ALREADY_CLAIMED');
  }

  assertTransition(order.status, status);
  const previous = order.status;
  order.status = status;
  stampStatusTimestamp(order, status);
  appendTimeline(order, { action: `STATUS_${status}`, status, byUserId: actor._id, byRole: actor.role, note });

  await saveAndPublish(
    order,
    actor,
    { action: 'STATUS_CHANGE', oldValues: { status: previous }, newValues: { status } },
    status === 'READY' ? 'order:ready' : 'order:updated',
  );

  if (status === 'READY') {
    const pharmacy = await Pharmacy.findById(order.pharmacyId).select('name').lean();
    await notifyOrderStakeholders(order, {
      type: 'ORDER_READY',
      title: 'Order ready for collection',
      message: `${order.referenceNumber} is ready at ${pharmacy?.name ?? 'the pharmacy'}.`,
      ruleKey: 'notifyOnReady',
    });
    await notifyLinkedDrivers(order);
  }

  sendSuccess(res, order.toJSON(), { message: `Order moved to ${status.replace(/_/g, ' ').toLowerCase()}` });
});

/**
 * Cancellation.
 *
 * If a driver physically holds the package the order cannot vanish — it is sent
 * through RETURNING first and only finalised once handed back to the pharmacy.
 */
export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { reason } = req.body as { reason: string };

  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw ApiError.unprocessable('This order is already finalised', 'ORDER_FINALISED');
  }

  const driverHasPackage = order.status === 'ON_THE_WAY' && Boolean(order.claimedAt);
  const previous = order.status;

  if (driverHasPackage) {
    order.status = 'RETURNING';
    order.returningAt = new Date();
    order.cancellationDetails = {
      reason,
      cancelledAt: null,
      cancelledBy: actor._id,
      requiredReturn: true,
    };
    order.returnDetails = {
      ...(order.returnDetails ?? { exceptionStatus: 'NONE', dispatcherNotes: [] }),
      destinationPharmacyId: order.pharmacyId,
      exceptionStatus: 'OPEN',
      dispatcherNotes: order.returnDetails?.dispatcherNotes ?? [],
    };
    appendTimeline(order, {
      action: 'CANCELLATION_REQUESTED_RETURN_FIRST',
      status: 'RETURNING',
      byUserId: actor._id,
      byRole: actor.role,
      note: reason,
    });
  } else {
    order.status = 'CANCELLED';
    order.cancelledAt = new Date();
    order.cancellationDetails = {
      reason,
      cancelledAt: new Date(),
      cancelledBy: actor._id,
      requiredReturn: false,
    };
    appendTimeline(order, {
      action: 'ORDER_CANCELLED',
      status: 'CANCELLED',
      byUserId: actor._id,
      byRole: actor.role,
      note: reason,
    });
  }

  await saveAndPublish(
    order,
    actor,
    { action: 'CANCEL', oldValues: { status: previous }, newValues: { status: order.status }, metadata: { reason, requiredReturn: driverHasPackage } },
    driverHasPackage ? 'order:returning' : 'order:cancelled',
  );

  await notifyOrderStakeholders(order, {
    type: driverHasPackage ? 'RETURN_STARTED' : 'ORDER_CANCELLED',
    title: driverHasPackage ? 'Cancellation — package returning' : 'Order cancelled',
    message: driverHasPackage
      ? `${order.referenceNumber} was cancelled while with the driver. It is being returned to the pharmacy.`
      : `${order.referenceNumber} was cancelled. Reason: ${reason}`,
    includeDriver: true,
  });

  sendSuccess(res, order.toJSON(), {
    message: driverHasPackage
      ? 'The driver has the package — the order will be cancelled once it is returned to the pharmacy.'
      : 'Order cancelled',
  });
});

export const duplicateOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const source = await Order.findById(req.params.id);
  if (!source) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, source);

  const copy = new Order({
    referenceNumber: await generateUniqueReference(),
    pharmacyId: source.pharmacyId,
    customerId: source.customerId,
    destinationPharmacyId: source.destinationPharmacyId,
    orderType: source.orderType,
    status: 'ACTION_REQUIRED',
    deliveryDate: new Date(),
    timeWindowStart: source.timeWindowStart,
    timeWindowEnd: source.timeWindowEnd,
    priority: source.priority,
    amountDue: source.amountDue,
    packageCount: source.packageCount,
    orderNotes: source.orderNotes,
    employeeReference: source.employeeReference,
    manifestItems: source.manifestItems.map((item) => ({ ...item, confirmed: false })),
    pickupAddress: source.pickupAddress,
    deliveryAddress: source.deliveryAddress,
    pickupCoordinates: source.pickupCoordinates,
    deliveryCoordinates: source.deliveryCoordinates,
    customerSnapshot: source.customerSnapshot,
    customerNotesSnapshot: source.customerNotesSnapshot,
    proofConfigSnapshot: source.proofConfigSnapshot,
    distanceKm: source.distanceKm,
    createdBy: actor._id,
  });

  appendTimeline(copy, {
    action: 'ORDER_DUPLICATED',
    status: 'ACTION_REQUIRED',
    byUserId: actor._id,
    byRole: actor.role,
    note: `Copied from ${source.referenceNumber}`,
  });

  await saveAndPublish(copy, actor, { action: 'CREATE', metadata: { duplicatedFrom: source.referenceNumber } }, 'order:created');
  sendSuccess(res, copy.toJSON(), { status: 201, message: 'Order duplicated' });
});

/* ------------------------------------------------------------------ */
/* Dispatcher assignment                                               */
/* ------------------------------------------------------------------ */

export const assignOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!canDispatch(actor)) throw ApiError.forbidden('Only dispatchers can assign orders');

  const { driverId, note } = req.body as { driverId: string | null; note?: string };
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');

  // Unassigning is only possible before the driver takes ownership.
  if (order.claimedAt && driverId === null) {
    throw ApiError.unprocessable(
      'This driver already collected the package. Use transfer or return instead.',
      'ORDER_ALREADY_CLAIMED',
    );
  }
  if (!['READY', 'PREPARING', 'ACTION_REQUIRED'].includes(order.status) && !order.claimedAt) {
    throw ApiError.unprocessable(`An order in ${order.status} cannot be assigned`, 'INVALID_STATE');
  }

  const previousDriver = order.assignedDriverId;

  if (driverId) {
    const driver = await User.findOne({ _id: driverId, role: 'DRIVER', active: true });
    if (!driver) throw ApiError.notFound('Driver not found or inactive');
    order.assignedDriverId = driver._id;
    order.assignedAt = new Date();
  } else {
    order.assignedDriverId = null;
    order.assignedAt = null;
  }

  appendTimeline(order, {
    action: driverId ? 'DRIVER_ASSIGNED' : 'DRIVER_UNASSIGNED',
    byUserId: actor._id,
    byRole: actor.role,
    note,
  });

  await saveAndPublish(
    order,
    actor,
    {
      action: driverId ? 'ASSIGN' : 'UNASSIGN',
      oldValues: { assignedDriverId: previousDriver },
      newValues: { assignedDriverId: order.assignedDriverId },
    },
    'order:assigned',
  );

  const recipients = [
    ...(driverId ? [driverId] : []),
    ...(previousDriver ? [String(previousDriver)] : []),
  ];
  if (recipients.length > 0) {
    await notifyUsers({
      recipientUserIds: recipients,
      type: 'ORDER_ASSIGNED',
      title: driverId ? 'Order assigned to you' : 'Order removed from your list',
      message: `${order.referenceNumber}`,
      orderId: order._id,
      pharmacyId: order.pharmacyId,
      channels: ['IN_APP', 'PUSH'],
    });
  }

  sendSuccess(res, order.toJSON(), { message: driverId ? 'Order assigned' : 'Order unassigned' });
});

/** Assigns a whole batch (e.g. every Ready order at one pharmacy) to one driver. */
export const batchAssign = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!canDispatch(actor)) throw ApiError.forbidden('Only dispatchers can assign orders');

  const { orderIds, driverId } = req.body as { orderIds: string[]; driverId: string };
  const driver = await User.findOne({ _id: driverId, role: 'DRIVER', active: true });
  if (!driver) throw ApiError.notFound('Driver not found or inactive');

  const result = await Order.updateMany(
    { _id: { $in: orderIds }, claimedAt: null, status: { $in: ['ACTION_REQUIRED', 'PREPARING', 'READY'] } },
    {
      $set: { assignedDriverId: driver._id, assignedAt: new Date(), updatedBy: actor._id },
      $inc: { version: 1 },
      $push: {
        timeline: {
          action: 'DRIVER_ASSIGNED',
          at: new Date(),
          byUserId: actor._id,
          byRole: actor.role,
        },
      },
    },
  );

  const skipped = orderIds.length - result.modifiedCount;

  await notifyUsers({
    recipientUserIds: [driverId],
    type: 'ORDER_ASSIGNED',
    title: `${result.modifiedCount} order(s) assigned to you`,
    message: 'Open the Ready screen to take ownership.',
    channels: ['IN_APP', 'PUSH'],
  });

  sendSuccess(
    res,
    { assigned: result.modifiedCount, skipped },
    {
      message:
        skipped > 0
          ? `${result.modifiedCount} assigned. ${skipped} were skipped (already claimed or not assignable).`
          : `${result.modifiedCount} order(s) assigned`,
    },
  );
});

/** Transfers an order that a driver already holds to a different driver. */
export const transferOrder = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!canDispatch(actor)) throw ApiError.forbidden('Only dispatchers can transfer orders');

  const { driverId, note } = req.body as { driverId: string; note?: string };
  if (!driverId) throw ApiError.badRequest('A destination driver is required');

  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');

  const driver = await User.findOne({ _id: driverId, role: 'DRIVER', active: true });
  if (!driver) throw ApiError.notFound('Driver not found or inactive');

  const previousDriver = order.assignedDriverId;
  order.assignedDriverId = driver._id;
  order.assignedAt = new Date();
  appendTimeline(order, {
    action: 'ORDER_TRANSFERRED',
    byUserId: actor._id,
    byRole: actor.role,
    note: note ?? `Transferred to ${driver.firstName} ${driver.lastName}`,
  });

  await saveAndPublish(
    order,
    actor,
    { action: 'TRANSFER', oldValues: { assignedDriverId: previousDriver }, newValues: { assignedDriverId: driver._id } },
    'order:assigned',
  );

  await notifyUsers({
    recipientUserIds: [driverId, ...(previousDriver ? [String(previousDriver)] : [])],
    type: 'ORDER_ASSIGNED',
    title: 'Order transferred',
    message: `${order.referenceNumber} has been transferred.`,
    orderId: order._id,
    channels: ['IN_APP', 'PUSH'],
  });

  sendSuccess(res, order.toJSON(), { message: 'Order transferred' });
});

export const setPriority = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  const priority = String((req.body as { priority?: string }).priority ?? 'NORMAL');
  const before = order.priority;
  order.priority = priority as IOrder['priority'];
  appendTimeline(order, { action: 'PRIORITY_CHANGED', byUserId: actor._id, byRole: actor.role, note: `${before} → ${priority}` });

  await saveAndPublish(order, actor, { action: 'UPDATE', oldValues: { priority: before }, newValues: { priority } }, 'order:updated');
  sendSuccess(res, order.toJSON(), { message: 'Priority updated' });
});

/* ------------------------------------------------------------------ */
/* Returns management (dispatcher + pharmacy)                          */
/* ------------------------------------------------------------------ */

export const listReturns = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip } = resolvePagination(req.query, { sort: 'returningAt' });

  const filter: FilterQuery<IOrder> = { status: 'RETURNING' };
  const scope = pharmacyScopeFor(actor);
  if (scope !== null) filter.pharmacyId = { $in: scope };

  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ returningAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedDriverId', 'firstName lastName phone driverStatus lastKnownLocation')
      .populate('pharmacyId', 'name address latitude longitude')
      .lean(),
    Order.countDocuments(filter),
  ]);

  sendSuccess(res, items, { meta: buildPaginationMeta(page, limit, total) });
});

export const updateReturnException = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { exceptionStatus, note } = req.body as { exceptionStatus?: string; note?: string };

  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  order.returnDetails = order.returnDetails ?? { exceptionStatus: 'NONE', dispatcherNotes: [] };
  if (exceptionStatus) order.returnDetails.exceptionStatus = exceptionStatus as IOrder['returnDetails'] extends null ? never : 'OPEN';
  if (note) {
    order.returnDetails.dispatcherNotes.push({ note, byUserId: actor._id, at: new Date() });
  }

  appendTimeline(order, { action: 'RETURN_EXCEPTION_UPDATED', byUserId: actor._id, byRole: actor.role, note });
  await saveAndPublish(order, actor, { action: 'UPDATE', newValues: { exceptionStatus, note } }, 'order:updated');

  sendSuccess(res, order.toJSON(), { message: 'Return updated' });
});

/** The pharmacy confirms it has the returned package back in its hands. */
export const acknowledgeReturn = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  order.returnDetails = order.returnDetails ?? { exceptionStatus: 'NONE', dispatcherNotes: [] };
  order.returnDetails.pharmacyAcknowledgedAt = new Date();
  order.returnDetails.pharmacyAcknowledgedBy = actor._id;
  if (order.returnDetails.exceptionStatus === 'OPEN') order.returnDetails.exceptionStatus = 'CLOSED';

  appendTimeline(order, { action: 'RETURN_ACKNOWLEDGED', byUserId: actor._id, byRole: actor.role });
  await saveAndPublish(order, actor, { action: 'RETURN', metadata: { acknowledged: true } }, 'order:returned');

  sendSuccess(res, order.toJSON(), { message: 'Return acknowledged' });
});

/** Dispatcher approves a retry: the order goes back into the READY pool. */
export const approveRetry = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!canDispatch(actor)) throw ApiError.forbidden('Only dispatchers can approve retries');

  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');

  if (!['ACTION_REQUIRED', 'RETURNING'].includes(order.status)) {
    throw ApiError.unprocessable('Only failed or returning orders can be retried', 'INVALID_STATE');
  }

  const { driverId } = req.body as { driverId?: string | null };

  order.status = 'READY';
  order.readyAt = new Date();
  order.claimedAt = null;
  order.assignedDriverId = driverId ? new Types.ObjectId(driverId) : null;
  order.assignedAt = driverId ? new Date() : null;
  order.retryCount += 1;
  order.requiresDispatcherReview = false;
  order.dispatcherReviewReason = null;

  appendTimeline(order, {
    action: 'RETRY_APPROVED',
    status: 'READY',
    byUserId: actor._id,
    byRole: actor.role,
    note: `Attempt #${order.retryCount + 1}`,
  });

  await saveAndPublish(order, actor, { action: 'STATUS_CHANGE', newValues: { status: 'READY', retryCount: order.retryCount } }, 'order:ready');
  await notifyLinkedDrivers(order);

  sendSuccess(res, order.toJSON(), { message: 'Retry approved — order is back in the Ready pool' });
});

/* ------------------------------------------------------------------ */
/* Dispatch board + tracking                                           */
/* ------------------------------------------------------------------ */

export const dispatchBoard = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!isCompanyUser(actor)) throw ApiError.forbidden('Dispatch board is company-only');

  const [pharmacies, orders, drivers] = await Promise.all([
    Pharmacy.find({ archivedAt: null }).select('name code address latitude longitude active').lean(),
    Order.find({ status: { $in: ACTIVE_ORDER_STATUSES } })
      .select(
        'referenceNumber pharmacyId status priority orderType assignedDriverId claimedAt deliveryDate timeWindowStart timeWindowEnd amountDue deliveryAddress deliveryCoordinates customerSnapshot etaAt requiresDispatcherReview retryCount failureDetails.reason readyAt onTheWayAt returningAt',
      )
      .sort({ priority: 1, deliveryDate: 1 })
      .lean(),
    User.find({ role: 'DRIVER', active: true, archivedAt: null })
      .select('firstName lastName phone driverStatus assignedPharmacyIds lastKnownLocation shiftStartedAt')
      .lean(),
  ]);

  const now = Date.now();
  const workload = new Map<string, number>();
  for (const order of orders) {
    if (!order.assignedDriverId) continue;
    const key = String(order.assignedDriverId);
    workload.set(key, (workload.get(key) ?? 0) + 1);
  }

  const enriched = orders.map((order) => {
    const windowEnd = order.timeWindowEnd
      ? new Date(`${new Date(order.deliveryDate).toISOString().slice(0, 10)}T${order.timeWindowEnd}:00Z`).getTime()
      : null;
    return {
      ...order,
      timeWindowBreached: windowEnd !== null && now > windowEnd && !['COMPLETED'].includes(order.status),
      delayed:
        order.status === 'ON_THE_WAY' &&
        order.onTheWayAt !== null &&
        now - new Date(order.onTheWayAt as Date).getTime() > 3 * 3600_000,
    };
  });

  sendSuccess(res, {
    pharmacies,
    orders: enriched,
    drivers: drivers.map((d) => ({ ...d, activeOrderCount: workload.get(String(d._id)) ?? 0 })),
    counts: {
      ready: enriched.filter((o) => o.status === 'READY').length,
      unassigned: enriched.filter((o) => o.status === 'READY' && !o.assignedDriverId).length,
      assigned: enriched.filter((o) => o.status === 'READY' && o.assignedDriverId).length,
      onTheWay: enriched.filter((o) => o.status === 'ON_THE_WAY').length,
      returning: enriched.filter((o) => o.status === 'RETURNING').length,
      urgent: enriched.filter((o) => o.priority === 'URGENT').length,
      delayed: enriched.filter((o) => o.delayed).length,
      breached: enriched.filter((o) => o.timeWindowBreached).length,
    },
  });
});

/**
 * Issues a tokenised, read-only patient tracking link. The token carries only an
 * order id; the public endpoint returns a deliberately narrow projection.
 */
export const createTrackingLink = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id).select('_id pharmacyId assignedDriverId status');
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  const token = createTrackingToken(String(order._id));
  sendSuccess(res, {
    token,
    path: `/api/v1/tracking/${token}`,
    expiresInHours: 48,
  });
});

/** Notifies the pharmacy that a driver is en route (used by ETA updates). */
export const updateEta = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  const minutes = Number((req.body as { minutes?: number }).minutes ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 720) {
    throw ApiError.badRequest('Provide an ETA between 0 and 720 minutes');
  }

  order.etaAt = new Date(Date.now() + minutes * 60_000);
  await saveAndPublish(order, actor, { action: 'UPDATE', newValues: { etaAt: order.etaAt } }, 'order:updated');

  const recipients = await pharmacyRecipients(order.pharmacyId);
  await notifyUsers({
    recipientUserIds: recipients,
    type: 'ETA_UPDATED',
    title: 'ETA updated',
    message: `${order.referenceNumber} — arriving in about ${minutes} minutes.`,
    orderId: order._id,
    pharmacyId: order.pharmacyId,
  });

  sendSuccess(res, order.toJSON(), { message: 'ETA updated' });
});

export const flagForReview = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  assertOrderReadAccess(actor, order);

  order.requiresDispatcherReview = false;
  order.dispatcherReviewReason = null;
  appendTimeline(order, { action: 'DISPATCHER_REVIEW_CLEARED', byUserId: actor._id, byRole: actor.role });
  await saveAndPublish(order, actor, { action: 'UPDATE', newValues: { requiresDispatcherReview: false } }, 'order:updated');

  const recipients = await dispatcherRecipients();
  await notifyUsers({
    recipientUserIds: recipients,
    type: 'SYSTEM',
    title: 'Review cleared',
    message: `${order.referenceNumber} no longer needs dispatcher review.`,
    orderId: order._id,
  });

  sendSuccess(res, order.toJSON(), { message: 'Review cleared' });
});
