import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createConsent } from '../src/lib/consent.js';
import { createMemoryStorage } from '../src/lib/storage.js';
import { createDataLayerAdapter, createMetaPixelAdapter, createTracker, EVENTS } from '../src/lib/tracking.js';

/** Adaptador de prueba que guarda lo que recibe. */
function recordingAdapter() {
  const events = [];
  return {
    name: 'test',
    events,
    track: (payload) => events.push(payload),
  };
}

describe('tracker interno', () => {
  it('registra eventos con timestamp, sesión y esquema', () => {
    const adapter = recordingAdapter();
    const tracker = createTracker({ adapters: [adapter], sessionId: () => 's_1' });
    const payload = tracker.trackEvent(EVENTS.CLICK_WHATSAPP, { source: 'hero' });

    expect(payload.event).toBe('click_whatsapp');
    expect(payload.sessionId).toBe('s_1');
    expect(payload.data.schemaVersion).toBeDefined();
    expect(adapter.events).toHaveLength(1);
  });

  it('un adaptador roto no rompe la landing', () => {
    const roto = {
      name: 'roto',
      track: () => {
        throw new Error('boom');
      },
    };
    const adapter = recordingAdapter();
    const tracker = createTracker({ adapters: [roto, adapter] });
    expect(() => tracker.trackEvent('page_view')).not.toThrow();
    expect(adapter.events).toHaveLength(1);
  });

  it('NO dispara purchase al pulsar comprar o WhatsApp', () => {
    const adapter = recordingAdapter();
    const tracker = createTracker({ adapters: [adapter] });

    tracker.trackEvent(EVENTS.CLICK_BUY, { source: 'hero' });
    tracker.trackEvent(EVENTS.CLICK_WHATSAPP, { source: 'checkout' });
    tracker.trackEvent(EVENTS.BEGIN_CHECKOUT, { quantity: 1 });
    tracker.trackEvent(EVENTS.LEAD, { source: 'formulario' });

    expect(adapter.events.map((event) => event.event)).toEqual([
      'click_buy',
      'click_whatsapp',
      'begin_checkout',
      'lead',
    ]);
    expect(adapter.events.some((event) => event.event === 'purchase')).toBe(false);
  });

  it('purchase solo se acepta con confirmación del backend', () => {
    const adapter = recordingAdapter();
    const tracker = createTracker({ adapters: [adapter] });

    expect(tracker.trackPurchase({ orderId: 'A1', value: 30 })).toBeNull();
    expect(tracker.trackPurchase({ orderId: 'A1', confirmedByBackend: false })).toBeNull();
    expect(tracker.trackPurchase({ confirmedByBackend: true })).toBeNull();
    expect(adapter.events).toHaveLength(0);

    const real = tracker.trackPurchase({ orderId: 'A1', value: 30, currency: 'USD', confirmedByBackend: true });
    expect(real.event).toBe('purchase');
    expect(adapter.events).toHaveLength(1);
  });
});

describe('consentimiento y Meta Pixel', () => {
  beforeEach(() => {
    delete window.fbq;
    delete window._fbq;
    delete window.dataLayer;
  });

  it('sin consentimiento no se carga el pixel ni se envía nada', () => {
    const consent = createConsent({ storage: createMemoryStorage() });
    const adapter = createMetaPixelAdapter({ pixelId: '1234567890', allowed: () => consent.adsAllowed() });

    adapter.track({ event: 'page_view', timestamp: '', sessionId: 's', data: {} });

    expect(window.fbq).toBeUndefined();
    expect(adapter.loaded).toBe(false);
  });

  it('con consentimiento inicializa el pixel y mapea los eventos', () => {
    const consent = createConsent({ storage: createMemoryStorage() });
    consent.set('accept');
    const adapter = createMetaPixelAdapter({ pixelId: '1234567890', allowed: () => consent.adsAllowed() });

    adapter.track({ event: EVENTS.PAGE_VIEW, timestamp: '', sessionId: 's', data: {} });
    adapter.track({
      event: EVENTS.BEGIN_CHECKOUT,
      timestamp: '',
      sessionId: 's',
      data: { productId: 'p1', productName: 'Phytoemagry', quantity: 2, value: 20, currency: 'USD' },
    });
    adapter.track({ event: EVENTS.LEAD, timestamp: '', sessionId: 's', data: { productName: 'Phytoemagry' } });

    expect(typeof window.fbq).toBe('function');
    const calls = window.fbq.queue.map((entry) => entry[0] + ':' + entry[1]);
    expect(calls).toContain('init:1234567890');
    expect(calls).toContain('track:PageView');
    expect(calls).toContain('track:InitiateCheckout');
    expect(calls).toContain('track:Lead');
    expect(adapter.loaded).toBe(true);
  });

  it('el consentimiento se persiste y puede revocarse', () => {
    const storage = createMemoryStorage();
    const consent = createConsent({ storage });
    expect(consent.hasDecided()).toBe(false);

    consent.set('reject');
    expect(consent.getState()).toBe('denied');
    expect(consent.adsAllowed()).toBe(false);
    expect(createConsent({ storage }).getState()).toBe('denied');

    consent.set('accept');
    expect(createConsent({ storage }).adsAllowed()).toBe(true);
  });

  it('el adaptador dataLayer respeta el consentimiento', () => {
    const allowed = { value: false };
    const adapter = createDataLayerAdapter({ allowed: () => allowed.value });
    const tracker = createTracker({ adapters: [adapter] });

    tracker.trackEvent('page_view');
    expect(window.dataLayer).toBeUndefined();

    allowed.value = true;
    tracker.trackEvent('page_view', { page: 'landing' });
    expect(window.dataLayer).toHaveLength(1);
    expect(window.dataLayer[0].event).toBe('page_view');
  });

  it('sin Pixel ID no se instancia medición publicitaria (cero peticiones)', () => {
    const loadSpy = vi.fn();
    const adapter = createMetaPixelAdapter({ pixelId: '', allowed: () => true });
    adapter.track({ event: 'page_view', timestamp: '', sessionId: 's', data: {} });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(window.fbq).toBeUndefined();
  });
});
