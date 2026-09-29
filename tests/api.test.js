import { describe, expect, it, vi } from 'vitest';

import { buildLeadPayload, buildOrderIntentPayload, createCrmClient, flattenAttribution, QUEUE_KEY } from '../src/lib/api.js';
import { buildAttribution } from '../src/lib/attribution.js';
import { createMemoryStorage } from '../src/lib/storage.js';

const attribution = buildAttribution({
  href: 'https://landing.test/?utm_source=facebook&utm_campaign=verano',
  params: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'verano', fbclid: 'FB1' },
  referrer: 'https://facebook.com/ads',
  now: '2026-01-01T00:00:00.000Z',
});

describe('contrato del bloque meta (pixel + API de conversiones)', () => {
  it('lleva los event_id del píxel y la URL donde ocurrió la acción', () => {
    const lead = buildLeadPayload({
      name: 'Ana',
      source: 'checkout',
      consent: true,
      attribution,
      meta: { events: { lead: 'lead_abc', initiateCheckout: 'ic_1', vacio: '' }, sourceUrl: 'https://x.test/#frascos' },
    });
    // Los ids se comparten con el píxel: Meta deduplica navegador + servidor.
    expect(lead.meta.events).toEqual({ lead: 'lead_abc', initiateCheckout: 'ic_1' });
    expect(lead.meta.sourceUrl).toBe('https://x.test/#frascos');
  });

  it('sin eventos sigue habiendo bloque (el servidor no revienta)', () => {
    const lead = buildLeadPayload({ name: 'Ana', source: 'checkout', consent: true });
    expect(lead.meta).toEqual({ events: {}, sourceUrl: null });
  });

  it('el pedido también lo lleva', () => {
    const order = buildOrderIntentPayload({
      customer: { name: 'Ana' },
      product: { id: 'phytoemagry-v1', name: 'Phytoemagry' },
      variant: { id: 'capsules_5', name: '5 cápsulas', price: 1250, capsules: 5 },
      quantity: 1,
      meta: { events: { lead: 'lead_z' }, sourceUrl: 'https://x.test/' },
    });
    expect(order.meta.events.lead).toBe('lead_z');
    expect(order.meta.sourceUrl).toBe('https://x.test/');
  });
});
describe('contrato de LEAD', () => {
  it('incluye identidad, origen, consentimiento y atribución', () => {
    const lead = buildLeadPayload({
      name: 'Ana Gómez',
      phone: '+18095551234',
      location: 'Higüey',
      source: 'selector',
      consent: true,
      consentVersion: 'v1',
      attribution,
      productId: 'phytoemagry-v1',
      variant: { id: 'capsules_10', name: '10 cápsulas', capsules: 10 },
      quantity: 2,
      sessionId: 's_1',
      createdAt: '2026-01-01T10:00:00.000Z',
    });

    expect(lead.type).toBe('lead');
    expect(lead.schemaVersion).toBe('1.1');
    expect(lead.id).toMatch(/^[0-9a-f-]{8,}/i);
    expect(lead.name).toBe('Ana Gómez');
    expect(lead.consent).toBe(true);
    expect(lead.attribution.utm_campaign).toBe('verano');
    expect(lead.attribution.fbclid).toBe('FB1');
    expect(lead.attribution.utm_source).toBe('facebook');
    // `_fbc` para Meta: sin cookie real, se construye desde el fbclid.
    expect(lead.attribution.fbc).toMatch(/^fb\.1\.\d+\.FB1$/);
    expect(lead.attribution.fbp).toBeNull();
    expect(lead.landingPage).toContain('utm_source=facebook');
    expect(lead.createdAt).toBe('2026-01-01T10:00:00.000Z');    // Datos de la presentación elegida
    expect(lead.variantId).toBe('capsules_10');
    expect(lead.variantName).toBe('10 cápsulas');
    expect(lead.capsules).toBe(10);
    expect(lead.quantity).toBe(2);
  });

  it('no incluye campos de más ni datos vacíos', () => {
    const lead = buildLeadPayload({ name: 'Ana', phone: '+18095551234', source: 'formulario', consent: false });
    expect(lead.location).toBeNull();
    expect(lead.productId).toBeNull();
    expect(lead.variantId).toBeNull();
    expect(lead.variantName).toBeNull();
    expect(lead.capsules).toBeNull();
    expect(lead.quantity).toBeNull();
    expect(Object.keys(lead)).not.toContain('password');
    expect(lead.consent).toBe(false);
  });
});

