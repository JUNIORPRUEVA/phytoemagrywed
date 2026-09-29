/**
 * Cliente de la API de conversiones de Meta (CAPI) — SOLO SERVIDOR.
 *
 * Por qué existe este archivo aparte:
 *  - El token de acceso es un SECRETO: nunca puede llegar al navegador, ni a un
 *    log, ni a un mensaje de error. Aquí se concentra todo lo que lo toca, para
 *    que sea fácil de auditar (y de probar).
 *  - Meta puede caerse o tardar. Nada de lo que pase en este archivo puede
 *    impedir guardar un lead, crear un pedido o confirmar una venta.
 *
 * Reglas que respeta:
 *  1. `Purchase` SOLO se envía cuando el negocio marca la venta como real
 *     (ver `PHYTO_META_PURCHASE_STATUS` en `crm-server.mjs`).
 *  2. Los identificadores que se hashean (teléfono, external_id) se normalizan
 *     ANTES del SHA-256, como pide Meta. Lo que Meta espera sin hash
 *     (`fbc`, `fbp`, `client_ip_address`, `client_user_agent`) NO se hashea.
 *  3. `test_event_code` solo se manda en entornos de prueba: si `APP_ENV` es
 *     `production`, se ignora aunque la variable esté puesta.
 *  4. Los errores se registran saneados (estado + código + tipo), nunca con el
 *     token dentro.
 *
 * Documentación: docs/META_INTEGRATION.md
 */

import { createHash } from 'node:crypto';

/** Versión de la Graph API. Se puede cambiar con `PHYTO_META_GRAPH_VERSION`. */
export const DEFAULT_GRAPH_VERSION = 'v21.0';

/** Nombre del evento de venta para Meta. */
export const PURCHASE_EVENT = 'Purchase';

/** Prefijos de `event_id` por evento: el navegador y el servidor usan el MISMO. */
export const EVENT_ID_PREFIX = Object.freeze({
  page_view: 'pv',
  view_product: 'vc',
  select_variant: 'sv',
  click_buy: 'cb',
  click_whatsapp: 'contact',
  begin_checkout: 'ic',
  lead: 'lead',
  purchase: 'purchase',
});

// --------------------------------------------------------------- normalización

/**
 * Normaliza un teléfono para hashearlo como espera Meta: SOLO dígitos, con
 * código de país y sin ceros iniciales raros.
 *
 * Casos reales de República Dominicana (todos deben dar `18091234567`):
 *   8091234567 · (809) 123-4567 · 809 123 4567 · +1 809 123 4567 · 0018091234567
 *
 * @param {unknown} raw
 * @param {{ countryCode?: string }} [options]
 * @returns {string|null} null si no hay dígitos suficientes para identificar un número
 */
export function normalizePhone(raw, options = {}) {
  const countryCode = options.countryCode ?? '1';
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // `00` inicial es el prefijo internacional en muchos móviles: se descarta.
  const withoutPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  const local = withoutPrefix.length === 10 ? `${countryCode}${withoutPrefix}` : withoutPrefix;
  // 7 dígitos o menos no identifican a nadie: mejor no mandarlo que mandar basura.
  if (local.length < 8 || local.length > 15) return null;
  return local;
}

/**
 * Texto normalizado para los campos que Meta exige en minúsculas y sin espacios
 * (nombre, ciudad…). No se inventan datos: si no hay valor, devuelve null.
 * @param {unknown} value
 */
export function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  return clean ? clean.slice(0, 200) : null;
}

/** SHA-256 en hexadecimal (formato que espera Meta). */
export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Teléfono listo para `user_data.ph`: normalizado y hasheado.
 * @param {unknown} raw
 * @param {{ countryCode?: string }} [options]
 */
export function hashPhone(raw, options = {}) {
  const normalized = normalizePhone(raw, options);
  return normalized ? sha256(normalized) : null;
}

/** Nombre hasheado (una sola palabra normalizada). */
export function hashName(value) {
  const normalized = normalizeText(value);
  return normalized ? sha256(normalized) : null;
}

/**
 * Construye `_fbc` a partir del `fbclid` cuando Meta no puso la cookie.
 *
 * Formato oficial: `fb.<subdomainIndex>.<timestampMs>.<fbclid>`. El índice es
 * 1 (el dominio de la web es el primero que se visita).
 *
 * @param {unknown} fbclid
 * @param {number} [timestampMs]
 */
export function buildFbc(fbclid, timestampMs = Date.now()) {
  const value = typeof fbclid === 'string' ? fbclid.trim() : '';
  if (!value) return null;
  return `fb.1.${Math.trunc(timestampMs)}.${value}`;
}

/**
 * `_fbc` definitivo: se prefiere la cookie real de Meta y, si no está, se
 * construye desde el `fbclid` de la URL.
 *
 * @param {{ fbc?: string|null, fbclid?: string|null, now?: number }} input
 */
