import { Router } from 'express';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PaymentReconciliation } from '../../models/PaymentReconciliation';
import { Order } from '../../models/Order';
import { User } from '../../models/User';
import { authenticate, requireUser } from '../../middleware/auth';
import { canReviewFinance, denyReadOnlyWrites, isCompanyUser } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { startOfDay } from '../../utils/dates';
import { recordAudit } from '../../services/audit.service';
import { emitTo, rooms } from '../../realtime/io';
import { dispatcherRecipients, notifyUsers } from '../../services/notification/notification.service';
import { idParamSchema } from '../users/users.validation';

const router = Router();
router.use(authenticate, denyReadOnlyWrites);

const submitSchema = z.object({
  date: z.coerce.date().optional(),
  submittedAmount: z.coerce.number().min(0).max(1_000_000),
  notes: z.string().trim().max(800).optional(),
});

const reviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reviewerNotes: z.string().trim().max(800).optional(),
});

/** Recomputes what a driver *should* have collected on a given day. */
async function computeExpected(driverId: Types.ObjectId, date: Date) {
  const next = new Date(date.getTime() + 86_400_000);
  const orders = await Order.find({
    assignedDriverId: driverId,
    status: 'COMPLETED',
    completedAt: { $gte: date, $lt: next },
  })
    .select('amountDue amountCollected paymentMethod')
    .lean();

  // Only cash is physically handed over; card/cheque settle elsewhere.
  const cashOrders = orders.filter((o) => o.paymentMethod === 'CASH');
  const expected = cashOrders.reduce((sum, o) => sum + (o.amountCollected ?? 0), 0);

  const breakdown = Object.entries(
    orders.reduce<Record<string, { amount: number; count: number }>>((acc, o) => {
      const key = o.paymentMethod ?? 'OTHER';
      acc[key] = acc[key] ?? { amount: 0, count: 0 };
      acc[key].amount += o.amountCollected ?? 0;
      acc[key].count += 1;
      return acc;
    }, {}),
  ).map(([method, value]) => ({ method, amount: Math.round(value.amount * 100) / 100, count: value.count }));

  return {
    expected: Math.round(expected * 100) / 100,
    orderCount: cashOrders.length,
    breakdown,
  };
}

/** Driver submits the cash they are handing in for a day. */
const submit = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (actor.role !== 'DRIVER') throw ApiError.forbidden('Only drivers submit cash reports');

  const body = req.body as z.infer<typeof submitSchema>;
  const date = startOfDay(body.date ?? new Date());

  const existing = await PaymentReconciliation.findOne({ driverId: actor._id, date });
  if (existing && (existing.status === 'APPROVED' || existing.status === 'LOCKED')) {
    throw ApiError.unprocessable(
      'This day has already been reconciled and locked.',
      'RECONCILIATION_LOCKED',
    );
  }

  const { expected, orderCount, breakdown } = await computeExpected(actor._id, date);
  const difference = Math.round((body.submittedAmount - expected) * 100) / 100;

  const record = await PaymentReconciliation.findOneAndUpdate(
    { driverId: actor._id, date },
    {
      $set: {
        expectedAmount: expected,
        submittedAmount: body.submittedAmount,
        difference,
        orderCount,
        breakdown,
        notes: body.notes,
        status: 'SUBMITTED',
        reviewedBy: null,
        reviewedAt: null,
      },
    },
    { new: true, upsert: true },
  );

  await recordAudit({
    actorId: actor._id,
    actorRole: 'DRIVER',
    entityType: 'PaymentReconciliation',
    entityId: record!._id,
    action: 'RECONCILE',
    newValues: { submittedAmount: body.submittedAmount, expected, difference },
  });

  emitTo(rooms.company(), 'reconciliation:updated', record?.toJSON());

  if (Math.abs(difference) > 0.009) {
    await notifyUsers({
      recipientUserIds: await financeRecipients(),
      type: 'CASH_DISCREPANCY',
      title: 'Cash discrepancy reported',
      message: `${actor.firstName} ${actor.lastName}: ${difference > 0 ? '+' : ''}${difference.toFixed(2)} on ${date.toISOString().slice(0, 10)}.`,
      data: { driverId: String(actor._id), difference },
    });
  }

  sendSuccess(res, record?.toJSON(), {
    message:
      Math.abs(difference) > 0.009
        ? 'Submitted. A discrepancy was flagged for finance review.'
        : 'Cash report submitted',
  });
});

