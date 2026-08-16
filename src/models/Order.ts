import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import {
  FAILURE_REASONS,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  RECEIVER_TYPES,
  RETURN_EXCEPTION_STATUSES,
  type FailureReason,
  type OrderPriority,
  type OrderStatus,
  type OrderType,
  type PaymentMethod,
  type ReceiverType,
  type ReturnExceptionStatus,
} from '../constants/enums';
import type { IProofConfig } from './Pharmacy';

export interface IGeoPoint {
  latitude: number;
  longitude: number;
}

export interface IManifestItem {
  _id?: Types.ObjectId;
  name: string;
  quantity: number;
  reference?: string;
  requiresColdChain?: boolean;
  controlled?: boolean;
  confirmed?: boolean;
}

/**
 * Proof of delivery. Images are stored by the upload adapter and referenced here
 * by URL + metadata — never as inline base64 blobs.
 */
export interface IProofOfDelivery {
  receiverType?: ReceiverType;
  receiverName?: string;
  receiverRelationship?: string;
  authorizedRecipientId?: Types.ObjectId | null;
  signatureUrl?: string | null;
  signatureCapturedAt?: Date | null;
  photoUrls: string[];
  photoMeta: { url: string; mimeType: string; sizeBytes: number; capturedAt: Date }[];
  manifestConfirmed: boolean;
  note?: string;
  coordinates?: IGeoPoint | null;
  capturedAt?: Date | null;
  capturedByDriverId?: Types.ObjectId | null;
}

export interface IFailureDetails {
  reason?: FailureReason;
  note?: string;
  photoUrl?: string | null;
  callAttempted: boolean;
  requestedRescheduleAt?: Date | null;
  coordinates?: IGeoPoint | null;
  failedAt?: Date | null;
  failedByDriverId?: Types.ObjectId | null;
  attemptNumber: number;
}

export interface IReturnDetails {
  receivedByName?: string;
  receivedByEmployeeCode?: string;
  signatureUrl?: string | null;
  photoUrl?: string | null;
  coordinates?: IGeoPoint | null;
  returnedAt?: Date | null;
  destinationPharmacyId?: Types.ObjectId | null;
  pharmacyAcknowledgedAt?: Date | null;
  pharmacyAcknowledgedBy?: Types.ObjectId | null;
  exceptionStatus: ReturnExceptionStatus;
  dispatcherNotes: { note: string; byUserId: Types.ObjectId; at: Date }[];
}

export interface ICancellationDetails {
  reason?: string;
  cancelledAt?: Date | null;
  cancelledBy?: Types.ObjectId | null;
  requiredReturn: boolean;
}

export interface IOrderAddressSnapshot {
  label?: string;
  line1: string;
  line2?: string;
  city?: string;
  postalCode?: string;
  accessInstructions?: string;
}

export interface ITimelineEntry {
  status?: OrderStatus;
  action: string;
  at: Date;
  byUserId?: Types.ObjectId | null;
  byRole?: string;
  note?: string;
}

export interface IOrder {
  _id: Types.ObjectId;
  referenceNumber: string;
  pharmacyId: Types.ObjectId;
  customerId?: Types.ObjectId | null;
  destinationPharmacyId?: Types.ObjectId | null;

  orderType: OrderType;
  status: OrderStatus;

  assignedDriverId?: Types.ObjectId | null;
  claimedAt?: Date | null;

  deliveryDate: Date;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  priority: OrderPriority;

  amountDue: number;
  amountCollected: number;
  paymentMethod?: PaymentMethod | null;

  orderNotes?: string;
  customerNotesSnapshot?: string;
  employeeReference?: string;

  pickupAddress: IOrderAddressSnapshot;
  deliveryAddress: IOrderAddressSnapshot;
  pickupCoordinates?: IGeoPoint | null;
  deliveryCoordinates?: IGeoPoint | null;

