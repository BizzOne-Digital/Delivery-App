import { Types } from 'mongoose';
import { Notification } from '../../models/Notification';
import { User } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { emitTo, emitToUser, rooms } from '../../realtime/io';
import { logger } from '../../config/logger';
import { getAdapter } from './adapters';
import type { NotificationChannel, NotificationType } from '../../constants/enums';
import type { OrderDocument } from '../../models/Order';

export interface NotifyInput {
  recipientUserIds: (Types.ObjectId | string)[];
  type: NotificationType;
  title: string;
  message: string;
  orderId?: Types.ObjectId | string | null;
  pharmacyId?: Types.ObjectId | string | null;
  channels?: NotificationChannel[];
  data?: Record<string, unknown>;
}

/**
 * Creates in-app notification records, pushes them over Socket.IO to the
 * recipient's private room, and fans out to the configured external adapters.
 */
export async function notifyUsers(input: NotifyInput): Promise<void> {
  const uniqueIds = [...new Set(input.recipientUserIds.map((id) => String(id)))].filter((id) =>
    Types.ObjectId.isValid(id),
  );
  if (uniqueIds.length === 0) return;

  const channels = input.channels?.length ? input.channels : (['IN_APP'] as NotificationChannel[]);

  try {
    const docs = await Notification.insertMany(
      uniqueIds.map((id) => ({
        recipientUserId: new Types.ObjectId(id),
        orderId: input.orderId ? new Types.ObjectId(String(input.orderId)) : null,
        pharmacyId: input.pharmacyId ? new Types.ObjectId(String(input.pharmacyId)) : null,
        type: input.type,
        title: input.title,
        message: input.message,
        channels,
        simulated: channels.some((c) => c !== 'IN_APP'),
        data: input.data ?? {},
        sentAt: new Date(),
      })),
    );

    for (const doc of docs) {
      emitToUser(String(doc.recipientUserId), 'notification:new', doc.toJSON());
    }

    const external = channels.filter((c) => c !== 'IN_APP');
    if (external.length > 0) {
      await dispatchExternal(uniqueIds, external, input);
    }
  } catch (error) {
    // A failed notification must never roll back the business operation.
    logger.error('notifyUsers failed', {
      type: input.type,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dispatchExternal(
  userIds: string[],
  channels: NotificationChannel[],
  input: NotifyInput,
): Promise<void> {
  const users = await User.find({ _id: { $in: userIds } })
    .select('+pushToken email phone')
    .lean();

  await Promise.all(
    users.flatMap((user) =>
      channels.map((channel) => {
        const to =
          channel === 'PUSH'
            ? (user as { pushToken?: string }).pushToken
            : channel === 'SMS'
              ? user.phone
              : user.email;
        if (!to) return Promise.resolve();
        return getAdapter(channel)
          .send({
            channel,
            type: input.type,
            to,
            title: input.title,
            body: input.message,
            data: { orderId: input.orderId ? String(input.orderId) : null },
          })
          .catch(() => undefined);
      }),
    ),
  );
}

/** All company dispatchers/admins who should hear about operational events. */
export async function dispatcherRecipients(): Promise<string[]> {
  const users = await User.find({
    role: { $in: ['COMPANY_ADMIN', 'DISPATCHER'] },
    active: true,
  })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
}

/** All active staff of a pharmacy. */
export async function pharmacyRecipients(pharmacyId: Types.ObjectId | string): Promise<string[]> {
  const users = await User.find({
    pharmacyId: new Types.ObjectId(String(pharmacyId)),
    role: { $in: ['PHARMACY_ADMIN', 'PHARMACY_STAFF'] },
    active: true,
  })
    .select('_id')
    .lean();
  return users.map((u) => String(u._id));
}

/**
 * Notifies both the pharmacy and the dispatch desk about an order event, honouring
 * the pharmacy's notification rules for the pharmacy-side recipients.
 */
export async function notifyOrderStakeholders(
  order: OrderDocument,
  options: {
    type: NotificationType;
    title: string;
    message: string;
    includeDriver?: boolean;
    ruleKey?: keyof NonNullable<Awaited<ReturnType<typeof getPharmacyRules>>>;
  },
): Promise<void> {
  const [pharmacyUsers, dispatchers] = await Promise.all([
    pharmacyRecipients(order.pharmacyId),
    dispatcherRecipients(),
  ]);

  const rules = await getPharmacyRules(order.pharmacyId);
  const pharmacyAllowed =
    !options.ruleKey || !rules ? true : Boolean(rules[options.ruleKey]);

  const recipients = [...dispatchers, ...(pharmacyAllowed ? pharmacyUsers : [])];
  if (options.includeDriver && order.assignedDriverId) {
    recipients.push(String(order.assignedDriverId));
  }

  await notifyUsers({
    recipientUserIds: recipients,
    type: options.type,
    title: options.title,
    message: options.message,
    orderId: order._id,
    pharmacyId: order.pharmacyId,
    channels: (rules?.channels as NotificationChannel[]) ?? ['IN_APP'],
    data: { referenceNumber: order.referenceNumber, status: order.status },
  });

  // Realtime fan-out to the pharmacy, company desk and anyone watching this order.
  emitTo(
    [rooms.company(), rooms.pharmacy(String(order.pharmacyId)), rooms.order(String(order._id))],
    'order:updated',
    order.toJSON(),
  );
}

async function getPharmacyRules(pharmacyId: Types.ObjectId | string) {
  const pharmacy = await Pharmacy.findById(pharmacyId).select('notificationRules').lean();
  return pharmacy?.notificationRules ?? null;
}
