import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { DRIVER_STATUSES, ROLES, type DriverStatus, type Role } from '../constants/enums';

export interface IUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: Role;
  companyId?: Types.ObjectId | null;
  pharmacyId?: Types.ObjectId | null;
  assignedPharmacyIds: Types.ObjectId[];
  active: boolean;
  driverStatus: DriverStatus;
  shiftStartedAt?: Date | null;
  employeeCode?: string;
  preferredMapApp: 'GOOGLE' | 'APPLE' | 'WAZE';
  themePreference: 'system' | 'light' | 'dark';
  languagePreference: string;
  pushToken?: string | null;
  lastKnownLocation?: { latitude: number; longitude: number; recordedAt: Date } | null;
  lastLoginAt?: Date | null;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
  fullName(): string;
}

export type UserDocument = HydratedDocument<IUser, IUserMethods>;

interface IUserModel extends Model<IUser, Record<string, never>, IUserMethods> {
  hashPassword(plain: string): Promise<string>;
}

const userSchema = new Schema<IUser, IUserModel, IUserMethods>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, trim: true, maxlength: 32 },
    // `select: false` keeps the hash out of every ordinary query result.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    pharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', default: null, index: true },
    assignedPharmacyIds: [{ type: Schema.Types.ObjectId, ref: 'Pharmacy', index: true }],
    active: { type: Boolean, default: true, index: true },
    driverStatus: { type: String, enum: DRIVER_STATUSES, default: 'OFFLINE', index: true },
    shiftStartedAt: { type: Date, default: null },
    employeeCode: { type: String, trim: true, maxlength: 32 },
    preferredMapApp: { type: String, enum: ['GOOGLE', 'APPLE', 'WAZE'], default: 'GOOGLE' },
    themePreference: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    languagePreference: { type: String, default: 'en' },
    pushToken: { type: String, default: null, select: false },
    lastKnownLocation: {
      type: new Schema(
        {
          latitude: { type: Number, required: true },
          longitude: { type: Number, required: true },
          recordedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    lastLoginAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.passwordHash;
        delete ret.pushToken;
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSchema.index({ role: 1, active: 1 });
userSchema.index({ firstName: 'text', lastName: 'text', email: 'text' });

userSchema.virtual('name').get(function (this: IUser) {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.method('comparePassword', function (this: UserDocument, candidate: string) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.passwordHash);
});

userSchema.method('fullName', function (this: UserDocument) {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.static('hashPassword', function (plain: string) {
  return bcrypt.hash(plain, 12);
});

export const User = (models.User as IUserModel) ?? model<IUser, IUserModel>('User', userSchema);
