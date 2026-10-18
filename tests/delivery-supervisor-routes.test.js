// @vitest-environment node
/**
 * SUPERVISOR IA DELIVERY — prueba de punta a punta con el CRM de verdad.
 *
 * Comprueba la integración (no la unidad): rutas nuevas, pasada del motor por el
 * scheduler manual, recordatorio real por WhatsApp simulado, posposición desde
 * el panel y confirmación de entrega por el webhook firmado. Sin llamadas a Meta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'supervisor-token-123';
const APP_SECRET = 'supervisor-secret';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminSupervisor-12345';
const CUSTOMER_PHONE = '18095557777';
const COURIER_PHONE = '18095550123';
const COURIER_TWO_PHONE = '18095550124';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12' };

let tmpDir;
let app;
let adminCookie = '';
let conversationId = '';
let now = new Date('2026-10-18T12:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-SUP',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.SUP_TEXT_${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.SUP_TPL_${mockWhatsApp.sent.length}` };
  },
  async sendDocument(to, input) {
    mockWhatsApp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.SUP_DOC_${mockWhatsApp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const storage = {
  enabled: true,
  provider: 'memory',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

const json = async (response) => JSON.parse(await response.text());
const request = (route, options = {}, cookie = adminCookie) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) },
  });

async function login(username, password) {
  const response = await request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }, '');
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Mensaje entrante firmado, como el que manda Meta. */
async function inbound(from, body, id = `wamid.IN.${Math.random().toString(36).slice(2)}`) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-SUP' },
              contacts: [{ profile: { name: 'Contacto' }, wa_id: from }],
              messages: [{ id, from, timestamp: `${Math.floor(now.getTime() / 1000)}`, type: 'text', text: { body } }],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return request('/api/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': signature }, body: raw }, '');
}

async function approveTemplate(name, body, variables) {
  const response = await request('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name, status: 'APPROVED', body, variables, lastSyncedAt: new Date().toISOString(), lastTemplateSyncAt: new Date().toISOString() }),
  });
  expect(response.status).toBe(200);
}

