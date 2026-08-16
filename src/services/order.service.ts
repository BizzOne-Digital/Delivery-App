import { Types, type FilterQuery } from 'mongoose';
import { Order, type IOrder, type OrderDocument } from '../models/Order';
import { Customer } from '../models/Customer';
import { Pharmacy, DEFAULT_PROOF_CONFIG } from '../models/Pharmacy';
import { User, type UserDocument } from '../models/User';
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from '../constants/enums';
import { ApiError } from '../utils/ApiError';
import { generateOrderReference } from '../utils/reference';
import { haversineKm, isValidCoordinate } from '../utils/geo';
import { recordAudit } from './audit.service';
import { emitTo, rooms } from '../realtime/io';
import { isCompanyUser, isDriver, isPharmacyUser } from '../middleware/rbac';

/** Fields a pharmacy may still edit freely once a driver owns the order. */
const SAFE_FIELDS_AFTER_CLAIM = ['orderNotes', 'priority'];
/** Fields that are locked outright once a driver owns the order. */
const LOCKED_FIELDS_AFTER_CLAIM = ['deliveryDate', 'orderType', 'pharmacyId'];
/** Fields whose change forces a dispatcher review + route recalculation. */
const REVIEW_TRIGGER_FIELDS = ['deliveryAddress', 'deliveryCoordinates', 'timeWindowStart', 'timeWindowEnd'];

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return;
  const allowed = ORDER_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.unprocessable(
      `An order cannot move from ${from} to ${to}.`,
      'INVALID_STATUS_TRANSITION',
    );
  }
}

export function appendTimeline(
  order: OrderDocument,
  entry: { action: string; status?: OrderStatus; byUserId?: Types.ObjectId | string | null; byRole?: string; note?: string },
): void {
  order.timeline.push({
    action: entry.action,
    status: entry.status ?? order.status,
    at: new Date(),
    byUserId: entry.byUserId ? new Types.ObjectId(String(entry.byUserId)) : null,
    byRole: entry.byRole,
    note: entry.note,
  });
  if (order.timeline.length > 200) order.timeline = order.timeline.slice(-200);
}

/** Stamps the timestamp field that corresponds to a status. */
export function stampStatusTimestamp(order: OrderDocument, status: OrderStatus): void {
  const now = new Date();
  const map: Partial<Record<OrderStatus, keyof IOrder>> = {
    PREPARING: 'preparingAt',
    READY: 'readyAt',
    ON_THE_WAY: 'onTheWayAt',
    COMPLETED: 'completedAt',
    RETURNING: 'returningAt',
    CANCELLED: 'cancelledAt',
  };
  const field = map[status];
  if (field) (order as unknown as Record<string, unknown>)[field] = now;
}

/** Reference numbers are unique; retry a few times on the (unlikely) collision. */
export async function generateUniqueReference(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const reference = generateOrderReference();
    const exists = await Order.exists({ referenceNumber: reference });
    if (!exists) return reference;
  }
  throw ApiError.internal('Could not allocate an order reference. Please retry.');
}

/**
 * Builds the immutable snapshots an order carries: customer contact details,
 * addresses, coordinates and the pharmacy's proof rules at time of creation.
 * Snapshotting means later edits to a customer record never rewrite history.
 */
