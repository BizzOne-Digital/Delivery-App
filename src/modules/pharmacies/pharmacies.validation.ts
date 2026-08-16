import { z } from 'zod';
import { ASSIGNMENT_MODES, NOTIFICATION_CHANNELS } from '../../constants/enums';
import { objectId } from '../users/users.validation';

const openingHoursSchema = z.object({
  day: z.number().int().min(0).max(6),
  open: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').default('09:00'),
  close: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').default('18:00'),
  closed: z.boolean().default(false),
});

const proofConfigSchema = z.object({
  signatureRequired: z.boolean(),
  photoRequired: z.boolean(),
  receiverIdentityRequired: z.boolean(),
  authorizedRecipientRequired: z.boolean(),
  manifestConfirmationRequired: z.boolean(),
});

const notificationRulesSchema = z.object({
  notifyOnReady: z.boolean(),
  notifyOnClaimed: z.boolean(),
  notifyOnOnTheWay: z.boolean(),
  notifyOnCompleted: z.boolean(),
  notifyOnFailed: z.boolean(),
  notifyOnReturn: z.boolean(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
});

export const createPharmacySchema = z.object({
  name: z.string().trim().min(2).max(140),
  code: z.string().trim().min(2).max(16).optional(),
  logo: z.string().trim().max(500).nullable().optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  phone: z.string().trim().max(32).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  address: z.string().trim().min(4).max(300),
  city: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(24).optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  openingHours: z.array(openingHoursSchema).max(7).optional(),
  deliveryStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  pickupInstructions: z.string().trim().max(1000).optional(),
  serviceZones: z.array(z.string().trim().max(60)).max(50).optional(),
  linkedDriverIds: z.array(objectId).max(200).optional(),
  assignmentMode: z.enum(ASSIGNMENT_MODES).optional(),
  proofConfig: proofConfigSchema.partial().optional(),
  notificationRules: notificationRulesSchema.partial().optional(),
  active: z.boolean().optional(),
});

export const updatePharmacySchema = createPharmacySchema.partial();

export const listPharmaciesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  active: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(120).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

export const toggleActiveSchema = z.object({
  active: z.boolean(),
  /** Set when an admin deliberately overrides the active-orders guard. */
  force: z.boolean().optional().default(false),
});

export const linkDriversSchema = z.object({
  driverIds: z.array(objectId).max(200),
});
