import { Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { logger } from '../config/logger';
import type { AuditAction, Role } from '../constants/enums';

export interface AuditInput {
  actorId?: Types.ObjectId | string | null;
  actorRole?: Role | 'SYSTEM';
  entityType: string;
  entityId?: Types.ObjectId | string | null;
  action: AuditAction;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/** Fields that must never be written into the audit trail. */
const FORBIDDEN_FIELDS = ['passwordHash', 'password', 'token', 'refreshToken', 'pushToken'];

function sanitize(values?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!values) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (FORBIDDEN_FIELDS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Audit logging must never break the operation it is recording — failures are
 * logged and swallowed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      actorId: input.actorId ? new Types.ObjectId(String(input.actorId)) : null,
      actorRole: input.actorRole ?? 'SYSTEM',
      entityType: input.entityType,
      entityId: input.entityId ? new Types.ObjectId(String(input.entityId)) : null,
      action: input.action,
      oldValues: sanitize(input.oldValues),
      newValues: sanitize(input.newValues),
      metadata: input.metadata ?? {},
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('Failed to write audit log', {
      entityType: input.entityType,
      action: input.action,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Produces a shallow diff of only the fields that actually changed. */
export function diffValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const field of fields) {
    const a = before[field];
    const b = after[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      oldValues[field] = a;
      newValues[field] = b;
    }
  }
  return { oldValues, newValues };
}
