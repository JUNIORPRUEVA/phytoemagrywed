// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

/*
 * FLUJO ÚNICO DE ENTREGA — UAT AISLADA.
 *
 * Un solo recorrido: aceptar → contactar → iniciar → finalizar, con el cobro
 * declarado por el repartidor y la resolución de incidencias con rastro.
 * Todo con clientes y pedidos FICTICIOS, WhatsApp apagado (no se envía nada) y
 * una base SQLite temporal que se borra al terminar.
 */

const TOKEN = 'delivery-unified-flow-token';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminUnified-12345';
const DELIVERY_PASS = 'DeliveryUnified-12345';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' };

let tmpDir;
let app;
let adminCookie = '';
let deliveryCookie = '';
let otherDeliveryCookie = '';
let delivery;
let otherDelivery;

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

async function createOrder(overrides = {}) {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: overrides.phone ?? '18095550999',
      name: overrides.name ?? 'Cliente Flujo',
      paymentMethod: 'CASH',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: L1,
      deliveryFee: 250,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

async function assign(orderId, userId = delivery.id) {
  const response = await request(`/api/admin/orders/${orderId}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: userId }),
  });
  expect(response.status).toBe(200);
  return json(response);
}

/** Vista de reparto (la que recibe el teléfono del repartidor). */
async function deliveryOrder(orderId, cookie = deliveryCookie) {
  const response = await request(`/api/admin/delivery/orders/${orderId}`, {}, cookie);
  expect(response.status).toBe(200);
  return (await json(response)).order;
}

async function startDelivery(orderId, cookie = deliveryCookie) {
  return request(`/api/admin/orders/${orderId}/delivery/start`, { method: 'POST', body: '{}' }, cookie);
}

async function configureSupervisor(overrides = {}) {
  const response = await request('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      activatedAt: '2026-09-01T00:00:00.000Z',
      includeOldOrders: true,
      useDeepSeek: false,
      ...overrides,
    }),
  });
  expect(response.status).toBe(200);
  return json(response);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-delivery-flow-'));
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
  adminCookie = (await login(ADMIN_USER, ADMIN_PASS)).cookie;
  delivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'flow1@phyto.local', password: DELIVERY_PASS, displayName: 'Repartidor Uno', role: 'DELIVERY', personalPhone: '8295550001' }),
  }))).user;
  otherDelivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'flow2@phyto.local', password: DELIVERY_PASS, displayName: 'Repartidor Dos', role: 'DELIVERY', personalPhone: '8295550002' }),
  }))).user;
  deliveryCookie = (await login('flow1@phyto.local', DELIVERY_PASS)).cookie;
  otherDeliveryCookie = (await login('flow2@phyto.local', DELIVERY_PASS)).cookie;
  const restock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 600, unitCost: '126.66', reason: 'Inventario UAT flujo único' }),
  });
  expect(restock.status).toBe(201);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('paso 1 — aceptar', () => {
  it('aceptar es un hecho propio: no envía nada y el paso siguiente lo decide el servidor', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    const before = await deliveryOrder(created.item.id);
    expect(before.next_step).toBe('accepted');
    expect(before.delivery_accepted_at ?? null).toBeNull();

    const accepted = await request(`/api/admin/orders/${created.item.id}/delivery/accept`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).duplicate).toBe(false);

    const after = await deliveryOrder(created.item.id);
    expect(after.next_step).toBe('contacted');
    expect(after.delivery_accepted_at).toBeTruthy();
    /* Aceptar no crea sesión de GPS ni cambia el estado del pedido. */
    expect(after.delivery.delivery_status).toBe('PENDING_CONTACT');
    expect(after.status).not.toBe('enviado');

    const again = await request(`/api/admin/orders/${created.item.id}/delivery/accept`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(again.status).toBe(200);
    expect((await json(again)).duplicate).toBe(true);
  });

  it('otro repartidor no puede aceptar un pedido ajeno', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    const denied = await request(`/api/admin/orders/${created.item.id}/delivery/accept`, { method: 'POST', body: '{}' }, otherDeliveryCookie);
    expect(denied.status).toBe(403);
  });
});

describe('paso 1b — contacto registrado', () => {
  it('una llamada cuenta como contacto (no se exige WhatsApp entregado)', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    await request(`/api/admin/orders/${created.item.id}/delivery/accept`, { method: 'POST', body: '{}' }, deliveryCookie);

    const attempt = await request(`/api/admin/orders/${created.item.id}/delivery/contact-attempt`, {
      method: 'POST',
      body: JSON.stringify({ channel: 'call' }),
    }, deliveryCookie);
    expect(attempt.status).toBe(200);
    expect((await json(attempt)).duplicate).toBe(false);

    const after = await deliveryOrder(created.item.id);
    expect(after.contacted_at).toBeTruthy();
    expect(after.next_step).toBe('on_the_way');

    /* Dos toques seguidos del mismo canal no son dos intentos. */
    const repeat = await request(`/api/admin/orders/${created.item.id}/delivery/contact-attempt`, {
      method: 'POST',
      body: JSON.stringify({ channel: 'call' }),
    }, deliveryCookie);
    expect((await json(repeat)).duplicate).toBe(true);
    const order = await deliveryOrder(created.item.id);
    expect(order.delivery.delivery_contact_attempts).toHaveLength(1);
  });

  it('con la política de contacto encendida el backend exige un intento registrado', async () => {
    await configureSupervisor({ requireContactBeforeStart: true });
    try {
      const created = await createOrder();
      await assign(created.item.id);
      const blocked = await startDelivery(created.item.id);
      expect(blocked.status).toBe(409);
      expect((await json(blocked)).error).toBe('contact_required');

      await request(`/api/admin/orders/${created.item.id}/delivery/contact-attempt`, {
        method: 'POST',
        body: JSON.stringify({ channel: 'whatsapp' }),
      }, deliveryCookie);
      const started = await startDelivery(created.item.id);
      expect(started.status).toBe(201);
    } finally {
      await configureSupervisor({ requireContactBeforeStart: false });
    }
  });
});

describe('paso 3 — finalizar con el cobro real', () => {
  it('efectivo: registra el cobro, deja el saldo en cero y el dinero en poder del repartidor', async () => {
    const created = await createOrder();
    const total = Number(created.order.total);
    await assign(created.item.id);
    const started = await json(await startDelivery(created.item.id));

    const completed = await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'cash', amount: total }, note: 'Pagó al recibir' }),
    }, deliveryCookie);
    expect(completed.status).toBe(200);
    const body = await json(completed);
    expect(body.payment_recorded).toBe(true);
    expect(body.payment.received).toBeCloseTo(total, 2);
    expect(body.payment.due).toBe(0);
    expect(body.order.status).toBe('entregado');

    /* El cobro queda con su autor y como efectivo EN PODER del repartidor. */
    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(detail.payment.cashReceived).toBeCloseTo(total, 2);
    expect(detail.payment.courier.pending).toBeCloseTo(total, 2);
    expect(detail.payment.entries).toHaveLength(1);
    expect(detail.payment.entries[0].by_user_id).toBe(delivery.id);
    expect(detail.payment.entries[0].source).toBe('courier');

    /* Reintentar la finalización NO duplica el cobro. */
    const retry = await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'cash', amount: total } }),
    }, deliveryCookie);
    expect(retry.status).toBe(200);
    expect((await json(retry)).duplicate).toBe(true);
    const afterRetry = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(afterRetry.payment.entries).toHaveLength(1);
  });

  it('transferencia: queda REPORTADA (no cobrada) hasta que administración la verifica', async () => {
    const created = await createOrder();
    const total = Number(created.order.total);
    await assign(created.item.id);
    const started = await json(await startDelivery(created.item.id));

    const completed = await json(await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'transfer', amount: total, note: 'Ref 998877' } }),
    }, deliveryCookie));
    expect(completed.payment_recorded).toBe(true);
    expect(completed.payment.pendingVerification).toBeCloseTo(total, 2);
    expect(completed.payment.due).toBeCloseTo(total, 2);
    expect(completed.payment.status).toBe('pending');

    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    const entry = detail.payment.entries[0];
    expect(entry.method).toBe('TRANSFER');
    expect(entry.verification).toBe('pending');

    const verified = await json(await request(`/api/admin/orders/${created.item.id}/payments/${entry.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'verified', note: 'Comprobado en el banco' }),
    }));
    expect(verified.payment.due).toBe(0);
    expect(verified.payment.status).toBe('paid');
    const afterVerify = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(afterVerify.order.payment_status).toBe('paid');

    /* Verificar dos veces no cambia nada ni duplica el cobro. */
    const again = await request(`/api/admin/orders/${created.item.id}/payments/${entry.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'verified' }),
    });
    expect(again.status).toBe(200);
    expect((await json(again)).duplicate).toBe(true);
    const finalDetail = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(finalDetail.payment.entries).toHaveLength(1);
    expect(finalDetail.payment.received).toBeCloseTo(total, 2);
  });

  it('solo administración verifica una transferencia', async () => {
    const created = await createOrder();
    const total = Number(created.order.total);
    await assign(created.item.id);
    const started = await json(await startDelivery(created.item.id));
    await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'transfer', amount: total } }),
    }, deliveryCookie);
    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    const entry = detail.payment.entries[0];
    const denied = await request(`/api/admin/orders/${created.item.id}/payments/${entry.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'verified' }),
    }, deliveryCookie);
    expect(denied.status).toBe(403);
  });

  it('sin pago no se inventa nada: el saldo sigue y queda constancia', async () => {
    const created = await createOrder();
    const total = Number(created.order.total);
    await assign(created.item.id);
    const started = await json(await startDelivery(created.item.id));
    const completed = await json(await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'none', note: 'El cliente no tenía efectivo' } }),
    }, deliveryCookie));
    expect(completed.order.status).toBe('entregado');
    expect(completed.payment_recorded).toBeUndefined();

    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(detail.payment.entries).toHaveLength(0);
    expect(detail.payment.due).toBeCloseTo(total, 2);

    const audits = await app.collections.list('audit', { limit: 2000 });
    expect(audits.some((row) => row.entity_id === created.item.id && row.action === 'delivery.payment_not_received')).toBe(true);
  });

  it('un importe mayor que el saldo se rechaza y la entrega NO se cierra', async () => {
    const created = await createOrder();
    const total = Number(created.order.total);
    await assign(created.item.id);
    const started = await json(await startDelivery(created.item.id));
    const rejected = await request(`/api/admin/delivery-tracking/${started.session.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ payment: { outcome: 'cash', amount: total + 500 } }),
    }, deliveryCookie);
    expect(rejected.status).toBe(422);
    expect((await json(rejected)).error).toBe('amount_exceeds_due');
    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(detail.order.status).not.toBe('entregado');
    expect(detail.payment.entries).toHaveLength(0);
  });
});

describe('privacidad del repartidor', () => {
  it('«Ver pedido» devuelve lo operativo y el saldo, sin auditoría ni cobros ajenos', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    const response = await request(`/api/admin/orders/${created.item.id}`, {}, deliveryCookie);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.delivery_view).toBe(true);
    expect(body.timeline).toBeUndefined();
    expect(body.followups).toBeUndefined();
    expect(body.scheduled).toBeUndefined();
    expect(body.payment.entries).toBeUndefined();
    expect(body.payment.due).toBeGreaterThan(0);
    expect(body.order.delivery.location).toBeTruthy();
    /* La oficina sigue viendo la ficha completa. */
    const office = await json(await request(`/api/admin/orders/${created.item.id}`));
    expect(Array.isArray(office.timeline)).toBe(true);
    expect(office.timeline.length).toBeGreaterThan(0);
  });
});

describe('incidencias', () => {
  it('una a la vez, con resolución firmada, y el reinicio no la borra', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    await startDelivery(created.item.id);

    const first = await request(`/api/admin/orders/${created.item.id}/delivery/issue`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'no_response', note: 'Llamé dos veces' }),
    }, deliveryCookie);
    expect(first.status).toBe(200);

    /* Duplicar la incidencia ya no crea dos registros. */
    const duplicate = await request(`/api/admin/orders/${created.item.id}/delivery/issue`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'no_response' }),
    }, deliveryCookie);
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).error).toBe('issue_pending');

    /* El repartidor no puede reiniciar por su cuenta. */
    const blocked = await startDelivery(created.item.id);
    expect(blocked.status).toBe(409);

    /* Resolver exige decir qué se decidió. */
    const sinNota = await request(`/api/admin/orders/${created.item.id}/delivery/issue/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'resume' }),
    });
    expect(sinNota.status).toBe(422);

    const resolved = await json(await request(`/api/admin/orders/${created.item.id}/delivery/issue/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'resume', note: 'El cliente confirma la dirección' }),
    }));
    expect(resolved.order.delivery.delivery_status).toBe('READY_FOR_DELIVERY');
    expect(resolved.order.delivery.issues.at(-1).resolved_at).toBeTruthy();
    expect(resolved.order.delivery.issue_resolution).toBe('resume');

    const audits = await app.collections.list('audit', { limit: 2000 });
    expect(audits.some((row) => row.entity_id === created.item.id && row.action === 'delivery.issue_resolved')).toBe(true);

    /* Ya se puede reanudar (no arranca sola). */
    const restarted = await startDelivery(created.item.id);
    expect(restarted.status).toBe(201);
  });

  it('si administración reinicia con la incidencia abierta, queda resuelta con su motivo', async () => {
    const created = await createOrder();
    await assign(created.item.id);
    await startDelivery(created.item.id);
    await request(`/api/admin/orders/${created.item.id}/delivery/issue`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'wrong_address', note: 'La dirección no existe' }),
    }, deliveryCookie);

    const restarted = await request(`/api/admin/orders/${created.item.id}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id, resolutionNote: 'Se corrigió la dirección con el cliente' }),
    });
    expect(restarted.status).toBe(201);
    const detail = await json(await request(`/api/admin/orders/${created.item.id}`));
    const issue = detail.order.delivery.issues.at(-1);
    expect(issue.resolved_at).toBeTruthy();
    expect(issue.resolution).toBe('restarted_by_admin');
    expect(issue.resolution_note).toBe('Se corrigió la dirección con el cliente');
  });
});

