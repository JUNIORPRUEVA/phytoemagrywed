// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'delivery-tracking-token';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminDelivery-12345';
const DELIVERY_PASS = 'Delivery-12345';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' };
const P1 = { lat: 18.61, lng: -68.7, accuracy: 8, timestamp: new Date().toISOString() };

let tmpDir;
let app;
let adminCookie = '';
let deliveryCookie = '';
let otherDeliveryCookie = '';
let delivery;

const json = async (response) => JSON.parse(await response.text());
const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

async function login(username, password) {
  const response = await request('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, '');
  return { response, body: await json(response), cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] };
}

async function createOrder() {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: '18095550999',
      name: 'Cliente Delivery',
      paymentMethod: 'CASH',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: L1,
      deliveryFee: 250,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-delivery-tracking-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
  });
  const admin = await login(ADMIN_USER, ADMIN_PASS);
  adminCookie = admin.cookie;

  delivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'delivery1@phyto.local', password: DELIVERY_PASS, displayName: 'Delivery Uno', role: 'DELIVERY' }),
  }))).user;
  await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'delivery2@phyto.local', password: DELIVERY_PASS, displayName: 'Delivery Dos', role: 'DELIVERY' }),
  });
  deliveryCookie = (await login('delivery1@phyto.local', DELIVERY_PASS)).cookie;
  otherDeliveryCookie = (await login('delivery2@phyto.local', DELIVERY_PASS)).cookie;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('delivery tracking realtime API', () => {
  it('un DELIVERY no inicia un pedido sin asignación persistente previa', async () => {
    const order = await createOrder();
    const blocked = await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('delivery_not_assigned');

    const assigned = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(assigned.status).toBe(200);

    const stillBlocked = await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(stillBlocked.status).toBe(409);
    expect((await json(stillBlocked)).error).toBe('delivery_contact_required');

    const startedByAdmin = await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(startedByAdmin.status).toBe(201);
    const body = await json(startedByAdmin);
    expect(body.session.delivery_user_id).toBe(delivery.id);
  });

  it('ADMIN inicia tracking para un DELIVERY y el pedido pasa a enviado', async () => {
    const order = await createOrder();
    const response = await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.session.status).toBe('ACTIVE');
    expect(body.session.delivery_user_id).toBe(delivery.id);
    expect(body.session.destination.latitude).toBeCloseTo(L1.latitude, 4);
    expect(body.order.status).toBe('enviado');
  });

  it('DELIVERY actualiza solo su sesión; otro delivery queda bloqueado', async () => {
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));
    const own = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify(P1),
    }, deliveryCookie);
    expect(own.status).toBe(200);
    const body = await json(own);
    expect(body.session.last_position.latitude).toBeCloseTo(P1.lat, 4);
    expect(body.session.distance_m).toBeGreaterThan(0);
    expect(body.session.eta_label).toMatch(/min/);

    const stolen = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ ...P1, lat: 19 }),
    }, otherDeliveryCookie);
    expect(stolen.status).toBe(403);

    const stolenRead = await request(`/api/admin/delivery-tracking/${start.session.id}`, {}, otherDeliveryCookie);
    expect(stolenRead.status).toBe(403);
  });

  it('rechaza coordenadas inválidas y sesiones cerradas', async () => {
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));
    const bad = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ lat: 99, lng: -68 }),
    }, deliveryCookie);
    expect(bad.status).toBe(422);

    const stale = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ lat: 18.61, lng: -68.7, timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString() }),
    }, deliveryCookie);
    expect(stale.status).toBe(422);

    const stopped = await request(`/api/admin/delivery-tracking/${start.session.id}/stop`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(stopped.status).toBe(200);
    const after = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify(P1),
    }, deliveryCookie);
    expect(after.status).toBe(409);
  });

  it('guarda puntos consistentes y mantiene último punto de la sesión', async () => {
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));
    const first = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ ...P1, accuracy: 10 }),
    }, deliveryCookie);
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondPoint = { lat: 18.612, lng: -68.702, accuracy: 90, timestamp: new Date().toISOString() };
    const second = await request(`/api/admin/delivery-tracking/${start.session.id}/location`, {
      method: 'POST',
      body: JSON.stringify(secondPoint),
    }, deliveryCookie);
    expect(second.status).toBe(200);

    const detail = await json(await request(`/api/admin/delivery-tracking/${start.session.id}`));
    expect(detail.session.order_id).toBe(order.item.id);
    expect(detail.session.delivery_user_id).toBe(delivery.id);
    expect(detail.session.last_position.latitude).toBeCloseTo(secondPoint.lat, 4);
    expect(detail.session.last_position.accuracy).toBe(90);
    expect(detail.points.length).toBeGreaterThan(0);
    expect(detail.points.every((point) => typeof point.recorded_at === 'string')).toBe(true);
  });

  it('completar entrega cierra tracking y marca el pedido entregado', async () => {
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));
    const complete = await request(`/api/admin/delivery-tracking/${start.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(complete.status).toBe(200);
    const body = await json(complete);
    expect(body.session.status).toBe('COMPLETED');
    expect(body.order.status).toBe('entregado');
  });
});
