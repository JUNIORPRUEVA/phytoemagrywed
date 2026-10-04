import { randomBytes } from 'node:crypto';

import { parseCoordinates } from './locations.mjs';

export const TRACKING_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export const ACTIVE_TRACKING_STATUS = 'ACTIVE';
export const STALE_LOCATION_MS = 60_000;
export const ARRIVAL_RADIUS_M = 50;
export const MIN_POINT_SECONDS = 5;
export const MIN_POINT_METERS = 10;

export function newTrackingId(prefix = 'dts') {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function cleanText(value, max = 120) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateLocationUpdate(input = {}, options = {}) {
  const parsed = parseCoordinates({
    latitude: input.lat ?? input.latitude,
    longitude: input.lng ?? input.longitude,
  });
  if (!parsed.ok) return parsed;

  const accuracy = optionalNumber(input.accuracy);
  if (accuracy !== null && accuracy < 0) {
    return { ok: false, code: 'invalid_accuracy', message: 'La precisión no puede ser negativa.' };
  }
  const heading = optionalNumber(input.heading);
  const speed = optionalNumber(input.speed);
  const now = options.now instanceof Date ? options.now : new Date();
  const reportedAt = input.timestamp ?? input.recorded_at ?? input.recordedAt ?? now.toISOString();
  const date = new Date(reportedAt);
  if (Number.isNaN(date.getTime())) return { ok: false, code: 'invalid_timestamp', message: 'Timestamp inválido.' };
  const skew = date.getTime() - now.getTime();
  if (skew > 2 * 60_000) return { ok: false, code: 'timestamp_in_future', message: 'La ubicación viene del futuro.' };
  if (now.getTime() - date.getTime() > 15 * 60_000) {
    return { ok: false, code: 'stale_timestamp', message: 'La ubicación es demasiado vieja.' };
  }

  return {
    ok: true,
    point: {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracy,
      heading,
      speed,
      recorded_at: date.toISOString(),
    },
  };
}

export function haversineMeters(a, b) {
  const parsedA = parseCoordinates({ latitude: a?.latitude, longitude: a?.longitude });
  const parsedB = parseCoordinates({ latitude: b?.latitude, longitude: b?.longitude });
  if (!parsedA.ok || !parsedB.ok) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(parsedB.latitude - parsedA.latitude);
  const dLng = toRad(parsedB.longitude - parsedA.longitude);
  const lat1 = toRad(parsedA.latitude);
  const lat2 = toRad(parsedB.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

export function routeSummary(from, to) {
  const meters = haversineMeters(from, to);
  if (meters === null) return { distance_m: null, distance_label: 'Sin distancia', eta_seconds: null, eta_label: 'Sin ETA', provider: 'none' };
  const walkingishMetersPerSecond = 5.5;
  const eta = Math.max(60, Math.round(meters / walkingishMetersPerSecond));
  return {
    distance_m: meters,
    distance_label: meters >= 1000 ? `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km` : `${meters} m`,
    eta_seconds: eta,
    eta_label: `${Math.max(1, Math.round(eta / 60))} min aprox.`,
    provider: 'haversine_fallback',
  };
}

export function isLocationStale(positionAt, options = {}) {
  if (!positionAt) return true;
  const now = options.now instanceof Date ? options.now : new Date();
  const at = new Date(positionAt);
  if (Number.isNaN(at.getTime())) return true;
  return now.getTime() - at.getTime() > (options.maxAgeMs ?? STALE_LOCATION_MS);
}

export function shouldStorePoint(previousPoint, nextPoint, options = {}) {
  if (!previousPoint) return true;
  const seconds = Math.abs(new Date(nextPoint.recorded_at).getTime() - new Date(previousPoint.recorded_at).getTime()) / 1000;
  const meters = haversineMeters(previousPoint, nextPoint);
  return seconds >= (options.minSeconds ?? MIN_POINT_SECONDS) || (meters ?? 0) >= (options.minMeters ?? MIN_POINT_METERS);
}

export function suspiciousJump(previousPoint, nextPoint) {
  if (!previousPoint) return false;
  const meters = haversineMeters(previousPoint, nextPoint);
  if (meters === null) return false;
  const seconds = Math.max(1, Math.abs(new Date(nextPoint.recorded_at).getTime() - new Date(previousPoint.recorded_at).getTime()) / 1000);
  return meters / seconds > 70;
}

export function orderDestination(order) {
  const location = order?.delivery?.location ?? null;
  const parsed = parseCoordinates({ latitude: location?.latitude, longitude: location?.longitude });
  if (!parsed.ok) return null;
  return {
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    name: cleanText(location.name, 120),
    address: cleanText(location.address, 300),
    source_location_id: location.source_location_id ?? null,
  };
}

export function publicTrackingSession(session, options = {}) {
  if (!session) return null;
  const destination = options.destination ?? null;
  let metadata = {};
  try {
    metadata = session.metadata ? JSON.parse(session.metadata) : {};
  } catch {
    metadata = {};
  }
  const hasPosition = parseCoordinates({ latitude: session.last_latitude, longitude: session.last_longitude }).ok;
  const current = hasPosition
    ? {
        latitude: Number(session.last_latitude),
        longitude: Number(session.last_longitude),
        accuracy: session.last_accuracy ?? null,
        heading: session.last_heading ?? null,
        speed: session.last_speed ?? null,
        recorded_at: session.last_position_at ?? null,
        stale: isLocationStale(session.last_position_at, options),
      }
    : null;
  const summary = current && destination ? routeSummary(current, destination) : routeSummary(null, null);
  return {
    id: session.id,
    order_id: session.order_id,
    delivery_user_id: session.delivery_user_id,
    delivery_user_name: session.delivery_user_name_snapshot ?? null,
    status: session.status,
    started_at: session.started_at,
    ended_at: session.ended_at ?? null,
    metadata,
    last_position: current,
    destination,
    distance_m: summary.distance_m,
    distance_label: summary.distance_label,
    eta_seconds: summary.eta_seconds,
    eta_label: summary.eta_label,
    route_provider: summary.provider,
    arrived_near_destination: Boolean(current && destination && (summary.distance_m ?? Infinity) <= ARRIVAL_RADIUS_M),
    updated_at: session.updated_at ?? session.started_at,
  };
}

export function buildSession({ orderId, deliveryUser, order, now = new Date() }) {
  const at = iso(now);
  return {
    id: newTrackingId('dts'),
    order_id: String(orderId),
    delivery_user_id: deliveryUser.id,
    delivery_user_name_snapshot: deliveryUser.display_name ?? 'Delivery',
    status: ACTIVE_TRACKING_STATUS,
    started_at: at,
    ended_at: null,
    last_latitude: null,
    last_longitude: null,
    last_accuracy: null,
    last_heading: null,
    last_speed: null,
    last_position_at: null,
    destination: orderDestination(order),
    created_at: at,
    updated_at: at,
  };
}
