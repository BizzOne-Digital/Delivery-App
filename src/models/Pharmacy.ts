import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import { ASSIGNMENT_MODES, type AssignmentMode } from '../constants/enums';

/** Per-pharmacy proof-of-delivery requirements enforced by the completion flow. */
export interface IProofConfig {
  signatureRequired: boolean;
  photoRequired: boolean;
  receiverIdentityRequired: boolean;
  authorizedRecipientRequired: boolean;
  manifestConfirmationRequired: boolean;
}

export interface INotificationRules {
  notifyOnReady: boolean;
  notifyOnClaimed: boolean;
  notifyOnOnTheWay: boolean;
  notifyOnCompleted: boolean;
  notifyOnFailed: boolean;
  notifyOnReturn: boolean;
  channels: string[];
}

export interface IOpeningHours {
  day: number; // 0 = Sunday .. 6 = Saturday
  open: string; // "09:00"
  close: string; // "18:00"
  closed: boolean;
}

export interface IPharmacy {
  _id: Types.ObjectId;
  name: string;
  code: string;
  logo?: string | null;
  email?: string;
  phone?: string;
  contactPerson?: string;
  address: string;
  city?: string;
  postalCode?: string;
  latitude: number;
  longitude: number;
  openingHours: IOpeningHours[];
  deliveryStartTime?: string;
  pickupInstructions?: string;
  serviceZones: string[];
  linkedDriverIds: Types.ObjectId[];
  assignmentMode: AssignmentMode;
  proofConfig: IProofConfig;
  notificationRules: INotificationRules;
  active: boolean;
  archivedAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PharmacyDocument = HydratedDocument<IPharmacy>;

const openingHoursSchema = new Schema<IOpeningHours>(
  {
    day: { type: Number, min: 0, max: 6, required: true },
    open: { type: String, default: '09:00' },
    close: { type: String, default: '18:00' },
    closed: { type: Boolean, default: false },
  },
  { _id: false },
);

export const DEFAULT_PROOF_CONFIG: IProofConfig = {
  signatureRequired: true,
  photoRequired: false,
  receiverIdentityRequired: true,
  authorizedRecipientRequired: false,
  manifestConfirmationRequired: true,
};

const pharmacySchema = new Schema<IPharmacy>(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 16 },
    logo: { type: String, default: null },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    city: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    openingHours: { type: [openingHoursSchema], default: [] },
    deliveryStartTime: { type: String, default: '10:00' },
    pickupInstructions: { type: String, maxlength: 1000 },
    serviceZones: { type: [String], default: [] },
    linkedDriverIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    assignmentMode: { type: String, enum: ASSIGNMENT_MODES, default: 'HYBRID' },
    proofConfig: {
      signatureRequired: { type: Boolean, default: DEFAULT_PROOF_CONFIG.signatureRequired },
      photoRequired: { type: Boolean, default: DEFAULT_PROOF_CONFIG.photoRequired },
      receiverIdentityRequired: {
        type: Boolean,
        default: DEFAULT_PROOF_CONFIG.receiverIdentityRequired,
      },
      authorizedRecipientRequired: {
        type: Boolean,
        default: DEFAULT_PROOF_CONFIG.authorizedRecipientRequired,
      },
      manifestConfirmationRequired: {
        type: Boolean,
        default: DEFAULT_PROOF_CONFIG.manifestConfirmationRequired,
      },
    },
    notificationRules: {
      notifyOnReady: { type: Boolean, default: true },
      notifyOnClaimed: { type: Boolean, default: true },
      notifyOnOnTheWay: { type: Boolean, default: true },
      notifyOnCompleted: { type: Boolean, default: true },
      notifyOnFailed: { type: Boolean, default: true },
      notifyOnReturn: { type: Boolean, default: true },
      channels: { type: [String], default: ['IN_APP'] },
    },
    active: { type: Boolean, default: true, index: true },
    archivedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

pharmacySchema.index({ name: 'text', code: 'text', address: 'text' });
pharmacySchema.index({ active: 1, archivedAt: 1 });

export const Pharmacy: Model<IPharmacy> =
  (models.Pharmacy as Model<IPharmacy>) ?? model<IPharmacy>('Pharmacy', pharmacySchema);
