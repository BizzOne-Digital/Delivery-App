import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';

export interface ICustomerAddress {
  _id: Types.ObjectId;
  label: string;
  line1: string;
  line2?: string;
  city?: string;
  postalCode?: string;
  latitude?: number | null;
  longitude?: number | null;
  accessInstructions?: string;
  isDefault: boolean;
}

export interface IAuthorizedRecipient {
  _id: Types.ObjectId;
  name: string;
  relationship: string;
  phone?: string;
  notes?: string;
}

export interface ICustomer {
  _id: Types.ObjectId;
  pharmacyId: Types.ObjectId;
  firstName: string;
  lastName: string;
  phone: string;
  alternatePhone?: string;
  email?: string;
  preferredLanguage: string;
  addresses: ICustomerAddress[];
  defaultAddressId?: Types.ObjectId | null;
  deliveryNotes?: string;
  accessInstructions?: string;
  tags: string[];
  authorizedRecipients: IAuthorizedRecipient[];
  active: boolean;
  archivedAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerDocument = HydratedDocument<ICustomer>;

const addressSchema = new Schema<ICustomerAddress>({
  label: { type: String, default: 'Home', trim: true, maxlength: 60 },
  line1: { type: String, required: true, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200 },
  city: { type: String, trim: true, maxlength: 100 },
  postalCode: { type: String, trim: true, maxlength: 24 },
  latitude: { type: Number, default: null, min: -90, max: 90 },
  longitude: { type: Number, default: null, min: -180, max: 180 },
  accessInstructions: { type: String, maxlength: 500 },
  isDefault: { type: Boolean, default: false },
});

const authorizedRecipientSchema = new Schema<IAuthorizedRecipient>({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  relationship: { type: String, default: 'OTHER', trim: true, maxlength: 60 },
  phone: { type: String, trim: true, maxlength: 32 },
  notes: { type: String, maxlength: 300 },
});

const customerSchema = new Schema<ICustomer>(
  {
    // Every customer belongs to exactly one pharmacy — this is the tenant boundary.
    pharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    alternatePhone: { type: String, trim: true, maxlength: 32 },
    email: { type: String, lowercase: true, trim: true },
    preferredLanguage: { type: String, default: 'en' },
    addresses: { type: [addressSchema], default: [] },
    defaultAddressId: { type: Schema.Types.ObjectId, default: null },
    deliveryNotes: { type: String, maxlength: 1000 },
    accessInstructions: { type: String, maxlength: 1000 },
    tags: { type: [String], default: [], index: true },
    authorizedRecipients: { type: [authorizedRecipientSchema], default: [] },
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

customerSchema.index({ pharmacyId: 1, active: 1 });
customerSchema.index({ pharmacyId: 1, firstName: 1, lastName: 1 });
customerSchema.index({ firstName: 'text', lastName: 'text', phone: 'text', email: 'text' });

customerSchema.virtual('fullName').get(function (this: ICustomer) {
  return `${this.firstName} ${this.lastName}`.trim();
});

export const Customer: Model<ICustomer> =
  (models.Customer as Model<ICustomer>) ?? model<ICustomer>('Customer', customerSchema);
