/**
 * Domain enumerations shared by models, validation schemas and controllers.
 * Keep these in sync with `app/src/constants/enums.ts` on the frontend.
 */

export const ROLES = [
  'COMPANY_ADMIN',
  'DISPATCHER',
  'FINANCE',
  'PHARMACY_ADMIN',
  'PHARMACY_STAFF',
  'DRIVER',
  'READ_ONLY',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that belong to the delivery company (as opposed to a pharmacy tenant). */
export const COMPANY_ROLES: Role[] = ['COMPANY_ADMIN', 'DISPATCHER', 'FINANCE', 'READ_ONLY'];
export const PHARMACY_ROLES: Role[] = ['PHARMACY_ADMIN', 'PHARMACY_STAFF'];

export const DRIVER_STATUSES = [
  'OFFLINE',
  'AVAILABLE',
  'PICKING_UP',
  'DELIVERING',
  'RETURNING',
  'ON_BREAK',
] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const ORDER_STATUSES = [
  'ACTION_REQUIRED',
  'PREPARING',
  'READY',
  'ON_THE_WAY',
  'RETURNING',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses that still require operational attention. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'ACTION_REQUIRED',
  'PREPARING',
  'READY',
  'ON_THE_WAY',
  'RETURNING',
];

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED'];

export const ORDER_TYPES = ['DELIVERY', 'CUSTOMER_PICKUP', 'PHARMACY_TRANSFER'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_PRIORITIES = ['NORMAL', 'HIGH', 'URGENT'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export const PAYMENT_METHODS = ['CASH', 'CARD', 'CHEQUE', 'NO_PAYMENT', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FAILURE_REASONS = [
  'CUSTOMER_ABSENT',
  'CUSTOMER_REFUSED',
  'WRONG_ADDRESS',
  'UNABLE_TO_ACCESS',
  'PAYMENT_UNAVAILABLE',
  'RESCHEDULE_REQUESTED',
  'PACKAGE_DAMAGED',
  'SAFETY_ISSUE',
  'OTHER',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const RECEIVER_TYPES = [
  'CUSTOMER',
  'AUTHORIZED_RECIPIENT',
  'FAMILY_MEMBER',
  'NEIGHBOUR',
  'CARE_HOME_STAFF',
  'RECEPTION',
  'OTHER',
] as const;
export type ReceiverType = (typeof RECEIVER_TYPES)[number];

export const RECURRENCE_FREQUENCIES = [
  'DAILY',
  'WEEKLY',
  'SELECTED_WEEKDAYS',
  'MONTHLY',
  'CUSTOM_INTERVAL',
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const NOTIFICATION_TYPES = [
  'ORDER_READY',
  'ORDER_ASSIGNED',
  'ORDER_CLAIMED',
  'ORDER_ON_THE_WAY',
  'ETA_UPDATED',
  'ORDER_EDITED',
  'ORDER_COMPLETED',
  'ORDER_FAILED',
  'RETURN_STARTED',
  'RETURN_COMPLETED',
  'ORDER_CANCELLED',
  'CASH_DISCREPANCY',
  'DRIVER_GPS_OFFLINE',
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'PUSH', 'SMS', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const RECONCILIATION_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'LOCKED',
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const ASSIGNMENT_MODES = ['OPEN_POOL', 'ASSIGNED', 'HYBRID'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export const RETURN_EXCEPTION_STATUSES = ['NONE', 'OPEN', 'INVESTIGATING', 'CLOSED'] as const;
export type ReturnExceptionStatus = (typeof RETURN_EXCEPTION_STATUSES)[number];

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'ARCHIVE',
  'RESTORE',
  'LOGIN',
  'LOGOUT',
  'PASSWORD_CHANGE',
  'CREDENTIALS_RESET',
  'STATUS_CHANGE',
  'CLAIM',
  'ASSIGN',
  'UNASSIGN',
  'TRANSFER',
  'COMPLETE',
  'FAIL',
  'RETURN',
  'CANCEL',
  'RECONCILE',
  'EXPORT',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Allowed order status transitions. Enforced server-side by the order service so
 * a client cannot push an order into an impossible state.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ACTION_REQUIRED: ['PREPARING', 'READY', 'CANCELLED'],
  PREPARING: ['READY', 'ACTION_REQUIRED', 'CANCELLED'],
  READY: ['ON_THE_WAY', 'PREPARING', 'ACTION_REQUIRED', 'CANCELLED'],
  ON_THE_WAY: ['COMPLETED', 'RETURNING', 'CANCELLED'],
  RETURNING: ['ON_THE_WAY', 'ACTION_REQUIRED', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
