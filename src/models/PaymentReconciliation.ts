import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import { RECONCILIATION_STATUSES, type ReconciliationStatus } from '../constants/enums';

export interface IPaymentReconciliation {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  /** Normalised to 00:00 UTC of the business day being reconciled. */
  date: Date;
  expectedAmount: number;
  submittedAmount: number;
  difference: number;
  orderCount: number;
  status: ReconciliationStatus;
  notes?: string;
  reviewerNotes?: string;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  lockedAt?: Date | null;
  breakdown: { method: string; amount: number; count: number }[];
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentReconciliationDocument = HydratedDocument<IPaymentReconciliation>;

const reconciliationSchema = new Schema<IPaymentReconciliation>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true, index: true },
    expectedAmount: { type: Number, default: 0 },
    submittedAmount: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    orderCount: { type: Number, default: 0 },
    status: { type: String, enum: RECONCILIATION_STATUSES, default: 'PENDING', index: true },
    notes: { type: String, maxlength: 800 },
    reviewerNotes: { type: String, maxlength: 800 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    breakdown: {
      type: [new Schema({ method: String, amount: Number, count: Number }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

// One reconciliation record per driver per business day.
reconciliationSchema.index({ driverId: 1, date: 1 }, { unique: true });

export const PaymentReconciliation: Model<IPaymentReconciliation> =
  (models.PaymentReconciliation as Model<IPaymentReconciliation>) ?? model<IPaymentReconciliation>('PaymentReconciliation', reconciliationSchema);
