// @vitest-environment node
/*
 * FASE 05 — MOTOR OPERATIVO DE ENTREGAS.
 *
 * Se prueba en dos capas:
 *   1. la máquina de estados pura (sin E/S): qué transición vale y qué estado comercial deriva;
 *   2. los endpoints reales del móvil: aceptar, recoger, iniciar, llegar, entregar, rechazar,
 *      con versión, clave de idempotencia, vencimiento de la oferta y avisos encolados.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import {
  DELIVERY_STATES,
  applyTransition,
  deriveLifecycleFromLegacy,
  derivedOrderStatus,
  isOfferExpired,
  lifecycleOf,
} from '../server/delivery-lifecycle.mjs';

const TOKEN = 'lifecycle-test-token';
const PHONE = '+18095550101';

let app;
let dir;
let admin;

const call = async (route, body, auth = admin) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie: auth, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const patch = async (route, body) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method: 'PATCH',
    headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const courier = async (route, { token, method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const login = (phone, pin) => courier('/api/courier/login', { method: 'POST', body: { phone, pin } });

/** Fila del pedido tal y como la guarda el almacén (tolera las dos formas). */
async function storedOrder(orderId) {
  const rows = await app.ctx.store.listAdmin({ limit: 5000 });
  const row = rows.find((item) => item.id === orderId) ?? {};
  const raw = row.orderJson ?? row.order_json;
  return raw ? JSON.parse(raw) : null;
}

async function prepare({ status = 'nuevo' } = {}) {
  const customer = await call('pos/customers', { name: 'Cliente Ciclo', phone: '8095559001' });
  const created = await call('orders', {
    name: customer.data?.customer?.name ?? 'Cliente Ciclo',
    phone: '8095559001',
    status,
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  });
  const orderId = created.data?.item?.id ?? created.data?.order?.id ?? created.data?.id;
  await call(`orders/${orderId}/courier/assign`, { contactPhone: PHONE });
  const session = await login(PHONE, '123456');
  return { orderId, token: session.data.token };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'phyto-lifecycle-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'lifecycle.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });
  const session = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  admin = session.headers.get('set-cookie').split(';')[0];
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-ext', name: 'Mensajero Externo', phone: PHONE, shareOrders: true },
  ]);
  await call('couriers', {
    kind: 'EXTERNAL',
    phone: PHONE,
    displayName: 'Mensajero Externo',
    contactId: 'contact-ext',
    appAccess: true,
    pin: '123456',
  });
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('máquina de estados (pura)', () => {
  it('deriva el ciclo de los pedidos antiguos sin inventar «entregado»', () => {
    expect(deriveLifecycleFromLegacy({ status: 'nuevo' })).toBe(DELIVERY_STATES.ASSIGNED);
    expect(deriveLifecycleFromLegacy({ status: 'entregado' })).toBe(DELIVERY_STATES.DELIVERED);
    expect(deriveLifecycleFromLegacy({ status: 'cancelado' })).toBe(DELIVERY_STATES.CANCELLED);
    expect(deriveLifecycleFromLegacy({ status: 'nuevo', delivery: { delivery_user_id: 'u1' } })).toBe(
      DELIVERY_STATES.OFFERED,
    );
    expect(deriveLifecycleFromLegacy({ status: 'en_camino', delivery: { delivery_accepted_at: 'x', delivery_started_at: 'y' } })).toBe(
      DELIVERY_STATES.EN_ROUTE,
    );
  });

  it('aplica la cadena completa y sube la versión en cada paso', () => {
    let order = { status: 'nuevo', version: 1, delivery: { lifecycle: DELIVERY_STATES.OFFERED } };
    expect(lifecycleOf(order)).toBe(DELIVERY_STATES.OFFERED);

    order = applyTransition(order, 'accept', { now: '2026-10-23T10:00:00.000Z' }).order;
    expect(order.delivery.lifecycle).toBe(DELIVERY_STATES.ACCEPTED);
    expect(order.status).toBe('preparando');
    expect(order.version).toBe(2);

    order = applyTransition(order, 'pickup', { now: '2026-10-23T10:05:00.000Z' }).order;
    expect(order.delivery.lifecycle).toBe(DELIVERY_STATES.PICKED_UP);

    order = applyTransition(order, 'start', { now: '2026-10-23T10:10:00.000Z' }).order;
    expect(order.delivery.lifecycle).toBe(DELIVERY_STATES.EN_ROUTE);
    expect(order.status).toBe('en_camino');
    expect(order.delivery.delivery_started_at).toBe('2026-10-23T10:10:00.000Z');

    order = applyTransition(order, 'arrive', { now: '2026-10-23T10:30:00.000Z' }).order;
    expect(order.delivery.lifecycle).toBe(DELIVERY_STATES.ARRIVED);

    order = applyTransition(order, 'deliver', { now: '2026-10-23T10:32:00.000Z' }).order;
    expect(order.delivery.lifecycle).toBe(DELIVERY_STATES.DELIVERED);
    expect(order.status).toBe('entregado');
    expect(order.version).toBe(6);
  });

  it('rechaza transiciones imposibles y estados finales', () => {
    const offered = { status: 'nuevo', delivery: { lifecycle: DELIVERY_STATES.OFFERED } };
    expect(applyTransition(offered, 'deliver').ok).toBe(false);
    /* Recoger sin aceptar sigue siendo imposible (INICIAR sí está permitido desde oferta). */
    expect(applyTransition(offered, 'pickup').error).toBe('invalid_transition');

    const delivered = { status: 'entregado', delivery: { lifecycle: DELIVERY_STATES.DELIVERED } };
    const again = applyTransition(delivered, 'accept');
    expect(again.ok).toBe(false);
    expect(again.error).toBe('already_closed');
  });

  it('el estado comercial del pedido no se pisa con el logístico', () => {
    expect(derivedOrderStatus(DELIVERY_STATES.OFFERED, 'nuevo')).toBe('confirmado');
    expect(derivedOrderStatus(DELIVERY_STATES.EN_ROUTE, 'preparando')).toBe('en_camino');
    expect(derivedOrderStatus(DELIVERY_STATES.DELIVERED, 'en_camino')).toBe('entregado');
    /* Un pedido cancelado no revive por una transición logística. */
    expect(derivedOrderStatus(DELIVERY_STATES.REJECTED, 'cancelado')).toBe('cancelado');
  });

  it('la oferta vencida se detecta con el reloj del servidor', () => {
    const order = {
      delivery: { lifecycle: DELIVERY_STATES.OFFERED, offer_expires_at: '2026-10-23T10:00:00.000Z' },
    };
    expect(isOfferExpired(order, Date.parse('2026-10-23T10:01:00.000Z'))).toBe(true);
    expect(isOfferExpired(order, Date.parse('2026-10-23T09:59:00.000Z'))).toBe(false);
    expect(isOfferExpired({ delivery: { lifecycle: DELIVERY_STATES.ACCEPTED, offer_expires_at: '2020-01-01T00:00:00.000Z' } })).toBe(false);
  });
});

