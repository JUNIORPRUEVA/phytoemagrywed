/**
 * UBICACIONES GPS — el modelo de «dónde se entrega» (fase GPS+DELIVERY).
 *
 * POR QUÉ EXISTE ESTE MÓDULO
 *   Hasta ahora «ubicación» en este CRM era un TEXTO libre que significaba
 *   «ciudad» (lo que el cliente escribía en la landing, y que en los pedidos se
 *   guardaba en `delivery.city`). Eso no sirve para repartir: nadie puede abrir un
 *   mapa con la palabra «Higüey». Ahora la ubicación de entrega es, cuando existe,
 *   un par de COORDENADAS con su procedencia, y es **opcional**: un pedido sin
 *   ubicación es perfectamente válido.
 *
 * REGLAS QUE NO SE PUEDEN ROMPER
 *   1. La fuente de verdad son `latitude` y `longitude`. Nunca una URL de mapa
 *      guardada: la URL se CALCULA al pintarla (`mapUrl`). Así no almacenamos
 *      enlaces externos que caducan ni regalamos la ubicación a un tercero.
 *   2. No se inventa nada: si WhatsApp no manda `address`, no hay dirección. No se
 *      rellena con la ciudad del cliente ni con un texto genérico.
 *   3. No se inventa precisión: se guarda el número que llegó, validado. No se
 *      redondea «para que quede bonito».
 *   4. La PROCEDENCIA es obligatoria (`source`): una ubicación del cliente NO es
 *      una ubicación del operador, y la auditoría tiene que poder distinguirlo.
 *   5. Privacidad: las coordenadas son dato sensible. No se imprimen en logs, no
 *      viajan a Meta (Pixel/CAPI), no van a R2 y solo salen por rutas con sesión.
 *
 * Este módulo es PURO (no toca red ni base de datos): se prueba solo.
 */

import { randomBytes } from 'node:crypto';

/** De dónde salió una ubicación. Se guarda SIEMPRE (auditoría). */
export const LOCATION_SOURCES = Object.freeze({
  /** El cliente la compartió por WhatsApp. */
  WHATSAPP_INBOUND: 'whatsapp_inbound',
  /** El negocio se la envió al cliente por WhatsApp. */
  WHATSAPP_OUTBOUND: 'whatsapp_outbound',
  /** El operador pulsó «usar mi ubicación actual» en el panel. */
  BROWSER_GEOLOCATION: 'browser_geolocation',
  /** El operador escribió las coordenadas a mano. */
  MANUAL_COORDINATES: 'manual_coordinates',
  /** Se reutilizó una ubicación que ya estaba guardada (pedido nuevo). */
  REUSED_LOCATION: 'reused_location',
});

/** Etiqueta humana de cada procedencia (la usa el panel y el comprobante). */
export const LOCATION_SOURCE_LABELS = Object.freeze({
  [LOCATION_SOURCES.WHATSAPP_INBOUND]: 'Compartida por el cliente',
  [LOCATION_SOURCES.WHATSAPP_OUTBOUND]: 'Enviada al cliente',
  [LOCATION_SOURCES.BROWSER_GEOLOCATION]: 'Ubicación del dispositivo',
  [LOCATION_SOURCES.MANUAL_COORDINATES]: 'Coordenadas escritas a mano',
  [LOCATION_SOURCES.REUSED_LOCATION]: 'Reutilizada de otra conversación',
});

/** ¿Es una procedencia conocida? (nunca se guarda una inventada). */
export function isKnownSource(value) {
  return Object.values(LOCATION_SOURCES).includes(String(value ?? ''));
}

/** Identificador corto para la colección `locations`. */
export function newLocationId() {
  return `loc_${randomBytes(12).toString('hex')}`;
}

/**
 * Texto de WhatsApp (input NO confiable): se limpia sin inventar nada.
 * Se quitan caracteres de control, se colapsan espacios y se corta a `max`.
 * NO se escapa aquí: el escape es cosa de quien pinta HTML (el panel usa
 * `escapeHtml`). Guardar el texto tal cual permite corregirlo después.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
export function cleanText(value, max = 300) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    // eslint-disable-next-line no-control-regex -- se eliminan a propósito
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Valida un par de coordenadas. ESTRICTO a propósito: un `42` de más o un
 * `Infinity` no pueden acabar en un enlace de mapa ni en una base de datos.
 *
 * @param {{ latitude?: unknown, longitude?: unknown }} input
 * @returns {{ ok: true, latitude: number, longitude: number } | { ok: false, code: string, message: string }}
 */