export function resolveFbc(input = {}) {
  const cookie = typeof input.fbc === 'string' ? input.fbc.trim() : '';
  if (/^fb\.\d+\.\d+\./.test(cookie)) return cookie;
  return buildFbc(input.fbclid, input.now ?? Date.now());
}

/**
 * `_fbp`: identificador de navegador de Meta. Se usa tal cual (NO se hashea).
 * @param {unknown} fbp
 */
export function resolveFbp(fbp) {
  const value = typeof fbp === 'string' ? fbp.trim() : '';
  return /^fb\.\d+\.\d+\./.test(value) ? value : null;
}

/**
 * Datos de usuario para CAPI a partir de lo que la landing guardó con el pedido.
 *
 * @param {object} input
 * @param {any} [input.payload]   payload guardado en el CRM (attribution, meta…)
 * @param {string|null} [input.phone]
 * @param {string|null} [input.name]
 * @param {string|null} [input.externalId]
 * @param {string|null} [input.ip]
 * @param {string|null} [input.userAgent]
 * @param {number} [input.now]
 * @returns {Record<string, unknown>}
 */
export function buildUserData(input = {}) {
  const payload = input.payload ?? {};
  const attribution = payload.attribution ?? {};
  const meta = payload.meta ?? {};

  const fbc = resolveFbc({
    fbc: attribution.fbc ?? meta.fbc ?? null,
    fbclid: attribution.fbclid ?? attribution.clickIds?.fbclid ?? meta.fbclid ?? null,
    now: input.now,
  });

  /** @type {Record<string, unknown>} */
  const userData = {};
  const phone = hashPhone(input.phone);
  if (phone) userData.ph = [phone];
  const firstName = hashName(input.name);
  if (firstName) userData.fn = [firstName];
  if (input.externalId) userData.external_id = [sha256(input.externalId)];
  // Sin hash, tal y como pide Meta:
  if (fbc) userData.fbc = fbc;
  const fbp = resolveFbp(attribution.fbp ?? meta.fbp ?? null);
  if (fbp) userData.fbp = fbp;
  if (input.ip) userData.client_ip_address = input.ip;
  if (input.userAgent) userData.client_user_agent = String(input.userAgent).slice(0, 300);
  return userData;
}

// ------------------------------------------------------------------- errores

/**
 * Convierte cualquier fallo en un objeto corto y sin secretos.
 *
 * Un mensaje de Meta puede traer la URL con el token dentro: se recorta y se
 * sustituye por `[oculto]` antes de que nadie lo vea.
 *
 * @param {unknown} error
 * @param {string} [secret] token a ocultar
 */
export function sanitizeError(error, secret = '') {
  // Un Error, un texto o un objeto con `message` (lo que devuelve Meta).
  const source =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : String(error ?? 'error');
  let message = source.replace(/\s+/g, ' ').slice(0, 300);
  if (secret) message = message.replaceAll(secret, '[oculto]');
  message = message.replace(/access_token=[^&\s]+/gi, 'access_token=[oculto]');
  message = message.replace(/EAA[\w-]{20,}/g, '[oculto]');
  return {
    status: Number(/** @type {any} */ (error)?.status ?? 0) || null,
    code: /** @type {any} */ (error)?.code ?? null,
    type: /** @type {any} */ (error)?.type ?? null,
    message,
  };
}

/**
 * Sanea la respuesta de Meta: se queda con lo útil (eventos recibidos, avisos,
 * traza) y tira cualquier cosa que huela a credencial.
 *
 * @param {any} body
 * @param {string} [secret]
 */
export function sanitizeResponse(body, secret = '') {
  if (!body || typeof body !== 'object') return null;
  const messages = Array.isArray(body.messages)
    ? body.messages.slice(0, 5).map((entry) => ({
        code: entry?.code ?? null,
        message: sanitizeError({ message: entry?.message }, secret).message,
      }))
    : [];
  return {
    eventsReceived: Number.isFinite(body.events_received) ? body.events_received : null,
    messages,
    fbtraceId: typeof body.fbtrace_id === 'string' ? body.fbtrace_id : null,
  };
}

// --------------------------------------------------------------------- cliente

/**
 * Crea el cliente de CAPI.
 *
 * Sin `pixelId` o sin `accessToken` queda desactivado y `send()` no hace nada:
 * así el CRM funciona igual en local (donde no hay credenciales) y no hay que
 * llenar el código de condicionales.
 *
 * @param {object} options
 * @param {string} [options.pixelId]
 * @param {string} [options.accessToken]
 * @param {string} [options.testEventCode]
 * @param {string} [options.graphVersion]
 * @param {string} [options.appEnv]           `production` desactiva el código de prueba
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @param {boolean} [options.debug]
 */
