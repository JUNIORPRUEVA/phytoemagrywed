// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

let app;
let dir;
afterEach(async () => { await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('cotiza desde la tienda hasta el GPS confirmado usando la ruta vial del servidor', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'customer-delivery-'));
  let routeCalls = 0;
  app = await startCrmServer({ port: 0, host: '127.0.0.1', databaseUrl: '',
    dataFile: path.join(dir, 'crm.sqlite'), token: 'delivery-rules-uat', quiet: true,
    schedulerEnabled: false, whatsapp: { enabled: false }, metaCapi: { enabled: false },
    storeSmartCommerce: { enabled: false, router: { configured: true,
      route: async () => { routeCalls++; return { ok: true, meters: 2500, durationSeconds: 600, provider: 'fixture-road' }; } } } });
  const login = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'delivery-rules-uat' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (path, body) => {
    const response = await fetch(`${app.url}/api/admin/${path}`, { method: body ? 'POST' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const store = (await request('suppliers', { company_id: 'fulltech', name: 'Tienda Ruta',
    address: 'Calle 1', lat: 18.6, lng: -68.7, phone: '8095559999' })).data.supplier;
  const policy = await request('delivery-rules/customer', { company_id: 'fulltech', policy: {
    active: true, mode: 'per_km', max_meters: 10000, minimum_cents: 8000,
    base_cents: 3000, per_km_cents: 1000 } });
  expect(policy.status).toBe(200);
  const input = { company_id: 'fulltech', supplier_id: store.id,
    destination: { latitude: 18.62, longitude: -68.71 }, destinationConfirmed: true };
  expect((await request('delivery-rules/quote', { ...input, destinationConfirmed: false })).data.error)
    .toBe('destination_confirmation_required');
  const quoted = await request('delivery-rules/quote', input);
  expect(quoted.status).toBe(201);
  expect(quoted.data.quote).toMatchObject({ supplier_id: store.id, fee_cents: 8000,
    route: { meters: 2500, provider: 'fixture-road' } });
  expect(JSON.stringify(quoted.data)).not.toContain('8095559999');
  expect(routeCalls).toBe(1);
  const product = (await request('store/products', { kind: 'product', product_type: 'third_party',
    track_stock: false, name: 'Artículo de tienda', sku: 'RUTA-001', price: 100, cost: 50 })).data.product;
  await request(`products/${product.id}/suppliers`, { supplier_id: store.id, cost_cents: 5000 });
  const customer = (await request('pos/customers', { name: 'Cliente Ruta', phone: '8095550101' })).data.customer;
  const prematureInvoice = await request('pos/checkout', { requestId: randomUUID(), mode: 'invoice',
    customerId: customer.id, items: [{ variantId: product.id, quantity: 1, supplierId: store.id }],
    expectedTotal: 18000, paymentMethod: 'CASH', deliveryQuoteId: quoted.data.quote.id,
    location: input.destination });
  expect(prematureInvoice.status).toBe(409);
  expect(prematureInvoice.data.error).toBe('store_pickup_requires_open_order');
  const order = await request('pos/checkout', { requestId: randomUUID(), mode: 'order',
    customerId: customer.id, items: [{ variantId: product.id, quantity: 1, supplierId: store.id }],
    expectedTotal: 18000, paymentMethod: 'CASH', deliveryQuoteId: quoted.data.quote.id,
    location: input.destination, deliveryFee: 1 });
  expect(order.status).toBe(201);
  const saved = (await request(`orders/${order.data.orderId}`)).data.order;
  expect(saved.delivery.fee).toBe(80);
  expect(saved.delivery.route).toMatchObject({ meters: 2500, provider: 'fixture-road' });
  expect(saved.delivery.customer_quote_snapshot.fee_cents).toBe(8000);
  expect(JSON.stringify(saved.delivery.customer_quote_snapshot)).not.toContain('8095559999');
  const courierPhone = '+18095550888';
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-route', name: 'Repartidor Ruta', phone: courierPhone, shareOrders: true },
  ]);
  const courier = await request('couriers', { companyId: 'fulltech', kind: 'EXTERNAL',
    phone: courierPhone, displayName: 'Repartidor Ruta', contactId: 'contact-route',
    appAccess: true, pin: '123456' });
  expect(courier.status).toBe(201);
  const compensation = await request('courier-compensation', { company_id: 'fulltech', policy: {
    active: true, base_model: 'DISTANCE', distance_base_cents: 5000,
    distance_per_km_cents: 1200, distance_min_cents: 6000, product_sale_percent: 3,
  } });
  expect(compensation.status).toBe(200);
  const assigned = await request(`orders/${order.data.orderId}/courier/assign`, { contactPhone: courierPhone });
  expect(assigned.status).toBe(200);
  expect(assigned.data.order.delivery.courier_compensation_snapshot.total_cents).toBe(8300);
  expect(assigned.data.order.delivery.pickup).toMatchObject({ name: 'Tienda Ruta', latitude: 18.6 });
});
