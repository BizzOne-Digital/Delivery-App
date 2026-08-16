import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';

export interface IDriverLocation {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  orderId?: Types.ObjectId | null;
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  batteryLevel?: number;
  recordedAt: Date;
  createdAt: Date;
}

export type DriverLocationDocument = HydratedDocument<IDriverLocation>;

const driverLocationSchema = new Schema<IDriverLocation>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    accuracy: { type: Number },
    heading: { type: Number },
    speed: { type: Number },
    batteryLevel: { type: Number },
    recordedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

driverLocationSchema.index({ driverId: 1, recordedAt: -1 });

/**
 * Detailed breadcrumb history is operational telemetry, not a record of proof.
 * It self-expires after 14 days; proof-relevant coordinates are copied onto the
 * order document (proofOfDelivery.coordinates, failureDetails.coordinates,
 * returnDetails.coordinates) and are never removed by this TTL.
 */
driverLocationSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });

export const DriverLocation: Model<IDriverLocation> =
  (models.DriverLocation as Model<IDriverLocation>) ?? model<IDriverLocation>('DriverLocation', driverLocationSchema);
