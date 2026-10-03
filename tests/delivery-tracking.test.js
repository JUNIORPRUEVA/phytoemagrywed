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

async function restock(quantity = 100) {
  const response = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity, unitCost: '126.66', reason: 'Inventario inicial delivery' }),
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

    const startedByDelivery = await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(startedByDelivery.status).toBe(201);
    const body = await json(startedByDelivery);
    expect(body.session.delivery_user_id).toBe(delivery.id);
    expect(body.order.status).toBe('enviado');
  });

  it('el pedido se le pasa a un AGENTE (no admin) y es él quien lo entrega', async () => {
    // El negocio no tiene un equipo de reparto aparte: reparte un agente.
    const agente = (
      await json(
        await request('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: 'agente-reparto@phyto.local',
            password: 'Agente-12345',
            displayName: 'Agente Reparto',
            role: 'AGENT',
          }),
        }),
      )
    ).user;
    expect(agente.role).toBe('AGENT');
    const agenteCookie = (await login('agente-reparto@phyto.local', 'Agente-12345')).cookie;

    const order = await createOrder();
    const assigned = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: agente.id }),
    });
    expect(assigned.status).toBe(200);
    expect((await json(assigned)).order.delivery.delivery_user_id).toBe(agente.id);

    // El agente asignado sí puede arrancar SU entrega (permisos de reparto propios).
    const started = await request(
      `/api/admin/orders/${order.item.id}/delivery/start`,
      { method: 'POST', body: '{}' },
      agenteCookie,
    );
    expect(started.status).toBe(201);
    expect((await json(started)).session.delivery_user_id).toBe(agente.id);

    // Un administrador NO reparte: no se puede poner como delivery.
    const adminId = (await json(await request('/api/admin/users'))).users.find((user) => user.role === 'ADMIN').id;
    const comoAdmin = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: adminId }),
    });
    expect(comoAdmin.status).toBe(422);
    expect((await json(comoAdmin)).error).toBe('invalid_delivery_user');
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
    await restock(100);
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
    expect(body.order.delivered_at).toBeTruthy();
    expect(body.order.delivery.delivery_status).toBe('DELIVERED');

    const duplicate = await request(`/api/admin/delivery-tracking/${start.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(duplicate.status).toBe(200);
    expect((await json(duplicate)).duplicate).toBe(true);

    const inventory = await json(await request('/api/admin/inventory'));
    const movements = inventory.movements.filter((row) => row.order_id === order.item.id && row.type === 'SALE');
    expect(movements).toHaveLength(1);
    expect(inventory.stock).toBe(90);
  });

  it('ADMIN cambia manualmente pendiente a cancelado con motivo, auditoría e integridad válida', async () => {
    const order = await createOrder();
    const response = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'PENDIENTE', reason: 'Cliente desistió del pedido' }),
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.order.status).toBe('cancelado');
    expect(body.integrity.status).toBe('VALID');

    const detail = await json(await request(`/api/admin/orders/${order.item.id}`));
    expect(detail.timeline.some((row) => row.reason === 'Cliente desistió del pedido')).toBe(true);

    const audit = await json(await request(`/api/admin/audit?entity=order&entityId=${encodeURIComponent(order.item.id)}`));
    const manual = audit.entries.find((row) => row.data?.source === 'MANUAL_ADMIN');
    expect(manual).toBeTruthy();
    expect(manual.data).toMatchObject({
      previous_status: 'nuevo',
      new_status: 'cancelado',
      reason: 'Cliente desistió del pedido',
      source: 'MANUAL_ADMIN',
    });
  });

  it('bloquea motivo débil, no admin y estado obsoleto', async () => {
    const order = await createOrder();
    const weak = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'PENDIENTE', reason: 'ok' }),
    });
    expect(weak.status).toBe(422);
    expect((await json(weak)).error).toBe('invalid_reason');

    const forbidden = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'PENDIENTE', reason: 'Cliente no recibirá' }),
    }, deliveryCookie);
    expect(forbidden.status).toBe(403);

    const stale = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'EN_CAMINO', reason: 'Pantalla vieja abierta' }),
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe('stale_order_status');
  });

  it('no permite marcar En camino sin tracking activo', async () => {
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const blocked = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'EN_CAMINO', expectedStatus: 'PENDIENTE', reason: 'Intento manual sin sesión activa' }),
    });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('active_tracking_required');
  });

  it('ADMIN marca Entregado con lógica central: cierra tracking, inventario/postventa una vez y bloquea reversión simple', async () => {
    await restock(100);
    const beforeInventory = await json(await request('/api/admin/inventory'));
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));

    const delivered = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ENTREGADO', expectedStatus: 'EN_CAMINO', reason: 'Entrega verificada por administración' }),
    });
    expect(delivered.status).toBe(200);
    const deliveredBody = await json(delivered);
    expect(deliveredBody.order.status).toBe('entregado');
    expect(deliveredBody.order.delivered_at).toBeTruthy();
    expect(deliveredBody.order.delivery.delivery_status).toBe('DELIVERED');
    expect(deliveredBody.integrity.status).toBe('VALID');

    const session = await json(await request(`/api/admin/delivery-tracking/${start.session.id}`));
    expect(session.session.status).toBe('COMPLETED');

    const duplicate = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ENTREGADO', expectedStatus: 'ENTREGADO', reason: 'Doble click controlado' }),
    });
    expect(duplicate.status).toBe(200);
    expect((await json(duplicate)).duplicate).toBe(true);

    const inventory = await json(await request('/api/admin/inventory'));
    expect(inventory.movements.filter((row) => row.order_id === order.item.id && row.type === 'SALE')).toHaveLength(1);
    expect(inventory.stock).toBe(Number(beforeInventory.stock) - 10);

    const detail = await json(await request(`/api/admin/orders/${order.item.id}`));
    expect(detail.followups.filter((row) => row.status === 'pending')).toHaveLength(6);
    const report = await json(await request('/api/admin/reports/sales?period=hoy'));
    expect(report.report.summary.orders).toBeGreaterThanOrEqual(1);

    const backToPending = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'PENDIENTE', expectedStatus: 'ENTREGADO', reason: 'Intento de reversión simple' }),
    });
    expect(backToPending.status).toBe(409);
    expect((await json(backToPending)).error).toBe('delivered_reversal_required');

    const backToCancelled = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'ENTREGADO', reason: 'Intento de cancelar entrega' }),
    });
    expect(backToCancelled.status).toBe(409);
    expect((await json(backToCancelled)).error).toBe('delivered_reversal_required');
  });

  it('ADMIN cancela un pedido en camino y cierra tracking activo', async () => {
    const order = await createOrder();
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    }));
    const cancelled = await request(`/api/admin/orders/${order.item.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', expectedStatus: 'EN_CAMINO', reason: 'Cliente canceló durante la ruta' }),
    });
    expect(cancelled.status).toBe(200);
    const body = await json(cancelled);
    expect(body.order.status).toBe('cancelado');
    expect(body.integrity.status).toBe('VALID');

    const session = await json(await request(`/api/admin/delivery-tracking/${start.session.id}`));
    expect(session.session.status).toBe('CANCELLED');
  });

  it('cambios concurrentes: una transición gana y la otra recibe 409 por estado obsoleto', async () => {
    await restock(100);
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const payload = { status: 'ENTREGADO', expectedStatus: 'EN_CAMINO', reason: 'Confirmación simultánea de entrega' };
    const [a, b] = await Promise.all([
      request(`/api/admin/orders/${order.item.id}/status`, { method: 'PATCH', body: JSON.stringify(payload) }),
      request(`/api/admin/orders/${order.item.id}/status`, { method: 'PATCH', body: JSON.stringify(payload) }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const inventory = await json(await request('/api/admin/inventory'));
    expect(inventory.movements.filter((row) => row.order_id === order.item.id && row.type === 'SALE')).toHaveLength(1);
  });
});
