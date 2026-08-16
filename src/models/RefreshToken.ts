import { Schema, model, models, Types, type HydratedDocument, type Model } from 'mongoose';

/**
 * Refresh tokens are never stored in plaintext. We persist a SHA-256 hash of the
 * token so a database leak cannot be replayed, and rotate on every refresh:
 * using an already-rotated token revokes the whole family (reuse detection).
 */
export interface IRefreshToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedByHash?: string | null;
  userAgent?: string;
  createdAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<IRefreshToken>;

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Expired sessions clean themselves up.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken: Model<IRefreshToken> =
  (models.RefreshToken as Model<IRefreshToken>) ?? model<IRefreshToken>('RefreshToken', refreshTokenSchema);
