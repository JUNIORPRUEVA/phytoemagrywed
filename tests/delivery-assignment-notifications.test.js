// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'delivery-assignment-token';
const APP_SECRET = 'delivery-assignment-secret';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminDelivery-12345';
const DELIVERY_PASS = 'Delivery-12345';
const PHONE = '18095558888';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12' };

let tmpDir;
let app;
let adminCookie = '';
let deliveryCookie = '';
let otherDeliveryCookie = '';
let delivery;
let otherDelivery;
let conversationId;

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-DELIVERY',
  businessAccountId: 'WABA1',
  sent: [],
  read: [],
  failWith: null,
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.DEL${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.TPL${mockWhatsApp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead(messageId) {
    mockWhatsApp.read.push(messageId);
    return { ok: true };
  },
};

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

async function inbound(id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN-DELIVERY' }, contacts: [{ profile: { name: 'Cliente Delivery' }, wa_id: PHONE }], messages: [{ id, from: PHONE, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body } }] }, field: 'messages' }] }],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return request('/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature },
    body: raw,
  }, '');
}

async function createOrder() {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: PHONE,
      name: 'Cliente Delivery',
      paymentMethod: 'CASH',
      conversationId,
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: L1,
      deliveryFee: 250,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-delivery-assign-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
  });
  adminCookie = (await login(ADMIN_USER, ADMIN_PASS)).cookie;
  delivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'delivery1@phyto.local', password: DELIVERY_PASS, displayName: 'Carlos Rodríguez', role: 'DELIVERY' }),
  }))).user;
  otherDelivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'delivery2@phyto.local', password: DELIVERY_PASS, displayName: 'José Martínez', role: 'DELIVERY' }),
  }))).user;
  deliveryCookie = (await login('delivery1@phyto.local', DELIVERY_PASS)).cookie;
  otherDeliveryCookie = (await login('delivery2@phyto.local', DELIVERY_PASS)).cookie;
  await inbound('wamid.DEL-IN-1', 'Hola, quiero mi pedido');
  const data = await json(await request('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === '+18095558888')?.id;
  expect(conversationId).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('delivery assignment notifications and contact flow', () => {
  it('asignar delivery crea notificación interna idempotente y deep link seguro', async () => {
    const order = await createOrder();
    const assign = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(assign.status).toBe(200);
    const duplicate = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(duplicate.status).toBe(200);

    const notifications = await json(await request('/api/admin/notifications', {}, deliveryCookie));
    const matching = notifications.notifications.filter((row) => row.entity_id === order.item.id && row.type === 'DELIVERY_ORDER_ASSIGNED');
    expect(matching).toHaveLength(1);
    expect(matching[0].deep_link).toContain(`/admin/?v=delivery&order=${encodeURIComponent(order.item.id)}`);

    const forbidden = await request(`/api/admin/delivery/orders/${order.item.id}`, {}, otherDeliveryCookie);
    expect(forbidden.status).toBe(403);
    const allowed = await request(`/api/admin/delivery/orders/${order.item.id}`, {}, deliveryCookie);
    expect(allowed.status).toBe(200);
  });

  it('delivery no inicia antes de contactar; tras WhatsApp exitoso pasa a CONTACTED e inicia tracking', async () => {
    mockWhatsApp.sent = [];
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const blocked = await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('delivery_contact_required');

    const first = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, voy con su pedido' }),
    }, deliveryCookie);
    expect(first.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).body).toBe('*Carlos Rodríguez · Delivery*\nHola, voy con su pedido');
    expect((await json(first)).deliveryOrder.delivery.delivery_status).toBe('CONTACTED');

    const second = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Estoy saliendo ahora' }),
    }, deliveryCookie);
    expect(second.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).body).toBe('Estoy saliendo ahora');

    const started = await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(started.status).toBe(201);
  });

  it('si WhatsApp falla no marca CONTACTED', async () => {
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    mockWhatsApp.failWith = { code: 131000, message: 'fallo simulado' };
    const failed = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'No debe marcar contactado' }),
    }, deliveryCookie);
    mockWhatsApp.failWith = null;
    expect(failed.status).toBe(502);
    const detail = await json(await request(`/api/admin/delivery/orders/${order.item.id}`, {}, deliveryCookie));
    expect(detail.order.delivery_status).toBe('PENDING_CONTACT');
  });

  it('reasignación notifica al nuevo delivery y usa identidad nueva', async () => {
    mockWhatsApp.sent = [];
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const reassigned = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: otherDelivery.id }),
    });
    expect(reassigned.status).toBe(200);
    const oldAccess = await request(`/api/admin/delivery/orders/${order.item.id}`, {}, deliveryCookie);
    expect(oldAccess.status).toBe(403);
    const notifications = await json(await request('/api/admin/notifications', {}, otherDeliveryCookie));
    expect(notifications.notifications.some((row) => row.entity_id === order.item.id && row.type === 'DELIVERY_ORDER_REASSIGNED')).toBe(true);

    const sent = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'A partir de ahora estaré encargado de tu entrega', senderName: 'Administrador' }),
    }, otherDeliveryCookie);
    expect(sent.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).body).toBe('*José Martínez · Delivery*\nA partir de ahora estaré encargado de tu entrega');
  });
});
