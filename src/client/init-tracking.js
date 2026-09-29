/**
 * Inicialización de la capa de medición.
 *
 * - Crea el tracker con los adaptadores que correspondan.
 * - Meta Pixel SOLO se instancia si hay Pixel ID; y SOLO envía datos si el
 *   usuario aceptó el banner de medición.
 * - Sin Pixel ID la web funciona exactamente igual (consola limpia).
 */

import { createConsent } from '../lib/consent.js';
import { createDataLayerAdapter, createMetaPixelAdapter, createTracker, EVENTS, SESSION_KEY } from '../lib/tracking.js';
import { createStorage } from '../lib/storage.js';

/** Identificador de sesión anónimo (persistente en la sesión del navegador). */
export function getSessionId(storage = createStorage('pe', 'session')) {
  let id = storage.get(SESSION_KEY);
  if (!id) {
    id = `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    storage.set(SESSION_KEY, id);
  }
  return id;
}

/**
 * @param {object} input
 * @param {import('../render/view.js').buildView extends (...args: any) => infer R ? R : any} input.view
 * @param {ReturnType<typeof createConsent>} [input.consent]
 * @param {ReturnType<typeof createStorage>} [input.storage]
 */
export function initTracking(input) {
  const { view } = input;
  const storage = input.storage ?? createStorage('pe', 'local');
  const consent = input.consent ?? createConsent({ storage });
  const debug = view.site.tracking.debug === true;
  const pixelId = view.site.tracking.metaPixelId;
  const sessionId = getSessionId();

  /** @type {{ name: string, track: Function }[]} */
  const adsAdapters = [];
  let adsStarted = false;

  const tracker = createTracker({
    debug,
    sessionId: () => sessionId,
    onEvent: view.site.tracking.keepLocalLog
      ? (payload) => {
          const log = storage.get('analytics.log') ?? [];
          log.push({ ...payload, data: { ...payload.data, attribution: undefined } });
          storage.set('analytics.log', log.slice(-100));
        }
      : undefined,
  });

  if (view.site.tracking.dataLayer) {
    adsAdapters.push(createDataLayerAdapter({ allowed: () => consent.adsAllowed() }));
  }

  const metaPixel = pixelId
    ? createMetaPixelAdapter({ pixelId, allowed: () => consent.adsAllowed(), debug })
    : null;
  if (metaPixel) adsAdapters.push(metaPixel);

  /** Se llama cuando el usuario acepta la medición. */
  function enableAds(context = {}) {
    if (adsStarted) return;
    adsStarted = true;
    // El pixel puede aparecer DESPUÉS del page_view inicial: se le reenvía el
    // estado actual para no perder el PageView/ViewContent de esta visita.
    for (const adapter of adsAdapters) {
      try {
        adapter.track({
          event: EVENTS.PAGE_VIEW,
          timestamp: new Date().toISOString(),
          sessionId,
          data: { page: 'landing' },
        });
        if (view.flags.pricing || view.product.id) {
          adapter.track({
            event: EVENTS.VIEW_PRODUCT,
            timestamp: new Date().toISOString(),
            sessionId,
            data: {
              productId: view.product.id,
              productName: view.product.name,
              value: view.pricing.hasPrice ? view.pricing.unitPrice : undefined,
              currency: view.currency,
            },
          });
        }
      } catch (error) {
        if (debug) console.warn('[tracking] no se pudo inicializar la medición publicitaria:', error);
      }
    }
    if (debug && context.reason) console.info('[tracking] medición publicitaria habilitada:', context.reason);
  }

  if (adsAdapters.length > 0 && consent.adsAllowed()) enableAds({ reason: 'consentimiento previo' });

  return { tracker, consent, sessionId, metaPixel, enableAds, hasAds: adsAdapters.length > 0 };
}
