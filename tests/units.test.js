import { describe, expect, it } from 'vitest';
import { computeTotals, formatPrice, hasPrice, normalizeQuantity } from '../src/lib/format.js';
import { normalizePhone, sanitizeText, validateLead, validateOrder } from '../src/lib/validation.js';
import { attributionRef, buildAttribution, hasCampaignData } from '../src/lib/attribution.js';
import { buildWhatsAppMessage, buildWhatsAppUrl, isWhatsAppConfigured, normalizeWhatsAppNumber } from '../src/lib/whatsapp.js';
import { attributionRef as ref2 } from '../src/lib/attribution.js';
import { createMemoryStorage } from '../src/lib/storage.js';
import { persistAttribution, getAttribution } from '../src/lib/attribution.js';

describe('formato y precios', () => {
  it('nunca muestra precio si no está configurado', () => {
    expect(hasPrice(null)).toBe(false);
    expect(hasPrice(0)).toBe(false);
    expect(hasPrice('29.99')).toBe(false);
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice(undefined)).toBeNull();
  });

  it('formatea un precio real en pesos dominicanos', () => {
    expect(formatPrice(29.99, { currency: 'USD', locale: 'es-CL' })).toMatch(/29,99|29\.99/);
    expect(formatPrice(2500, { currency: 'DOP', locale: 'es-DO' })).toBe('RD$2,500');
  });

  it('calcula el total y deja null si no hay precio', () => {
    const conPrecio = computeTotals({ unitPrice: 10, quantity: 3, currency: 'USD', locale: 'es-CL' });
    expect(conPrecio.total).toBe(30);
    expect(conPrecio.hasPrice).toBe(true);

    const sinPrecio = computeTotals({ unitPrice: null, quantity: 3 });
    expect(sinPrecio.hasPrice).toBe(false);
    expect(sinPrecio.total).toBeNull();
    expect(sinPrecio.totalLabel).toBeNull();
    expect(sinPrecio.quantity).toBe(3);
  });

  it('acota la cantidad al rango permitido', () => {
    expect(normalizeQuantity('0', { min: 1, max: 10 })).toBe(1);
    expect(normalizeQuantity('99', { min: 1, max: 10 })).toBe(10);
    expect(normalizeQuantity('abc', { min: 1, max: 10 })).toBe(1);
    expect(normalizeQuantity(4.7, { min: 1, max: 10 })).toBe(4);
  });
});

describe('validación de entradas', () => {
  it('sanitiza texto (control, etiquetas, espacios, longitud)', () => {
    expect(sanitizeText('  María   <script>alert(1)</script>  ', 80)).toBe('María scriptalert(1)/script');
    expect(sanitizeText('a\u0000b', 80)).toBe('a b');
    expect(sanitizeText('x'.repeat(200), 10)).toBe('x'.repeat(10));
  });

  it('normaliza teléfonos', () => {
    expect(normalizePhone('+56 9 1234 5678')).toEqual({ ok: true, value: '+56912345678', digits: '56912345678' });
    expect(normalizePhone('900123456')).toEqual({ ok: true, value: '900123456', digits: '900123456' });
    expect(normalizePhone('123')).toMatchObject({ ok: false, code: 'phone_too_short' });
    expect(normalizePhone('')).toMatchObject({ ok: false, code: 'phone_required' });
    expect(normalizePhone('9'.repeat(20))).toMatchObject({ ok: false, code: 'phone_too_long' });
  });

  it('valida el formulario de información', () => {
    const vacio = validateLead({});
    expect(vacio.ok).toBe(false);
    expect(vacio.errors).toMatchObject({ name: 'name_required', phone: 'phone_required', consent: 'consent_required' });

    const ok = validateLead({ name: 'Ana', phone: '+56911112222', location: 'Lima', consent: true });
    expect(ok.ok).toBe(true);
    expect(ok.values.phone).toBe('+56911112222');
    expect(ok.values.consent).toBe(true);
  });

  it('valida el pedido: la ubicación y la cantidad son obligatorias', () => {
    const result = validateOrder({ name: 'Ana', phone: '+56911112222', consent: true, quantity: '99' }, { maxQuantity: 10 });
    expect(result.errors.location).toBe('location_required');
    expect(result.errors.quantity).toBe('quantity_too_high');
    expect(result.values.quantity).toBe(10);
    expect(result.ok).toBe(false);
  });
});