export async function buildOrderSnapshots(input: {
  pharmacyId: string;
  customerId?: string | null;
  addressId?: string | null;
  destinationPharmacyId?: string | null;
  orderType: string;
}) {
  const pharmacy = await Pharmacy.findById(input.pharmacyId);
  if (!pharmacy) throw ApiError.notFound('Pharmacy not found');
  if (!pharmacy.active || pharmacy.archivedAt) {
    throw ApiError.unprocessable(
      'This pharmacy is inactive and cannot create new orders.',
      'PHARMACY_INACTIVE',
    );
  }

  const pickupAddress = {
    label: pharmacy.name,
    line1: pharmacy.address,
    city: pharmacy.city,
    postalCode: pharmacy.postalCode,
    accessInstructions: pharmacy.pickupInstructions,
  };
  const pickupCoordinates = { latitude: pharmacy.latitude, longitude: pharmacy.longitude };

  // Pharmacy-to-pharmacy transfer: destination is another pharmacy, not a customer.
  if (input.orderType === 'PHARMACY_TRANSFER') {
    if (!input.destinationPharmacyId) {
      throw ApiError.badRequest('A destination pharmacy is required for transfers');
    }
    const destination = await Pharmacy.findById(input.destinationPharmacyId);
    if (!destination) throw ApiError.notFound('Destination pharmacy not found');
    return {
      pharmacy,
      customer: null,
      pickupAddress,
      pickupCoordinates,
      deliveryAddress: {
        label: destination.name,
        line1: destination.address,
        city: destination.city,
        postalCode: destination.postalCode,
      },
      deliveryCoordinates: { latitude: destination.latitude, longitude: destination.longitude },
      customerSnapshot: { authorizedRecipients: [] },
      customerNotesSnapshot: '',
    };
  }

  if (!input.customerId) throw ApiError.badRequest('A customer is required for this order type');
  const customer = await Customer.findOne({
    _id: input.customerId,
    pharmacyId: pharmacy._id,
  });
  if (!customer) throw ApiError.notFound('Customer not found for this pharmacy');

  const address =
    customer.addresses.find((a) => String(a._id) === String(input.addressId)) ??
    customer.addresses.find((a) => String(a._id) === String(customer.defaultAddressId)) ??
    customer.addresses.find((a) => a.isDefault) ??
    customer.addresses[0];

  if (!address) throw ApiError.badRequest('This customer has no saved address');

  const deliveryAddress = {
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    postalCode: address.postalCode,
    accessInstructions: address.accessInstructions ?? customer.accessInstructions,
  };
  const deliveryCoordinates = isValidCoordinate({
    latitude: address.latitude ?? undefined,
    longitude: address.longitude ?? undefined,
  })
    ? { latitude: address.latitude as number, longitude: address.longitude as number }
    : null;

  // A customer pickup travels from the customer to the pharmacy.
  const isPickup = input.orderType === 'CUSTOMER_PICKUP';

  return {
    pharmacy,
    customer,
    pickupAddress: isPickup ? deliveryAddress : pickupAddress,
    pickupCoordinates: isPickup ? deliveryCoordinates : pickupCoordinates,
    deliveryAddress: isPickup ? pickupAddress : deliveryAddress,
    deliveryCoordinates: isPickup ? pickupCoordinates : deliveryCoordinates,
    customerSnapshot: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      alternatePhone: customer.alternatePhone,
      authorizedRecipients: customer.authorizedRecipients.map((r) => ({
        name: r.name,
        relationship: r.relationship,
        phone: r.phone,
      })),
    },
    customerNotesSnapshot: customer.deliveryNotes ?? '',
    proofConfig: pharmacy.proofConfig ?? DEFAULT_PROOF_CONFIG,
  };
}

/**
 * ATOMIC ORDER CLAIM.
 *
 * The filter requires the order to still be READY *and* unclaimed (or already
 * pre-assigned to this driver). MongoDB applies findOneAndUpdate atomically at
 * the document level, so when two drivers race, exactly one matches the filter
 * and the other gets `null` back — no transaction and no read-then-write gap.
 */
