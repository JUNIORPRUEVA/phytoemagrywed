/**
 * Bootstrap de la landing.
 *
 * Orden estricto:
 *   1. Captura de atribución (UTM/fbclid) ANTES de cualquier evento.
 *   2. Tracker + (si procede) medición publicitaria con consentimiento.
 *   3. Eventos de página (page_view, view_product).
 *   4. Interacción: nav, banner, WhatsApp, modal de compra, formulario.
 *
 * Todo va envuelto en try/catch: si algo falla, la web sigue siendo usable.
 */

import { attributionRef, getAttribution, persistAttribution } from '../lib/attribution.js';
import { createCrmClient } from '../lib/api.js';
import { createConsent } from '../lib/consent.js';
import { createStorage } from '../lib/storage.js';
import { EVENTS, newEventId } from '../lib/tracking.js';
import { buildView } from '../render/view.js';
import { initCheckout } from './checkout.js';
import { initConsentBanner, initNav } from './consent-banner.js';
import { initLeadForm } from './lead-form.js';
import { initTracking } from './init-tracking.js';
import { buildOrderWhatsAppUrl, variantEventData } from './order-message.js';
import { createSelectionStore } from './selection.js';
import { initVariantSelector } from './variant-selector.js';
import { initWhatsAppActions } from './whatsapp-actions.js';

export function boot() {
  const view = buildView();
  const debug = view.site.tracking.debug === true;

  const local = createStorage('pe', 'local');
  const session = createStorage('pe', 'session');

  // 1) Atribución: se guarda antes de cualquier otro evento.
  persistAttribution({ local, session });

  const consent = createConsent({ storage: local });
  const tracking = initTracking({ view, consent, storage: local });
  const { tracker } = tracking;

  const crm = createCrmClient({
    endpoint: view.site.crm.endpoint,
    storage: local,
    timeoutMs: view.site.crm.timeoutMs,
    debug,
  });

  // Estado compartido de presentación + cantidad de unidades.
  const selection = createSelectionStore({ view, storage: session });

  const ctx = {
    view,
    tracker,
    crm,
    consent,
    selection,
    enableAds: tracking.enableAds,
    sessionId: () => tracking.sessionId,
    /**
     * `event_id` de los eventos que la API de conversiones también va a enviar
     * (espejo del píxel): el pedido los lleva para que Meta deduplique.
     * @type {{ viewContent?: string, initiateCheckout?: string }}
     */
    eventIds: {},
    /** URL exacta donde ocurrió la acción (`event_source_url` de CAPI). */
    currentUrl: () => (typeof location === 'undefined' ? null : location.href),
    getAttribution: () => getAttribution({ local, session }),
    getAttributionRef: () => attributionRef(getAttribution({ local, session })),
    /** Enlace de WhatsApp del pedido con la selección vigente (o un frasco concreto). */
    buildOrderUrl: (options = {}) =>
      buildOrderWhatsAppUrl(ctx, { template: view.content.whatsapp.checkout, ...options }),
  };

  // 2) Eventos iniciales.
  const attribution = ctx.getAttribution();
  tracker.trackEvent(EVENTS.PAGE_VIEW, {
    page: 'landing',
    landingPage: attribution?.landingPage ?? null,
    referrer: attribution?.referrer ?? null,
    hasCampaign: Boolean(attributionRef(attribution)),
  });
  const viewProduct = tracker.trackEvent(EVENTS.VIEW_PRODUCT, {
    productId: view.product.id,
    productName: view.product.name,
    currency: view.currency,
    variants: view.pricing.variants.length,
    ...variantEventData(selection.get()),
  });
  // El pedido reenviará este mismo id si el servidor manda el `ViewContent`.
  ctx.eventIds.viewContent = viewProduct?.eventId ?? newEventId(EVENTS.VIEW_PRODUCT);

  // 3) Interacción.
  initNav();
  initConsentBanner(ctx);
  initWhatsAppActions(ctx);
  initVariantSelector(ctx);
  const checkout = initCheckout(ctx);
  initLeadForm(ctx);

  // Reintento de los envíos que quedaron pendientes (móvil sin datos, servidor
  // reiniciándose...). Se lanza cuando la página ya está lista, no antes: la
  // medición y la interacción nunca esperan a la red.
  const retryPending = () => {
    crm.flushQueue().catch(() => {});
  };
  if (document.readyState === 'complete') window.setTimeout(retryPending, 1500);
  else window.addEventListener('load', () => window.setTimeout(retryPending, 1500), { once: true });

  // 4) API pública mínima (documentada en docs/CRM-CONTRACT.md).
  window.Phytoemagry = {
    version: '1.1.0',
    track: (name, data) => tracker.trackEvent(name, data),
    /** Solo para la confirmación real desde el CRM/backend. */
    confirmPurchase: (payload) => tracker.trackPurchase({ ...payload, confirmedByBackend: true }),
    getAttribution: ctx.getAttribution,
    openCheckout: (source = 'api') => checkout?.open(source),
    /** Presentación y cantidad actuales. */
    getSelection: () => selection.get(),
    selectVariant: (id, quantity) => {
      selection.setVariant(id);
      if (quantity !== undefined) selection.setQuantity(quantity);
      return selection.get();
    },
    /** Cola local pendiente de enviar al CRM (modo sin endpoint). */
    pendingCrmItems: () => crm.listQueued(),
    /** Fuerza el reintento de la cola pendiente (lo hace solo al cargar la página). */
    retryPendingCrmItems: () => crm.flushQueue(),
    debug,
  };

  if (debug) {
    console.info('[phytoemagry] landing lista', {
      whatsapp: view.whatsapp.enabled,
      frascos: view.pricing.variants.length,
      variantePorDefecto: view.pricing.defaultVariantId,
      comunidad: view.community.active?.id ?? null,
      pixel: Boolean(view.site.tracking.metaPixelId),
      crm: crm.enabled,
      atribucion: attributionRef(attribution),
    });
  }

  return ctx;
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        boot();
      } catch (error) {
        console.error('[phytoemagry] error al inicializar:', error);
      }
    });
  } else {
    boot();
  }
} catch (error) {
  console.error('[phytoemagry] error al inicializar:', error);
}
