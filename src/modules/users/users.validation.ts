import { z } from 'zod';
import { DRIVER_STATUSES, ROLES } from '../../constants/enums';
import { emailSchema, passwordSchema } from '../auth/auth.validation';

export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

export const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  phone: z.string().trim().max(32).optional(),
  password: passwordSchema,
  role: z.enum(ROLES),
  pharmacyId: objectId.nullable().optional(),
  assignedPharmacyIds: z.array(objectId).max(100).optional().default([]),
  employeeCode: z.string().trim().max(32).optional(),
  active: z.boolean().optional().default(true),
});

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  email: emailSchema.optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  role: z.enum(ROLES).optional(),
  pharmacyId: objectId.nullable().optional(),
  assignedPharmacyIds: z.array(objectId).max(100).optional(),
  employeeCode: z.string().trim().max(32).nullable().optional(),
  active: z.boolean().optional(),
  driverStatus: z.enum(DRIVER_STATUSES).optional(),
});

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  role: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  pharmacyId: objectId.optional(),
  search: z.string().trim().max(120).optional(),
});

export const resetCredentialsSchema = z.object({
  newPassword: passwordSchema.optional(),
});

export const updatePreferencesSchema = z.object({
  themePreference: z.enum(['system', 'light', 'dark']).optional(),
  preferredMapApp: z.enum(['GOOGLE', 'APPLE', 'WAZE']).optional(),
  languagePreference: z.string().trim().min(2).max(10).optional(),
  phone: z.string().trim().max(32).optional(),
});

export const idParamSchema = z.object({ id: objectId });
