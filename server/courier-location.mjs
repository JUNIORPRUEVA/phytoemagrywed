/**
 * UBICACIÓN DEL REPARTIDOR (FULLTECH DELIVERY) — reglas puras.
 *
 * La app manda posiciones durante una entrega activa; el backend decide si
 * sirven. Nada de confiar en el cliente:
 *   - coordenadas válidas y precisión razonable,
 *   - marca de tiempo no futura y no demasiado vieja,
 *   - orden temporal (una posición vieja NUNCA pisa una nueva),
 *   - salto físicamente imposible = sospechoso (se guarda, se marca),
 *   - estado de señal calculado aquí para que CRM y app no discrepen.
 *
 * No se guarda historial de rutas: solo la ÚLTIMA posición por repartidor.
 */

/** La posición deja de ser «en vivo» pasado este tiempo. */
export const LOCATION_LIVE_MS = 2 * 60_000;
/** Pasado este tiempo el repartidor se considera sin señal. */
export const LOCATION_STALE_MS = 10 * 60_000;
/** Precisión máxima aceptada (metros). */
export const MAX_ACCURACY_M = 200;
/** Velocidad imposible para una moto/camión urbano (m/s). */
export const MAX_SPEED_MPS = 55;

export const SIGNAL = Object.freeze({
  LIVE: 'live',
  DELAYED: 'delayed',
  NO_SIGNAL: 'no_signal',
  NO_LOCATION: 'no_location',
});

const meters = (a, b) => {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * @param {object} input  `{latitude, longitude, accuracy, at, orderId, trackingId}`
 * @param {object} [options] `{now, previous}` (`previous` = última posición guardada)
 */
export function validateCourierLocation(input = {}, { now = Date.now(), previous = null } = {}) {
  const lat = Number(input.latitude ?? input.lat);
  const lng = Number(input.longitude ?? input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, status: 422, error: 'invalid_coordinates', message: 'La ubicación no trae coordenadas válidas.' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, status: 422, error: 'invalid_coordinates', message: 'Las coordenadas están fuera de rango.' };
  }
  /* (0,0) es el «null island»: señal de un GPS que no fijó posición. */
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) {
    return { ok: false, status: 422, error: 'invalid_coordinates', message: 'El GPS no fijó una posición real.' };
  }

  const accuracy = Number.isFinite(Number(input.accuracy)) ? Math.max(0, Number(input.accuracy)) : null;
  if (accuracy !== null && accuracy > MAX_ACCURACY_M) {
    return { ok: false, status: 422, error: 'low_accuracy', message: 'La precisión del GPS es demasiado baja para ubicar la entrega.', accuracy };
  }

  const atMs = input.at ? Date.parse(input.at) : now;
  if (!Number.isFinite(atMs)) {
    return { ok: false, status: 422, error: 'invalid_timestamp', message: 'La marca de tiempo de la ubicación no es válida.' };
  }
  if (atMs > now + 60_000) {
    return { ok: false, status: 422, error: 'future_timestamp', message: 'La ubicación dice venir del futuro: revisa el reloj del teléfono.' };
  }
  if (now - atMs > LOCATION_STALE_MS) {
    return { ok: false, status: 409, error: 'stale_location', message: 'Esa ubicación es demasiado antigua para usarla.' };
  }

  const point = { lat, lng, accuracy, at: new Date(atMs).toISOString(), orderId: input.orderId ?? null, trackingId: input.trackingId ?? null };

  if (previous && Number.isFinite(Date.parse(previous.at))) {
    const previousMs = Date.parse(previous.at);
    /* Una posición vieja no sobrescribe una nueva (eventos fuera de orden). */
    if (atMs <= previousMs) {
      return { ok: false, status: 409, error: 'out_of_order', message: 'Llega una ubicación más antigua que la guardada; se ignora.', previous_at: previous.at };
    }
    const distance = meters({ lat: previous.lat, lng: previous.lng }, point);
    const seconds = Math.max(1, (atMs - previousMs) / 1000);
    const speed = distance / seconds;
    const jump = {
      distanceMeters: Math.round(distance),
      seconds: Math.round(seconds),
      speedMps: Math.round(speed * 10) / 10,
      suspicious: speed > MAX_SPEED_MPS,
    };
    /* Se acepta y se MARCA: si se descartara, una posición corrupta bloquearía el seguimiento. */
    return { ok: true, point: { ...point, jump }, suspicious: jump.suspicious };
  }

  return { ok: true, point: { ...point, jump: null }, suspicious: false };
}

/** Estado de señal de un repartidor, para que el CRM pinte lo mismo que la app. */
export function signalState(position, { now = Date.now() } = {}) {
  if (!position || !Number.isFinite(Date.parse(position.at))) return SIGNAL.NO_LOCATION;
  const age = now - Date.parse(position.at);
  if (age <= LOCATION_LIVE_MS) return SIGNAL.LIVE;
  if (age <= LOCATION_STALE_MS) return SIGNAL.DELAYED;
  return SIGNAL.NO_SIGNAL;
}

export function describePosition(position, { now = Date.now(), courierId = null, orderIds = [] } = {}) {
  const state = signalState(position, { now });
  return {
    courier_id: courierId ?? position?.courier_id ?? null,
    order_ids: orderIds,
    state,
    latitude: state === SIGNAL.NO_LOCATION ? null : position?.lat ?? null,
    longitude: state === SIGNAL.NO_LOCATION ? null : position?.lng ?? null,
    accuracy_m: position?.accuracy ?? null,
    at: position?.at ?? null,
    age_seconds: position?.at ? Math.max(0, Math.round((now - Date.parse(position.at)) / 1000)) : null,
    suspicious: Boolean(position?.jump?.suspicious),
  };
}
