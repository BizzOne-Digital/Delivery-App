import { estimateDurationMinutes, haversineKm, type LatLng } from '../../utils/geo';

export interface RouteStopInput extends LatLng {
  orderId: string;
  label?: string;
  priority?: 'NORMAL' | 'HIGH' | 'URGENT';
  timeWindowStartMinutes?: number | null;
}

export interface OptimizedStop extends RouteStopInput {
  sequence: number;
  legDistanceKm: number;
  etaMinutesFromStart: number;
}

export interface OptimizedRoute {
  provider: string;
  stops: OptimizedStop[];
  totalDistanceKm: number;
  estimatedDurationMinutes: number;
  /**
   * Honest capability flag. The local provider computes straight-line distances
   * only — it does not know about roads, one-way systems or live traffic.
   */
  usesLiveTraffic: boolean;
  usesRoadNetwork: boolean;
  notes: string;
}

export interface RouteProvider {
  readonly name: string;
  optimize(start: LatLng, stops: RouteStopInput[]): Promise<OptimizedRoute>;
}

/** Stops are served strictly tier by tier: every URGENT before any HIGH, and so on. */
const PRIORITY_TIERS = ['URGENT', 'HIGH', 'NORMAL'] as const;

/**
 * Development route provider.
 *
 * Priority is a hard constraint, not a tiebreaker: stops are partitioned into
 * URGENT / HIGH / NORMAL tiers and each tier is solved independently with greedy
 * nearest-neighbour plus a 2-opt pass to remove path crossings. The tiers are
 * then concatenated in priority order.
 *
 * Optimising per tier (rather than globally, then re-sorting) matters — a global
 * 2-opt pass minimises raw distance and would happily push an urgent stop to the
 * end of the route.
 *
 * Deterministic, free, offline — and explicitly NOT traffic-aware.
 */
export class LocalNearestNeighbourProvider implements RouteProvider {
  readonly name = 'local-nearest-neighbour';

  async optimize(start: LatLng, stops: RouteStopInput[]): Promise<OptimizedRoute> {
    if (stops.length === 0) {
      return {
        provider: this.name,
        stops: [],
        totalDistanceKm: 0,
        estimatedDurationMinutes: 0,
        usesLiveTraffic: false,
        usesRoadNetwork: false,
        notes: 'No stops to optimise.',
      };
    }

    const ordered: RouteStopInput[] = [];
    let cursor: LatLng = start;

    for (const tier of PRIORITY_TIERS) {
      const inTier = stops.filter((s) => (s.priority ?? 'NORMAL') === tier);
      if (inTier.length === 0) continue;

      const nearestFirst = greedyNearestNeighbour(cursor, inTier);
      const improved = twoOpt(cursor, nearestFirst);
      ordered.push(...improved);
      cursor = improved[improved.length - 1] ?? cursor;
    }

    return buildRoute(this.name, start, ordered, {
      usesLiveTraffic: false,
      usesRoadNetwork: false,
      notes:
        'Ordering computed locally from straight-line (Haversine) distances, urgent stops first. ' +
        'Distances and ETAs are estimates and do not account for road networks or live traffic.',
    });
  }
}

/** Repeatedly hop to the closest stop not yet visited. */
function greedyNearestNeighbour(start: LatLng, stops: RouteStopInput[]): RouteStopInput[] {
  const remaining = [...stops];
  const ordered: RouteStopInput[] = [];
  let cursor: LatLng = start;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < remaining.length; i += 1) {
      const distance = haversineKm(cursor, remaining[i]!);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next!);
    cursor = next!;
  }

  return ordered;
}

/** Classic 2-opt improvement: reverse segments while total distance drops. */
function twoOpt(start: LatLng, stops: RouteStopInput[]): RouteStopInput[] {
  if (stops.length < 4) return stops;

  const totalFor = (list: RouteStopInput[]) => {
    let total = 0;
    let prev: LatLng = start;
    for (const s of list) {
      total += haversineKm(prev, s);
      prev = s;
    }
    return total;
  };

  let best = [...stops];
  let bestDistance = totalFor(best);
  let improvedThisPass = true;
  let guard = 0;

  while (improvedThisPass && guard < 40) {
    improvedThisPass = false;
    guard += 1;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const distance = totalFor(candidate);
        if (distance < bestDistance - 0.0001) {
          best = candidate;
          bestDistance = distance;
          improvedThisPass = true;
        }
      }
    }
  }
  return best;
}

function buildRoute(
  provider: string,
  start: LatLng,
  stops: RouteStopInput[],
  flags: { usesLiveTraffic: boolean; usesRoadNetwork: boolean; notes: string },
): OptimizedRoute {
  let previous: LatLng = start;
  let cumulativeDistance = 0;
  const result: OptimizedStop[] = stops.map((stop, index) => {
    const legDistanceKm = haversineKm(previous, stop);
    cumulativeDistance += legDistanceKm;
    previous = stop;
    return {
      ...stop,
      sequence: index + 1,
      legDistanceKm: round(legDistanceKm),
      etaMinutesFromStart: estimateDurationMinutes(cumulativeDistance, index + 1),
    };
  });

  return {
    provider,
    stops: result,
    totalDistanceKm: round(cumulativeDistance),
    estimatedDurationMinutes: estimateDurationMinutes(cumulativeDistance, stops.length),
    ...flags,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/*
 * ---------------------------------------------------------------------------
 * Integrating a paid routing service later
 * ---------------------------------------------------------------------------
 * Implement RouteProvider against e.g. Google Routes API, Mapbox Optimization or
 * HERE, and register it below. The rest of the application only depends on this
 * interface, so no controller or UI code needs to change.
 *
 *   class GoogleRoutesProvider implements RouteProvider {
 *     readonly name = 'google-routes';
 *     async optimize(start, stops) { ...; return { ..., usesLiveTraffic: true,
 *                                                  usesRoadNetwork: true }; }
 *   }
 *   setRouteProvider(new GoogleRoutesProvider());
 */
let activeProvider: RouteProvider = new LocalNearestNeighbourProvider();

export function getRouteProvider(): RouteProvider {
  return activeProvider;
}

export function setRouteProvider(provider: RouteProvider): void {
  activeProvider = provider;
}
