/**
 * Capa propia de eventos (tracking).
 *
 * Regla de oro: los componentes NUNCA llaman a Meta/Google directamente.
 * Todo pasa por `trackEvent()`, y los adaptadores (Meta Pixel, dataLayer, consola)
 * se registran desde un único punto (`src/client/init-tracking.js`).
 *
 * `purchase` SOLO puede dispararse con confirmación del backend/CRM.
 * Pulsar WhatsApp o enviar un formulario NO es una compra.
 */

export const EVENTS = Object.freeze({
  PAGE_VIEW: 'page_view',
  VIEW_PRODUCT: 'view_product',
  /** Presentación elegida en el selector (cápsulas + precio unitario). */
  SELECT_VARIANT: 'select_variant',
  CLICK_BUY: 'click_buy',
  CLICK_WHATSAPP: 'click_whatsapp',
  /**
   * Entrada a un grupo de la comunidad. Mide INTERÉS (visitante que todavía no
   * está listo para comprar): NO es un Lead ni una compra, y nunca se envía
   * como tal al CRM ni al pixel.
   */
  CLICK_COMMUNITY_GROUP: 'click_community_group',
  LEAD: 'lead',
  BEGIN_CHECKOUT: 'begin_checkout',
  PURCHASE: 'purchase',
});

export const SCHEMA_VERSION = '1.1';

/** Identificador de sesión anónimo (para deduplicar en el CRM). */
export const SESSION_KEY = 'analytics.sessionId';

/**
 * Prefijos de `event_id` por evento.
 *
 * El MISMO identificador tiene que viajar en las dos copias del evento (píxel
 * del navegador y API de conversiones del servidor) para que Meta deduplique y
 * no cuente la misma acción dos veces. El servidor usa estos mismos prefijos
 * (`server/meta-capi.mjs`).
 */
export const EVENT_ID_PREFIX = Object.freeze({
  [EVENTS.PAGE_VIEW]: 'pv',
  [EVENTS.VIEW_PRODUCT]: 'vc',
  [EVENTS.SELECT_VARIANT]: 'sv',
  [EVENTS.CLICK_BUY]: 'cb',
  [EVENTS.CLICK_WHATSAPP]: 'contact',
  [EVENTS.BEGIN_CHECKOUT]: 'ic',
  [EVENTS.LEAD]: 'lead',
  [EVENTS.PURCHASE]: 'purchase',
});

/** Cadena aleatoria corta (UUID si el navegador lo permite). */
function randomToken() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* ignorado a propósito */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `event_id` de una acción.
 *
 * - Sin `suffix`: `lead_<uuid>` (acción irrepetible, se genera una vez).
 * - Con `suffix`: `purchase_<pedido>` (mismo id siempre → idempotencia).
 *
 * @param {string} eventName
 * @param {string} [suffix]
 */
export function newEventId(eventName, suffix = '') {
  const fallback = String(eventName ?? 'evt')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  const prefix = EVENT_ID_PREFIX[eventName] ?? (fallback || 'evt');
  return suffix ? `${prefix}_${suffix}` : `${prefix}_${randomToken()}`;
}

/**
 * @typedef {object} TrackedEvent
 * @property {string} event
 * @property {string} timestamp
 * @property {string} sessionId
 * @property {Record<string, any>} data
 */

/**
 * Crea el tracker. Aislado para poder testearlo sin navegador.
 * @param {object} [options]
 * @param {{ name: string, track: (payload: TrackedEvent) => void }[]} [options.adapters]
 * @param {boolean} [options.debug]
 * @param {() => string} [options.sessionId]
 * @param {(payload: TrackedEvent) => void} [options.onEvent]  Persistencia local del plan de medición.
 */
export function createTracker(options = {}) {
  const { adapters = [], debug = false, sessionId, onEvent } = options;
  /** @type {{ name: string, track: (payload: TrackedEvent) => void }[]} */
  const registered = [...adapters];
  /** @type {TrackedEvent[]} */
  const history = [];
  /** Último payload de cada evento (para reenviarlo con el MISMO `event_id`). */
  const lastByEvent = new Map();

  const getId = sessionId ?? (() => 'anon');

  /**
   * @param {string} name
   * @param {Record<string, any>} [data]
   * @param {{ eventId?: string }} [options] `eventId` para compartirlo con el servidor
   * @returns {TrackedEvent|null}
   */
  function trackEvent(name, data = {}, options = {}) {
    if (typeof name !== 'string' || !name.trim()) return null;

    const eventId =
      typeof options.eventId === 'string' && options.eventId ? options.eventId : newEventId(name);
    const payload = {
      event: name,
      /** Se manda a Meta como `eventID` y viaja al CRM para el espejo server-side. */
      eventId,
      timestamp: new Date().toISOString(),
      sessionId: getId(),
      data: { ...data, schemaVersion: SCHEMA_VERSION },
    };

    history.push(payload);
    if (history.length > 100) history.shift();
    lastByEvent.set(name, payload);

    for (const adapter of registered) {
      try {
        adapter.track(payload);
      } catch (error) {
        // Un adaptador roto jamás puede romper la landing.
        if (debug) console.warn(`[tracking] adaptador "${adapter.name}" falló:`, error);
      }
    }

    try {
      onEvent?.(payload);
    } catch {
      /* ignorado a propósito */
    }

    if (debug) console.info('[tracking]', payload.event, payload.data);
    return payload;
  }

  return {
    trackEvent,
    addAdapter(adapter) {
      registered.push(adapter);
      return adapter;
    },
    getAdapters: () => [...registered],
    getHistory: () => [...history],
    /**
     * Último evento registrado con ese nombre (o null).
     *
     * Sirve para reenviar un evento a un adaptador que aparece MÁS TARDE (el
     * píxel se carga al aceptar la medición) sin inventarle otro `event_id`: la
     * acción es la misma, así que el identificador tiene que ser el mismo.
     *
     * @param {string} name
     * @returns {TrackedEvent|null}
     */
    getLastPayload: (name) => lastByEvent.get(name) ?? null,
    /**
     * SOLO desde la confirmación del backend/CRM.
     * @param {{ orderId?: string, value?: number, currency?: string, confirmedByBackend?: boolean } & Record<string, any>} payload
     */
    trackPurchase(payload = {}) {
      if (payload.confirmedByBackend !== true || !payload.orderId) {
        if (debug) {
          console.warn(
            '[tracking] purchase ignorado: requiere { orderId } y { confirmedByBackend: true } (confirmación del CRM).',
          );
        }
        return null;
      }
      return trackEvent(EVENTS.PURCHASE, payload);
    },
  };
}

