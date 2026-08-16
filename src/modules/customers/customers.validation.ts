import { z } from 'zod';
import { objectId } from '../users/users.validation';

export const addressSchema = z.object({
  _id: objectId.optional(),
  label: z.string().trim().max(60).default('Home'),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(24).optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  accessInstructions: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional().default(false),
});

export const authorizedRecipientSchema = z.object({
  _id: objectId.optional(),
  name: z.string().trim().min(2).max(120),
  relationship: z.string().trim().max(60).default('OTHER'),
  phone: z.string().trim().max(32).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const createCustomerSchema = z.object({
  pharmacyId: objectId.optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(5).max(32),
  alternatePhone: z.string().trim().max(32).optional(),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  preferredLanguage: z.string().trim().min(2).max(10).optional(),
  addresses: z.array(addressSchema).min(1, 'At least one address is required').max(10),
  deliveryNotes: z.string().trim().max(1000).optional(),
  accessInstructions: z.string().trim().max(1000).optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  authorizedRecipients: z.array(authorizedRecipientSchema).max(10).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  active: z.boolean().optional(),
});

export const listCustomersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  search: z.string().trim().max(120).optional(),
  pharmacyId: objectId.optional(),
  tag: z.string().trim().max(40).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});
