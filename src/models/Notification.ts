import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
} from '../constants/enums';

export interface INotification {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  orderId?: Types.ObjectId | null;
  pharmacyId?: Types.ObjectId | null;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  readAt?: Date | null;
  channels: NotificationChannel[];
  /** True when a channel adapter was a development stub rather than a real provider. */
  simulated: boolean;
  data?: Record<string, unknown>;
  sentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<INotification>;

const notificationSchema = new Schema<INotification>(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    pharmacyId: { type: Schema.Types.ObjectId, ref: 'Pharmacy', default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true, index: true },
    title: { type: String, required: true, maxlength: 160 },
    message: { type: String, required: true, maxlength: 600 },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    channels: { type: [String], enum: NOTIFICATION_CHANNELS, default: ['IN_APP'] },
    simulated: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: {} },
    sentAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

notificationSchema.index({ recipientUserId: 1, read: 1, sentAt: -1 });

export const Notification: Model<INotification> =
  (models.Notification as Model<INotification>) ?? model<INotification>('Notification', notificationSchema);
