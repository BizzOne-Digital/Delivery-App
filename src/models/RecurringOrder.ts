import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import {
  ORDER_PRIORITIES,
  ORDER_TYPES,
  RECURRENCE_FREQUENCIES,
  type OrderPriority,
  type OrderType,
  type RecurrenceFrequency,
} from '../constants/enums';
import type { IManifestItem } from './Order';

export interface IRecurringOrder {
  _id: Types.ObjectId;
  pharmacyId: Types.ObjectId;
  customerId: Types.ObjectId;
  orderType: OrderType;
  frequency: RecurrenceFrequency;
  /** For SELECTED_WEEKDAYS: 0 = Sunday .. 6 = Saturday. */
  weekdays: number[];
  /** For MONTHLY: day of month. For CUSTOM_INTERVAL: number of days between runs. */
  dayOfMonth?: number | null;
  intervalDays?: number | null;
  startDate: Date;
  endDate?: Date | null;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  priority: OrderPriority;
  amountDue: number;
  packageCount: number;
  manifestItems: IManifestItem[];
  orderNotes?: string;
  addressId?: Types.ObjectId | null;
  active: boolean;
  /** Occurrence dates (YYYY-MM-DD) explicitly cancelled by pharmacy staff. */
  skippedDates: string[];
  lastGeneratedDate?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RecurringOrderDocument = HydratedDocument<IRecurringOrder>;

const recurringOrderSchema = new Schema<IRecurringOrder>(
  {
    pharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    orderType: { type: String, enum: ORDER_TYPES, default: 'DELIVERY' },
    frequency: { type: String, enum: RECURRENCE_FREQUENCIES, required: true },
    weekdays: { type: [Number], default: [] },
    dayOfMonth: { type: Number, default: null, min: 1, max: 31 },
    intervalDays: { type: Number, default: null, min: 1, max: 365 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    timeWindowStart: { type: String },
    timeWindowEnd: { type: String },
    priority: { type: String, enum: ORDER_PRIORITIES, default: 'NORMAL' },
    amountDue: { type: Number, default: 0, min: 0 },
    packageCount: { type: Number, default: 1 },
    manifestItems: { type: Schema.Types.Mixed, default: [] },
    orderNotes: { type: String, maxlength: 1000 },
    addressId: { type: Schema.Types.ObjectId, default: null },
    active: { type: Boolean, default: true, index: true },
    skippedDates: { type: [String], default: [] },
    lastGeneratedDate: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

export const RecurringOrder: Model<IRecurringOrder> =
  (models.RecurringOrder as Model<IRecurringOrder>) ?? model<IRecurringOrder>('RecurringOrder', recurringOrderSchema);
