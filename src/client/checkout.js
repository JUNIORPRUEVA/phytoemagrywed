/**
 * Flujo de compra: botones "Comprar" → modal de pedido → WhatsApp.
 *
 * Lo que NO hace (a propósito):
 *  - no cobra nada,
 *  - no pide datos de tarjeta,
 *  - no dispara `purchase` (eso solo lo confirma el CRM/backend).
 */

import { buildLeadPayload, buildOrderIntentPayload } from '../lib/api.js';
import { EVENTS } from '../lib/tracking.js';
import { sanitizeName } from '../lib/validation.js';
import { clearFieldErrors, focusById, hideElement, on, prefersReducedMotion, qs, setAlert, setFieldError, showElement } from './dom.js';
import { promptChooseVariant } from './choose-variant.js';
import { buildOrderWhatsAppUrl, variantEventData } from './order-message.js';
import { openWhatsAppWindow } from './whatsapp-open.js';

/**
 * @param {object} ctx
 */
export function initCheckout(ctx) {
  const { tracker, view, crm } = ctx;
  /** @type {HTMLDialogElement|null} */
  const dialog = qs('[data-checkout]');
  const form = qs('#pe-checkout-form');
  if (!dialog || !form) return null;

  const store = ctx.selection;
  const summaryVariant = qs('[data-summary-variant]', form);
  const summaryUnit = qs('[data-summary-unit]', form);
  const summaryQty = qs('[data-summary-qty]', form);
  const summaryCapsules = qs('[data-summary-capsules]', form);
  const summaryTotal = qs('[data-summary-total]', form);
  const alertBox = qs('[data-form-alert]', form);
  const successPanel = qs('[data-checkout-success]', dialog);
  const fallbackBox = qs('[data-whatsapp-fallback]', dialog);
  const fallbackLink = /** @type {HTMLAnchorElement|null} */ (qs('[data-whatsapp-fallback-link]', dialog));

  /** Última intención de pedido enviada (por si el CRM quiere reintentar). */
  let lastOrderIntent = null;

  const priceOnRequest = view.content.checkout.labels.priceOnRequest;

  /** Refleja la selección (presentación + unidades) en el resumen del modal. */
  function updateSummary() {
    const state = store.get();
    const { variant, quantity, totals } = state;
    if (summaryVariant) summaryVariant.textContent = variant?.name ?? view.content.checkout.labels.notChosen;
    if (summaryUnit) summaryUnit.textContent = variant?.priceLabel ?? priceOnRequest;
    if (summaryQty) summaryQty.textContent = String(quantity);
    if (summaryCapsules) summaryCapsules.textContent = variant ? String(totals.totalCapsules ?? '') : '';
    if (summaryTotal) summaryTotal.textContent = totals.totalLabel ?? priceOnRequest;
    return state;
  }

  function open(source) {
    // Sin frasco elegido no se abre el pedido: se pide que lo elija primero.
    if (!store.get().variant) {
      tracker.trackEvent(EVENTS.CLICK_BUY, {
        source,
        blocked: 'no_variant',
        productId: view.product.id,
        productName: view.product.name,
        currency: view.currency,
      });
      promptChooseVariant(view);
      return null;
    }

    clearFieldErrors(form);
    setAlert(alertBox, '');
    hideElement(successPanel);
    showElement(form);
    updateSummary();

    tracker.trackEvent(EVENTS.CLICK_BUY, {
      source,
      productId: view.product.id,
      productName: view.product.name,
      currency: view.currency,
      ...variantEventData(store.get()),
    });

    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    }

    tracker.trackEvent(EVENTS.BEGIN_CHECKOUT, {
      source,
      productId: view.product.id,
      productName: view.product.name,
      currency: view.currency,
      ...variantEventData(store.get()),
    });

    // Foco en el primer campo (accesibilidad) sin robar el scroll.
    window.setTimeout(() => focusById('pe-co-name'), prefersReducedMotion() ? 0 : 60);

    return store.get();
  }

  function close() {
    // jsdom (tests) y navegadores antiguos pueden no implementar dialog.close().
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } else {
      dialog.removeAttribute('open');
    }
  }

  /**
   * Abre WhatsApp. Se ejecuta de forma síncrona dentro del gesto del usuario
   * para que el navegador no bloquee la pestaña nueva.
   */
  function openWhatsApp(url) {
    if (!url) return false;
    const opened = openWhatsAppWindow(url);
    if (!opened) {
      // Bloqueado por el navegador: dejamos el enlace visible para pulsarlo.
      if (fallbackBox && fallbackLink) {
        fallbackLink.href = url;
        showElement(fallbackBox);
      }
      return false;
    }
    return true;
  }

  on(dialog, 'click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-checkout-close]') : null;
    if (target) close();

    // "Cambiar presentación": cierra el modal y lleva al selector.
    const change = event.target instanceof Element ? event.target.closest('[data-change-variant]') : null;
    if (change) {
      close();
      const section = document.getElementById('frascos');
      if (section) {
        // Defensivo: entornos sin scrollIntoView (jsdom, navegadores antiguos).
        if (typeof section.scrollIntoView === 'function') {
          section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        } else {
          window.location.hash = '#frascos';
        }
        const selected = /** @type {HTMLInputElement|null} */ (
          section.querySelector('[data-variant-input]:checked') ?? section.querySelector('[data-variant-input]')
        );
        window.setTimeout(() => selected?.focus({ preventScroll: true }), prefersReducedMotion() ? 0 : 400);
      }
    }
  });

  // Si la presentación o la cantidad cambian en cualquier sitio, el resumen se actualiza.
  store.subscribe((state, reason) => {
    if (reason === 'variant' || reason === 'quantity') updateSummary();
  });

  on(form, 'submit', (event) => {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement)) return;

    clearFieldErrors(form);
    setAlert(alertBox, '');

    // Formulario mínimo: SOLO el nombre. El frasco y la cantidad ya se eligieron
    // arriba y el pedido se cierra en WhatsApp (donde el negocio ve el número).
    const data = new FormData(form);
    const name = sanitizeName(data.get('name'));
    if (!name || name.length < 2) {
      setFieldError(form, 'name', view.content.errors[name ? 'name_too_short' : 'name_required']);
      setAlert(alertBox, view.content.leadForm.errorSummary);
      focusById('pe-co-name');
      tracker.trackEvent('form_error', { form: 'checkout', fields: ['name'] });
      return;
    }

    const selection = store.get();
    const { variant, quantity, totals } = selection;
    // Si llegara aquí sin frasco (no debería: `open()` lo impide), se pide elegir.
    if (!variant) {
      promptChooseVariant(view);
      return;
    }

    const attribution = ctx.getAttribution();
    const source = 'checkout';

    // 1) Lead + intención de pedido (van al CRM cuando exista endpoint; si no,
    //    quedan en la cola local del navegador).
    const lead = buildLeadPayload({
      name,
      phone: null,
      location: null,
      source,
      consent: true,
      consentVersion: view.site.crm.consentTextVersion,
      attribution,
      productId: view.product.id,
      variant,
      quantity,
      sessionId: ctx.sessionId(),
    });
    const orderIntent = buildOrderIntentPayload({
      customer: { id: lead.id, name: lead.name, phone: lead.phone, location: lead.location },
      product: { id: view.product.id, name: view.product.name, currency: view.currency },
      variant,
      quantity,
      source,
      attribution,
      sessionId: ctx.sessionId(),
    });
    lastOrderIntent = orderIntent;

    const submission = Promise.all([crm.submitLead(lead), crm.submitOrderIntent(orderIntent)]).catch((error) => {
      if (view.site.tracking.debug) console.warn('[checkout] envío al CRM falló:', error);
      return null;
    });

    tracker.trackEvent(EVENTS.LEAD, {
      source,
      channel: 'checkout',
      productId: view.product.id,
      productName: view.product.name,
      orderIntentId: orderIntent.id,
      currency: view.currency,
      consent: true,
      ...variantEventData(selection),
    });

    // 2) WhatsApp (síncrono, conserva el gesto del usuario).
    //    Si no hay número configurado no hay enlace y, por tanto, NO se registra
    //    `click_whatsapp` (sería una métrica falsa: no se abrió WhatsApp).
    const url = buildOrderWhatsAppUrl(ctx, {
      selection,
      customer: { name },
      template: view.content.whatsapp.checkout,
    });
    const opened = url ? openWhatsApp(url) : false;

    if (url) {
      tracker.trackEvent(EVENTS.CLICK_WHATSAPP, {
        source,
        context: 'checkout',
        orderIntentId: orderIntent.id,
        ref: ctx.getAttributionRef(),
        opened,
        ...variantEventData(selection),
      });
    }

    // 3) Estado final del modal.
    hideElement(form);
    showElement(successPanel);
    if (successPanel && successPanel instanceof HTMLElement) successPanel.focus();
    if (!opened && !fallbackBox) {
      setAlert(alertBox, view.content.errors.generic);
    }
  });

  // Delegación: cualquier botón "Comprar" de la página abre el modal.
  on(document, 'click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action="buy"]') : null;
    if (!target) return;
    event.preventDefault();
    open(target.getAttribute('data-source') ?? 'unknown');
  });

  return {
    open,
    close,
    updateSummary,
    getLastOrderIntent: () => lastOrderIntent,
  };
}
