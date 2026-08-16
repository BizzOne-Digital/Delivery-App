import { Types, type FilterQuery } from 'mongoose';
import { Order, type IOrder } from '../../models/Order';
import { User } from '../../models/User';
import { Pharmacy } from '../../models/Pharmacy';
import { RecurringOrder } from '../../models/RecurringOrder';
import { minutesBetween } from '../../utils/dates';

export interface ReportScope {
  pharmacyIds: Types.ObjectId[] | null;
  from: Date;
  to: Date;
  driverId?: string;
  pharmacyId?: string;
}

function baseFilter(scope: ReportScope): FilterQuery<IOrder> {
  const filter: FilterQuery<IOrder> = { createdAt: { $gte: scope.from, $lte: scope.to } };
  if (scope.pharmacyIds !== null) filter.pharmacyId = { $in: scope.pharmacyIds };
  else if (scope.pharmacyId) filter.pharmacyId = new Types.ObjectId(scope.pharmacyId);
  if (scope.driverId) filter.assignedDriverId = new Types.ObjectId(scope.driverId);
  return filter;
}

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Headline operational + financial metrics for the selected window. */
export async function buildSummary(scope: ReportScope) {
  const filter = baseFilter(scope);
  const orders = await Order.find(filter)
    .select(
      'status orderType priority amountDue amountCollected paymentMethod createdAt readyAt onTheWayAt completedAt failedAt returnedAt retryCount distanceKm timeWindowEnd deliveryDate proofOfDelivery proofConfigSnapshot failureDetails.reason preparingAt',
    )
    .lean();

  const completed = orders.filter((o) => o.status === 'COMPLETED');
  const failedAttempts = orders.filter((o) => o.failedAt);
  const cancelled = orders.filter((o) => o.status === 'CANCELLED');

  const deliveryDurations = completed
    .filter((o) => o.onTheWayAt && o.completedAt)
    .map((o) => minutesBetween(new Date(o.onTheWayAt as Date), new Date(o.completedAt as Date)));

  const prepDurations = orders
    .filter((o) => o.readyAt)
    .map((o) => minutesBetween(new Date(o.createdAt), new Date(o.readyAt as Date)));

  const onTime = completed.filter((o) => {
    if (!o.timeWindowEnd || !o.completedAt) return false;
    const deadline = new Date(
      `${new Date(o.deliveryDate).toISOString().slice(0, 10)}T${o.timeWindowEnd}:00Z`,
    );
    return new Date(o.completedAt) <= deadline;
  });
  const withWindow = completed.filter((o) => o.timeWindowEnd);

  const firstAttemptSuccess = completed.filter((o) => (o.retryCount ?? 0) === 0);

  const proofCompliant = completed.filter((o) => {
    const config = o.proofConfigSnapshot;
    const proof = o.proofOfDelivery;
    if (!proof) return false;
    if (config?.signatureRequired && !proof.signatureUrl) return false;
    if (config?.photoRequired && (proof.photoUrls?.length ?? 0) === 0) return false;
    if (config?.receiverIdentityRequired && !proof.receiverName) return false;
    if (config?.manifestConfirmationRequired && !proof.manifestConfirmed) return false;
    return true;
  });

  const cashCollected = completed.reduce((sum, o) => sum + (o.amountCollected ?? 0), 0);
  const cashExpected = completed.reduce((sum, o) => sum + (o.amountDue ?? 0), 0);
  const discrepancies = completed.filter(
    (o) => Math.abs((o.amountCollected ?? 0) - (o.amountDue ?? 0)) > 0.009,
  );

  const avg = (values: number[]) =>
    values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length, 1);

  return {
    window: { from: scope.from, to: scope.to },
    totalOrders: orders.length,
    completedDeliveries: completed.length,
    failedDeliveries: failedAttempts.length,
    cancelledOrders: cancelled.length,
    returnRate: orders.length > 0 ? round((failedAttempts.length / orders.length) * 100, 1) : 0,
    firstAttemptSuccessRate:
      completed.length > 0 ? round((firstAttemptSuccess.length / completed.length) * 100, 1) : null,
    averageDeliveryMinutes: avg(deliveryDurations),
    averagePreparationMinutes: avg(prepDurations),
    onTimeDeliveryRate:
      withWindow.length > 0 ? round((onTime.length / withWindow.length) * 100, 1) : null,
    proofComplianceRate:
      completed.length > 0 ? round((proofCompliant.length / completed.length) * 100, 1) : null,
    cashCollected: round(cashCollected),
    cashExpected: round(cashExpected),
    cashDifference: round(cashCollected - cashExpected),
    cashDiscrepancyCount: discrepancies.length,
    totalDistanceKm: round(orders.reduce((sum, o) => sum + (o.distanceKm ?? 0), 0), 1),
    byStatus: countBy(orders, (o) => o.status),
    byType: countBy(orders, (o) => o.orderType),
    byPriority: countBy(orders, (o) => o.priority),
    byPaymentMethod: countBy(completed, (o) => o.paymentMethod ?? 'UNRECORDED'),
    byFailureReason: countBy(failedAttempts, (o) => o.failureDetails?.reason ?? 'OTHER'),
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

/** Orders per day, split into completed / failed / cancelled. */
export async function buildTimeSeries(scope: ReportScope) {
  const rows = await Order.aggregate<{
    _id: string;
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    collected: number;
  }>([
    { $match: baseFilter(scope) },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $ne: ['$failedAt', null] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
        collected: { $sum: '$amountCollected' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({ date: r._id, ...r, collected: round(r.collected) }));
}

/** Workload distribution across hours of the day and days of the week. */
export async function buildWorkload(scope: ReportScope) {
  const [byHour, byWeekday] = await Promise.all([
    Order.aggregate<{ _id: number; count: number }>([
      { $match: baseFilter(scope) },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate<{ _id: number; count: number }>([
      { $match: baseFilter(scope) },
      { $group: { _id: { $dayOfWeek: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    byHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: byHour.find((r) => r._id === hour)?.count ?? 0,
    })),
    // MongoDB $dayOfWeek is 1=Sunday..7=Saturday.
    byWeekday: Array.from({ length: 7 }, (_, index) => ({
      weekday: index,
      count: byWeekday.find((r) => r._id === index + 1)?.count ?? 0,
    })),
  };
}

/** Per-driver performance league table. */
export async function buildDriverPerformance(scope: ReportScope) {
  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    completed: number;
    failed: number;
    collected: number;
    expected: number;
    distance: number;
    totalMinutes: number;
    timedCount: number;
  }>([
    { $match: { ...baseFilter(scope), assignedDriverId: { $ne: null } } },
    {
      $group: {
        _id: '$assignedDriverId',
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $ne: ['$failedAt', null] }, 1, 0] } },
        collected: { $sum: '$amountCollected' },
        expected: { $sum: '$amountDue' },
        distance: { $sum: { $ifNull: ['$distanceKm', 0] } },
        totalMinutes: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$onTheWayAt', null] }, { $ne: ['$completedAt', null] }] },
              { $divide: [{ $subtract: ['$completedAt', '$onTheWayAt'] }, 60000] },
              0,
            ],
          },
        },
        timedCount: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$onTheWayAt', null] }, { $ne: ['$completedAt', null] }] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { completed: -1 } },
  ]);

  const drivers = await User.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('firstName lastName email')
    .lean();
  const nameMap = new Map(drivers.map((d) => [String(d._id), `${d.firstName} ${d.lastName}`]));

  return rows.map((row) => {
    const attempts = row.completed + row.failed;
    return {
      driverId: String(row._id),
      driverName: nameMap.get(String(row._id)) ?? 'Unknown driver',
      completed: row.completed,
      failed: row.failed,
      successRate: attempts > 0 ? round((row.completed / attempts) * 100, 1) : null,
      averageDeliveryMinutes: row.timedCount > 0 ? round(row.totalMinutes / row.timedCount, 1) : null,
      cashCollected: round(row.collected),
      cashExpected: round(row.expected),
      cashDifference: round(row.collected - row.expected),
      distanceKm: round(row.distance, 1),
    };
  });
}

/** Order volume per pharmacy. */
export async function buildPharmacyVolume(scope: ReportScope) {
  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    total: number;
    completed: number;
    failed: number;
    collected: number;
  }>([
    { $match: baseFilter(scope) },
    {
      $group: {
        _id: '$pharmacyId',
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $ne: ['$failedAt', null] }, 1, 0] } },
        collected: { $sum: '$amountCollected' },
      },
    },
    { $sort: { total: -1 } },
  ]);

  const pharmacies = await Pharmacy.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('name code')
    .lean();
  const map = new Map(pharmacies.map((p) => [String(p._id), p]));

  return rows.map((row) => ({
    pharmacyId: String(row._id),
    pharmacyName: map.get(String(row._id))?.name ?? 'Unknown pharmacy',
    pharmacyCode: map.get(String(row._id))?.code ?? '',
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    cashCollected: round(row.collected),
  }));
}