export function parseCoordinates(input) {
  const raw = { latitude: input?.latitude, longitude: input?.longitude };
  /** @type {Record<string, number>} */
  const numbers = {};
  for (const key of ['latitude', 'longitude']) {
    const value = raw[key];
    if (value === null || value === undefined || value === '') {
      return { ok: false, code: 'missing_coordinates', message: 'Faltan las coordenadas.' };
    }
    // Sin coerción creativa: `Number('')` es 0 y `Number([])` también. Solo se
    // aceptan números o cadenas que sean EXACTAMENTE un número.
    const candidate =
      typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    if (!Number.isFinite(candidate)) {
      return { ok: false, code: 'invalid_coordinates', message: 'Las coordenadas no son números válidos.' };
    }
    numbers[key] = candidate;
  }
  if (numbers.latitude < -90 || numbers.latitude > 90) {
    return { ok: false, code: 'latitude_out_of_range', message: 'La latitud debe estar entre -90 y 90.' };
  }
  if (numbers.longitude < -180 || numbers.longitude > 180) {
    return { ok: false, code: 'longitude_out_of_range', message: 'La longitud debe estar entre -180 y 180.' };
  }
  // `-0` y `0` son lo mismo en un mapa, pero el JSON no distingue: se normaliza.
  return { ok: true, latitude: numbers.latitude === 0 ? 0 : numbers.latitude, longitude: numbers.longitude === 0 ? 0 : numbers.longitude };
}

/** ¿Son coordenadas utilizables? (para pintar sin volver a validar a mano). */
export function coordinatesOk(latitude, longitude) {
  return parseCoordinates({ latitude, longitude }).ok;
}

/**
 * URL de mapa a partir de las coordenadas. Se CALCULA, no se guarda (§ fuente de
 * verdad = lat/lng). Es la URL oficial de búsqueda de Google Maps, que funciona
 * en navegador y en móvil sin API key y sin SDK.
 *
 * @param {{ latitude?: unknown, longitude?: unknown }|null} location
 * @returns {string|null} `null` si las coordenadas no son válidas: nunca se
 *   genera un enlace de mapa con datos basura.
 */