describe('endpoints del repartidor', () => {
  it('la asignación crea una OFERTA con vencimiento y acciones disponibles', async () => {
    const { token, orderId } = await prepare();
    const detail = await courier(`/api/courier/orders/${orderId}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.data.order.delivery_lifecycle).toBe('OFFERED');
    /* Externo: aceptación explícita. INICIAR también está disponible (flujo de dos botones). */
    expect(detail.data.order.available_actions).toEqual(['accept', 'reject', 'start']);
    expect(typeof detail.data.order.offer_expires_at).toBe('string');
  });

  it('recorre aceptar → recoger → iniciar → llegar → entregar', async () => {
    const { token, orderId } = await prepare();
    const base = `/api/courier/orders/${orderId}`;

    const accepted = await courier(`${base}/accept`, { token, method: 'POST', body: {} });
    expect(accepted.status).toBe(200);
    expect(accepted.data.state).toBe('ACCEPTED');
    /* Tras aceptar: recoger o ir directo a INICIAR (que implica recogida). */
    expect(accepted.data.actions).toEqual(['pickup', 'start']);

    const picked = await courier(`${base}/pickup`, { token, method: 'POST', body: {} });
    expect(picked.data.state).toBe('PICKED_UP');

    const started = await courier(`${base}/start`, { token, method: 'POST', body: {} });
    expect(started.data.state).toBe('EN_ROUTE');

    const arrived = await courier(`${base}/arrive`, { token, method: 'POST', body: {} });
    expect(arrived.data.state).toBe('ARRIVED');

    /* Seguridad: sin código de entrega configurado NO se confirma; queda pendiente. */
    const pending = await courier(`${base}/deliver`, { token, method: 'POST', body: {} });
    expect(pending.status).toBe(202);
    expect(pending.data.pending_verification).toBe(true);

    /* Administración fija el código y el repartidor lo usa: ahí sí se confirma. */
    const codeResponse = await call(`orders/${orderId}/delivery-code`, {});
    const code = codeResponse.data?.code;
    expect(typeof code).toBe('string');
    const delivered = await courier(`${base}/deliver`, { token, method: 'POST', body: { proofCode: code } });
    expect(delivered.data.state).toBe('DELIVERED');
    expect(delivered.data.order.order_status).toBe('entregado');

    /* Historial real de la entrega, incluido el intento que quedó pendiente. */
    const events = await app.ctx.db.list('delivery_events', { limit: 100 });
    expect(events.map((row) => row.event).sort()).toEqual(
      ['accept', 'arrive', 'deliver', 'deliver_pending_verification', 'pickup', 'start'].sort(),
    );
  });

  it('iniciar y llegar encolan los DOS avisos, sin declararlos enviados', async () => {
    const { token, orderId } = await prepare();
    const base = `/api/courier/orders/${orderId}`;
    await courier(`${base}/accept`, { token, method: 'POST', body: {} });
    await courier(`${base}/pickup`, { token, method: 'POST', body: {} });
    await courier(`${base}/start`, { token, method: 'POST', body: {} });
    await courier(`${base}/arrive`, { token, method: 'POST', body: {} });

    const outbox = await app.ctx.db.list('delivery_message_outbox', { limit: 50 });
    expect(outbox.map((row) => row.kind).sort()).toEqual(['delivery_arrived', 'delivery_started']);
    for (const row of outbox) {
      expect(row.status).toBe('pending_template');
      expect(row.status).not.toBe('sent');
      expect(row.error).toBe('no_approved_template');
    }
  });

  it('aceptar no envía ningún aviso al cliente', async () => {
    const { token, orderId } = await prepare();
    await courier(`/api/courier/orders/${orderId}/accept`, { token, method: 'POST', body: {} });
    const outbox = await app.ctx.db.list('delivery_message_outbox', { limit: 50 });
    expect(outbox).toHaveLength(0);
  });

  it('la misma clave de idempotencia no ejecuta dos veces', async () => {
    const { token, orderId } = await prepare();
    const base = `/api/courier/orders/${orderId}/accept`;
    const first = await courier(base, { token, method: 'POST', body: { idempotencyKey: 'aceptar-1' } });
    expect(first.status).toBe(200);
    expect(first.data.duplicate).toBe(false);

    const second = await courier(base, { token, method: 'POST', body: { idempotencyKey: 'aceptar-1' } });
    expect(second.status).toBe(200);
    expect(second.data.duplicate).toBe(true);

    const events = await app.ctx.db.list('delivery_events', { limit: 50 });
    expect(events.filter((row) => row.event === 'accept')).toHaveLength(1);
  });

  it('una versión vieja no pisa el trabajo', async () => {
    const { token, orderId } = await prepare();
    const detail = await courier(`/api/courier/orders/${orderId}`, { token });
    /* Una versión claramente distinta de la actual (los pedidos nuevos nacen en 1). */
    const stale = Number(detail.data.order.version ?? 1) + 5;
    const attempt = await courier(`/api/courier/orders/${orderId}/accept`, {
      token,
      method: 'POST',
      body: { expectedVersion: stale },
    });
    expect(attempt.status).toBe(409);
    expect(attempt.data.error).toBe('stale_order');
  });

  it('no se puede aceptar dos veces ni entregar sin aceptar', async () => {
    const { token, orderId } = await prepare();
    const base = `/api/courier/orders/${orderId}`;
    await courier(`${base}/accept`, { token, method: 'POST', body: {} });
    const twice = await courier(`${base}/accept`, { token, method: 'POST', body: {} });
    expect(twice.status).toBe(409);
    expect(twice.data.error).toBe('invalid_transition');
  });

  it('rechazar guarda el motivo y cierra la entrega', async () => {
    const { token, orderId } = await prepare();
    const rejected = await courier(`/api/courier/orders/${orderId}/reject`, {
      token,
      method: 'POST',
      body: { reason: 'No tengo el vehículo disponible' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.state).toBe('REJECTED');
    const stored = await storedOrder(orderId);
    expect(JSON.stringify(stored)).toContain('No tengo el vehículo disponible');
  });

  it('la oferta vencida se cierra en el servidor y no se puede aceptar', async () => {
    const { token, orderId } = await prepare();
    const rows = await app.ctx.store.listAdmin({ limit: 5000 });
    const row = rows.find((item) => item.id === orderId);
    const order = JSON.parse(row.orderJson ?? row.order_json);
    order.delivery.offer_expires_at = new Date(Date.now() - 60_000).toISOString();
    await app.ctx.store.update(orderId, { orderJson: JSON.stringify(order) });

    const attempt = await courier(`/api/courier/orders/${orderId}/accept`, { token, method: 'POST', body: {} });
    expect(attempt.status).toBe(409);
    expect(attempt.data.error).toBe('offer_expired');

    const after = await storedOrder(orderId);
    expect(after.delivery.lifecycle).toBe('EXPIRED');
  });

  it('un pedido cancelado no admite acciones del repartidor', async () => {
    const { token, orderId } = await prepare();
    const cancelled = await patch(`orders/${orderId}/status`, { status: 'cancelado', reason: 'Cliente desistió' });
    expect(cancelled.status).toBe(200);
    const attempt = await courier(`/api/courier/orders/${orderId}/accept`, { token, method: 'POST', body: {} });
    expect(attempt.status).toBe(409);
    expect(['already_closed', 'invalid_transition']).toContain(attempt.data.error);
  });

  it('si el pedido se reasigna, el repartidor anterior no puede operar', async () => {
    const { token, orderId } = await prepare();
    const user = await call('users', {
      username: 'repartidor-nuevo',
      displayName: 'Repartidor Nuevo',
      role: 'DELIVERY',
      password: 'Clave-Ciclo-1',
    });
    expect((await call(`orders/${orderId}/delivery/assign`, { deliveryUserId: user.data?.user?.id })).status).toBe(200);

    const attempt = await courier(`/api/courier/orders/${orderId}/accept`, { token, method: 'POST', body: {} });
    expect(attempt.status).toBe(404);
  });
});
