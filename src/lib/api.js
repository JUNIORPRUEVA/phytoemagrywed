/**
 * Contrato y cliente del mini-CRM.
 *
 * V1: el endpoint es OPCIONAL. Si no está configurado, los leads/pedidos se
 * guardan en una cola local (`localStorage`) y la landing sigue funcionando
 * exactamente igual. Cuando exista backend, basta con definir
 * `PHYTO_CRM_ENDPOINT` (o `site.crm.endpoint`): el mismo payload empieza a
 * viajar por HTTP sin tocar la UI.
 *
 * Ver `docs/CRM-CONTRACT.md`.
 */

import { createStorage } from './storage.js';
import { SCHEMA_VERSION } from './tracking.js';

export const QUEUE_KEY = 'crm.queue';
export const MAX_QUEUE_ITEMS = 50;

/** @param {unknown} value */
function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignorado a propósito */
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {unknown} value @param {number} [max] */
function trim(value, max = 200) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text.slice(0, max);
}

/**
 * Atribución "plana" + objeto, lista para persistir en el CRM.
 * @param {import('./attribution.js').Attribution|null} attribution
 */
export function flattenAttribution(attribution) {
  if (!attribution) {
    return {
      source: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      fbclid: null,
      clickIds: {},
      landingPage: null,
      referrer: null,
      capturedAt: null,
      touch: null,
    };
  }
  return {
    source: attribution.utm_source ?? null,
    utm_source: attribution.utm_source ?? null,
    utm_medium: attribution.utm_medium ?? null,
    utm_campaign: attribution.utm_campaign ?? null,
    utm_content: attribution.utm_content ?? null,
    utm_term: attribution.utm_term ?? null,
    fbclid: attribution.clickIds?.fbclid ?? null,
    clickIds: attribution.clickIds ?? {},
    landingPage: attribution.landingPage ?? null,
    referrer: attribution.referrer ?? null,
    capturedAt: attribution.capturedAt ?? null,
    touch: attribution.touch ?? null,
  };
}

/**
 * Payload de LEAD (persona interesada).
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.phone
 * @param {string|null} [input.location]
 * @param {string} input.source  origen interno: hero|checkout|selector|formulario|footer...
 * @param {boolean} input.consent
 * @param {import('./attribution.js').Attribution|null} [input.attribution]
 * @param {string|null} [input.productId]
 * @param {{ id?: string, name?: string, capsules?: number }|null} [input.variant]
 * @param {number|null} [input.quantity]
 * @param {string|null} [input.sessionId]
 * @param {string|null} [input.id]
 * @param {string} [input.createdAt]
 */