describe('un solo supervisor', () => {
  it('la pasada del scheduler ya no ejecuta el motor heredado', async () => {
    const tick = await app.scheduler.tick();
    expect(tick.delivery).toBeNull();
    expect(tick.supervisor).toBeTruthy();
  });

  it('el servidor solo conecta el supervisor al scheduler', () => {
    const source = readFileSync(new URL('../server/crm-server.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const wiring = source.slice(source.indexOf('deliverySupervisorTick:'));
    expect(wiring.slice(0, 200)).toContain('supervisorTick');
    expect(source).not.toContain('deliveryControlTick: () =>');
    /* El motor heredado sigue en el archivo como historia, pero sin ejecutarse. */
    expect(source).toContain('async function deliveryControlTick');
  });
});

describe('UI: una sola acción primaria', () => {
  const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

  it('el panel del repartidor pinta UN CTA y ninguna acción primaria suelta', () => {
    const panel = app.slice(app.indexOf('function deliveryDetailPanelHtml'), app.indexOf('const DELIVERY_PAGE'));
    expect(panel.length).toBeGreaterThan(200);
    /* Un único punto de decisión para la acción principal. */
    expect((panel.match(/deliveryPrimaryCtaHtml\(/g) ?? []).length).toBe(1);
    /* Y ninguna acción primaria «a mano» dentro del panel. */
    expect(panel).not.toContain('data-delivery-start=');
    expect(panel).not.toContain('data-delivery-complete=');
    expect(panel).not.toContain('data-delivery-accept=');
    /* Los pasos se representan, no se duplican. */
    expect((panel.match(/deliveryStepsHtml\(/g) ?? []).length).toBe(1);
    expect(panel).toContain('deliveryMoneyHtml(order)');
    expect(panel).toContain('deliverySecondaryActionsHtml(order, session)');
  });

  it('la tarjeta de la lista también tiene una sola acción', () => {
    const card = app.slice(app.indexOf('function deliveryCardCta'), app.indexOf('function deliveryCard('));
    /* Cada rama (aceptar, contactar, iniciar, falta ubicación, finalizar, incidencia)
       devuelve UN botón: no hay dos acciones compitiendo en la tarjeta. */
    expect((card.match(/return `<button/g) ?? []).length).toBe(6);
    expect((card.match(/class="dv-cta/g) ?? []).length).toBe(6);
  });

  it('finalizar pregunta cómo pagó solo cuando hay saldo', () => {
    const sheet = app.slice(app.indexOf('function confirmDeliveryComplete'), app.indexOf('function deliveryPayExtraHtml'));
    expect(sheet).toContain('¿Cómo pagó el cliente?');
    expect(sheet).toContain("data-dv-pay=\"cash\"");
    expect(sheet).toContain("data-dv-pay=\"transfer\"");
    expect(sheet).toContain("data-dv-pay=\"none\"");
    /* Un pedido ya pagado no vuelve a pedir el cobro. */
    expect(sheet).toContain('Pago registrado');
  });
});

describe('offline: nada se da por entregado sin el servidor', () => {
  it('la finalización sin red queda PENDIENTE y no escribe «entregado» ni cobra', () => {
    const source = readFileSync(new URL('../public/admin/offline.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    expect(source).toContain('pending_status');
    expect(source).not.toContain("item.status=order.status='entregado'");
    expect(source).toContain('El cobro necesita conexión');
  });
});
