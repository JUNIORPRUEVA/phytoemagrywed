/**
 * Acciones de WhatsApp.
 *
 * Regla: el evento interno se registra ANTES de abrir WhatsApp, y el enlace se
 * construye en un solo lugar (`lib/whatsapp.js`) usando el número de configuración.
 */

import { attributionRef } from '../lib/attribution.js';
import { EVENTS } from '../lib/tracking.js';
import { promptChooseVariant } from './choose-variant.js';
import { on } from './dom.js';
import { buildOrderWhatsAppUrl, variantEventData } from './order-message.js';

/**
 * Añade la referencia de campaña al mensaje ya construido en el HTML
 * (así el CTA funciona incluso sin JavaScript).
 * @param {string} href
 * @param {string|null} ref
 */
export function withAttributionRef(href, ref) {
  if (!ref) return href;
  try {
    const url = new URL(href);
    const text = url.searchParams.get('text') ?? '';
    if (/\bRef:\s/.test(text)) return url.toString();
    // Se usa encodeURIComponent (igual que en el render) para que la codificación
    // del mensaje sea idéntica en el HTML estático y en el cliente.
    const base = `${url.origin}${url.pathname}`;
    return `${base}?text=${encodeURIComponent(`${text}\n\nRef: ${ref}`)}`;
  } catch {
    return href;
  }
}

/**
 * @param {object} ctx contexto de la app (ver `main.js`)
 */
export function initWhatsAppActions(ctx) {
  const { tracker, view } = ctx;

  on(document, 'click', (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;

    // ------------------------------------------------------------------
    // 1) "Pedir por WhatsApp": el mensaje lleva el pedido COMPLETO
    //    (producto, frasco, cantidad, precio y total).
    //
    //    Las tarjetas del carrusel traen `data-variant`, así que al pulsar
    //    el botón de un frasco la selección pasa a ESE frasco y el resumen
    //    de abajo se sincroniza (una sola fuente de verdad).
    // ------------------------------------------------------------------
    const orderLink = element.closest('[data-action="whatsapp-order"]');
    if (orderLink instanceof HTMLAnchorElement && ctx.selection) {
      const cardVariant = orderLink.dataset.variant ?? null;
      // Botón del resumen sin frasco elegido: no se abre un pedido a medias, se
      // pide que elija primero (y no se registra `click_whatsapp`: sería falso,
      // porque no se abrió WhatsApp).
      if (!cardVariant && !ctx.selection.get().variant) {
        event.preventDefault();
        tracker.trackEvent(EVENTS.CLICK_BUY, {
          source: orderLink.dataset.source ?? 'selector',
          blocked: 'no_variant',
          productId: view.product.id,
          productName: view.product.name,
          currency: view.currency,
        });
        promptChooseVariant(view);
        return;
      }

      if (cardVariant && ctx.selection.get().variantId !== cardVariant) {
        const state = ctx.selection.setVariant(cardVariant);
        tracker.trackEvent(EVENTS.SELECT_VARIANT, { source: 'card', ...variantEventData(state) });
      }
      const selection = ctx.selection.get();
      const url = buildOrderWhatsAppUrl(ctx, { selection });
      if (url) orderLink.href = url;
      tracker.trackEvent(EVENTS.CLICK_WHATSAPP, {
        source: orderLink.dataset.source ?? 'selector',
        context: 'selector',
        ref: ctx.getAttributionRef(),
        ...variantEventData(selection),
      });
      return;
    }

    // ------------------------------------------------------------------
    // 2) Comunidad: camino de CONFIANZA para quien todavía no compra.
    //    Se registra aparte (`click_community_group`) para no ensuciar la
    //    métrica de WhatsApp ni contarlo como Lead/compra.
    // ------------------------------------------------------------------
    const community = element.closest('[data-action="community"]');
    if (community) {
      const attribution = ctx.getAttribution?.() ?? null;
      tracker.trackEvent(EVENTS.CLICK_COMMUNITY_GROUP, {
        groupId: community.getAttribute('data-group'),
        groupName: community.getAttribute('data-group-name'),
        sourceSection: community.getAttribute('data-source-section') ?? 'comunidad',
        utm_campaign: attribution?.utm_campaign ?? null,
        utm_content: attribution?.utm_content ?? null,
        ref: ctx.getAttributionRef(),
      });
      return;
    }

    // ------------------------------------------------------------------
    // 3) Enlaces genéricos de WhatsApp (hero, footer, barra móvil…).
    // ------------------------------------------------------------------
    const target = element.closest('[data-action="whatsapp"]');
    if (!target || !(target instanceof HTMLAnchorElement)) return;

    const source = target.dataset.source ?? 'link';
    const ref = attributionRef(ctx.getAttribution());

    if (view.whatsapp.includeRef) {
      const enriched = withAttributionRef(target.href, ref);
      if (enriched !== target.href) target.href = enriched;
    }

    // Se registra SIEMPRE antes de que el navegador abra WhatsApp.
    tracker.trackEvent(EVENTS.CLICK_WHATSAPP, {
      source,
      context: 'link',
      ref,
      productId: view.product.id,
      productName: view.product.name,
      landingPage: ctx.getAttribution()?.landingPage ?? null,
    });
  });
}