export function mapUrl(location) {
  const parsed = parseCoordinates(location ?? {});
  if (!parsed.ok) return null;
  const lat = parsed.latitude;
  const lng = parsed.longitude;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

/**
 * Normaliza una ubicación que llega de fuera (webhook, panel, API) al modelo.
 *
 * @param {object} input
 * @param {unknown} input.latitude
 * @param {unknown} input.longitude
 * @param {unknown} [input.name]        nombre que da WhatsApp («Casa», «Menlo Park»)
 * @param {unknown} [input.address]     dirección que da WhatsApp (si la hay)
 * @param {unknown} [input.source]
 * @param {unknown} [input.reportedUrl] URL que mandó WhatsApp (solo traza; no es la fuente de verdad)
 * @returns {{ ok: true, location: any } | { ok: false, code: string, message: string }}
 */
export function normalizeLocation(input) {
  const parsed = parseCoordinates({ latitude: input?.latitude, longitude: input?.longitude });
  if (!parsed.ok) return parsed;
  const source = isKnownSource(input?.source) ? String(input.source) : LOCATION_SOURCES.MANUAL_COORDINATES;
  return {
    ok: true,
    location: {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      // Vacío es `null`, no cadena vacía: así «no hay dirección» es siempre `null`.
      name: cleanText(input?.name, 120),
      address: cleanText(input?.address, 300),
      source,
      // Traza de lo que dijo WhatsApp. NO se usa para abrir el mapa.
      reported_url: cleanText(input?.reportedUrl, 500),
    },
  };
}

/**
 * Ubicación de un mensaje ENTRANTE de WhatsApp.
 *
 * Payload oficial (`type: "location"`):
 *   { location: { latitude, longitude, name?, address?, url? } }
 * Se lee tal cual, sin suponer campos que Meta no manda.
 *
 * @param {any} message mensaje crudo del webhook
 * @returns {{ ok: true, location: any } | { ok: false, code: string } | null}
 *   `null` si el mensaje no es una ubicación.
 */
export function locationFromInbound(message) {
  const type = String(message?.type ?? '');
  const node = message?.location ?? null;
  if (type !== 'location' && !node) return null;
  if (!node || typeof node !== 'object') return { ok: false, code: 'missing_coordinates' };
  return normalizeLocation({
    latitude: node.latitude,
    longitude: node.longitude,
    name: node.name,
    address: node.address,
    reportedUrl: node.url,
    source: LOCATION_SOURCES.WHATSAPP_INBOUND,
  });
}

/** Documento listo para guardar en la colección `locations`. */
export function buildLocationDoc({ location, customerId = null, conversationId = null, messageId = null, waMessageId = null, orderId = null, idempotencyKey = null, createdAt = null }) {
  const normalized = normalizeLocation(location ?? {});
  if (!normalized.ok) return normalized;
  const now = createdAt ?? new Date().toISOString();
  return {
    ok: true,
    doc: {
      id: location?.id ?? newLocationId(),
      ...normalized.location,
      customer_id: customerId,
      conversation_id: conversationId,
      message_id: messageId,
      wa_message_id: waMessageId,
      order_id: orderId,
      idempotency_key: idempotencyKey,
      created_at: now,
    },
  };
}

/**
 * «Compartida hoy» / «Compartida ayer» / «Compartida el 28 sep.».
 *
 * El operador tiene que saber si la ubicación es de ahora o de hace un mes: usar
 * una ubicación vieja creyendo que es la actual es un error de reparto, no un
 * detalle estético.
 *
 * @param {string|null} iso
 * @param {{ now?: Date, timeZone?: string }} [options]
 */
export function locationAgeLabel(iso, options = {}) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = options.timeZone ?? 'America/Santo_Domingo';
  const now = options.now ?? new Date();
  const day = (value) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(value);
  const today = day(now);
  const target = day(date);
  if (target === today) return 'Compartida hoy';
  const yesterday = day(new Date(now.getTime() - 86400000));
  if (target === yesterday) return 'Compartida ayer';
  const formatted = new Intl.DateTimeFormat('es-DO', { timeZone, day: 'numeric', month: 'short' }).format(date);
  return `Compartida el ${formatted.replace('.', '')}`;
}

/**
 * Cómo se describe una ubicación a una persona. Nunca inventa dirección: si solo
 * hay coordenadas, se dice que solo hay coordenadas.
 *
 * @param {{ name?: string|null, address?: string|null, latitude?: number, longitude?: number }|null} location
 */
export function describeLocation(location) {
  if (!location) return { title: 'Ubicación', detail: null, precise: false };
  const name = cleanText(location.name, 120);
  const address = cleanText(location.address, 300);
  const precise = coordinatesOk(location.latitude, location.longitude);
  return {
    title: name ?? (address ? 'Ubicación compartida' : 'Ubicación compartida'),
    detail: address ?? null,
    precise,
  };
}

/**
 * Copia INMUTABLE para un pedido (snapshot).
 *
 * Un pedido histórico tiene que seguir representando LA ubicación que se usó. Si
 * el cliente manda otra después, el pedido viejo no se puede mover: por eso el
 * pedido guarda su propia copia y solo conserva `source_location_id` como traza.
 *
 * @param {any} location
 */
export function orderLocationSnapshot(location) {
  const normalized = normalizeLocation(location ?? {});
  if (!normalized.ok) return null;
  const { latitude, longitude, name, address, source } = normalized.location;
  return {
    latitude,
    longitude,
    name,
    address,
    source,
    source_location_id: location?.id ?? location?.source_location_id ?? null,
    captured_at: location?.captured_at ?? location?.created_at ?? null,
  };
}

/** Forma pública (la que ve el panel con sesión). NUNCA se expone sin auth. */
export function publicLocation(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    latitude: Number(doc.latitude),
    longitude: Number(doc.longitude),
    name: doc.name ?? null,
    address: doc.address ?? null,
    source: doc.source ?? LOCATION_SOURCES.MANUAL_COORDINATES,
    source_label: LOCATION_SOURCE_LABELS[doc.source] ?? 'Ubicación',
    customer_id: doc.customer_id ?? null,
    conversation_id: doc.conversation_id ?? null,
    order_id: doc.order_id ?? null,
    created_at: doc.created_at ?? null,
    age_label: locationAgeLabel(doc.created_at),
    map_url: mapUrl(doc),
    described: describeLocation(doc),
  };
}