export async function claimOrderAtomically(
  orderId: string,
  driver: UserDocument,
): Promise<OrderDocument> {
  const driverId = driver._id;
  const now = new Date();

  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: 'READY',
      claimedAt: null,
      $or: [{ assignedDriverId: null }, { assignedDriverId: driverId }],
    },
    {
      $set: {
        assignedDriverId: driverId,
        claimedAt: now,
        status: 'ON_THE_WAY',
        onTheWayAt: now,
        updatedBy: driverId,
      },
      $inc: { version: 1 },
      $push: {
        timeline: {
          action: 'DRIVER_TOOK_OWNERSHIP',
          status: 'ON_THE_WAY',
          at: now,
          byUserId: driverId,
          byRole: 'DRIVER',
        },
      },
    },
    { new: true },
  );

  if (claimed) return claimed;

  // The claim failed — work out why so the driver gets a useful message.
  const current = await Order.findById(orderId).select(
    'status assignedDriverId referenceNumber claimedAt',
  );
  if (!current) throw ApiError.notFound('That order no longer exists');

  if (current.assignedDriverId && String(current.assignedDriverId) !== String(driverId)) {
    const other = await User.findById(current.assignedDriverId).select('firstName lastName');
    const name = other ? `${other.firstName} ${other.lastName}` : 'another driver';
    throw ApiError.conflict(
      `${name} took this order first. Your list has been refreshed.`,
      'ORDER_ALREADY_CLAIMED',
      { orderId, referenceNumber: current.referenceNumber, status: current.status },
    );
  }

  if (current.status !== 'READY') {
    throw ApiError.conflict(
      `This order is no longer available (it is now ${current.status.replace(/_/g, ' ').toLowerCase()}).`,
      'ORDER_NOT_READY',
      { orderId, referenceNumber: current.referenceNumber, status: current.status },
    );
  }

  throw ApiError.conflict('This order could not be claimed. Please refresh and try again.', 'CLAIM_FAILED');
}

/**
 * Visibility rules for a driver's Ready screen, honouring each pharmacy's
 * assignment mode:
 *   OPEN_POOL — any linked driver sees unassigned READY orders.
 *   ASSIGNED  — only the pre-assigned driver sees the order.
 *   HYBRID    — assigned-to-me orders plus the open pool (default).
 */
export async function buildDriverReadyFilter(driver: UserDocument): Promise<FilterQuery<IOrder>> {
  const assignedPharmacyIds = driver.assignedPharmacyIds ?? [];
  if (assignedPharmacyIds.length === 0) return { _id: { $in: [] } };

  const pharmacies = await Pharmacy.find({
    _id: { $in: assignedPharmacyIds },
    active: true,
    archivedAt: null,
  })
    .select('_id assignmentMode linkedDriverIds')
    .lean();

  const clauses: FilterQuery<IOrder>[] = [];

  for (const pharmacy of pharmacies) {
    const linked = (pharmacy.linkedDriverIds ?? []).some(
      (id: Types.ObjectId) => String(id) === String(driver._id),
    );
    const mode = pharmacy.assignmentMode ?? 'HYBRID';

    if (mode === 'ASSIGNED') {
      clauses.push({ pharmacyId: pharmacy._id, assignedDriverId: driver._id });
    } else if (mode === 'OPEN_POOL') {
      if (linked) clauses.push({ pharmacyId: pharmacy._id, assignedDriverId: null });
    } else {
      // HYBRID
      const hybrid: FilterQuery<IOrder>[] = [
        { pharmacyId: pharmacy._id, assignedDriverId: driver._id },
      ];
      if (linked) hybrid.push({ pharmacyId: pharmacy._id, assignedDriverId: null });
      clauses.push({ $or: hybrid });
    }
  }

  if (clauses.length === 0) return { _id: { $in: [] } };
  return { status: 'READY', claimedAt: null, $or: clauses };
}

/**
 * The id behind a reference field, whether or not it has been populated.
 *
 * `populate()` swaps an ObjectId for a full document, and `String(document)` is
 * not the id — so comparing raw `String(...)` silently fails on any route that
 * populates. Access checks must never depend on how the caller happened to
 * build the query, so every id comparison below goes through this.
 */
function refId(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === 'object' && '_id' in (value as { _id?: unknown })) {
    return String((value as { _id?: unknown })._id ?? '');
  }
  return String(value);
}

/** Throws unless the caller may read this specific order. */
export function assertOrderReadAccess(user: UserDocument, order: OrderDocument): void {
  if (isCompanyUser(user)) return;

  if (isPharmacyUser(user)) {
    const scope = refId(user.pharmacyId);
    // A user with no pharmacy has no scope — never let "" match "".
    const own =
      scope !== '' &&
      (refId(order.pharmacyId) === scope || refId(order.destinationPharmacyId) === scope);
    if (!own) throw ApiError.forbidden('This order belongs to a different pharmacy');
    return;
  }

  if (isDriver(user)) {
    const mine = refId(order.assignedDriverId) === refId(user._id);
    const inPool =
      order.status === 'READY' &&
      !order.assignedDriverId &&
      (user.assignedPharmacyIds ?? []).some((id) => refId(id) === refId(order.pharmacyId));
    if (!mine && !inPool) throw ApiError.forbidden('This order is not assigned to you');
    return;
  }

  throw ApiError.forbidden('You do not have access to this order');
}