export async function buildRecurringSummary(scope: ReportScope) {
  const filter: FilterQuery<Record<string, unknown>> = {};
  if (scope.pharmacyIds !== null) filter.pharmacyId = { $in: scope.pharmacyIds };

  const [active, total, generated] = await Promise.all([
    RecurringOrder.countDocuments({ ...filter, active: true }),
    RecurringOrder.countDocuments(filter),
    Order.countDocuments({ ...baseFilter(scope), recurringOrderId: { $ne: null } }),
  ]);

  return { activeSchedules: active, totalSchedules: total, ordersGeneratedInWindow: generated };
}

/** Flat rows suitable for CSV export. */
export async function buildOrderExportRows(scope: ReportScope) {
  const orders = await Order.find(baseFilter(scope))
    .populate('pharmacyId', 'name code')
    .populate('assignedDriverId', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(10000)
    .lean();

  return orders.map((o) => {
    const pharmacy = o.pharmacyId as unknown as { name?: string; code?: string } | null;
    const driver = o.assignedDriverId as unknown as { firstName?: string; lastName?: string } | null;
    return {
      reference: o.referenceNumber,
      pharmacy: pharmacy?.name ?? '',
      pharmacyCode: pharmacy?.code ?? '',
      customer: `${o.customerSnapshot?.firstName ?? ''} ${o.customerSnapshot?.lastName ?? ''}`.trim(),
      type: o.orderType,
      status: o.status,
      priority: o.priority,
      driver: driver ? `${driver.firstName} ${driver.lastName}` : '',
      deliveryDate: o.deliveryDate,
      timeWindow: [o.timeWindowStart, o.timeWindowEnd].filter(Boolean).join(' - '),
      amountDue: o.amountDue,
      amountCollected: o.amountCollected,
      paymentMethod: o.paymentMethod ?? '',
      failureReason: o.failureDetails?.reason ?? '',
      retryCount: o.retryCount,
      distanceKm: o.distanceKm ?? '',
      createdAt: o.createdAt,
      readyAt: o.readyAt ?? '',
      onTheWayAt: o.onTheWayAt ?? '',
      completedAt: o.completedAt ?? '',
      returnedAt: o.returnedAt ?? '',
      // Deliberately excluded from exports: order notes and customer notes,
      // which can carry clinical detail.
    };
  });
}