export function buildLeadPayload(input) {
  const variant = input.variant ?? null;
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'lead',
    id: input.id ?? randomId(),
    name: trim(input.name, 80),
    phone: trim(input.phone, 24),
    location: trim(input.location, 120),
    source: trim(input.source, 40),
    productId: trim(input.productId, 60),
    // Presentación de interés (null si el lead viene del formulario general).
    variantId: trim(variant?.id, 60),
    variantName: trim(variant?.name, 120),
    capsules: Number.isFinite(variant?.capsules) ? variant.capsules : null,
    quantity: Number.isFinite(input.quantity) ? input.quantity : null,
    consent: input.consent === true,
    consentVersion: trim(input.consentVersion, 20),
    sessionId: trim(input.sessionId, 60),
    attribution: flattenAttribution(input.attribution ?? null),
    landingPage: input.attribution?.landingPage ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Payload de ORDER_INTENT (intención de pedido). NO es una venta:
 * la venta la confirma el CRM/backend.
 *
 * Modelo clave: `variant` es la PRESENTACIÓN (cápsulas) y `quantity` es cuántas
 * UNIDADES de esa presentación pide la persona.
 * 10 cápsulas (RD$2,500) × 2 unidades = RD$5,000 y 20 cápsulas en total.
 *
 * @param {object} input
 * @param {{ id?: string, name: string, phone: string, location?: string|null }} input.customer
 * @param {{ id: string, name: string, currency?: string }} input.product
 * @param {{ id?: string, name?: string, capsules?: number, price?: number|null }|null} input.variant
 * @param {number} input.quantity
 * @param {string} [input.source]
 * @param {import('./attribution.js').Attribution|null} [input.attribution]
 * @param {string|null} [input.sessionId]
 * @param {string} [input.createdAt]
 */
export function buildOrderIntentPayload(input) {
  const variant = input.variant ?? null;
  const currency = trim(input.product?.currency, 8) ?? 'DOP';
  const unitPrice = Number.isFinite(variant?.price) ? variant.price : null;
  const quantity = Number.isFinite(input.quantity) ? input.quantity : 1;
  const capsules = Number.isFinite(variant?.capsules) ? variant.capsules : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'order_intent',
    id: randomId(),
    leadId: input.customer?.id ?? null,
    product: {
      id: trim(input.product?.id, 60),
      name: trim(input.product?.name, 120),
      presentation: trim(variant?.name, 120),
      currency,
    },
    // ---- Presentación elegida (variante) ----
    variantId: trim(variant?.id, 60),
    variantName: trim(variant?.name, 120),
    capsules,
    // ---- Pedido ----
    quantity,
    totalCapsules: Number.isFinite(capsules) ? capsules * quantity : null,
    currency,
    unitPrice,
    total: unitPrice !== null ? Math.round(unitPrice * quantity * 100) / 100 : null,
    source: trim(input.source, 40),
    status: 'pending_confirmation',
    attribution: flattenAttribution(input.attribution ?? null),
    sessionId: trim(input.sessionId, 60),
    createdAt: input.createdAt ?? new Date().toISOString(),
    customer: {
      name: trim(input.customer?.name, 80),
      phone: trim(input.customer?.phone, 24),
      location: trim(input.customer?.location, 120),
    },
  };
}

/**
 * Cliente del CRM con cola local.
 * @param {object} options
 * @param {string|null} options.endpoint
 * @param {ReturnType<typeof createStorage>} [options.storage]
 * @param {typeof fetch|null} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.debug]
 */
export function createCrmClient(options) {
  const {
    endpoint,
    storage = createStorage('pe', 'local'),
    fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    timeoutMs = 8000,
    debug = false,
  } = options;

  const enabled = typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint);

  /** @returns {any[]} */
  function listQueued() {
    const queue = storage.get(QUEUE_KEY);
    return Array.isArray(queue) ? queue : [];
  }

  /** @param {any} item */
  function enqueue(item) {
    const queue = listQueued();
    queue.push({ ...item, queuedAt: new Date().toISOString() });
    while (queue.length > MAX_QUEUE_ITEMS) queue.shift();
    storage.set(QUEUE_KEY, queue);
    return queue.length;
  }

  /**
   * @param {'lead'|'order_intent'} type
   * @param {any} payload
   * @returns {Promise<{ ok: boolean, queued: boolean, status?: number, id: string, error?: string }>}
   */
  async function send(type, payload) {
    if (!enabled || !fetchImpl) {
      const size = enqueue(payload);
      if (debug) console.info(`[crm] endpoint no configurado: ${type} guardado en cola local (${size}).`);
      return { ok: true, queued: true, id: payload.id };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
        // Sin credenciales: el endpoint público no debe necesitar cookies.
        credentials: 'omit',
        mode: 'cors',
      });
      if (!response.ok) {
        enqueue(payload);
        return { ok: false, queued: true, status: response.status, id: payload.id, error: 'http_error' };
      }
      return { ok: true, queued: false, status: response.status, id: payload.id };
    } catch (error) {
      // Fallo de red: no perdemos el dato, se reintentará después.
      enqueue(payload);
      if (debug) console.warn(`[crm] fallo al enviar ${type}:`, error);
      return { ok: false, queued: true, id: payload.id, error: 'network_error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    enabled,
    endpoint: enabled ? endpoint : null,
    /** @param {any} payload */
    submitLead: (payload) => send('lead', payload),
    /** @param {any} payload */
    submitOrderIntent: (payload) => send('order_intent', payload),
    listQueued,
    /** @param {string} id */
    removeQueued(id) {
      storage.set(
        QUEUE_KEY,
        listQueued().filter((item) => item.id !== id),
      );
    },
    clearQueue() {
      storage.remove(QUEUE_KEY);
    },
  };
}
