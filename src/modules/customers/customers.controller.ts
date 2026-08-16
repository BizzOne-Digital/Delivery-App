import type { Request, Response } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { Customer, type ICustomer } from '../../models/Customer';
import { Order } from '../../models/Order';
import { RecurringOrder } from '../../models/RecurringOrder';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { escapeRegex, resolvePagination } from '../../utils/pagination';
import { recordAudit } from '../../services/audit.service';
import { requireUser } from '../../middleware/auth';
import { assertPharmacyAccess, isPharmacyUser, pharmacyScopeFor } from '../../middleware/rbac';
import { ACTIVE_ORDER_STATUSES } from '../../constants/enums';

/** Resolves which pharmacy a write should target, enforcing tenant isolation. */
function resolveTargetPharmacy(actor: ReturnType<typeof requireUser>, requested?: string | null) {
  if (isPharmacyUser(actor)) {
    if (!actor.pharmacyId) throw ApiError.forbidden('Your account is not linked to a pharmacy');
    if (requested && String(requested) !== String(actor.pharmacyId)) {
      throw ApiError.forbidden('You cannot create records for another pharmacy');
    }
    return actor.pharmacyId;
  }
  if (!requested) throw ApiError.badRequest('pharmacyId is required');
  return new Types.ObjectId(requested);
}

function normaliseAddresses(addresses: ICustomer['addresses']) {
  if (addresses.length === 0) return addresses;
  const hasDefault = addresses.some((a) => a.isDefault);
  if (!hasDefault) addresses[0]!.isDefault = true;
  // Exactly one default.
  let seen = false;
  for (const address of addresses) {
    if (address.isDefault && seen) address.isDefault = false;
    if (address.isDefault) seen = true;
  }
  return addresses;
}

export const listCustomers = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip, sort } = resolvePagination(req.query, { sort: 'lastName', order: 'asc' });
  const query = req.query as Record<string, string | undefined>;

  const filter: FilterQuery<ICustomer> = {};
  const scope = pharmacyScopeFor(actor);
  if (scope !== null) filter.pharmacyId = { $in: scope };
  else if (query.pharmacyId) filter.pharmacyId = new Types.ObjectId(query.pharmacyId);

  if (query.includeArchived !== 'true') filter.archivedAt = null;
  if (query.tag) filter.tags = query.tag;
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { phone: rx }, { email: rx }];
  }

  const [items, total] = await Promise.all([
    Customer.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter),
  ]);

  sendSuccess(res, items, { meta: buildPaginationMeta(page, limit, total) });
});

export const getCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const customer = await Customer.findById(req.params.id).lean();
  if (!customer) throw ApiError.notFound('Customer not found');
  assertPharmacyAccess(actor, customer.pharmacyId);

  const now = new Date();
  const [pastOrders, futureOrders, recurring] = await Promise.all([
    Order.find({ customerId: customer._id, status: { $in: ['COMPLETED', 'CANCELLED'] } })
      .sort({ deliveryDate: -1 })
      .limit(25)
      .lean(),
    Order.find({ customerId: customer._id, status: { $in: ACTIVE_ORDER_STATUSES } })
      .sort({ deliveryDate: 1 })
      .limit(25)
      .lean(),
    RecurringOrder.find({ customerId: customer._id, active: true }).lean(),
  ]);

  sendSuccess(res, {
    ...customer,
    pastOrders,
    futureOrders: futureOrders.filter((o) => new Date(o.deliveryDate) >= new Date(now.toDateString())),
    activeOrders: futureOrders,
    recurringOrders: recurring,
  });
});

export const createCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = req.body as Record<string, unknown>;

  const pharmacyId = resolveTargetPharmacy(actor, body.pharmacyId as string | undefined);
  assertPharmacyAccess(actor, pharmacyId);

  const customer = new Customer({
    ...body,
    email: body.email || undefined,
    pharmacyId,
    createdBy: actor._id,
  });

  normaliseAddresses(customer.addresses);
  customer.defaultAddressId = customer.addresses.find((a) => a.isDefault)?._id ?? null;
  await customer.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Customer',
    entityId: customer._id,
    action: 'CREATE',
    newValues: { name: `${customer.firstName} ${customer.lastName}`, pharmacyId },
  });

  sendSuccess(res, customer.toJSON(), { status: 201, message: 'Customer created' });
});

export const updateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
  assertPharmacyAccess(actor, customer.pharmacyId);

  const body = req.body as Record<string, unknown>;
  const before = {
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    tags: [...customer.tags],
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || key === 'pharmacyId') continue;
    (customer as unknown as Record<string, unknown>)[key] = value;
  }

  if (body.addresses) {
    normaliseAddresses(customer.addresses);
    customer.defaultAddressId = customer.addresses.find((a) => a.isDefault)?._id ?? null;
  }

  await customer.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Customer',
    entityId: customer._id,
    action: 'UPDATE',
    oldValues: before,
    newValues: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      tags: customer.tags,
    },
  });

  sendSuccess(res, customer.toJSON(), { message: 'Customer updated' });
});

/** Customers are archived, never deleted — order history must stay intact. */
export const archiveCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
  assertPharmacyAccess(actor, customer.pharmacyId);

  const openOrders = await Order.countDocuments({
    customerId: customer._id,
    status: { $in: ACTIVE_ORDER_STATUSES },
  });
  if (openOrders > 0) {
    throw ApiError.unprocessable(
      `This customer has ${openOrders} order(s) in progress. Complete or cancel them first.`,
      'CUSTOMER_HAS_ACTIVE_ORDERS',
      { openOrders },
    );
  }

  customer.active = false;
  customer.archivedAt = new Date();
  await customer.save();
  await RecurringOrder.updateMany({ customerId: customer._id }, { $set: { active: false } });

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Customer',
    entityId: customer._id,
    action: 'ARCHIVE',
  });

  sendSuccess(res, { archived: true }, { message: 'Customer archived' });
});

export const restoreCustomer = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
  assertPharmacyAccess(actor, customer.pharmacyId);

  customer.active = true;
  customer.archivedAt = null;
  await customer.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'Customer',
    entityId: customer._id,
    action: 'RESTORE',
  });

  sendSuccess(res, customer.toJSON(), { message: 'Customer restored' });
});