export function createMetaCapi(options = {}) {
  const pixelId = String(options.pixelId ?? '').trim();
  const accessToken = String(options.accessToken ?? '').trim();
  // OJO: una variable de entorno VACÍA llega como '' (no como undefined). Con
  // `??` se colaba y la URL salía `graph.facebook.com//<pixel>/events`.
  const graphVersion = String(options.graphVersion ?? '').trim() || DEFAULT_GRAPH_VERSION;
  const appEnv = String(options.appEnv ?? '').trim().toLowerCase();
  const timeoutMs = Number(options.timeoutMs ?? 6000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? ((message) => console.log(message));
  const debug = options.debug === true;

  /*
   * El código de prueba SOLO vale en entornos que no son producción y con el
   * formato real de Meta (`TEST12345`). Así, una variable olvidada no convierte
   * el tráfico de producción en tráfico de prueba.
   */
  const rawTestCode = String(options.testEventCode ?? '').trim();
  const testCodeLooksValid = /^TEST\d{3,}$/i.test(rawTestCode);
  const testEventCode = appEnv === 'production' ? '' : testCodeLooksValid ? rawTestCode : '';
  if (rawTestCode && !testEventCode) {
    log(
      appEnv === 'production'
        ? '[meta] PHYTO_META_CAPI_TEST_EVENT_CODE ignorado: en producción no se envían eventos de prueba.'
        : '[meta] PHYTO_META_CAPI_TEST_EVENT_CODE con formato inesperado: se ignora.',
    );
  }

  const enabled = Boolean(pixelId && accessToken && typeof fetchImpl === 'function');
  if (!enabled && debug) {
    log('[meta] CAPI desactivada: faltan PHYTO_META_PIXEL_ID o PHYTO_META_CAPI_ACCESS_TOKEN.');
  }

  /**
   * Envía un evento a Meta.
   *
   * Nunca lanza: devuelve `{ ok, skipped?, error?, response? }` para que quien
   * llame decida (y el CRM siga funcionando pase lo que pase).
   *
   * @param {object} event
   * @param {string} event.eventName
   * @param {string} event.eventId
   * @param {number} [event.eventTime]  segundos; por defecto ahora
   * @param {string} [event.eventSourceUrl]
   * @param {Record<string, unknown>} event.userData
   * @param {Record<string, unknown>} [event.customData]
   * @param {string} [event.actionSource]
   * @param {string} [event.testEventCode]  fuerza un código concreto (pruebas)
   */
  async function send(event) {
    if (!enabled) return { ok: false, skipped: true, reason: 'not_configured' };
    if (!event?.eventName || !event?.eventId) return { ok: false, skipped: true, reason: 'missing_fields' };

    const body = {
      data: [
        {
          event_name: event.eventName,
          event_time: event.eventTime ?? Math.floor(Date.now() / 1000),
          event_id: event.eventId,
          action_source: event.actionSource ?? 'website',
          ...(event.eventSourceUrl ? { event_source_url: event.eventSourceUrl } : {}),
          user_data: event.userData ?? {},
          ...(event.customData ? { custom_data: event.customData } : {}),
        },
      ],
      // El token viaja en el cuerpo (no en la URL) para que no acabe en logs de proxy.
      access_token: accessToken,
    };
    const code = event.testEventCode ?? testEventCode;
    if (code) body.test_event_code = code;

    try {
      const response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${pixelId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      const text = await response.text();
      /** @type {any} */
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok || parsed?.error) {
        const detail = sanitizeError(
          { message: parsed?.error?.message ?? text, status: response.status, code: parsed?.error?.code, type: parsed?.error?.type },
          accessToken,
        );
        return { ok: false, status: response.status, error: detail, response: sanitizeResponse(parsed, accessToken) };
      }
      return { ok: true, status: response.status, response: sanitizeResponse(parsed, accessToken) };
    } catch (error) {
      return { ok: false, error: sanitizeError(error, accessToken) };
    }
  }

  return {
    enabled,
    pixelId: enabled ? pixelId : null,
    graphVersion,
    /** Solo para diagnóstico: nunca se expone el valor. */
    hasTestEventCode: Boolean(testEventCode),
    send,
    /**
     * Evento de compra. El `event_id` sale del pedido, así que es idempotente
     * por construcción: el mismo pedido no puede contar dos veces.
     */
    sendPurchase(purchase) {
      if (!enabled) return Promise.resolve({ ok: false, skipped: true, reason: 'not_configured' });
      if (!purchase?.eventId) return Promise.resolve({ ok: false, skipped: true, reason: 'missing_fields' });
      const custom = {
        currency: String(purchase.currency ?? 'DOP').slice(0, 8),
        value: Number(purchase.value ?? 0),
        ...(purchase.orderId ? { order_id: String(purchase.orderId).slice(0, 80) } : {}),
        ...(purchase.contentIds?.length
          ? { content_ids: purchase.contentIds, content_type: 'product' }
          : {}),
        ...(purchase.contents?.length ? { contents: purchase.contents } : {}),
      };
      return send({
        eventName: PURCHASE_EVENT,
        eventId: purchase.eventId,
        eventTime: purchase.eventTime,
        eventSourceUrl: purchase.eventSourceUrl,
        userData: purchase.userData ?? {},
        customData: custom,
        testEventCode: purchase.testEventCode,
      });
    },
  };
}