/**
 * Adaptador dataLayer (compatible con GTM / Google Ads).
 * @param {{ allowed?: () => boolean }} [options]
 */
export function createDataLayerAdapter(options = {}) {
  const allowed = options.allowed ?? (() => true);
  return {
    name: 'dataLayer',
    track(payload) {
      if (!allowed()) return;
      if (typeof window === 'undefined') return;
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: payload.event, ...payload.data });
    },
  };
}

/**
 * Adaptador Meta Pixel. Carga `fbevents.js` LAZY y solo si:
 *  - hay Pixel ID configurado,
 *  - el usuario dio consentimiento publicitario.
 * Sin Pixel ID la landing funciona exactamente igual.
 * @param {object} options
 * @param {string} pixelId
 * @param {() => boolean} allowed
 * @param {(src: string) => void} [loadScript]
 * @param {boolean} [debug]
 * @param {{ seen: () => boolean, mark: () => void }} [contactGuard] una conversión Contact por sesión
 */
export function createMetaPixelAdapter(options) {
  const { pixelId, allowed, debug = false } = options;
  /** La primera vez de la sesión cuenta como `Contact`; las demás, como evento propio. */
  const contactGuard = options.contactGuard ?? { seen: () => false, mark: () => {} };
  let ready = false;
  let loading = false;

  /** Mapa evento interno -> evento estándar de Meta. */
  const MAP = {
    [EVENTS.PAGE_VIEW]: 'PageView',
    [EVENTS.VIEW_PRODUCT]: 'ViewContent',
    [EVENTS.BEGIN_CHECKOUT]: 'InitiateCheckout',
    [EVENTS.LEAD]: 'Lead',
    [EVENTS.PURCHASE]: 'Purchase',
  };

  function load() {
    if (ready || loading || typeof window === 'undefined' || typeof document === 'undefined') return;
    loading = true;
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.head || b.getElementsByTagName('head')[0] || b.documentElement;
      s.appendChild(t);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', pixelId);
    ready = true;
  }

  return {
    name: 'metaPixel',
    pixelId,
    track(payload) {
      if (!pixelId) return;
      if (!allowed()) return;
      const data = payload.data ?? {};
      /** Mismo `event_id` que usará el servidor para el espejo de este evento. */
      const eventOptions = payload.eventId ? { eventID: payload.eventId } : null;
      const mapped = MAP[payload.event] ?? null;
      load();
      if (!ready || typeof window.fbq !== 'function') return;

      /** Llama a `fbq('track', …)` conservando la posición de los argumentos. */
      const track = (name, params) => {
        const args = [name];
        if (params) args.push(params);
        if (eventOptions) {
          if (!params) args.push({});
          args.push(eventOptions);
        }
        window.fbq('track', ...args);
      };

      /*
       * Clic en WhatsApp = INTERACCIÓN, nunca compra.
       * La primera de la sesión se cuenta como `Contact` (el evento estándar que
       * el negocio configuró en Meta); las siguientes van como evento propio,
       * porque volver a pulsar no es un contacto nuevo.
       */
      if (payload.event === EVENTS.CLICK_WHATSAPP) {
        if (!contactGuard.seen()) {
          track('Contact', data.productName ? { content_name: data.productName } : null);
          contactGuard.mark();
        }
        window.fbq('trackCustom', 'click_whatsapp', {
          ...(data.source ? { source: data.source } : {}),
          ...(data.context ? { context: data.context } : {}),
        });
        return;
      }

      // Evento propio de la landing: se manda como personalizado (nunca como un
      // evento estándar inventado) y jamás se convierte en conversión.
      if (!mapped) {
        window.fbq('trackCustom', payload.event);
        return;
      }

      if (mapped === 'InitiateCheckout') {
        track(mapped, {
          content_ids: [data.productId].filter(Boolean),
          content_name: data.productName ?? undefined,
          num_items: data.quantity,
          value: data.value ?? undefined,
          currency: data.currency ?? undefined,
        });
        return;
      }
      if (mapped === 'Lead') {
        track(mapped, { content_name: data.productName ?? undefined });
        return;
      }
      if (mapped === 'Purchase') {
        track(mapped, { value: data.value, currency: data.currency });
        return;
      }
      if (mapped === 'ViewContent') {
        track(mapped, {
          content_ids: [data.productId].filter(Boolean),
          content_name: data.productName ?? undefined,
          content_type: 'product',
        });
        return;
      }
      track(mapped, null);
    },
    /** Usado en la confirmación posterior del CRM (el pixel puede no estar cargado). */
    get loaded() {
      return ready;
    },
    ...(debug ? { _load: load } : {}),
  };
}
