import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { COMPANY_ROLES, PHARMACY_ROLES, type Role } from '../constants/enums';
import { ApiError } from '../utils/ApiError';
import type { UserDocument } from '../models/User';

/**
 * Route-level role gate. This is the real security boundary — the frontend also
 * hides controls, but that is cosmetic only.
 */
export function requireRoles(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Your role does not permit this action'));
    }
    next();
  };
}

/** READ_ONLY may never mutate anything, whatever else a route allows. */
export function denyReadOnlyWrites(req: Request, _res: Response, next: NextFunction) {
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isWrite && req.user?.role === 'READ_ONLY') {
    return next(ApiError.forbidden('Read-only accounts cannot modify data'));
  }
  next();
}

export const isCompanyUser = (user: UserDocument) => COMPANY_ROLES.includes(user.role);
export const isPharmacyUser = (user: UserDocument) => PHARMACY_ROLES.includes(user.role);
export const isDriver = (user: UserDocument) => user.role === 'DRIVER';
export const isAdmin = (user: UserDocument) => user.role === 'COMPANY_ADMIN';
export const canDispatch = (user: UserDocument) =>
  user.role === 'COMPANY_ADMIN' || user.role === 'DISPATCHER';
export const canReviewFinance = (user: UserDocument) =>
  user.role === 'COMPANY_ADMIN' || user.role === 'FINANCE';

/**
 * Pharmacy-level data isolation.
 *
 * - Company roles see every pharmacy.
 * - Pharmacy roles are hard-scoped to their own `pharmacyId`.
 * - Drivers are scoped to the pharmacies an admin has linked them to.
 *
 * Returns `null` when the caller may see all pharmacies, otherwise the id list to
 * constrain the query with.
 */
export function pharmacyScopeFor(user: UserDocument): Types.ObjectId[] | null {
  if (isCompanyUser(user)) return null;
  if (isPharmacyUser(user)) return user.pharmacyId ? [user.pharmacyId] : [];
  if (isDriver(user)) return user.assignedPharmacyIds ?? [];
  return [];
}

/** Throws unless the caller is allowed to act on the given pharmacy. */
export function assertPharmacyAccess(user: UserDocument, pharmacyId: Types.ObjectId | string): void {
  const scope = pharmacyScopeFor(user);
  if (scope === null) return;
  const target = String(pharmacyId);
  if (!scope.some((id) => String(id) === target)) {
    throw ApiError.forbidden('You do not have access to this pharmacy');
  }
}

/** Builds the `pharmacyId` filter fragment for list queries. */
export function pharmacyFilterFor(user: UserDocument): Record<string, unknown> {
  const scope = pharmacyScopeFor(user);
  if (scope === null) return {};
  return { pharmacyId: { $in: scope } };
}
