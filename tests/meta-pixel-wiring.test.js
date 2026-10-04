/**
 * La capa de medición tiene que estar CONECTADA.
 *
 * Este test existe por un fallo real: los adaptadores de medición publicitaria
 * (Meta Pixel, dataLayer) se creaban pero nunca se registraban en el tracker
 * (`addAdapter` no se llamaba en ningún sitio). Resultado: al píxel le llegaba el
 * `PageView`/`ViewContent` del arranque y **nada más** — ni `InitiateCheckout`,
 * ni `Lead`, ni `Contact`. La web parecía medida y no lo estaba.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTracking } from '../src/client/init-tracking.js';
import { createConsent } from '../src/lib/consent.js';
import { EVENTS } from '../src/lib/tracking.js';

/** Almacén en memoria (ni localStorage ni cookies de verdad). */
function memoryStorage() {
  const map = new Map();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => map.set(key, value),
    remove: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

/** Vista mínima con la forma que espera la capa de medición. */
function fakeView(overrides = {}) {
  return {
    currency: 'DOP',
    product: { id: 'phytoemagry-v1', name: 'Phytoemagry' },
    pricing: { variants: [{ id: 'capsules_5', name: '5 cápsulas' }], hasPrice: true, unitPrice: 1250 },
    flags: { pricing: true },
    site: { tracking: { metaPixelId: '1234567890', debug: false, ...(overrides.tracking ?? {}) } },
  };
}

beforeEach(() => {
  delete window.fbq;
  delete window._fbq;
  delete window.dataLayer;
  // jsdom comparte `sessionStorage` entre tests del mismo archivo: sin limpiarlo,
  // la marca de "Contact ya enviado" viajaría de un caso a otro.
  localStorage.clear();
  sessionStorage.clear();
});

describe('medición · los adaptadores quedan conectados al tracker', () => {
  it('con Pixel ID, el adaptador metaPixel está REGISTRADO (no solo creado)', () => {
    const consent = createConsent({ storage: memoryStorage() });
    const tracking = initTracking({ view: fakeView(), consent, storage: memoryStorage() });

    const nombres = tracking.tracker.getAdapters().map((adapter) => adapter.name);
    expect(nombres).toContain('metaPixel');
    expect(tracking.metaPixel).toBeTruthy();
  });

  it('sin Pixel ID no se registra ningún adaptador de anuncios', () => {
    const consent = createConsent({ storage: memoryStorage() });
    const tracking = initTracking({
      view: fakeView({ tracking: { metaPixelId: '' } }),
      consent,
      storage: memoryStorage(),
    });

    expect(tracking.tracker.getAdapters()).toHaveLength(0);
    expect(window.fbq).toBeUndefined();
    expect(tracking.hasAds).toBe(false);
  });

  it('con consentimiento, TODOS los eventos llegan al píxel (no solo el PageView)', async () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    consent.set('accept');

    const tracking = initTracking({ view: fakeView(), consent, storage });
    expect(typeof window.fbq).toBe('function');

    // Espía: lo que recibe el píxel después del arranque.
    const queue = window.fbq.queue ?? [];
    tracking.tracker.trackEvent(EVENTS.BEGIN_CHECKOUT, { productId: 'phytoemagry-v1', quantity: 1, value: 1250 });
    tracking.tracker.trackEvent(EVENTS.LEAD, { productName: 'Phytoemagry' });
    tracking.tracker.trackEvent(EVENTS.CLICK_WHATSAPP, { productName: 'Phytoemagry', source: 'hero' });

    const eventos = queue.map((entry) => `${entry[0]}:${entry[1]}`);
    expect(eventos).toContain('track:InitiateCheckout');
    expect(eventos).toContain('track:Lead');
    expect(eventos).toContain('track:Contact');
    // El clic en WhatsApp NUNCA es una compra.
    expect(eventos).not.toContain('track:Purchase');
    expect(queue.filter((entry) => entry[1] === 'Contact')).toHaveLength(1);
  });

  it('sin consentimiento no sale nada al píxel (ni siquiera registrado)', () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    consent.set('reject');

    const tracking = initTracking({ view: fakeView(), consent, storage });
    tracking.tracker.trackEvent(EVENTS.LEAD, { productName: 'Phytoemagry' });

    expect(window.fbq).toBeUndefined();
  });

  /*
   * DECISIÓN DEL NEGOCIO (2026-10-03): no hay aviso de cookies y la medición va
   * con la visita, porque el aviso casi nadie lo acepta y dejaba ciego al tráfico
   * pagado. El interruptor es `tracking.consentRequired`.
   */
  it('sin aviso (consentRequired: false) el píxel mide desde el arranque, sin decisión previa', async () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    expect(consent.hasDecided()).toBe(false);

    const tracking = initTracking({
      view: fakeView({ tracking: { consentRequired: false } }),
      consent,
      storage,
    });

    expect(typeof window.fbq).toBe('function');
    await tracking.tracker.trackEvent(EVENTS.LEAD, { productName: 'Phytoemagry' });

    const eventos = (window.fbq.queue ?? []).map((entry) => `${entry[0]}:${entry[1]}`);
    expect(eventos).toContain('track:Lead');
    // Y sigue sin haber decisión guardada: no se finge un consentimiento.
    expect(consent.hasDecided()).toBe(false);
  });

  it('el evento lleva el mismo event_id con el que se envió al CRM', () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    consent.set('accept');
    const tracking = initTracking({ view: fakeView(), consent, storage });

    const payload = tracking.tracker.trackEvent(EVENTS.LEAD, { productName: 'Phytoemagry' }, { eventId: 'lead_compartido' });
    expect(payload.eventId).toBe('lead_compartido');

    const conLead = (window.fbq.queue ?? []).find((entry) => entry[1] === 'Lead');
    expect(conLead?.[3]).toEqual({ eventID: 'lead_compartido' });
  });

  it('`Contact` se envía una sola vez por sesión, pero el clic se sigue registrando', () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    consent.set('accept');
    const tracking = initTracking({ view: fakeView(), consent, storage });

    const track = () => tracking.tracker.trackEvent(EVENTS.CLICK_WHATSAPP, { productName: 'Phytoemagry' });
    track();
    track();
    track();

    const queue = window.fbq.queue ?? [];
    expect(queue.filter((entry) => entry[1] === 'Contact')).toHaveLength(1);
    expect(queue.filter((entry) => entry[0] === 'trackCustom' && entry[1] === 'click_whatsapp')).toHaveLength(3);
  });

  it('un evento propio NO se manda como evento estándar', () => {
    const storage = memoryStorage();
    const consent = createConsent({ storage });
    consent.set('accept');
    const tracking = initTracking({ view: fakeView(), consent, storage });

    tracking.tracker.trackEvent(EVENTS.SELECT_VARIANT, { variantId: 'capsules_5' });
    tracking.tracker.trackEvent(EVENTS.CLICK_BUY, { source: 'selector' });

    const queue = window.fbq.queue ?? [];
    expect(queue.filter((entry) => entry[0] === 'trackCustom').map((entry) => entry[1])).toEqual([
      'select_variant',
      'click_buy',
    ]);
    expect(queue.filter((entry) => entry[0] === 'track' && entry[1] === 'select_variant')).toHaveLength(0);
  });
});