/**
 * Applies a pharmacy-side edit, enforcing the post-ownership rules:
 * locked fields are rejected, address/time-window changes flag the order for
 * dispatcher review, and everyone involved is told what changed.
 */
export function applyEditRules(
  order: OrderDocument,
  changedFields: string[],
): { requiresReview: boolean; reviewReason: string | null; notifyDriver: boolean } {
  const driverOwns = Boolean(order.claimedAt && order.assignedDriverId);
  if (!driverOwns) return { requiresReview: false, reviewReason: null, notifyDriver: false };

  const locked = changedFields.filter((f) => LOCKED_FIELDS_AFTER_CLAIM.includes(f));
  if (locked.length > 0) {
    throw ApiError.unprocessable(
      `A driver already has this package. These fields can no longer be changed: ${locked.join(', ')}. ` +
        'Cancel the order (it will be returned to the pharmacy) and raise a new one instead.',
      'FIELD_LOCKED_AFTER_CLAIM',
      { lockedFields: locked },
    );
  }

  const reviewFields = changedFields.filter((f) => REVIEW_TRIGGER_FIELDS.includes(f));
  const criticalFields = changedFields.filter((f) => !SAFE_FIELDS_AFTER_CLAIM.includes(f));

  return {
    requiresReview: reviewFields.length > 0,
    reviewReason:
      reviewFields.length > 0
        ? `Changed after driver took ownership: ${reviewFields.join(', ')}. Route needs recalculation.`
        : null,
    notifyDriver: criticalFields.length > 0,
  };
}

/** Distance from the pharmacy to the delivery point, when both are known. */
export function computeOrderDistanceKm(order: OrderDocument): number | null {
  if (!isValidCoordinate(order.pickupCoordinates) || !isValidCoordinate(order.deliveryCoordinates)) {
    return null;
  }
  return Math.round(haversineKm(order.pickupCoordinates, order.deliveryCoordinates) * 100) / 100;
}

/** Broadcasts an order change to everyone entitled to see it. */
export function broadcastOrder(
  order: OrderDocument,
  event:
    | 'order:created'
    | 'order:updated'
    | 'order:ready'
    | 'order:assigned'
    | 'order:claimed'
    | 'order:completed'
    | 'order:failed'
    | 'order:returning'
    | 'order:returned'
    | 'order:cancelled',
): void {
  // refId, not String(): these fields are populated on some routes, and a
  // populated document stringifies to something that is not a room name.
  const targets = [
    rooms.company(),
    rooms.pharmacy(refId(order.pharmacyId)),
    rooms.order(refId(order._id)),
  ];
  if (order.destinationPharmacyId) targets.push(rooms.pharmacy(refId(order.destinationPharmacyId)));
  if (order.assignedDriverId) targets.push(rooms.driver(refId(order.assignedDriverId)));
  emitTo(targets, event, order.toJSON());
}

/** Convenience wrapper: persist + audit + broadcast in one call. */
export async function saveAndPublish(
  order: OrderDocument,
  actor: UserDocument | null,
  audit: { action: Parameters<typeof recordAudit>[0]['action']; oldValues?: Record<string, unknown>; newValues?: Record<string, unknown>; metadata?: Record<string, unknown> },
  event: Parameters<typeof broadcastOrder>[1],
): Promise<OrderDocument> {
  order.version += 1;
  if (actor) order.updatedBy = actor._id;
  await order.save();

  await recordAudit({
    actorId: actor?._id ?? null,
    actorRole: actor?.role ?? 'SYSTEM',
    entityType: 'Order',
    entityId: order._id,
    action: audit.action,
    oldValues: audit.oldValues ?? null,
    newValues: audit.newValues ?? null,
    metadata: { referenceNumber: order.referenceNumber, ...audit.metadata },
  });

  broadcastOrder(order, event);
  return order;
}
