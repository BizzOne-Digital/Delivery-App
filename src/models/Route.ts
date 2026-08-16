import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';

export interface IRouteStop {
  orderId: Types.ObjectId;
  sequence: number;
  latitude: number;
  longitude: number;
  label?: string;
  legDistanceKm?: number;
  etaAt?: Date | null;
  completedAt?: Date | null;
}

export interface IRoute {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  orderIds: Types.ObjectId[];
  orderedStops: IRouteStop[];
  startingLocation?: { latitude: number; longitude: number } | null;
  endingLocation?: { latitude: number; longitude: number } | null;
  plannedStartTime?: Date | null;
  totalDistance: number;
  estimatedDuration: number;
  optimized: boolean;
  optimizerProvider: string;
  active: boolean;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RouteDocument = HydratedDocument<IRoute>;

const stopSchema = new Schema<IRouteStop>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    sequence: { type: Number, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    label: { type: String },
    legDistanceKm: { type: Number, default: 0 },
    etaAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const routeSchema = new Schema<IRoute>(
  {
    driverId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderIds: [{ type: Schema.Types.ObjectId, ref: 'Order' }],
    orderedStops: { type: [stopSchema], default: [] },
    startingLocation: {
      type: new Schema({ latitude: Number, longitude: Number }, { _id: false }),
      default: null,
    },
    endingLocation: {
      type: new Schema({ latitude: Number, longitude: Number }, { _id: false }),
      default: null,
    },
    plannedStartTime: { type: Date, default: null },
    totalDistance: { type: Number, default: 0 },
    estimatedDuration: { type: Number, default: 0 },
    optimized: { type: Boolean, default: false },
    // Which provider produced the ordering. `local-nearest-neighbour` has no traffic data.
    optimizerProvider: { type: String, default: 'local-nearest-neighbour' },
    active: { type: Boolean, default: true, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

routeSchema.index({ driverId: 1, active: 1 });

export const Route: Model<IRoute> =
  (models.Route as Model<IRoute>) ?? model<IRoute>('Route', routeSchema);