  customerSnapshot: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    alternatePhone?: string;
    authorizedRecipients: { name: string; relationship: string; phone?: string }[];
  };

  manifestItems: IManifestItem[];
  packageCount: number;

  recurringOrderId?: Types.ObjectId | null;
  recurrenceOccurrenceDate?: Date | null;

  proofConfigSnapshot: IProofConfig;
  proofOfDelivery?: IProofOfDelivery | null;
  failureDetails?: IFailureDetails | null;
  returnDetails?: IReturnDetails | null;
  cancellationDetails?: ICancellationDetails | null;

  // Lifecycle timestamps — one per major state change.
  createdAtStatus?: Date | null;
  preparingAt?: Date | null;
  readyAt?: Date | null;
  assignedAt?: Date | null;
  onTheWayAt?: Date | null;
  arrivedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  returningAt?: Date | null;
  returnedAt?: Date | null;
  cancelledAt?: Date | null;

  etaAt?: Date | null;
  retryCount: number;
  distanceKm?: number | null;

  requiresDispatcherReview: boolean;
  dispatcherReviewReason?: string | null;

  timeline: ITimelineEntry[];

  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<IOrder>;

const geoPointSchema = new Schema<IGeoPoint>(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

const addressSnapshotSchema = new Schema<IOrderAddressSnapshot>(
  {
    label: { type: String, trim: true },
    line1: { type: String, required: true, trim: true, maxlength: 250 },
    line2: { type: String, trim: true, maxlength: 250 },
    city: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    accessInstructions: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const manifestItemSchema = new Schema<IManifestItem>({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  quantity: { type: Number, default: 1, min: 1, max: 999 },
  reference: { type: String, trim: true, maxlength: 60 },
  requiresColdChain: { type: Boolean, default: false },
  controlled: { type: Boolean, default: false },
  confirmed: { type: Boolean, default: false },
});

const timelineEntrySchema = new Schema<ITimelineEntry>(
  {
    status: { type: String, enum: ORDER_STATUSES },
    action: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    byRole: { type: String },
    note: { type: String, maxlength: 600 },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    referenceNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    pharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    destinationPharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', default: null },

    orderType: { type: String, enum: ORDER_TYPES, default: 'DELIVERY', index: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'ACTION_REQUIRED', index: true },

    assignedDriverId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    claimedAt: { type: Date, default: null },

    deliveryDate: { type: Date, required: true, index: true },
    timeWindowStart: { type: String },
    timeWindowEnd: { type: String },
    priority: { type: String, enum: ORDER_PRIORITIES, default: 'NORMAL', index: true },

    amountDue: { type: Number, default: 0, min: 0 },
    amountCollected: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, enum: [...PAYMENT_METHODS, null], default: null },

    orderNotes: { type: String, maxlength: 1500 },
    customerNotesSnapshot: { type: String, maxlength: 1500 },
    employeeReference: { type: String, trim: true, maxlength: 60 },

    pickupAddress: { type: addressSnapshotSchema, required: true },
    deliveryAddress: { type: addressSnapshotSchema, required: true },
    pickupCoordinates: { type: geoPointSchema, default: null },
    deliveryCoordinates: { type: geoPointSchema, default: null },

    customerSnapshot: {
      firstName: String,
      lastName: String,
      phone: String,
      alternatePhone: String,
      authorizedRecipients: {
        type: [
          new Schema(
            {
              name: String,
              relationship: String,
              phone: String,
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },

    manifestItems: { type: [manifestItemSchema], default: [] },
    packageCount: { type: Number, default: 1, min: 0, max: 999 },

    recurringOrderId: { type: Schema.Types.ObjectId, ref: 'RecurringOrder', default: null, index: true },
    recurrenceOccurrenceDate: { type: Date, default: null },

    proofConfigSnapshot: {
      signatureRequired: { type: Boolean, default: true },
      photoRequired: { type: Boolean, default: false },
      receiverIdentityRequired: { type: Boolean, default: true },
      authorizedRecipientRequired: { type: Boolean, default: false },
      manifestConfirmationRequired: { type: Boolean, default: true },
    },

    proofOfDelivery: {
      type: new Schema<IProofOfDelivery>(
        {
          receiverType: { type: String, enum: RECEIVER_TYPES },
          receiverName: { type: String, trim: true, maxlength: 120 },
          receiverRelationship: { type: String, trim: true, maxlength: 60 },
          authorizedRecipientId: { type: Schema.Types.ObjectId, default: null },
          signatureUrl: { type: String, default: null },
          signatureCapturedAt: { type: Date, default: null },
          photoUrls: { type: [String], default: [] },
          photoMeta: {
            type: [
              new Schema(
                {
                  url: String,
                  mimeType: String,
                  sizeBytes: Number,
                  capturedAt: Date,
                },
                { _id: false },
              ),
            ],
            default: [],
          },
          manifestConfirmed: { type: Boolean, default: false },
          note: { type: String, maxlength: 600 },
          coordinates: { type: geoPointSchema, default: null },
          capturedAt: { type: Date, default: null },
          capturedByDriverId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    failureDetails: {
      type: new Schema<IFailureDetails>(
        {
          reason: { type: String, enum: FAILURE_REASONS },
          note: { type: String, maxlength: 600 },
          photoUrl: { type: String, default: null },
          callAttempted: { type: Boolean, default: false },
          requestedRescheduleAt: { type: Date, default: null },
          coordinates: { type: geoPointSchema, default: null },
          failedAt: { type: Date, default: null },
          failedByDriverId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          attemptNumber: { type: Number, default: 1 },
        },
        { _id: false },
      ),
      default: null,
    },

    returnDetails: {
      type: new Schema<IReturnDetails>(
        {
          receivedByName: { type: String, trim: true, maxlength: 120 },
          receivedByEmployeeCode: { type: String, trim: true, maxlength: 60 },
          signatureUrl: { type: String, default: null },
          photoUrl: { type: String, default: null },
          coordinates: { type: geoPointSchema, default: null },
          returnedAt: { type: Date, default: null },
          destinationPharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', default: null },
          pharmacyAcknowledgedAt: { type: Date, default: null },
          pharmacyAcknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          exceptionStatus: { type: String, enum: RETURN_EXCEPTION_STATUSES, default: 'NONE' },
          dispatcherNotes: {
            type: [
              new Schema(
                {
                  note: String,
                  byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
                  at: { type: Date, default: () => new Date() },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      default: null,
    },

    cancellationDetails: {
      type: new Schema<ICancellationDetails>(
        {
          reason: { type: String, maxlength: 400 },
          cancelledAt: { type: Date, default: null },
          cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          requiredReturn: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: null,
    },

    createdAtStatus: { type: Date, default: () => new Date() },
    preparingAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    assignedAt: { type: Date, default: null },
    onTheWayAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null, index: true },
    failedAt: { type: Date, default: null },
    returningAt: { type: Date, default: null },
    returnedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    etaAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    distanceKm: { type: Number, default: null },

    requiresDispatcherReview: { type: Boolean, default: false, index: true },
    dispatcherReviewReason: { type: String, default: null },

    timeline: { type: [timelineEntrySchema], default: [] },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    // Mongoose optimistic concurrency: a save() on a stale doc throws VersionError.
    optimisticConcurrency: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Query patterns the app actually uses.
orderSchema.index({ pharmacyId: 1, status: 1, deliveryDate: -1 });
orderSchema.index({ status: 1, assignedDriverId: 1 });
orderSchema.index({ assignedDriverId: 1, status: 1, deliveryDate: -1 });
orderSchema.index({ pharmacyId: 1, createdAt: -1 });
orderSchema.index({ referenceNumber: 'text' });

export const Order: Model<IOrder> =
  (models.Order as Model<IOrder>) ?? model<IOrder>('Order', orderSchema);