describe('WhatsApp', () => {
  it('valida y normaliza el número', () => {
    expect(normalizeWhatsAppNumber('+56 9 1234 5678')).toBe('56912345678');
    expect(normalizeWhatsAppNumber('')).toBeNull();
    expect(normalizeWhatsAppNumber(null)).toBeNull();
    expect(normalizeWhatsAppNumber('123')).toBeNull();
    expect(isWhatsAppConfigured('56912345678')).toBe(true);
    expect(isWhatsAppConfigured('')).toBe(false);
  });

  it('construye la URL con el mensaje codificado', () => {
    const url = buildWhatsAppUrl({ number: '56912345678', message: 'Hola, quiero información' });
    expect(url).toBe('https://wa.me/56912345678?text=Hola%2C%20quiero%20informaci%C3%B3n');
    expect(buildWhatsAppUrl({ number: '123', message: 'x' })).toBeNull();
  });

  it('incluye frasco, cantidad, total y referencia de campaña', () => {
    const message = buildWhatsAppMessage({
      template: 'Hola, quiero confirmar este pedido',
      data: {
        variantName: '10 cápsulas',
        capsules: 10,
        quantity: 2,
        unitPriceLabel: 'RD$2,500',
        totalLabel: 'RD$5,000',
        totalCapsules: 20,
        customerName: 'Ana',
        location: 'Higüey',
        ref: 'facebook/instagram/verano',
      },
    });
    expect(message).toContain('Frasco: 10 cápsulas');
    expect(message).toContain('Cantidad: 2');
    expect(message).toContain('Precio por frasco: RD$2,500');
    expect(message).toContain('Cápsulas en total: 20');
    expect(message).toContain('Total: RD$5,000');
    expect(message).toContain('Nombre: Ana');
    expect(message).toContain('Ubicación: Higüey');
    expect(message).toContain('Ref: facebook/instagram/verano');
  });

  it('el contacto del formulario lleva nombre, teléfono y ubicación', () => {
    const message = buildWhatsAppMessage({
      template: 'Hola, quiero recibir información sobre Phytoemagry.',
      data: {
        customerName: 'Carlos Pérez',
        customerPhone: '8091234567',
        location: 'Higüey, La Altagracia',
        ref: 'facebook/cpc/verano',
      },
    });
    expect(message).toContain('Hola, quiero recibir información sobre Phytoemagry.');
    expect(message).toContain('Nombre: Carlos Pérez');
    // El teléfono es lo que permite devolver la llamada: no puede faltar.
    expect(message).toContain('WhatsApp o teléfono: 8091234567');
    expect(message).toContain('Ubicación: Higüey, La Altagracia');
    expect(message).toContain('Ref: facebook/cpc/verano');
    // Sin datos de pedido no se inventan líneas de producto ni de precio.
    expect(message).not.toContain('Frasco:');
    expect(message).not.toContain('Total:');
  });

  it('con un solo frasco no repite precio por frasco ni cápsulas totales', () => {
    const message = buildWhatsAppMessage({
      template: 'Hola, estoy interesado/a en Phytoemagry.',
      data: { variantName: '10 cápsulas', capsules: 10, quantity: 1, unitPriceLabel: 'RD$2,500', totalLabel: 'RD$2,500', totalCapsules: 10 },
    });
    expect(message).toContain('Frasco: 10 cápsulas');
    expect(message).toContain('Cantidad: 1');
    expect(message).toContain('Total: RD$2,500');
    expect(message).not.toContain('Precio por frasco');
    expect(message).not.toContain('Cápsulas en total');
  });

  it('no inventa datos: sin precio no añade líneas de precio', () => {
    const message = buildWhatsAppMessage({
      template: 'Hola',
      data: { variantName: '10 cápsulas', quantity: 1, unitPriceLabel: null, totalLabel: null },
    });
    expect(message).not.toContain('Precio unitario');
    expect(message).not.toContain('Total');
  });
});

describe('atribución', () => {
  const params = { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'lanzamiento', fbclid: 'ABC123' };

  it('captura UTM, fbclid, landing y referrer', () => {
    const attribution = buildAttribution({
      href: 'https://landing.test/?utm_source=facebook&utm_medium=cpc',
      params,
      referrer: 'https://facebook.com/ads',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(attribution.utm_source).toBe('facebook');
    expect(attribution.utm_campaign).toBe('lanzamiento');
    expect(attribution.clickIds.fbclid).toBe('ABC123');
    expect(attribution.landingPage).toContain('utm_source=facebook');
    expect(attribution.referrer).toBe('https://facebook.com/ads');
    expect(hasCampaignData(attribution)).toBe(true);
  });

  it('ignora el tráfico interno como referrer', () => {
    const attribution = buildAttribution({
      href: 'https://landing.test/',
      params: {},
      referrer: 'https://landing.test/otra',
    });
    expect(attribution.referrer).toBeNull();
    expect(hasCampaignData(attribution)).toBe(false);
  });

  it('persiste first-touch y last-touch', () => {
    const local = createMemoryStorage();
    const session = createMemoryStorage();

    const first = persistAttribution({
      local,
      session,
      attribution: buildAttribution({ href: 'https://x.test/', params, referrer: null, touch: 'first' }),
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(first.isNewFirstTouch).toBe(true);

    // Segunda visita sin campaña: el first-touch se conserva.
    persistAttribution({
      local,
      session,
      attribution: buildAttribution({ href: 'https://x.test/otra', params: {}, referrer: null, touch: 'last' }),
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const resolved = getAttribution({ local, session });
    expect(resolved.utm_campaign).toBe('lanzamiento');
    expect(resolved.touch).toBe('first');
  });

  it('caduca el first-touch después del TTL', () => {
    const local = createMemoryStorage();
    const session = createMemoryStorage();
    persistAttribution({
      local,
      session,
      attribution: buildAttribution({
        href: 'https://x.test/',
        params,
        referrer: null,
        now: '2026-01-01T00:00:00.000Z',
      }),
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const later = persistAttribution({
      local,
      session,
      attribution: buildAttribution({
        href: 'https://x.test/',
        params: { utm_source: 'tiktok' },
        referrer: null,
        now: '2026-06-01T00:00:00.000Z',
      }),
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(later.isNewFirstTouch).toBe(true);
    expect(later.first.utm_source).toBe('tiktok');
  });

  it('genera una referencia corta y segura para el mensaje', () => {
    expect(attributionRef({ utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'verano 2026', clickIds: {} })).toBe(
      'facebook/cpc/verano_2026',
    );
    expect(attributionRef({ clickIds: { fbclid: 'x' } })).toBe('fbclid');
    expect(attributionRef(null)).toBeNull();
    expect(ref2({ utm_source: 'a', clickIds: {} })).toBe('a');
  });
});
