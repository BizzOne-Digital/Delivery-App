import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(160)
  .email('Enter a valid email address');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Refresh token is required'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
  allDevices: z.boolean().optional().default(false),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'Choose a password different from your current one',
    path: ['newPassword'],
  });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10, 'Reset token is required'),
  newPassword: passwordSchema,
});

/**
 * Public self-registration. Only two account types can be created this way;
 * company roles (admin, dispatcher, finance) are always created by an existing
 * company admin, so they are deliberately not accepted here.
 */
export const registerSchema = z
  .object({
    accountType: z.enum(['PHARMACY', 'DRIVER']),
    fullName: z.string().trim().min(2, 'Enter your full name').max(160),
    email: emailSchema,
    phone: z.string().trim().min(5, 'Enter your phone number').max(32),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your password'),
    /** Required when accountType is PHARMACY — becomes the pharmacy's name. */
    pharmacyName: z.string().trim().min(2).max(140).optional(),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy' }),
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.accountType !== 'PHARMACY' || Boolean(data.pharmacyName), {
    message: 'Enter your pharmacy name',
    path: ['pharmacyName'],
  });

export const pushTokenSchema = z.object({
  pushToken: z.string().min(4).max(300).nullable(),
});

export type LoginInput = z.infer<typeof loginSchema>;