async function createOrder(overrides = {}) {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: CUSTOMER_PHONE,
      name: 'Cliente Supervisor',
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

/** Guarda el contacto de reparto en los ajustes (es lo que hace el panel). */
async function seedCourierContact() {
  const stamp = new Date().toISOString();
  await app.collections.insert('settings', {
    id: 'set_delivery_contacts',
    key: 'delivery_contacts',
    value: [
      { id: 'cus_mensajero', name: 'Mensajero Pedro', phone: COURIER_PHONE, updated_at: stamp },
      { id: 'cus_mensajero2', name: 'Mensajera Luisa', phone: COURIER_TWO_PHONE, updated_at: stamp },
    ],
    created_at: stamp,
    updated_at: stamp,
  });
}

const advance = (minutes) => {
  now = new Date(now.getTime() + minutes * 60 * 1000);
};

/**
 * El webhook responde 200 ANTES de procesar (Meta no debe reintentar). Por eso
 * una prueba no puede asegurar nada justo después del POST: espera el efecto.
 */
async function waitFor(check, { timeout = 10000, interval = 150 } = {}) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('tiempo de espera agotado');
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-supervisor-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phyto.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: mockWhatsApp,
    whatsappMedia: mockWhatsApp,
    storage,
    bootstrapAdminUser: ADMIN_USER,
    bootstrapAdminPassword: ADMIN_PASS,
    schedulerEnabled: false,
    clock: () => now,
  });
  adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  await inbound(CUSTOMER_PHONE, 'Hola, quiero hacer un pedido');
  const data = await json(await request('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === `+${CUSTOMER_PHONE}`)?.id;
  expect(conversationId).toBeTruthy();
  await seedCourierContact();
  await approveTemplate(
    'phyto_supervisor_recordatorio_v1',
    'Hola {{1}}, seguimos pendientes del pedido {{2}}.\n\nSiguiente paso: {{3}}',
    ['courier_name', 'order_number', 'next_action'],
  );
  await approveTemplate(
    'phyto_pedido_repartidor_v1',
    'Hola {{1}}, pedido {{2}}.\n\nCliente: {{3}}\nProductos: {{4}}\nCobrar: {{5}}\nDirección: {{6}}\nMapa: {{7}}\n\nInstrucciones: {{8}}',
    ['courier_name', 'order_number', 'customer_contact', 'products', 'amount', 'address', 'maps_link', 'instructions'],
  );
  // Una venta entregada necesita stock: sin él la transición oficial se niega
  // (y el supervisor lo dice, no finge un cierre).
  const stock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 60, unitCost: '126.66', reason: 'Inventario UAT supervisor' }),
  });
  expect(stock.status).toBe(201);
}, 60000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('supervisor de delivery con el servidor real', () => {
  it('los ajustes se guardan y se leen con los límites aplicados', async () => {
    const saved = await request('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ firstReminderMinutes: 15, maxAttempts: 4, useDeepSeek: false }),
    });
    expect(saved.status).toBe(200);
    const body = await json(saved);
    expect(body.settings.firstReminderMinutes).toBe(15);
    expect(body.settings.maxAttempts).toBe(4);
    expect(body.settings.useDeepSeek).toBe(false);
    // Se devuelven a los valores por defecto para el resto de la prueba.
    await request('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ firstReminderMinutes: 10, maxAttempts: 3, useDeepSeek: true }),
    });
  });

  it('un pedido asignado a un repartidor externo entra en supervisión y recibe recordatorio', async () => {
    const order = await createOrder();
    const assigned = await request(`/api/admin/orders/${order.item.id}/courier/assign`, {
      method: 'POST',
      body: JSON.stringify({ contactPhone: COURIER_PHONE }),
    });
    expect(assigned.status).toBe(200);
    const sent = await request(`/api/admin/orders/${order.item.id}/courier/send`, { method: 'POST', body: '{}' });
    expect(sent.status).toBe(200);

    advance(30);
    const run = await request('/api/admin/delivery-supervisor/run', { method: 'POST' });
    expect(run.status).toBe(200);
    const resultado = await json(run);
    expect(resultado.result.reminders).toBeGreaterThanOrEqual(1);
    const reminder = mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_supervisor_recordatorio_v1');
    expect(reminder.length).toBeGreaterThanOrEqual(1);
    expect(reminder.at(-1).to).toBe(`+${COURIER_PHONE}`);
    expect(reminder.at(-1).template.components[0].parameters.map((entry) => entry.text)).toEqual([
      'Mensajero Pedro',
      order.order.order_number,
      'Iniciar la entrega',
    ]);

    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    expect(snapshot.counts.sin_iniciar).toBeGreaterThanOrEqual(1);
    const row = snapshot.buckets.sin_iniciar.find((entry) => entry.id === order.item.id);
    expect(row.responsible).toMatchObject({ type: 'external', name: 'Mensajero Pedro' });
    expect(row.next_action).toBe('Iniciar la entrega');
  }, 60000);

  it('el repartidor confirma por WhatsApp y el pedido se cierra con la transición oficial', async () => {
    const order = await createOrder();
    const assigned = await request(`/api/admin/orders/${order.item.id}/courier/assign`, {
      method: 'POST',
      body: JSON.stringify({ contactPhone: COURIER_TWO_PHONE }),
    });
    expect(assigned.status).toBe(200);
    const sent = await request(`/api/admin/orders/${order.item.id}/courier/send`, { method: 'POST', body: '{}' });
    expect(sent.status).toBe(200);
    const row = { id: order.item.id };

    await inbound(COURIER_TWO_PHONE, 'Ya lo entregué');
    const reportado = await waitFor(async () => {
      const detail = await json(await request(`/api/admin/orders/${row.id}`));
      return detail.order?.delivery?.external?.status === 'awaiting_confirmation' ? detail.order : null;
    });
    expect(reportado.status).not.toBe('entregado');
    expect(reportado.delivery.supervisor.pending_action).toMatchObject({ type: 'confirm_delivery' });

    await inbound(COURIER_TWO_PHONE, 'CONFIRMAR');
    const cerrado = await waitFor(async () => {
      const detail = await json(await request(`/api/admin/orders/${row.id}`));
      return detail.order?.status === 'entregado' ? detail.order : null;
    });
    expect(cerrado.delivery.external.status).toBe('delivered');
    expect(cerrado.delivery.supervisor.confirmed_at).toBeTruthy();
    expect(cerrado.delivery.supervisor.pending_action).toBeNull();
    const textos = mockWhatsApp.sent.filter((entry) => entry.type === 'text').map((entry) => entry.body);
    expect(textos.some((body) => /Confirmas que el pedido/.test(body))).toBe(true);
  }, 60000);

  it('posponer desde el panel saca el pedido de la lista de pendientes y conserva su estado', async () => {
    const order = await createOrder();
    const assigned = await request(`/api/admin/orders/${order.item.id}/courier/assign`, {
      method: 'POST',
      body: JSON.stringify({ contactPhone: COURIER_PHONE }),
    });
    expect(assigned.status).toBe(200);
    const until = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const postponed = await request(`/api/admin/orders/${order.item.id}/delivery/postpone`, {
      method: 'POST',
      body: JSON.stringify({ until, reason: 'El cliente pidió otro día', note: 'Prefiere en la mañana' }),
    });
    expect(postponed.status).toBe(200);
    const body = await json(postponed);
    expect(body.order.status).toBe(order.order.status);
    expect(body.order.delivery.supervisor.postponed_until).toBe(`${until}T12:00:00.000Z`);

    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    expect(snapshot.counts.pospuestos).toBeGreaterThanOrEqual(1);
    expect(snapshot.buckets.pospuestos.some((row) => row.id === order.item.id)).toBe(true);
    expect(snapshot.buckets.sin_iniciar.some((row) => row.id === order.item.id)).toBe(false);

    // Sin motivo no se pospone: el servidor responde y no cambia nada.
    const sinMotivo = await request(`/api/admin/orders/${order.item.id}/delivery/postpone`, {
      method: 'POST',
      body: JSON.stringify({ until }),
    });
    expect(sinMotivo.status).toBe(422);
    expect((await json(sinMotivo)).error).toBe('reason_required');
  }, 60000);

  it('el resumen diario deja constancia y no cierra nada', async () => {
    const daily = await request('/api/admin/delivery-supervisor/daily', { method: 'POST' });
    expect(daily.status).toBe(200);
    const body = await json(daily);
    expect(body.ok).toBe(true);
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const events = await app.collections.list('delivery_supervision_events', { limit: 500 });
    expect(events.some((entry) => entry.kind === 'daily')).toBe(true);
  }, 60000);

  it('un usuario sin permiso de reparto no ve el supervisor', async () => {
    const agentPass = 'Agente-Supervisor-12345';
    await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'agente.supervisor@phyto.local', password: agentPass, displayName: 'Agente', role: 'AGENT' }),
    });
    const cookie = await login('agente.supervisor@phyto.local', agentPass);
    const response = await request('/api/admin/delivery-supervisor', {}, cookie);
    expect(response.status).toBe(403);
  }, 30000);
  it('asignar con autoSend manda el pedido al repartidor externo en el mismo paso', async () => {
    const order = await createOrder();
    const antes = mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_pedido_repartidor_v1').length;
    const assigned = await request(`/api/admin/orders/${order.item.id}/courier/assign`, {
      method: 'POST',
      body: JSON.stringify({ contactPhone: COURIER_PHONE, autoSend: true }),
    });
    expect(assigned.status).toBe(200);
    const body = await json(assigned);
    expect(body.sent).toBe(true);
    expect(body.order.delivery.external.status).toBe('sent');
    const despues = mockWhatsApp.sent.filter((row) => row.template?.name === 'phyto_pedido_repartidor_v1').length;
    expect(despues).toBe(antes + 1);
  }, 30000);});
