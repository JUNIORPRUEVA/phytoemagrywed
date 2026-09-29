/**
 * CARRUSEL DE FRASCOS (sección #frascos).
 *
 * - El carrusel es un contenedor con scroll horizontal: se desliza con el dedo
 *   (y con la rueda/teclado). Las flechas se activan con JavaScript: sin JS el
 *   carrusel sigue funcionando, simplemente no se muestran botones que no hacen
 *   nada.
 * - Las tarjetas son radios reales (`<input type="radio">`), así que se eligen
 *   con teclado y sin JavaScript.
 * - Cada tarjeta tiene su botón "Pedir por WhatsApp" con SU frasco.
 * - Al cambiar el frasco se actualizan: precio, cantidad, resumen, total, los
 *   enlaces de WhatsApp y el evento `select_variant`.
 * - La cantidad son FRASCOS de esa presentación (no cápsulas).
 */

import { EVENTS } from '../lib/tracking.js';
import { on, qs, qsa } from './dom.js';
import { variantEventData } from './order-message.js';

/**
 * Ancho de una tarjeta + el hueco entre tarjetas: así las flechas avanzan
 * exactamente una tarjeta (alineado con `scroll-snap`).
 * @param {HTMLElement} scroller
 * @param {Element[]} cards
 */
function cardStep(scroller, cards) {
  const card = cards[0];
  if (!card) return 0;
  const styles = getComputedStyle(scroller);
  const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0;
  return card.getBoundingClientRect().width + gap;
}

/**
 * Flechas del carrusel: desplazan una tarjeta y se desactivan cuando ya no
 * queda nada que ver en ese lado.
 * @param {object} ctx
 */
function initCarousel(ctx) {
  const section = qs('#frascos');
  const scroller = qs('[data-carousel]', section);
  const prev = /** @type {HTMLButtonElement|null} */ (qs('[data-carousel-prev]', section));
  const next = /** @type {HTMLButtonElement|null} */ (qs('[data-carousel-next]', section));
  if (!scroller || (!prev && !next)) return;

  const cards = qsa('[data-variant-card]', scroller);
  const scroll = (delta) => {
    // jsdom no implementa scrollBy: se usa como mejora, no como requisito.
    if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ left: delta, behavior: 'smooth' });
    else scroller.scrollLeft += delta;
  };

  /** Refleja si todavía se puede seguir deslizando en cada lado. */
  const update = () => {
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (prev) prev.disabled = scroller.scrollLeft <= 2;
    if (next) next.disabled = scroller.scrollLeft >= maxScroll - 2;
  };

  on(prev, 'click', () => scroll(-cardStep(scroller, cards)));
  on(next, 'click', () => scroll(cardStep(scroller, cards)));
  on(scroller, 'scroll', update, { passive: true });

  for (const button of [prev, next]) {
    if (button?.parentElement instanceof HTMLElement) button.parentElement.hidden = false;
  }
  update();
  if (ctx.view.site.tracking.debug) console.info('[carousel] frascos listos');
}

/** @param {object} ctx */
export function initVariantSelector(ctx) {
  const { view, tracker } = ctx;
  const section = qs('#frascos');
  if (!section || !ctx.selection) return null;

  const store = ctx.selection;
  const qtyInput = /** @type {HTMLInputElement|null} */ (qs('[data-qty-input]', section));
  const summaryVariant = qs('[data-summary-variant]', section);
  const summaryUnit = qs('[data-summary-unit]', section);
  const summaryCapsules = qs('[data-summary-capsules]', section);
  const summaryTotal = qs('[data-summary-total]', section);
  /** TODOS los botones de pedido: uno por tarjeta (+ el del resumen). */
  const orderLinks = /** @type {HTMLAnchorElement[]} */ (qsa('[data-action="whatsapp-order"]', section));
  const cards = qsa('[data-variant-card]', section);

  /** Sincroniza la interfaz con el estado actual. */
  function render(state, reason) {
    const { variant, quantity, totals } = state;
    const label = variant?.priceLabel ?? view.content.selector.priceOnRequest;

    if (summaryVariant) summaryVariant.textContent = variant?.name ?? view.content.selector.priceOnRequest;
    if (summaryUnit) summaryUnit.textContent = label;
    if (summaryCapsules && totals.totalCapsules) summaryCapsules.textContent = String(totals.totalCapsules);
    if (summaryTotal) summaryTotal.textContent = totals.totalLabel ?? view.content.selector.priceOnRequest;
    if (qtyInput && String(qtyInput.value) !== String(quantity)) qtyInput.value = String(quantity);

    for (const card of cards) {
      const selected = card.getAttribute('data-variant-card') === variant?.id;
      card.setAttribute('data-selected', selected ? 'true' : 'false');
      const input = /** @type {HTMLInputElement|null} */ (card.querySelector('[data-variant-input]'));
      if (input) input.checked = selected;
    }

    // Cada botón de WhatsApp lleva su propio pedido: el de una tarjeta, SU frasco
    // (el del resumen, la selección vigente con la cantidad elegida).
    if (reason !== 'init') {
      for (const link of orderLinks) {
        const url = ctx.buildOrderUrl({ variantId: link.dataset.variant });
        if (url) link.href = url;
      }
    }
  }

  // ---- Selección de presentación ----
  for (const input of qsa('[data-variant-input]', section)) {
    on(input, 'change', () => {
      if (!(input instanceof HTMLInputElement) || !input.checked) return;
      const state = store.setVariant(input.value);
      tracker.trackEvent(EVENTS.SELECT_VARIANT, {
        source: 'selector',
        ...variantEventData(state),
      });
    });
  }

  // ---- Cantidad de unidades ----
  on(qs('[data-qty-increase]', section), 'click', () => store.increase());
  on(qs('[data-qty-decrease]', section), 'click', () => store.decrease());
  on(qtyInput, 'change', () => store.setQuantity(qtyInput?.value));
  on(qtyInput, 'blur', () => store.setQuantity(qtyInput?.value));

  // ---- Suscripción al estado ----
  store.subscribe(render);
  render(store.get(), 'init');
  initCarousel(ctx);

  return { render };
}
