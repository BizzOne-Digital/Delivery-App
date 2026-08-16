import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog } from '../../models/AuditLog';
import { User } from '../../models/User';
import { authenticate, requireUser } from '../../middleware/auth';
import { requireRoles } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { resolvePagination } from '../../utils/pagination';
import { AUDIT_ACTIONS } from '../../constants/enums';
import { objectId } from '../users/users.validation';

const router = Router();

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  entityType: z.string().max(60).optional(),
  entityId: objectId.optional(),
  actorId: objectId.optional(),
  action: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Audit logs are append-only and readable by company staff only. */
const listAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  requireUser(req);
  const { page, limit, skip } = resolvePagination(req.query, { sort: 'timestamp', limit: 50 });
  const query = req.query as z.infer<typeof querySchema>;

  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = new Types.ObjectId(query.entityId);
  if (query.actorId) filter.actorId = new Types.ObjectId(query.actorId);
  if (query.action) {
    filter.action = { $in: String(query.action).split(',').filter((a) => (AUDIT_ACTIONS as readonly string[]).includes(a)) };
  }
  if (query.from || query.to) {
    filter.timestamp = {};
    if (query.from) (filter.timestamp as Record<string, Date>).$gte = query.from;
    if (query.to) (filter.timestamp as Record<string, Date>).$lte = query.to;
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  const actorIds = [...new Set(items.map((i) => String(i.actorId ?? '')).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('firstName lastName email role').lean();
  const actorMap = new Map(actors.map((a) => [String(a._id), a]));

  sendSuccess(
    res,
    items.map((item) => ({
      ...item,
      actor: item.actorId ? (actorMap.get(String(item.actorId)) ?? null) : null,
    })),
    { meta: buildPaginationMeta(page, limit, total) },
  );
});

router.get(
  '/',
  authenticate,
  requireRoles('COMPANY_ADMIN', 'DISPATCHER', 'FINANCE', 'READ_ONLY'),
  validate({ query: querySchema }),
  listAuditLogs,
);

export default router;
