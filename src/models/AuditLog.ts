import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';
import { AUDIT_ACTIONS, type AuditAction, type Role } from '../constants/enums';

export interface IAuditLog {
  _id: Types.ObjectId;
  actorId?: Types.ObjectId | null;
  actorRole?: Role | 'SYSTEM';
  entityType: string;
  entityId?: Types.ObjectId | null;
  action: AuditAction;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export type AuditLogDocument = HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String },
    entityType: { type: String, required: true, index: true },
    entityId: { type: Schema.Types.ObjectId, default: null, index: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    oldValues: { type: Schema.Types.Mixed, default: null },
    newValues: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false, versionKey: false },
);

auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });

export const AuditLog: Model<IAuditLog> =
  (models.AuditLog as Model<IAuditLog>) ?? model<IAuditLog>('AuditLog', auditLogSchema);
