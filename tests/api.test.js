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
    expect(lead.landingPage).toContain('utm_source=facebook');
    expect(lead.createdAt).toBe('2026-01-01T10:00:00.000Z');
    // Datos de la presentación elegida
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
    expect(result.error).toBe('network_error');
    expect(client.listQueued()).toHaveLength(1);
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
