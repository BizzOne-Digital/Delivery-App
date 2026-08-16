import { estimateDurationMinutes, haversineKm, isValidCoordinate } from '../src/utils/geo';
import { toCsv } from '../src/utils/csv';
import { escapeRegex, resolvePagination } from '../src/utils/pagination';
import { addDays, parseTimeToMinutes, startOfDay, toDateKey } from '../src/utils/dates';
import { durationToMs } from '../src/utils/tokens';
import { assertTransition } from '../src/services/order.service';
import { LocalNearestNeighbourProvider } from '../src/services/routing/route.provider';
import { occurrencesBetween } from '../src/modules/orders/recurring.controller';
import type { IRecurringOrder } from '../src/models/RecurringOrder';

describe('geo utilities', () => {
  it('computes a known distance', () => {
    // Islington → Southwark is roughly 3.5 km as the crow flies.
    const distance = haversineKm(
      { latitude: 51.5362, longitude: -0.1033 },
      { latitude: 51.5045, longitude: -0.0865 },
    );
    expect(distance).toBeGreaterThan(3);
    expect(distance).toBeLessThan(4.5);
  });

  it('returns zero for identical points', () => {
    const point = { latitude: 51.5, longitude: -0.1 };
    expect(haversineKm(point, point)).toBeCloseTo(0);
  });

  it('rejects null island and out-of-range coordinates', () => {
    expect(isValidCoordinate({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
    expect(isValidCoordinate({ latitude: 51.5, longitude: -0.1 })).toBe(true);
  });

  it('grows the duration estimate with distance and stop count', () => {
    expect(estimateDurationMinutes(10, 1)).toBeGreaterThan(estimateDurationMinutes(2, 1));
    expect(estimateDurationMinutes(10, 5)).toBeGreaterThan(estimateDurationMinutes(10, 1));
  });
});

describe('CSV writer', () => {
  it('quotes values containing commas and quotes', () => {
    const csv = toCsv([{ name: 'Smith, John', note: 'He said "hello"' }]);
    expect(csv).toContain('"Smith, John"');
    expect(csv).toContain('"He said ""hello"""');
  });

  it('neutralises formula injection', () => {
    const csv = toCsv([{ value: '=1+1' }]);
    expect(csv).toContain("'=1+1");
  });

  it('returns just the header row for an empty data set', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
  });
});

describe('pagination', () => {
  it('applies defaults and clamps the limit', () => {
    expect(resolvePagination({})).toMatchObject({ page: 1, limit: 25, skip: 0 });
    expect(resolvePagination({ limit: '5000' }).limit).toBe(200);
    expect(resolvePagination({ page: '-3' }).page).toBe(1);
  });

  it('computes skip from page and limit', () => {
    expect(resolvePagination({ page: '3', limit: '10' }).skip).toBe(20);
  });

  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });
});

