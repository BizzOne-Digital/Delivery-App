import type { UserDocument } from '../models/User';
import { COMPANY_ROLES } from '../constants/enums';

export const rooms = {
  /** Every delivery-company employee (admin, dispatcher, finance, read-only). */
  company: () => 'company',
  pharmacy: (pharmacyId: string) => `pharmacy:${pharmacyId}`,
  driver: (driverId: string) => `driver:${driverId}`,
  order: (orderId: string) => `order:${orderId}`,
  user: (userId: string) => `user:${userId}`,
};

/**
 * The rooms a connecting socket is allowed to join, derived from the
 * authenticated user — never from anything the client sends.
 */
export function roomsForUser(user: UserDocument): string[] {
  const joined = [rooms.user(String(user._id))];

  if (COMPANY_ROLES.includes(user.role)) {
    joined.push(rooms.company());
  }
  if (user.pharmacyId) {
    joined.push(rooms.pharmacy(String(user.pharmacyId)));
  }
  if (user.role === 'DRIVER') {
    joined.push(rooms.driver(String(user._id)));
    for (const id of user.assignedPharmacyIds ?? []) joined.push(rooms.pharmacy(String(id)));
  }
  return [...new Set(joined)];
}
