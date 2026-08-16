import { z } from 'zod';
import {
  FAILURE_REASONS,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  RECEIVER_TYPES,
  RECURRENCE_FREQUENCIES,
  RETURN_EXCEPTION_STATUSES,
} from '../../constants/enums';
import { objectId } from '../users/users.validation';

const timeString = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm');

export const manifestItemSchema = z.object({
  name: z.string().trim().min(1).max(160),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  reference: z.string().trim().max(60).optional(),
  requiresColdChain: z.boolean().optional().default(false),
  controlled: z.boolean().optional().default(false),
});

export const createOrderSchema = z
  .object({
    pharmacyId: objectId.optional(),
    customerId: objectId.nullable().optional(),
    destinationPharmacyId: objectId.nullable().optional(),
    addressId: objectId.nullable().optional(),

    orderType: z.enum(ORDER_TYPES).default('DELIVERY'),
    /** Only ACTION_REQUIRED, PREPARING or READY may be set at creation time. */
    initialStatus: z.enum(['ACTION_REQUIRED', 'PREPARING', 'READY']).default('ACTION_REQUIRED'),

    deliveryDate: z.coerce.date(),
    timeWindowStart: timeString.optional(),
    timeWindowEnd: timeString.optional(),
    priority: z.enum(ORDER_PRIORITIES).default('NORMAL'),

    amountDue: z.coerce.number().min(0).max(100000).default(0),
    packageCount: z.coerce.number().int().min(0).max(999).default(1),

    orderNotes: z.string().trim().max(1500).optional(),
    employeeReference: z.string().trim().max(60).optional(),

    manifestItems: z.array(manifestItemSchema).max(60).optional().default([]),
    assignedDriverId: objectId.nullable().optional(),

    proofConfig: z
      .object({
        signatureRequired: z.boolean(),
        photoRequired: z.boolean(),
        receiverIdentityRequired: z.boolean(),
        authorizedRecipientRequired: z.boolean(),
        manifestConfirmationRequired: z.boolean(),
      })
      .partial()
      .optional(),

    recurrence: z
      .object({
        frequency: z.enum(RECURRENCE_FREQUENCIES),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
        dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
        intervalDays: z.number().int().min(1).max(365).nullable().optional(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date().nullable().optional(),
      })
      .optional(),
  })
  .refine(
    (data) =>
      !data.timeWindowStart || !data.timeWindowEnd || data.timeWindowStart < data.timeWindowEnd,
    { message: 'The time window must end after it starts', path: ['timeWindowEnd'] },
  );

export const updateOrderSchema = z.object({
  customerId: objectId.optional(),
  addressId: objectId.optional(),
  deliveryDate: z.coerce.date().optional(),
  timeWindowStart: timeString.nullable().optional(),
  timeWindowEnd: timeString.nullable().optional(),
  priority: z.enum(ORDER_PRIORITIES).optional(),
  amountDue: z.coerce.number().min(0).max(100000).optional(),
  packageCount: z.coerce.number().int().min(0).max(999).optional(),
  orderNotes: z.string().trim().max(1500).nullable().optional(),
  employeeReference: z.string().trim().max(60).nullable().optional(),
  manifestItems: z.array(manifestItemSchema).max(60).optional(),
  orderType: z.enum(ORDER_TYPES).optional(),
});

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  status: z.string().optional(),
  orderType: z.string().optional(),
  priority: z.string().optional(),
  pharmacyId: objectId.optional(),
  customerId: objectId.optional(),
  driverId: objectId.optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(120).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  requiresReview: z.enum(['true', 'false']).optional(),
});

export const statusChangeSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(600).optional(),
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3).max(400),
});

export const claimBatchSchema = z.object({
  orderIds: z.array(objectId).min(1).max(50),
});

export const completeOrderSchema = z.object({
  receiverType: z.enum(RECEIVER_TYPES),
  receiverName: z.string().trim().max(120).optional(),
  receiverRelationship: z.string().trim().max(60).optional(),
  authorizedRecipientId: objectId.nullable().optional(),
  signatureUrl: z.string().trim().max(600).nullable().optional(),
  photoUrls: z.array(z.string().trim().max(600)).max(4).optional().default([]),
  manifestConfirmed: z.boolean().default(false),
  amountCollected: z.coerce.number().min(0).max(100000).default(0),
  paymentMethod: z.enum(PAYMENT_METHODS),
  note: z.string().trim().max(600).optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

export const failOrderSchema = z.object({
  reason: z.enum(FAILURE_REASONS),
  note: z.string().trim().max(600).optional(),
  photoUrl: z.string().trim().max(600).nullable().optional(),
  callAttempted: z.boolean().default(false),
  requestedRescheduleAt: z.coerce.date().nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

export const returnToPharmacySchema = z.object({
  receivedByName: z.string().trim().min(2).max(120),
  receivedByEmployeeCode: z.string().trim().max(60).optional(),
  signatureUrl: z.string().trim().max(600).nullable().optional(),
  photoUrl: z.string().trim().max(600).nullable().optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

export const assignOrderSchema = z.object({
  driverId: objectId.nullable(),
  note: z.string().trim().max(300).optional(),
});

export const batchAssignSchema = z.object({
  orderIds: z.array(objectId).min(1).max(100),
  driverId: objectId,
});

export const exceptionSchema = z.object({
  exceptionStatus: z.enum(RETURN_EXCEPTION_STATUSES).optional(),
  note: z.string().trim().max(600).optional(),
});

export const recurringUpdateScopeSchema = z.object({
  scope: z.enum(['THIS_OCCURRENCE', 'FUTURE_OCCURRENCES']).default('THIS_OCCURRENCE'),
});

export const createRecurringSchema = z.object({
  pharmacyId: objectId.optional(),
  customerId: objectId,
  orderType: z.enum(ORDER_TYPES).default('DELIVERY'),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  timeWindowStart: timeString.optional(),
  timeWindowEnd: timeString.optional(),
  priority: z.enum(ORDER_PRIORITIES).default('NORMAL'),
  amountDue: z.coerce.number().min(0).default(0),
  packageCount: z.coerce.number().int().min(0).max(999).default(1),
  manifestItems: z.array(manifestItemSchema).max(60).default([]),
  orderNotes: z.string().trim().max(1000).optional(),
  addressId: objectId.nullable().optional(),
});