describe('date utilities', () => {
  it('normalises to the start of the UTC day', () => {
    expect(startOfDay('2026-03-15T18:45:00Z').toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('adds days across a month boundary', () => {
    expect(toDateKey(addDays(new Date('2026-01-30T00:00:00Z'), 3))).toBe('2026-02-02');
  });

  it('parses HH:mm and rejects nonsense', () => {
    expect(parseTimeToMinutes('09:30')).toBe(570);
    expect(parseTimeToMinutes('25:00')).toBeNull();
    expect(parseTimeToMinutes('nope')).toBeNull();
    expect(parseTimeToMinutes(null)).toBeNull();
  });

  it('converts duration strings to milliseconds', () => {
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToMs('30d')).toBe(2_592_000_000);
    expect(durationToMs('2h')).toBe(7_200_000);
  });
});

describe('order status transitions', () => {
  it('permits documented transitions', () => {
    expect(() => assertTransition('READY', 'ON_THE_WAY')).not.toThrow();
    expect(() => assertTransition('ON_THE_WAY', 'RETURNING')).not.toThrow();
    expect(() => assertTransition('RETURNING', 'ON_THE_WAY')).not.toThrow();
  });

  it('blocks transitions out of a terminal state', () => {
    expect(() => assertTransition('COMPLETED', 'READY')).toThrow();
    expect(() => assertTransition('CANCELLED', 'ON_THE_WAY')).toThrow();
  });

  it('blocks skipping the road: READY cannot jump straight to COMPLETED', () => {
    expect(() => assertTransition('READY', 'COMPLETED')).toThrow();
  });

  it('treats a no-op transition as allowed', () => {
    expect(() => assertTransition('READY', 'READY')).not.toThrow();
  });
});

describe('local route optimiser', () => {
  const provider = new LocalNearestNeighbourProvider();
  const start = { latitude: 51.5362, longitude: -0.1033 };

  it('visits every stop exactly once', async () => {
    const stops = [
      { orderId: 'a', latitude: 51.55, longitude: -0.1 },
      { orderId: 'b', latitude: 51.51, longitude: -0.09 },
      { orderId: 'c', latitude: 51.54, longitude: -0.12 },
    ];
    const result = await provider.optimize(start, stops);

    expect(result.stops).toHaveLength(3);
    expect(new Set(result.stops.map((s) => s.orderId)).size).toBe(3);
    expect(result.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it('produces a route no longer than the naive input order', async () => {
    const stops = [
      { orderId: 'far', latitude: 51.6, longitude: -0.2 },
      { orderId: 'near', latitude: 51.537, longitude: -0.104 },
      { orderId: 'mid', latitude: 51.56, longitude: -0.15 },
    ];
    const optimised = await provider.optimize(start, stops);

    const naiveDistance =
      haversineKm(start, stops[0]!) +
      haversineKm(stops[0]!, stops[1]!) +
      haversineKm(stops[1]!, stops[2]!);

    expect(optimised.totalDistanceKm).toBeLessThanOrEqual(naiveDistance + 0.01);
  });

  it('serves an urgent stop before a much closer normal one', async () => {
    const result = await provider.optimize(start, [
      { orderId: 'close-normal', latitude: 51.537, longitude: -0.104, priority: 'NORMAL' },
      { orderId: 'far-urgent', latitude: 51.56, longitude: -0.14, priority: 'URGENT' },
    ]);
    expect(result.stops[0]!.orderId).toBe('far-urgent');
  });

  it('keeps priority tiers strictly ordered even when that costs distance', async () => {
    const result = await provider.optimize(start, [
      { orderId: 'n1', latitude: 51.537, longitude: -0.104, priority: 'NORMAL' },
      { orderId: 'u1', latitude: 51.58, longitude: -0.16, priority: 'URGENT' },
      { orderId: 'h1', latitude: 51.538, longitude: -0.105, priority: 'HIGH' },
      { orderId: 'u2', latitude: 51.575, longitude: -0.155, priority: 'URGENT' },
    ]);

    const tiers = result.stops.map((s) => s.priority);
    expect(tiers).toEqual(['URGENT', 'URGENT', 'HIGH', 'NORMAL']);
  });

  it('is honest about not using traffic or road data', async () => {
    const result = await provider.optimize(start, [{ orderId: 'a', latitude: 51.55, longitude: -0.1 }]);
    expect(result.usesLiveTraffic).toBe(false);
    expect(result.usesRoadNetwork).toBe(false);
    expect(result.notes).toMatch(/straight-line/i);
  });

  it('handles an empty stop list', async () => {
    const result = await provider.optimize(start, []);
    expect(result.stops).toHaveLength(0);
    expect(result.totalDistanceKm).toBe(0);
  });
});

describe('recurring occurrence generation', () => {
  const base = {
    skippedDates: [],
    weekdays: [],
    dayOfMonth: null,
    intervalDays: null,
    endDate: null,
  } as unknown as IRecurringOrder;

  it('produces one occurrence per day for DAILY', () => {
    const schedule = { ...base, frequency: 'DAILY', startDate: new Date('2026-03-01T00:00:00Z') } as IRecurringOrder;
    const dates = occurrencesBetween(
      schedule,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-05T00:00:00Z'),
    );
    expect(dates).toHaveLength(5);
  });

  it('honours selected weekdays', () => {
    const schedule = {
      ...base,
      frequency: 'SELECTED_WEEKDAYS',
      weekdays: [1, 4], // Monday + Thursday
      startDate: new Date('2026-03-01T00:00:00Z'),
    } as IRecurringOrder;

    const dates = occurrencesBetween(
      schedule,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-14T00:00:00Z'),
    );
    expect(dates.every((d) => [1, 4].includes(d.getUTCDay()))).toBe(true);
    expect(dates).toHaveLength(4);
  });

  it('skips explicitly cancelled occurrences', () => {
    const schedule = {
      ...base,
      frequency: 'DAILY',
      startDate: new Date('2026-03-01T00:00:00Z'),
      skippedDates: ['2026-03-03'],
    } as IRecurringOrder;

    const dates = occurrencesBetween(
      schedule,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-05T00:00:00Z'),
    );
    expect(dates.map(toDateKey)).not.toContain('2026-03-03');
    expect(dates).toHaveLength(4);
  });

  it('respects a custom interval', () => {
    const schedule = {
      ...base,
      frequency: 'CUSTOM_INTERVAL',
      intervalDays: 3,
      startDate: new Date('2026-03-01T00:00:00Z'),
    } as IRecurringOrder;

    const dates = occurrencesBetween(
      schedule,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
    );
    expect(dates.map(toDateKey)).toEqual(['2026-03-01', '2026-03-04', '2026-03-07', '2026-03-10']);
  });

  it('stops at the end date', () => {
    const schedule = {
      ...base,
      frequency: 'DAILY',
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-03T00:00:00Z'),
    } as IRecurringOrder;

    const dates = occurrencesBetween(
      schedule,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
    );
    expect(dates).toHaveLength(3);
  });
});