async function financeRecipients(): Promise<string[]> {
  const users = await User.find({ role: { $in: ['FINANCE', 'COMPANY_ADMIN'] }, active: true })
    .select('_id')
    .lean();
  const ids = users.map((u) => String(u._id));
  return ids.length > 0 ? ids : dispatcherRecipients();
}

const list = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const query = req.query as Record<string, string | undefined>;

  const filter: Record<string, unknown> = {};
  if (actor.role === 'DRIVER') filter.driverId = actor._id;
  else if (!isCompanyUser(actor)) throw ApiError.forbidden('Cash reconciliation is company-only');
  else if (query.driverId) filter.driverId = new Types.ObjectId(query.driverId);

  if (query.status) filter.status = { $in: query.status.split(',') };
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) (filter.date as Record<string, Date>).$gte = startOfDay(query.from);
    if (query.to) (filter.date as Record<string, Date>).$lte = startOfDay(query.to);
  }

  const records = await PaymentReconciliation.find(filter)
    .populate('driverId', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName')
    .sort({ date: -1 })
    .limit(200)
    .lean();

  const totals = records.reduce(
    (acc, r) => ({
      expected: acc.expected + r.expectedAmount,
      submitted: acc.submitted + r.submittedAmount,
      difference: acc.difference + r.difference,
    }),
    { expected: 0, submitted: 0, difference: 0 },
  );

  sendSuccess(res, records, {
    meta: {
      count: records.length,
      expected: Math.round(totals.expected * 100) / 100,
      submitted: Math.round(totals.submitted * 100) / 100,
      difference: Math.round(totals.difference * 100) / 100,
      pendingReview: records.filter((r) => r.status === 'SUBMITTED').length,
    },
  });
});

/** Today's expected figure, so the driver sees it before submitting. */
const preview = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const driverId =
    actor.role === 'DRIVER' ? actor._id : new Types.ObjectId(String((req.query as { driverId?: string }).driverId));
  if (!driverId) throw ApiError.badRequest('driverId is required');

  const date = startOfDay((req.query as { date?: string }).date);
  const result = await computeExpected(driverId, date);
  const existing = await PaymentReconciliation.findOne({ driverId, date }).lean();

  sendSuccess(res, { date: date.toISOString().slice(0, 10), ...result, existing });
});

/** Finance/admin approves or rejects; approval locks the record. */
const review = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  if (!canReviewFinance(actor)) throw ApiError.forbidden('Only finance or a company admin can review');

  const { decision, reviewerNotes } = req.body as z.infer<typeof reviewSchema>;
  const record = await PaymentReconciliation.findById(req.params.id);
  if (!record) throw ApiError.notFound('Reconciliation record not found');

  if (record.status === 'LOCKED') {
    throw ApiError.unprocessable('This record is locked and cannot be changed', 'RECONCILIATION_LOCKED');
  }

  const before = record.status;
  record.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  record.reviewerNotes = reviewerNotes;
  record.reviewedBy = actor._id;
  record.reviewedAt = new Date();
  // Approval is final — the record is immutable from here on.
  if (decision === 'APPROVE') {
    record.status = 'LOCKED';
    record.lockedAt = new Date();
  }
  await record.save();

  await recordAudit({
    actorId: actor._id,
    actorRole: actor.role,
    entityType: 'PaymentReconciliation',
    entityId: record._id,
    action: 'RECONCILE',
    oldValues: { status: before },
    newValues: { status: record.status, reviewerNotes },
  });

  emitTo([rooms.company(), rooms.driver(String(record.driverId))], 'reconciliation:updated', record.toJSON());

  await notifyUsers({
    recipientUserIds: [String(record.driverId)],
    type: 'CASH_DISCREPANCY',
    title: decision === 'APPROVE' ? 'Cash report approved' : 'Cash report needs attention',
    message:
      decision === 'APPROVE'
        ? `Your report for ${record.date.toISOString().slice(0, 10)} has been approved and locked.`
        : `Your report for ${record.date.toISOString().slice(0, 10)} was rejected. ${reviewerNotes ?? ''}`.trim(),
  });

  sendSuccess(res, record.toJSON(), {
    message: decision === 'APPROVE' ? 'Approved and locked' : 'Rejected — the driver has been notified',
  });
});

router.get('/', list);
router.get('/preview', preview);
router.post('/submit', validate({ body: submitSchema }), submit);
router.post('/:id/review', validate({ params: idParamSchema, body: reviewSchema }), review);

export default router;
