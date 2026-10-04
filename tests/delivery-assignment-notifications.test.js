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
let now = new Date('2026-10-04T10:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-DELIVERY',
  businessAccountId: 'WABA1',
  sent: [],
  read: [],
  failWith: null,
  failPhones: new Set(),
  async sendText(to, body, options) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.DEL${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (mockWhatsApp.failWith) return { ok: false, status: 400, error: mockWhatsApp.failWith };
    if (mockWhatsApp.failPhones.has(to)) return { ok: false, status: 400, error: { message: `fallo ${to}` } };
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

async function createOrder(overrides = {}) {
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
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

async function approveTemplate(name, body, variables = []) {
  const response = await request('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name,
      status: 'APPROVED',
      body,
      variables,
      lastSyncedAt: new Date().toISOString(),
      lastTemplateSyncAt: new Date().toISOString(),
    }),
  });
  expect(response.status).toBe(200);
  return json(response);
}

async function setConversationWindow(open = true) {
  await app.collections.update('conversations', conversationId, {
    last_inbound_at: open ? new Date().toISOString() : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
}

async function restock(quantity = 100) {
  const response = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity, unitCost: '126.66', reason: 'Inventario UAT delivery' }),
  });
  expect(response.status).toBe(201);
}

function advance(minutes) {
  now = new Date(now.getTime() + minutes * 60 * 1000);
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
    clock: () => now,
  });
  adminCookie = (await login(ADMIN_USER, ADMIN_PASS)).cookie;
  delivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'delivery1@phyto.local',
      password: DELIVERY_PASS,
      displayName: 'Carlos Rodríguez',
      role: 'DELIVERY',
      personalPhone: '8291111111',
      fleetPhone: '8292222222',
    }),
  }))).user;
  otherDelivery = (await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'delivery2@phyto.local',
      password: DELIVERY_PASS,
      displayName: 'José Martínez',
      role: 'DELIVERY',
      personalPhone: '8293333333',
      fleetPhone: '8294444444',
    }),
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
    mockWhatsApp.sent = [];
    await setConversationWindow(true);
    const order = await createOrder();
    const assign = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(assign.status).toBe(200);
    expect((await json(assign)).customerNotification.status).toBe('sent');
    expect(mockWhatsApp.sent.filter((row) => row.type === 'text' && row.body.includes('tu pedido ha sido asignado'))).toHaveLength(1);
    const duplicate = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(duplicate.status).toBe(200);
    expect(mockWhatsApp.sent.filter((row) => row.type === 'text' && row.body.includes('tu pedido ha sido asignado'))).toHaveLength(1);

    const notifications = await json(await request('/api/admin/notifications', {}, deliveryCookie));
    const matching = notifications.notifications.filter((row) => row.entity_id === order.item.id && row.type === 'DELIVERY_ORDER_ASSIGNED');
    expect(matching).toHaveLength(1);
    expect(matching[0].deep_link).toContain(`/admin/?v=delivery&order=${encodeURIComponent(order.item.id)}`);

    const forbidden = await request(`/api/admin/delivery/orders/${order.item.id}`, {}, otherDeliveryCookie);
    expect(forbidden.status).toBe(403);
    const allowed = await request(`/api/admin/delivery/orders/${order.item.id}`, {}, deliveryCookie);
    expect(allowed.status).toBe(200);
  });

  it('asignación fuera de 24h usa plantilla aprobada; pendiente o fallo no revierten', async () => {
    mockWhatsApp.sent = [];
    await setConversationWindow(false);
    const pending = await createOrder();
    const pendingAssign = await request(`/api/admin/orders/${pending.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(pendingAssign.status).toBe(200);
    expect((await json(pendingAssign)).customerNotification.status).toBe('pending');

    await approveTemplate('phyto_delivery_asignado_v1', 'Hola {{1}}, tu pedido {{2}} ya tiene delivery asignado. {{3}}', ['customer_name', 'order_number', 'delivery_display_name']);
    const templated = await createOrder();
    const templatedAssign = await request(`/api/admin/orders/${templated.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(templatedAssign.status).toBe(200);
    expect((await json(templatedAssign)).customerNotification.status).toBe('sent');
    expect(mockWhatsApp.sent.at(-1).type).toBe('template');

    mockWhatsApp.failWith = { code: 131000, message: 'Meta falló asignación' };
    const failed = await createOrder();
    const failedAssign = await request(`/api/admin/orders/${failed.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    mockWhatsApp.failWith = null;
    const failedBody = await json(failedAssign);
    expect(failedAssign.status).toBe(200);
    expect(failedBody.order.delivery.delivery_user_id).toBe(delivery.id);
    expect(failedBody.customerNotification.status).toBe('failed');
    await setConversationWindow(true);
  });

  it('entrega notifica al cliente después de marcar entregado y no revierte si falla', async () => {
    await restock(100);
    mockWhatsApp.sent = [];
    await setConversationWindow(true);
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie));
    const complete = await request(`/api/admin/delivery-tracking/${start.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(complete.status).toBe(200);
    const completeBody = await json(complete);
    expect(completeBody.order.status).toBe('entregado');
    expect(mockWhatsApp.sent.some((row) => row.type === 'text' && row.body.includes('como entregado'))).toBe(true);

    await restock(100);
    await approveTemplate('phyto_pedido_entregado_v1', 'Hola {{1}}, hemos registrado tu pedido {{2}} como entregado. Gracias por elegir Phytoemagry.', ['customer_name', 'order_number']);
    await setConversationWindow(false);
    const templated = await createOrder();
    await request(`/api/admin/orders/${templated.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const startTemplated = await json(await request(`/api/admin/orders/${templated.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie));
    const completeTemplated = await request(`/api/admin/delivery-tracking/${startTemplated.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(completeTemplated.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).type).toBe('template');

    await restock(100);
    mockWhatsApp.failWith = { code: 131000, message: 'Meta falló entrega' };
    const failed = await createOrder();
    await request(`/api/admin/orders/${failed.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const startFailed = await json(await request(`/api/admin/orders/${failed.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie));
    const completeFailed = await request(`/api/admin/delivery-tracking/${startFailed.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    mockWhatsApp.failWith = null;
    expect(completeFailed.status).toBe(200);
    expect((await json(completeFailed)).order.status).toBe('entregado');
    await setConversationWindow(true);
  });

  it('control de atención: 5 min recuerda al delivery y 30 min escala a admins sin tocar el chat del cliente', async () => {
    mockWhatsApp.sent = [];
    now = new Date('2026-10-04T10:00:00.000Z');
    await approveTemplate('phyto_delivery_pedido_pendiente_v1', 'Hola {{1}}, recuerda pedido {{2}} {{3}}', ['delivery_display_name', 'order_number', 'delivery_deep_link']);
    await approveTemplate('phyto_delivery_sin_atender_admin_v1', 'URGENTE pedido {{1}} delivery {{2}} {{3}}', ['order_number', 'delivery_display_name', 'delivery_deep_link']);
    const order = await createOrder();
    const assign = await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    expect(assign.status).toBe(200);
    expect((await json(assign)).order.delivery.delivery_status).toBe('PENDING_CONTACT');

    advance(4);
    let tick = await app.scheduler.tick();
    expect(tick.delivery.reminders).toBe(0);

    advance(2);
    tick = await app.scheduler.tick();
    expect(tick.delivery.reminders).toBeGreaterThanOrEqual(2);
    expect(mockWhatsApp.sent.some((row) => row.to === '+18291111111')).toBe(true);
    expect(mockWhatsApp.sent.some((row) => row.to === '+18292222222')).toBe(true);
    const afterReminder = mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_delivery_pedido_pendiente_v1').length;

    const repeated = await app.scheduler.tick();
    expect(repeated.delivery.reminders).toBe(0);
    expect(mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_delivery_pedido_pendiente_v1')).toHaveLength(afterReminder);

    const beforeMessages = (await app.collections.list('wa_messages', { limit: 1000 })).length;
    const first = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, voy con su pedido' }),
    }, deliveryCookie);
    expect(first.status).toBe(200);
    advance(25);
    tick = await app.scheduler.tick();
    const auditsAfterContact = await app.collections.list('audit', { limit: 1000 });
    expect(auditsAfterContact.filter((row) => row.entity_id === order.item.id && row.action === 'delivery.escalation_30m_sent')).toHaveLength(0);
    const afterMessages = (await app.collections.list('wa_messages', { limit: 1000 })).length;
    expect(afterMessages).toBe(beforeMessages + 1);

    now = new Date('2026-10-04T11:00:00.000Z');
    const escalated = await createOrder();
    await request(`/api/admin/orders/${escalated.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    advance(31);
    const beforeEscalation = mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_delivery_sin_atender_admin_v1').length;
    tick = await app.scheduler.tick();
    expect(tick.delivery.escalations).toBeGreaterThanOrEqual(2);
    expect(mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_delivery_sin_atender_admin_v1')).toHaveLength(beforeEscalation + 2);
    const repeatedEscalation = await app.scheduler.tick();
    expect(repeatedEscalation.delivery.escalations).toBe(0);
  });

  it('reasignación cancela ciclo anterior y arranca contador nuevo', async () => {
    mockWhatsApp.sent = [];
    now = new Date('2026-10-04T12:00:00.000Z');
    await approveTemplate('phyto_delivery_pedido_pendiente_v1', 'Hola {{1}}, recuerda pedido {{2}} {{3}}', ['delivery_display_name', 'order_number', 'delivery_deep_link']);
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    advance(3);
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: otherDelivery.id }),
    });
    advance(3);
    const tick = await app.scheduler.tick();
    expect(tick.delivery.reminders).toBe(0);
    advance(3);
    const tickNew = await app.scheduler.tick();
    expect(tickNew.delivery.reminders).toBe(2);
    expect(mockWhatsApp.sent.some((row) => row.to === '+18293333333')).toBe(true);
    expect(mockWhatsApp.sent.some((row) => row.to === '+18294444444')).toBe(true);
    expect(mockWhatsApp.sent.some((row) => row.to === '+18291111111')).toBe(false);
  });

  it('entrega completada notifica admins y fallo de WhatsApp no revierte entrega', async () => {
    await restock(100);
    mockWhatsApp.sent = [];
    now = new Date('2026-10-04T13:00:00.000Z');
    await approveTemplate('phyto_delivery_entregado_admin_v1', 'Pedido {{1}} entregado. {{2}} {{3}} {{4}} {{5}}', ['order_number', 'delivery_display_name', 'customer_name', 'delivered_at', 'delivery_deep_link']);
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const start = await json(await request(`/api/admin/orders/${order.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie));
    const complete = await request(`/api/admin/delivery-tracking/${start.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    expect(complete.status).toBe(200);
    expect((await json(complete)).order.status).toBe('entregado');
    expect(mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_delivery_entregado_admin_v1')).toHaveLength(2);

    await restock(100);
    mockWhatsApp.failWith = { code: 131000, message: 'fallo admin entrega' };
    const failed = await createOrder();
    await request(`/api/admin/orders/${failed.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });
    const startFailed = await json(await request(`/api/admin/orders/${failed.item.id}/delivery/start`, { method: 'POST', body: '{}' }, deliveryCookie));
    const completeFailed = await request(`/api/admin/delivery-tracking/${startFailed.session.id}/complete`, { method: 'POST', body: '{}' }, deliveryCookie);
    mockWhatsApp.failWith = null;
    expect(completeFailed.status).toBe(200);
    expect((await json(completeFailed)).order.status).toBe('entregado');
  });

  it('delivery asignado puede iniciar sin WhatsApp; el primer mensaje solo marca CONTACTED', async () => {
    mockWhatsApp.sent = [];
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });

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

  it('plantilla aprobada enviada por DELIVERY también marca CONTACTED', async () => {
    mockWhatsApp.sent = [];
    await approveTemplate('phyto_delivery_contacto_uat', 'Hola {{1}}, voy con tu pedido.', ['customer_name']);
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });

    const sent = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_delivery_contacto_uat' }),
    }, deliveryCookie);

    expect(sent.status).toBe(200);
    expect(mockWhatsApp.sent.at(-1).type).toBe('template');
    expect((await json(sent)).deliveryOrder.delivery.delivery_status).toBe('CONTACTED');
  });

  it('plantilla no aprobada o fallida no marca CONTACTED', async () => {
    const order = await createOrder();
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });

    const blocked = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'plantilla_no_aprobada' }),
    }, deliveryCookie);
    expect(blocked.status).toBe(409);

    await approveTemplate('phyto_delivery_falla_uat', 'Hola {{1}}, voy con tu pedido.', ['customer_name']);
    mockWhatsApp.failWith = { code: 131000, message: 'fallo simulado template' };
    const failed = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ template: 'phyto_delivery_falla_uat' }),
    }, deliveryCookie);
    mockWhatsApp.failWith = null;
    expect(failed.status).toBe(502);

    const detail = await json(await request(`/api/admin/delivery/orders/${order.item.id}`, {}, deliveryCookie));
    expect(detail.order.delivery_status).toBe('PENDING_CONTACT');
  });

  it('pedido sin conversation_id usa una conversación existente del mismo cliente sin crear otra', async () => {
    const order = await createOrder({ conversationId: null });
    await request(`/api/admin/orders/${order.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: delivery.id }),
    });

    const data = await json(await request('/api/admin/data', {}, deliveryCookie));
    const deliveryOrder = data.deliveryOrders.find((row) => row.id === order.item.id);
    expect(deliveryOrder.conversation_id).toBe(conversationId);
    expect(data.conversations.some((row) => row.id === conversationId)).toBe(true);

    const sent = await request(`/api/admin/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Hola, tengo tu pedido asignado' }),
    }, deliveryCookie);
    expect(sent.status).toBe(200);
    expect((await json(sent)).deliveryOrder.delivery.delivery_status).toBe('CONTACTED');
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
