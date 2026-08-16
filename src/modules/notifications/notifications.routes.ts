import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Notification } from '../../models/Notification';
import { authenticate, requireUser } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPaginationMeta, sendSuccess } from '../../utils/response';
import { resolvePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/ApiError';
import { usingSimulatedProviders } from '../../services/notification/adapters';
import { idParamSchema } from '../users/users.validation';

const router = Router();
router.use(authenticate);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  type: z.string().optional(),
});

/** A user only ever sees notifications addressed to them. */
const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { page, limit, skip } = resolvePagination(req.query, { sort: 'sentAt', limit: 30 });
  const query = req.query as Record<string, string | undefined>;

  const filter: Record<string, unknown> = { recipientUserId: actor._id };
  if (query.unreadOnly === 'true') filter.read = false;
  if (query.type) filter.type = { $in: query.type.split(',') };

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ sentAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ recipientUserId: actor._id, read: false }),
  ]);

  sendSuccess(res, items, {
    meta: {
      ...buildPaginationMeta(page, limit, total),
      unreadCount: unread,
      // Surfaced so the UI can be honest that push/SMS/email are stubbed.
      externalChannelsSimulated: usingSimulatedProviders(),
    },
  });
});

const markRead = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const notification = await Notification.findOne({
    _id: req.params.id,
    recipientUserId: actor._id,
  });
  if (!notification) throw ApiError.notFound('Notification not found');

  notification.read = true;
  notification.readAt = new Date();
  await notification.save();

  sendSuccess(res, notification.toJSON());
});

const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const result = await Notification.updateMany(
    { recipientUserId: actor._id, read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  sendSuccess(res, { updated: result.modifiedCount }, { message: 'All notifications marked as read' });
});

const unreadCount = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const count = await Notification.countDocuments({ recipientUserId: actor._id, read: false });
  sendSuccess(res, { unreadCount: count });
});

router.get('/', validate({ query: listQuerySchema }), listNotifications);
router.get('/unread-count', unreadCount);
router.post('/read-all', markAllRead);
router.post('/:id/read', validate({ params: idParamSchema }), markRead);

export default router;