describe('contrato de ORDER_INTENT', () => {
  it('separa presentación (cápsulas) de cantidad de unidades y calcula el total', () => {
    const order = buildOrderIntentPayload({
      customer: { id: 'lead-1', name: 'Ana', phone: '+18095551234', location: 'Higüey' },
      product: { id: 'phytoemagry-v1', name: 'Phytoemagry', currency: 'DOP' },
      variant: { id: 'capsules_10', name: '10 cápsulas', capsules: 10, price: 2500 },
      quantity: 2,
      source: 'checkout',
      attribution,
      sessionId: 's_1',
      createdAt: '2026-01-01T10:05:00.000Z',
    });

    expect(order.type).toBe('order_intent');
    expect(order.schemaVersion).toBe('1.1');
    expect(order.leadId).toBe('lead-1');
    // Presentación
    expect(order.variantId).toBe('capsules_10');
    expect(order.variantName).toBe('10 cápsulas');
    expect(order.capsules).toBe(10);
    // Pedido
    expect(order.quantity).toBe(2);
    expect(order.totalCapsules).toBe(20);
    expect(order.unitPrice).toBe(2500);
    expect(order.total).toBe(5000);
    expect(order.currency).toBe('DOP');
    expect(order.status).toBe('pending_confirmation');
    expect(order.attribution.utm_campaign).toBe('verano');
    expect(order.product.presentation).toBe('10 cápsulas');
  });

  it('los totales coinciden con los ejemplos obligatorios del negocio', () => {
    const build = (capsules, price, quantity) =>
      buildOrderIntentPayload({
        customer: { name: 'Ana', phone: '+18095551234' },
        product: { id: 'phytoemagry-v1', name: 'Phytoemagry', currency: 'DOP' },
        variant: { id: `capsules_${capsules}`, name: `${capsules} cápsulas`, capsules, price },
        quantity,
      });

    expect(build(10, 2500, 2).total).toBe(5000);
    expect(build(30, 6000, 2).total).toBe(12000);
    expect(build(60, 10000, 2).total).toBe(20000);
  });

  it('sin presentación configurada el total es null (no se inventa)', () => {
    const order = buildOrderIntentPayload({
      customer: { name: 'Ana', phone: '+18095551234' },
      product: { id: 'p1', name: 'Phytoemagry' },
      variant: null,
      quantity: 2,
    });
    expect(order.variantId).toBeNull();
    expect(order.unitPrice).toBeNull();
    expect(order.total).toBeNull();
    expect(order.totalCapsules).toBeNull();
    expect(order.currency).toBe('DOP');
  });

  it('aplana la atribución sin dejar campos indefinidos', () => {
    const flat = flattenAttribution(null);
    expect(flat).toMatchObject({ utm_source: null, fbclid: null, clickIds: {} });
    expect(Object.values(flat).every((value) => value !== undefined)).toBe(true);
  });
});

describe('cliente del CRM', () => {
  it('sin endpoint guarda en cola local y no hace fetch', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn();
    const client = createCrmClient({ endpoint: null, storage, fetchImpl });

    expect(client.enabled).toBe(false);
    const lead = buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true });
    const result = await client.submitLead(lead);

    expect(result.queued).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.get(QUEUE_KEY)).toHaveLength(1);
    expect(client.listQueued()[0].type).toBe('lead');
  });

  it('con endpoint hace POST JSON sin credenciales', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201 }));
    const client = createCrmClient({ endpoint: 'https://crm.test/api/leads', storage, fetchImpl });

    const lead = buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true });
    const result = await client.submitOrderIntent(lead);

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(false);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('omit');
    expect(JSON.parse(options.body).type).toBe('lead');
    expect(storage.get(QUEUE_KEY)).toBeNull();
  });

  it('acepta una ruta del mismo dominio (/api/crm): es la base de datos de la imagen Docker', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202 }));
    const client = createCrmClient({ endpoint: '/api/crm', storage, fetchImpl });

    expect(client.enabled).toBe(true);
    const lead = buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'checkout', consent: true });
    const result = await client.submitLead(lead);

    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/crm');
    expect(storage.get(QUEUE_KEY)).toBeNull();
  });

  it('un endpoint sin forma de URL se trata como "sin endpoint"', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn();
    const client = createCrmClient({ endpoint: 'mi-crm.com', storage, fetchImpl });

    expect(client.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('si el envío falla, el dato no se pierde', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const client = createCrmClient({ endpoint: 'https://crm.test/api/leads', storage, fetchImpl });

    const lead = buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true });
    const result = await client.submitLead(lead);

    expect(result.ok).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.error).toBe('send_failed');
    expect(client.listQueued()).toHaveLength(1);
  });

  it('la cola pendiente se reintenta y se vacía cuando vuelve la conexión', async () => {
    const storage = createMemoryStorage();
    // Primero sin conexión, luego con ella (el móvil se quedó sin datos).
    let online = false;
    const fetchImpl = vi.fn(async () => {
      if (!online) throw new Error('offline');
      return { ok: true, status: 202 };
    });
    const client = createCrmClient({ endpoint: 'https://crm.test/api/crm', storage, fetchImpl });

    const lead = buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true });
    await client.submitLead(lead);
    expect(client.listQueued()).toHaveLength(1);

    online = true;
    const result = await client.flushQueue();
    expect(result).toMatchObject({ ok: true, sent: 1, remaining: 0 });
    expect(client.listQueued()).toHaveLength(0);
    // El payload enviado es el del contrato: sin los metadatos del navegador.
    const body = JSON.parse(fetchImpl.mock.calls.at(-1)[1].body);
    expect(body.name).toBe('Ana');
    expect(body.queuedAt).toBeUndefined();
  });

  it('si el reintento falla, los datos siguen en la cola (no se pierden)', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const client = createCrmClient({ endpoint: 'https://crm.test/api/crm', storage, fetchImpl });
    await client.submitLead(buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true }));
    await client.submitOrderIntent(buildLeadPayload({ name: 'Luis', phone: '+56911113333', source: 'checkout', consent: true }));

    const result = await client.flushQueue();
    expect(result.sent).toBe(0);
    expect(client.listQueued()).toHaveLength(2);
  });

  it('sin endpoint configurado no se reintenta nada (no hay a dónde enviar)', async () => {
    const storage = createMemoryStorage();
    const fetchImpl = vi.fn();
    const client = createCrmClient({ endpoint: null, storage, fetchImpl });
    await client.submitLead(buildLeadPayload({ name: 'Ana', phone: '+56911112222', source: 'formulario', consent: true }));

    const result = await client.flushQueue();
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('la cola está limitada para no crecer sin control', async () => {
    const storage = createMemoryStorage();
    const client = createCrmClient({ endpoint: null, storage });
    for (let i = 0; i < 60; i += 1) {
      const lead = buildLeadPayload({ name: `Persona ${i}`, phone: '+56911112222', source: 'formulario', consent: true });
      await client.submitLead(lead);
    }
    expect(client.listQueued().length).toBeLessThanOrEqual(50);
  });
});
