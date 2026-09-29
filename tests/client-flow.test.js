/**
 * FLUJOS DE CLIENTE (jsdom sobre el HTML generado realmente).
 *
 * Cubre el recorrido comercial completo:
 *   landing → selector de frasco → cantidad → Comprar → datos →
 *   OrderIntent → WhatsApp.
 */

import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCrmClient, QUEUE_KEY } from '../src/lib/api.js';
import { buildAttribution } from '../src/lib/attribution.js';
import { siteConfig } from '../src/config/site.config.js';
import { createConsent } from '../src/lib/consent.js';
import { createMemoryStorage } from '../src/lib/storage.js';
import { createTracker, EVENTS } from '../src/lib/tracking.js';
import { renderIndexPage } from '../src/render/pages.js';
import { initCheckout } from '../src/client/checkout.js';
import { initConsentBanner } from '../src/client/consent-banner.js';
import { initLeadForm } from '../src/client/lead-form.js';
import { buildOrderWhatsAppUrl } from '../src/client/order-message.js';
import { createSelectionStore } from '../src/client/selection.js';
import { initVariantSelector } from '../src/client/variant-selector.js';
import { initWhatsAppActions } from '../src/client/whatsapp-actions.js';
import { makeShopView } from './helpers.js';

const attribution = buildAttribution({
  href: 'https://landing.test/?utm_source=facebook&utm_campaign=verano',
  params: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'verano' },
  referrer: 'https://facebook.com/ads',
  now: '2026-01-01T00:00:00.000Z',
});

