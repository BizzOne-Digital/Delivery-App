export interface LatLng {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. Straight-line, not driving distance. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidCoordinate(point?: Partial<LatLng> | null): point is LatLng {
  return (
    !!point &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180 &&
    !(point.latitude === 0 && point.longitude === 0)
  );
}

/**
 * Rough duration estimate from straight-line distance. This is a development
 * heuristic only: it assumes an average urban speed and a fixed service time per
 * stop, and it has NO knowledge of live traffic, road networks or turn costs.
 */
export function estimateDurationMinutes(distanceKm: number, stops = 1): number {
  const AVERAGE_URBAN_SPEED_KMH = 26;
  const SERVICE_MINUTES_PER_STOP = 4;
  return Math.round((distanceKm / AVERAGE_URBAN_SPEED_KMH) * 60 + stops * SERVICE_MINUTES_PER_STOP);
}
