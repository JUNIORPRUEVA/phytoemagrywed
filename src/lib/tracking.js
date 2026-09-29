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

  const getId = sessionId ?? (() => 'anon');

  /**
   * @param {string} name
   * @param {Record<string, any>} [data]
   * @returns {TrackedEvent|null}
   */
  function trackEvent(name, data = {}) {
    if (typeof name !== 'string' || !name.trim()) return null;

    const payload = {
      event: name,
      timestamp: new Date().toISOString(),
      sessionId: getId(),
      data: { ...data, schemaVersion: SCHEMA_VERSION },
    };

    history.push(payload);
    if (history.length > 100) history.shift();

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
 */
export function createMetaPixelAdapter(options) {
  const { pixelId, allowed, debug = false } = options;
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
      const mapped = MAP[payload.event] ?? payload.event;
      // Eventos propios (click_buy, click_whatsapp) también se envían como custom.
      load();
      if (!ready || typeof window.fbq !== 'function') return;
      const data = payload.data ?? {};
      if (mapped === 'InitiateCheckout') {
        window.fbq('track', mapped, {
          content_ids: [data.productId].filter(Boolean),
          content_name: data.productName ?? undefined,
          num_items: data.quantity,
          value: data.value ?? undefined,
          currency: data.currency ?? undefined,
        });
        return;
      }
      if (mapped === 'Lead') {
        window.fbq('track', mapped, { content_name: data.productName ?? undefined });
        return;
      }
      if (mapped === 'Purchase') {
        window.fbq('track', mapped, { value: data.value, currency: data.currency });
        return;
      }
      if (mapped === 'ViewContent') {
        window.fbq('track', mapped, {
          content_ids: [data.productId].filter(Boolean),
          content_name: data.productName ?? undefined,
          content_type: 'product',
        });
        return;
      }
      window.fbq('track', mapped);
    },
    /** Usado en la confirmación posterior del CRM (el pixel puede no estar cargado). */
    get loaded() {
      return ready;
    },
    ...(debug ? { _load: load } : {}),
  };
}