/** Monta la landing real en jsdom y conecta los módulos de cliente. */
function mount(options = {}) {
  const { whatsapp = '18095551234', pixelId = null, ...viewOptions } = options;
  const view = makeShopView({ whatsapp, siteUrl: 'https://phytoemagry.example', pixelId, ...viewOptions });
  const html = renderIndexPage(view);

  const dom = new JSDOM(html, { url: 'https://landing.test/' });
  document.documentElement.innerHTML = dom.window.document.documentElement.innerHTML;

  const storage = createMemoryStorage();
  const session = createMemoryStorage();
  /** @type {{ event: string, data: any }[]} */
  const events = [];
  const tracker = createTracker({ adapters: [{ name: 'spy', track: (payload) => events.push(payload) }] });
  const crm = createCrmClient({ endpoint: null, storage });
  const consent = createConsent({ storage });
  const selection = createSelectionStore({ view, storage: session });
  const enableAds = vi.fn();

  const ctx = {
    view,
    tracker,
    crm,
    consent,
    selection,
    enableAds,
    sessionId: () => 's_test',
    getAttribution: () => attribution,
    getAttributionRef: () => 'facebook/cpc/verano',
  };
  ctx.buildOrderUrl = (options = {}) =>
    buildOrderWhatsAppUrl(ctx, { template: view.content.whatsapp.checkout, ...options });

  const selector = initVariantSelector(ctx);
  const checkout = initCheckout(ctx);
  initLeadForm(ctx);
  initWhatsAppActions(ctx);
  initConsentBanner(ctx);

  const $ = (selectorText) => document.querySelector(selectorText);
  const inOrder = (selectorText) => $(`[data-order] ${selectorText}`);

  return {
    view,
    ctx,
    selector,
    checkout,
    selection,
    consent,
    storage,
    session,
    events,
    enableAds,
    $,
    inOrder,
    eventNames: () => events.map((event) => event.event),
    variantCard: (id) => $(`[data-variant-card="${id}"]`),
    selectVariant(id) {
      const input = $(`[data-variant-input][value="${id}"]`);
      input.checked = true;
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      return input;
    },
    clickInOrder(selectorText) {
      inOrder(selectorText).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    setQty(value) {
      const input = inOrder('[data-qty-input]');
      input.value = String(value);
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    fill(selectorText, value) {
      const input = $(selectorText);
      input.value = value;
      return input;
    },
    check(selectorText) {
      const input = $(selectorText);
      input.checked = true;
      return input;
    },
    submit(selectorText) {
      $(selectorText).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    },
    click(selectorText) {
      const el = $(selectorText);
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let openSpy;

beforeEach(() => {
  openSpy = vi.fn(() => ({}));
  window.open = openSpy;
  window.localStorage.clear();
});

describe('selector de frascos', () => {
  it('muestra la presentación preseleccionada y su precio', () => {
    const app = mount();
    expect(app.inOrder('[data-summary-variant]').textContent).toBe('10 cápsulas');
    expect(app.inOrder('[data-summary-unit]').textContent).toBe('RD$2,500');
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$2,500');
    expect(app.variantCard('capsules_10').getAttribute('data-selected')).toBe('true');
  });

  it('al elegir otra presentación actualiza precio, total y evento', () => {
    const app = mount();
    app.selectVariant('capsules_30');

    expect(app.inOrder('[data-summary-variant]').textContent).toBe('30 cápsulas');
    expect(app.inOrder('[data-summary-unit]').textContent).toBe('RD$6,000');
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$6,000');
    expect(app.variantCard('capsules_30').getAttribute('data-selected')).toBe('true');
    expect(app.variantCard('capsules_10').getAttribute('data-selected')).toBe('false');

    const selectEvent = app.events.find((event) => event.event === EVENTS.SELECT_VARIANT);
    expect(selectEvent.data).toMatchObject({ variantId: 'capsules_30', capsules: 30, unitPrice: 6000, quantity: 1, total: 6000, source: 'selector' });
  });

  it('la cantidad son unidades: 10 cápsulas × 2 = RD$5,000 (20 cápsulas)', () => {
    const app = mount();
    app.setQty(2);
    expect(app.inOrder('[data-qty-input]').value).toBe('2');
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$5,000');
    expect(app.inOrder('[data-summary-capsules]').textContent).toBe('20');
    expect(app.selection.get().totals.totalCapsules).toBe(20);
  });

  it('30 × 2 = RD$12,000 y 60 × 2 = RD$20,000', () => {
    const app = mount();
    app.selectVariant('capsules_30');
    app.setQty(2);
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$12,000');
    expect(app.inOrder('[data-summary-capsules]').textContent).toBe('60');

    app.selectVariant('capsules_60');
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$20,000');
    expect(app.inOrder('[data-summary-capsules]').textContent).toBe('120');
    expect(app.selection.get().totals.totalCapsules).toBe(120);
  });

  it('los botones + y − cambian la cantidad respetando los límites', () => {
    const app = mount();
    app.clickInOrder('[data-qty-increase]');
    app.clickInOrder('[data-qty-increase]');
    expect(app.inOrder('[data-qty-input]').value).toBe('3');

    app.clickInOrder('[data-qty-decrease]');
    expect(app.inOrder('[data-qty-input]').value).toBe('2');

    for (let i = 0; i < 5; i += 1) app.clickInOrder('[data-qty-decrease]');
    expect(app.inOrder('[data-qty-input]').value).toBe('1');

    app.setQty(99);
    expect(app.inOrder('[data-qty-input]').value).toBe('10');
  });

  it('el enlace de WhatsApp del selector lleva la presentación y la cantidad', () => {
    const app = mount();
    app.selectVariant('capsules_60');
    app.setQty(2);

    const link = app.inOrder('[data-action="whatsapp-order"]');
    const url = new URL(link.href);
    expect(url.origin + url.pathname).toBe('https://wa.me/18095551234');
    const text = url.searchParams.get('text');
    expect(text).toContain('Frasco: 60 cápsulas');
    expect(text).toContain('Cantidad: 2');
    expect(text).toContain('Total: RD$20,000');
    expect(text).toContain('Cápsulas en total: 120');
    // La referencia de campaña se añade siempre al reconstruir el enlace.
    expect(text).toContain('Ref: facebook/cpc/verano');
  });

  it('al pulsar WhatsApp registra el evento con la presentación (y no purchase)', () => {
    const app = mount();
    app.selectVariant('capsules_7');
    app.clickInOrder('[data-action="whatsapp-order"]');

    const wa = app.events.find((event) => event.event === EVENTS.CLICK_WHATSAPP);
    expect(wa.data).toMatchObject({ context: 'selector', variantId: 'capsules_7', capsules: 7, unitPrice: 1750, quantity: 1, total: 1750 });
    expect(app.eventNames()).not.toContain(EVENTS.PURCHASE);
  });

  it('el botón de cada tarjeta pide SU frasco con la cantidad elegida', () => {
    const app = mount();
    app.setQty(2);

    const link = app.click('[data-variant-card="capsules_30"] [data-action="whatsapp-order"]');

    // Pulsar el botón de una tarjeta elige ese frasco: una sola fuente de verdad.
    expect(app.selection.get().variantId).toBe('capsules_30');
    expect(app.variantCard('capsules_30').getAttribute('data-selected')).toBe('true');
    expect(app.variantCard('capsules_10').getAttribute('data-selected')).toBe('false');
    expect(app.inOrder('[data-summary-variant]').textContent).toBe('30 cápsulas');
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$12,000');

    // Y el mensaje sale con TODOS los datos del pedido.
    const text = new URL(link.href).searchParams.get('text');
    expect(text).toContain('Producto: Phytoemagry');
    expect(text).toContain('Frasco: 30 cápsulas');
    expect(text).toContain('Cantidad: 2');
    expect(text).toContain('Precio por frasco: RD$6,000');
    expect(text).toContain('Cápsulas en total: 60');
    expect(text).toContain('Total: RD$12,000');
    expect(text).toContain('Ref: facebook/cpc/verano');

    const selectEvent = app.events.filter((event) => event.event === EVENTS.SELECT_VARIANT).at(-1);
    expect(selectEvent.data).toMatchObject({ source: 'card', variantId: 'capsules_30' });

    const wa = app.events.filter((event) => event.event === EVENTS.CLICK_WHATSAPP).at(-1);
    expect(wa.data).toMatchObject({ source: 'frascos', variantId: 'capsules_30', quantity: 2, total: 12000 });
    expect(app.eventNames()).not.toContain(EVENTS.PURCHASE);
  });

  it('pedir un frasco sin elegirlo antes no cambia el frasco de las otras tarjetas', () => {
    const app = mount();
    app.click('[data-variant-card="capsules_60"] [data-action="whatsapp-order"]');

    expect(app.selection.get().variantId).toBe('capsules_60');
    // El resto de tarjetas siguen con su propio pedido.
    const otras = ['capsules_5', 'capsules_10', 'capsules_20'];
    for (const id of otras) {
      const text = new URL(app.$(`[data-variant-card="${id}"] [data-action="whatsapp-order"]`).href).searchParams.get('text');
      expect(text).toContain(`Frasco: ${id.replace('capsules_', '')} cápsulas`);
      expect(text).toContain('Cantidad: 1');
    }
  });

  it('al cambiar la cantidad, cada tarjeta lleva su frasco con la cantidad nueva', () => {
    const app = mount();
    app.setQty(3);

    const text = new URL(app.$('[data-variant-card="capsules_15"] [data-action="whatsapp-order"]').href).searchParams.get('text');
    expect(text).toContain('Frasco: 15 cápsulas');
    expect(text).toContain('Cantidad: 3');
    expect(text).toContain('Cápsulas en total: 45');
    expect(text).toContain('Total: RD$11,250');
  });

  it('las flechas del carrusel se activan con JavaScript', () => {
    const app = mount();
    // El HTML las trae ocultas: sin JS no se muestran botones que no harían nada.
    expect(app.$('.pe-carousel__nav').hasAttribute('hidden')).toBe(false);
    expect(app.$('[data-carousel-prev]').disabled).toBe(true); // al inicio no hay nada a la izquierda
    // Pulsarlas no debe romper nada (jsdom no tiene scroll real).
    expect(() => app.click('[data-carousel-next]')).not.toThrow();
  });

  it('recuerda la selección en la sesión', () => {
    const app = mount();
    app.selectVariant('capsules_15');
    app.setQty(3);
    const saved = app.session.get('selection');
    expect(saved).toEqual({ variantId: 'capsules_15', quantity: 3 });
  });
});

describe('modal de compra', () => {
  it('abre con la presentación y cantidad elegidas y registra los eventos', () => {
    const app = mount();
    app.selectVariant('capsules_20');
    app.setQty(2);
    app.click('[data-action="buy"][data-source="selector"]');

    expect(app.$('#pe-checkout').hasAttribute('open')).toBe(true);
    expect(app.$('#pe-checkout-form [data-summary-variant]').textContent).toBe('20 cápsulas');
    expect(app.$('#pe-checkout-form [data-summary-unit]').textContent).toBe('RD$5,000');
    expect(app.$('#pe-checkout-form [data-summary-qty]').textContent).toBe('2');
    expect(app.$('#pe-checkout-form [data-summary-total]').textContent).toBe('RD$10,000');

    const buy = app.events.find((event) => event.event === EVENTS.CLICK_BUY);
    const begin = app.events.find((event) => event.event === EVENTS.BEGIN_CHECKOUT);
    expect(buy.data).toMatchObject({ source: 'selector', variantId: 'capsules_20', total: 10000 });
    expect(begin.data).toMatchObject({ variantId: 'capsules_20', capsules: 20, quantity: 2, total: 10000 });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('valida antes de enviar', () => {
    const app = mount();
    app.click('[data-action="buy"]');
    app.submit('#pe-checkout-form');

    const form = '#pe-checkout-form ';
    expect(app.$(`${form}[data-error-for="name"]`).hidden).toBe(false);
    expect(app.$(`${form}[data-error-for="consent"]`).textContent).toContain('autorización');
    expect(app.$('[data-form-alert]').hidden).toBe(false);
    expect(app.storage.get(QUEUE_KEY)).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('cambiar la cantidad en el modal actualiza el selector', () => {
    const app = mount();
    app.click('[data-action="buy"]');
    app.setQty(3);
    expect(app.inOrder('[data-summary-total]').textContent).toBe('RD$7,500');
  });

  it('"Cambiar presentación" cierra el modal y lleva al selector', () => {
    const app = mount();
    app.click('[data-action="buy"]');
    expect(app.$('#pe-checkout').open).toBe(true);
    app.$('[data-change-variant]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(app.$('#pe-checkout').open).toBe(false);
  });

  it('con datos válidos guarda lead + order_intent y abre WhatsApp con la presentación', async () => {
    const app = mount();
    app.selectVariant('capsules_10');
    app.click('[data-action="buy"]');

    app.fill('#pe-co-name', 'Ana Gómez');
    app.fill('#pe-co-phone', '+1 809 555 1234');
    app.fill('#pe-co-location', 'Higüey, La Altagracia');
    app.fill('#pe-co-quantity', '2');
    app.check('#pe-co-consent');
    app.submit('#pe-checkout-form');
    await flush();

    expect(app.eventNames()).toEqual([EVENTS.SELECT_VARIANT, EVENTS.CLICK_BUY, EVENTS.BEGIN_CHECKOUT, EVENTS.LEAD, EVENTS.CLICK_WHATSAPP]);
    expect(app.eventNames()).not.toContain(EVENTS.PURCHASE);

    const queue = app.storage.get(QUEUE_KEY);
    const lead = queue.find((item) => item.type === 'lead');
    const order = queue.find((item) => item.type === 'order_intent');

    expect(lead).toMatchObject({
      name: 'Ana Gómez',
      phone: '+18095551234',
      location: 'Higüey, La Altagracia',
      source: 'checkout',
      consent: true,
      variantId: 'capsules_10',
      variantName: '10 cápsulas',
      capsules: 10,
      quantity: 2,
    });
    expect(order).toMatchObject({
      variantId: 'capsules_10',
      variantName: '10 cápsulas',
      capsules: 10,
      quantity: 2,
      unitPrice: 2500,
      total: 5000,
      totalCapsules: 20,
      currency: 'DOP',
      status: 'pending_confirmation',
    });
    expect(order.leadId).toBe(lead.id);
    expect(order.attribution.utm_campaign).toBe('verano');

    const url = new URL(openSpy.mock.calls[0][0]);
    const text = url.searchParams.get('text');
    expect(text).toContain('Frasco: 10 cápsulas');
    expect(text).toContain('Cantidad: 2');
    expect(text).toContain('Total: RD$5,000');
    expect(text).toContain('Ana Gómez');
    expect(text).toContain('Ref: facebook/cpc/verano');

    expect(app.$('#pe-checkout-form').hidden).toBe(true);
    expect(app.$('[data-checkout-success]').hidden).toBe(false);
  });

  it('si el navegador bloquea la pestaña ofrece el enlace manual', async () => {
    const app = mount();
    window.open = vi.fn(() => null);
    app.click('[data-action="buy"]');
    app.fill('#pe-co-name', 'Ana');
    app.fill('#pe-co-phone', '+18095551234');
    app.fill('#pe-co-location', 'Higüey');
    app.check('#pe-co-consent');
    app.submit('#pe-checkout-form');
    await flush();

    expect(app.$('[data-whatsapp-fallback]').hidden).toBe(false);
    expect(app.$('[data-whatsapp-fallback-link]').getAttribute('href')).toContain('https://wa.me/');
    expect(app.events.find((event) => event.event === EVENTS.CLICK_WHATSAPP).data.opened).toBe(false);
  });

  it('sin WhatsApp configurado guarda la solicitud y no simula un clic de WhatsApp', async () => {
    const app = mount({ whatsapp: null });
    expect(app.$('[data-action="whatsapp-order"]')).toBeNull();
    app.click('[data-action="buy"]');
    app.fill('#pe-co-name', 'Ana');
    app.fill('#pe-co-phone', '+18095551234');
    app.fill('#pe-co-location', 'Higüey');
    app.check('#pe-co-consent');
    app.submit('#pe-checkout-form');
    await flush();

    expect(app.eventNames()).not.toContain(EVENTS.CLICK_WHATSAPP);
    expect(app.storage.get(QUEUE_KEY)).toHaveLength(2);
    expect(app.$('[data-checkout-success]').hidden).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('formulario de información', () => {
  it('valida antes de enviar', () => {
    const app = mount();
    app.submit('#pe-lead-form');
    expect(app.$('#pe-lead-form [data-error-for="name"]').hidden).toBe(false);
    expect(app.storage.get(QUEUE_KEY)).toBeNull();
  });

  it('guarda el lead general (sin presentación) con su atribución', async () => {
    const app = mount();
    app.fill('#pe-lead-name', 'Carlos Pérez');
    app.fill('#pe-lead-phone', '8091234567');
    app.check('#pe-lead-consent');
    app.submit('#pe-lead-form');
    await flush();

    const [lead] = app.storage.get(QUEUE_KEY);
    expect(lead).toMatchObject({ type: 'lead', name: 'Carlos Pérez', phone: '8091234567', source: 'formulario', consent: true });
    expect(lead.variantId).toBeNull();
    expect(lead.attribution.utm_source).toBe('facebook');
    // Primero sale el WhatsApp (para que el contacto llegue) y después se guarda.
    expect(app.eventNames()).toEqual([EVENTS.CLICK_WHATSAPP, EVENTS.LEAD]);
  });

  it('el contacto del formulario llega al WhatsApp del negocio con todos los datos', async () => {
    const app = mount();
    app.fill('#pe-lead-name', 'Carlos Pérez');
    app.fill('#pe-lead-phone', '8091234567');
    app.fill('#pe-lead-location', 'Higüey, La Altagracia');
    app.check('#pe-lead-consent');
    app.submit('#pe-lead-form');
    await flush();

    // Se abrió WhatsApp (window.open) con el mensaje del contacto escrito.
    expect(openSpy).toHaveBeenCalled();
    const [url] = openSpy.mock.calls.at(-1);
    expect(url.startsWith('https://wa.me/18095551234?text=')).toBe(true);
    const text = new URL(url).searchParams.get('text');
    expect(text).toContain('quiero recibir información sobre Phytoemagry');
    expect(text).toContain('Nombre: Carlos Pérez');
    expect(text).toContain('WhatsApp o teléfono: 8091234567');
    expect(text).toContain('Ubicación: Higüey, La Altagracia');
    expect(text).toContain('Ref: facebook/cpc/verano');

    // Y el botón del panel de éxito lleva ese mismo enlace (si el navegador
    // bloquea la pestaña, el contacto sale igual al pulsarlo).
    const link = app.$('[data-lead-whatsapp]');
    expect(link.getAttribute('href')).toBe(url);

    const wa = app.events.find((event) => event.event === EVENTS.CLICK_WHATSAPP);
    expect(wa.data).toMatchObject({ source: 'formulario', context: 'lead_form', opened: true });
    // El pedido no es una compra: nunca se dispara purchase.
    expect(app.eventNames()).not.toContain(EVENTS.PURCHASE);
  });

  it('el honeypot detiene a los bots', async () => {
    const app = mount();
    app.fill('#pe-lead-name', 'Bot');
    app.fill('#pe-lead-phone', '8091234567');
    app.check('#pe-lead-consent');
    app.fill('#pe-lead-website', 'https://spam.example');
    app.submit('#pe-lead-form');
    await flush();
    expect(app.storage.get(QUEUE_KEY)).toBeNull();
    // Un bot tampoco abre WhatsApp: no se registra ninguna interacción.
    expect(openSpy).not.toHaveBeenCalled();
    expect(app.eventNames()).toEqual([]);
  });

  it('sin número de WhatsApp el formulario sigue guardando el lead', async () => {
    const app = mount({ whatsapp: null });
    app.fill('#pe-lead-name', 'Carlos Pérez');
    app.fill('#pe-lead-phone', '8091234567');
    app.check('#pe-lead-consent');
    app.submit('#pe-lead-form');
    await flush();

    expect(openSpy).not.toHaveBeenCalled();
    expect(app.eventNames()).toEqual([EVENTS.LEAD]);
    expect(app.storage.get(QUEUE_KEY)).toHaveLength(1);
    expect(app.$('[data-lead-whatsapp]')).toBeNull();
  });
});

describe('comunidad (desactivada por decisión del negocio)', () => {
  /** La comunidad está retirada de la web: los grupos no se publican. */
  it('no se publica ningún enlace de comunidad en la página', () => {
    const app = mount();
    expect(app.$('#comunidad')).toBeNull();
    expect(app.$('[data-action="community"]')).toBeNull();
    expect(app.$('[data-action="scroll-to-community"]')).toBeNull();
    expect(app.$('.pe-main').innerHTML).not.toContain('chat.whatsapp.com');
  });

  it('activada (por si se reactiva), registra click_community_group y no es lead ni compra', () => {
    const app = mount({ site: { community: { ...siteConfig.community, enabled: true } } });
    const link = app.click('#comunidad [data-action="community"]');
    expect(app.eventNames()).toEqual([EVENTS.CLICK_COMMUNITY_GROUP]);
    const data = app.events[0].data;
    expect(data.groupId).toBe('group_1');
    expect(data.groupName).toBeTruthy();
    expect(data.sourceSection).toBe('comunidad');
    expect(data).toHaveProperty('utm_campaign');
    expect(data).toHaveProperty('utm_content');
    expect(link.getAttribute('href')).toContain('https://chat.whatsapp.com/');
    expect(app.eventNames()).not.toContain(EVENTS.CLICK_WHATSAPP);
    expect(app.eventNames()).not.toContain(EVENTS.LEAD);
    expect(app.eventNames()).not.toContain(EVENTS.PURCHASE);
  });
});

describe('consentimiento y medición', () => {
  it('no existe banner si no hay medición configurada', () => {
    expect(mount().$('[data-consent]')).toBeNull();
  });

  it('con Pixel aparece el banner y solo al aceptar se habilita', () => {
    const app = mount({ pixelId: '1234567890' });
    expect(app.$('[data-consent]').hidden).toBe(false);
    app.click('[data-consent="accept"]');
    expect(app.enableAds).toHaveBeenCalledTimes(1);
    expect(app.consent.adsAllowed()).toBe(true);
  });

  it('al rechazar no se habilita la medición', () => {
    const app = mount({ pixelId: '1234567890' });
    app.click('[data-consent="reject"]');
    expect(app.enableAds).not.toHaveBeenCalled();
    expect(app.consent.getState()).toBe('denied');
  });
});
