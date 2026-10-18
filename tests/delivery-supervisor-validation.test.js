// @vitest-environment node
/**
 * SUPERVISOR IA DELIVERY — validación del ciclo completo (UAT aislada).
 *
 * Cubre con WhatsApp SIMULADO y datos temporales:
 *  - repartidor INTERNO y EXTERNO: asignación, aviso, respuesta, identificación
 *    del pedido, confirmación, posposición y escalamiento;
 *  - aislamiento: un cliente no es repartidor, un repartidor no toca pedidos
 *    ajenos y un agente no pospone lo que no es suyo;
 *  - scheduler sin navegador (pasada directa), idempotencia, frecuencia y
 *    reinicio del servidor;
 *  - DeepSeek apagado, sin saldo o ambiguo → no se ejecuta nada;
 *  - ninguna entrega se cierra sin confirmación explícita;
 *  - conciliación diaria y posposiciones vencidas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { handleSupervisorReply } from '../server/delivery-supervisor.mjs';

const TOKEN = 'supervisor-cycle-token';
const APP_SECRET = 'supervisor-cycle-secret';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminCiclo-12345';
const CUSTOMER_PHONE = '18095558880';
const EXT_A = '18095550141';
const EXT_B = '18095550142';
const EXT_C = '18095550143';
const AGENT_PHONE = '18095550151';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12' };

let tmpDir;
let app;
let adminCookie = '';
let conversationId = '';
let agentId = '';
let now = new Date('2026-10-18T12:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-CYCLE',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.CYCLE_TXT_${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.CYCLE_TPL_${mockWhatsApp.sent.length}` };
  },
  async sendDocument(to, input) {
    mockWhatsApp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.CYCLE_DOC_${mockWhatsApp.sent.length}` };
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

async function inbound(from, body, id = `wamid.CYCLE.${Math.random().toString(36).slice(2)}`) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-CYCLE' },
              contacts: [{ profile: { name: `Contacto ${from.slice(-4)}` }, wa_id: from }],
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
      name: 'Cliente Ciclo',
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

async function seedSettings(key, value) {
  const stamp = new Date().toISOString();
  await app.collections.insert('settings', { id: `set_${key}`, key, value, created_at: stamp, updated_at: stamp });
}

async function readOrder(orderId) {
  const detail = await json(await request(`/api/admin/orders/${orderId}`));
  return detail.order;
}

const supervisorEvents = () => app.collections.list('delivery_supervision_events', { limit: 2000 });

async function waitFor(check, { timeout = 12000, interval = 120 } = {}) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('tiempo de espera agotado');
}

async function bootApp() {
  const instance = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'ciclo.sqlite'),
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
  return instance;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-ciclo-'));
  app = await bootApp();
  adminCookie = await login(ADMIN_USER, ADMIN_PASS);
  await inbound(CUSTOMER_PHONE, 'Hola, quiero hacer un pedido');
  const data = await json(await request('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === `+${CUSTOMER_PHONE}`)?.id;
  expect(conversationId).toBeTruthy();

  await seedSettings('delivery_contacts', [
    { id: 'cus_ext_a', name: 'Mensajero A', phone: EXT_A },
    { id: 'cus_ext_b', name: 'Mensajera B', phone: EXT_B },
    { id: 'cus_ext_c', name: 'Mensajero C', phone: EXT_C },
  ]);
  // El recordatorio histórico de 5/30 min se aparta: aquí se valida el supervisor.
  await seedSettings('delivery_control', {
    deliveryReminderMinutes: 100000,
    deliveryAdminEscalationMinutes: 100000,
    deliveryAdminEscalationContacts: [{ name: 'Admin', phone: '8294933332' }],
  });
  /*
   * ACTIVACIÓN REAL: sin `activatedAt` el supervisor no toca nada (protección
   * para no escribir a pedidos de meses atrás al encenderlo). En esta UAT se
   * activa con fecha pasada para que los pedidos de la prueba entren.
   */
  await seedSettings('delivery_supervisor', { enabled: true, activatedAt: '2026-10-01T00:00:00.000Z' });
  /*
   * ACTIVACIÓN DEL SUPERVISOR (arranque controlado).
   * El supervisor no vigila nada hasta que administración lo activa: desde ese
   * momento solo siguen los pedidos asignados a partir de aquí. Es justo lo que
   * hace el botón del panel, así que la UAT lo hace igual.
   */
  const activated = await request('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activationMode: 'new' }),
  });
  expect(activated.status).toBe(200);
  const activation = await json(activated);
  expect(activation.settings.activatedAt).toBeTruthy();
  await approveTemplate('phyto_supervisor_recordatorio_v1', 'Hola {{1}}, seguimos pendientes del pedido {{2}}.\n\nSiguiente paso: {{3}}', ['courier_name', 'order_number', 'next_action']);
  await approveTemplate(
    'phyto_pedido_repartidor_v1',
    'Hola {{1}}, pedido {{2}}.\n\nCliente: {{3}}\nProductos: {{4}}\nCobrar: {{5}}\nDirección: {{6}}\nMapa: {{7}}\n\nInstrucciones: {{8}}',
    ['courier_name', 'order_number', 'customer_contact', 'products', 'amount', 'address', 'maps_link', 'instructions'],
  );
  const agent = await json(await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'agente.ciclo@phyto.local', password: 'AgenteCiclo-12345', displayName: 'Ruben Interno', role: 'AGENT', personalPhone: AGENT_PHONE }),
  }));
  agentId = agent.user.id;
  const stock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 200, unitCost: '126.66', reason: 'Inventario UAT ciclo' }),
  });
  expect(stock.status).toBe(201);
}, 90000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ciclo con repartidor INTERNO', () => {
  it('asignación → aviso interno → inicio → entregado → confirmación', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const assigned = await request(`/api/admin/orders/${orderId}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: agentId }),
    });
    expect(assigned.status).toBe(200);

    // Pasada del scheduler SIN navegador: se llama al servidor directamente.
    now = new Date(now.getTime() + 15 * 60 * 1000);
    const run = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(run.result.reminders).toBeGreaterThanOrEqual(1);

    const notifications = await app.collections.list('user_notifications', { limit: 1000 });
    expect(notifications.some((row) => row.type === 'DELIVERY_SUPERVISOR_REMINDER' && row.recipient_user_id === agentId)).toBe(true);
    // Al interno se le avisa por la app: NO se le manda una plantilla por WhatsApp.
    expect(mockWhatsApp.sent.filter((row) => row.to === `+${AGENT_PHONE}` && row.template?.name === 'phyto_supervisor_recordatorio_v1')).toHaveLength(0);

    // El agente responde desde SU teléfono por el webhook (como en producción).
    await inbound(AGENT_PHONE, 'Voy para allá');
    await waitFor(async () => ((await readOrder(orderId)).delivery.delivery_status === 'IN_TRANSIT' ? true : null));

    await inbound(AGENT_PHONE, 'Ya lo entregué');
    const reported = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.delivery.supervisor?.pending_action?.type === 'confirm_delivery' ? order : null;
    });
    expect(reported.status).not.toBe('entregado');

    await inbound(AGENT_PHONE, 'CONFIRMAR');
    const closed = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.status === 'entregado' ? order : null;
    });
    expect(closed.delivery.supervisor.confirmed_at).toBeTruthy();
  }, 60000);

  it('el agente no puede posponer un pedido que no es suyo', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    // Se asigna a otro repartidor (externo A).
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    const agentCookie = await login('agente.ciclo@phyto.local', 'AgenteCiclo-12345');
    const denied = await request(`/api/admin/orders/${orderId}/delivery/postpone`, {
      method: 'POST',
      body: JSON.stringify({ until: '2026-10-22', reason: 'No es mío' }),
    }, agentCookie);
    expect(denied.status).toBe(403);
    expect((await readOrder(orderId)).delivery.supervisor?.postponed_until ?? null).toBeNull();
  }, 30000);
});

describe('ciclo con repartidor EXTERNO e identificación del pedido', () => {
  it('con dos pedidos abiertos no adivina y el número elige el correcto', async () => {
    const one = await createOrder();
    const two = await createOrder();
    for (const order of [one, two]) {
      const assigned = await request(`/api/admin/orders/${order.item.id}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_B }) });
      expect(assigned.status).toBe(200);
      const sent = await request(`/api/admin/orders/${order.item.id}/courier/send`, { method: 'POST', body: '{}' });
      expect(sent.status).toBe(200);
    }

    await inbound(EXT_B, 'Ya lo entregué');
    const asked = await waitFor(async () => {
      const texts = mockWhatsApp.sent.filter((row) => row.to === `+${EXT_B}` && row.type === 'text');
      return texts.find((row) => row.body.includes('pedidos abiertos'));
    });
    expect(asked.body).toContain(one.order.order_number);
    expect(asked.body).toContain(two.order.order_number);
    expect((await readOrder(one.item.id)).delivery.external.status).toBe('sent');
    expect((await readOrder(two.item.id)).delivery.external.status).toBe('sent');

    await inbound(EXT_B, `Entregado ${two.order.order_number}`);
    const pendingTwo = await waitFor(async () => {
      const order = await readOrder(two.item.id);
      return order.delivery.external.status === 'awaiting_confirmation' ? order : null;
    });
    expect(pendingTwo.status).not.toBe('entregado');
    expect((await readOrder(one.item.id)).delivery.external.status).toBe('sent');
  }, 60000);

  it('un repartidor no puede mover el pedido de otro repartidor', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });

    // C envía el número del pedido de A: no tiene pedidos propios abiertos.
    await inbound(EXT_C, `Ya lo entregué ${created.order.order_number}`);
    const respuesta = await waitFor(async () => {
      const texts = mockWhatsApp.sent.filter((row) => row.to === `+${EXT_C}` && row.type === 'text');
      return texts.length ? texts.at(-1) : null;
    });
    expect(respuesta.body).toContain('No tienes pedidos abiertos');
    const after = await readOrder(orderId);
    expect(after.delivery.external.status).toBe('sent');
    expect(after.status).not.toBe('entregado');
  }, 60000);

  it('un cliente NO es repartidor: su mensaje no mueve nada', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    const before = await readOrder(orderId);

    await inbound(CUSTOMER_PHONE, 'Ya lo entregué');
    await new Promise((resolve) => setTimeout(resolve, 700));

    const after = await readOrder(orderId);
    expect(after.status).toBe(before.status);
    expect(after.delivery.external.status).toBe('sent');
    const events = await supervisorEvents();
    expect(events.some((row) => row.order_id === orderId && row.kind === 'delivered_reported')).toBe(false);
  }, 30000);
});

describe('DeepSeek apagado, sin saldo o ambiguo', () => {
  it('sin interpretación disponible pregunta y no ejecuta nada', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });

    const before = await readOrder(orderId);
    for (const interpret of [null, { intent: 'unknown', confidence: 0 }, { intent: 'delivered', confidence: 0.2 }]) {
      const out = await handleSupervisorReply({
        ctx: { ...app.ctx, proofreading: { interpret: async () => interpret } },
        inbound: { waMessageId: `wamid.DS.${Math.random()}`, fromE164: `+${EXT_A}`, text: { body: 'eso ya está listo' } },
        conversation: { id: conversationId, customer_id: 'cus_ext_a', last_inbound_at: new Date().toISOString() },
        deps: {},
      });
      expect(out.handled).toBe(true);
      expect(['unclear', 'ambiguous', 'ack', 'start', 'delivered']).toContain(out.reason);
      // Ningún caso puede cerrar el pedido sin confirmación explícita.
      expect((await readOrder(orderId)).status).toBe(before.status);
    }
    const after = await readOrder(orderId);
    expect(after.delivery.external.status).toBe('sent');
  }, 30000);

  it('el uso de IA se puede apagar en los ajustes', async () => {
    const saved = await request('/api/admin/delivery-supervisor/settings', { method: 'POST', body: JSON.stringify({ useDeepSeek: false }) });
    expect((await json(saved)).settings.useDeepSeek).toBe(false);
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    expect(snapshot.settings.useDeepSeek).toBe(false);
    await request('/api/admin/delivery-supervisor/settings', { method: 'POST', body: JSON.stringify({ useDeepSeek: true }) });
  }, 30000);
});

describe('scheduler, idempotencia y frecuencia', () => {
  it('dos pasadas seguidas no duplican el aviso y el límite de intentos se respeta', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    // Se cuenta ESTE pedido (por bitácora), no el teléfono: hay más pedidos abiertos.
    const remindersOfOrder = async () => (await supervisorEvents()).filter((row) => row.order_id === orderId && row.kind === 'reminder').length;
    const before = await remindersOfOrder();

    now = new Date(now.getTime() + 30 * 60 * 1000);
    // PASADA REAL DEL PLANIFICADOR (lo que corre sin navegador abierto).
    const tick = await app.scheduler.tick();
    expect(tick.supervisor?.reminders).toBeGreaterThanOrEqual(1);
    expect(await remindersOfOrder()).toBe(before + 1);

    const second = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(second.result.reminders).toBe(0);
    expect(await remindersOfOrder()).toBe(before + 1);

    // Antes del siguiente plazo no se repite.
    now = new Date(now.getTime() + 5 * 60 * 1000);
    const early = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(early.result.reminders).toBe(0);
    expect(await remindersOfOrder()).toBe(before + 1);

    // Al cumplirse el plazo, sí (y solo una vez).
    now = new Date(now.getTime() + 30 * 60 * 1000);
    const due = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(due.result.reminders).toBeGreaterThanOrEqual(1);
    expect(await remindersOfOrder()).toBe(before + 2);
  }, 60000);

  it('fuera del horario de contacto no se escribe', async () => {
    await request('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ contactFromHour: 8, contactToHour: 20 }),
    });
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_C }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    const before = mockWhatsApp.sent.filter((row) => row.to === `+${EXT_C}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length;

    // 02:00 UTC = 22:00 en República Dominicana.
    const previous = now;
    now = new Date('2026-10-19T02:00:00.000Z');
    const night = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(night.result.deferred).toBeGreaterThanOrEqual(1);
    expect(mockWhatsApp.sent.filter((row) => row.to === `+${EXT_C}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length).toBe(before);
    now = previous;
  }, 60000);

  it('un webhook repetido (mismo wamid) no duplica la acción', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_C }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    const messageId = `wamid.DUP.${Date.now()}`;

    await inbound(EXT_C, `Ya lo entregué ${created.order.order_number}`, messageId);
    await waitFor(async () => ((await readOrder(orderId)).delivery.external.status === 'awaiting_confirmation' ? true : null));
    // Meta reintenta el MISMO mensaje: no puede crear otro evento ni otro aviso.
    await inbound(EXT_C, `Ya lo entregué ${created.order.order_number}`, messageId);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const events = (await supervisorEvents()).filter((row) => row.order_id === orderId && row.kind === 'delivered_reported');
    expect(events).toHaveLength(1);
    const order = await readOrder(orderId);
    expect(order.delivery.external.status).toBe('awaiting_confirmation');
    expect(order.status).not.toBe('entregado');
  }, 60000);

  it('un pedido asignado ANTES de la activación no se supervisa (no se escribe a nadie)', async () => {
    // Se adelanta la activación al futuro: todo lo ya asignado queda fuera.
    await request('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ activatedAt: '2027-01-01T00:00:00.000Z' }),
    });
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    const before = mockWhatsApp.sent.length;
    now = new Date(now.getTime() + 30 * 60 * 1000);
    const run = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(run.result.reminders).toBe(0);
    expect(run.result.excluded?.before_activation ?? 0).toBeGreaterThanOrEqual(1);
    expect(mockWhatsApp.sent.length).toBe(before);

    // Se devuelve la activación a la fecha real de la prueba.
    await request('/api/admin/delivery-supervisor/settings', {
      method: 'POST',
      body: JSON.stringify({ activatedAt: '2026-10-01T00:00:00.000Z' }),
    });
  }, 60000);

  it('tras reiniciar el servidor los intentos NO se reinician (no repite avisos)', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_C }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });
    now = new Date(now.getTime() + 30 * 60 * 1000);
    await request('/api/admin/delivery-supervisor/run', { method: 'POST' });
    const beforeRestart = mockWhatsApp.sent.filter((row) => row.to === `+${EXT_C}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length;
    const eventsBefore = (await supervisorEvents()).length;
    const ownRemindersBefore = (await supervisorEvents()).filter((row) => row.order_id === orderId && row.kind === 'reminder').length;
    expect(ownRemindersBefore).toBe(1);

    await app.close();
    app = await bootApp();
    adminCookie = await login(ADMIN_USER, ADMIN_PASS);

    const afterRestart = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    /*
     * Un reinicio NO reinicia los intentos: ESTE pedido no vuelve a recibir aviso.
     * El contador global sí puede moverse, porque lo que quedó en cola por el tope
     * de volumen por pasada (`limited`) se envía en la pasada siguiente.
     */
    const ownRemindersAfter = (await supervisorEvents()).filter((row) => row.order_id === orderId && row.kind === 'reminder').length;
    expect(ownRemindersAfter).toBe(ownRemindersBefore);
    expect(Number.isFinite(afterRestart.result.reminders)).toBe(true);
    const events = await supervisorEvents();
    expect(events.length).toBeGreaterThanOrEqual(eventsBefore);
    expect(events.some((row) => row.order_id === orderId && row.kind === 'reminder')).toBe(true);
    // El pedido y su bitácora siguen ahí después del reinicio.
    const order = await readOrder(orderId);
    expect(order.delivery.external.status).toBe('sent');
    expect(mockWhatsApp.sent.filter((row) => row.to === `+${EXT_C}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length).toBeGreaterThanOrEqual(beforeRestart);
  }, 90000);
});

describe('incidencias y auditoría de cierre', () => {
  it('una incidencia escala a administración y NO desaparece del panel', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });

    await inbound(EXT_A, `El cliente no está ${created.order.order_number}`);
    const withIssue = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.delivery.external.status === 'issue' ? order : null;
    });
    expect(withIssue.status).not.toBe('entregado');

    const notifications = await app.collections.list('user_notifications', { limit: 1000 });
    expect(notifications.some((row) => row.type === 'DELIVERY_SUPERVISOR_ESCALATION' && row.entity_id === orderId)).toBe(true);

    // Mucho después sigue visible: no se cierra por antigüedad.
    now = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    expect(snapshot.buckets.incidencias.some((row) => row.id === orderId)).toBe(true);
    expect((await readOrder(orderId)).status).not.toBe('entregado');
  }, 60000);

  it('AUDITORÍA: ni el informe «entregado» ni la confirmación tocan el pago', async () => {
    const created = await createOrder({ paymentStatus: 'pending' });
    const orderId = created.item.id;
    expect(created.order.payment_status).toBe('pending');
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_A }) });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });

    await inbound(EXT_A, `Ya lo entregué ${created.order.order_number}`);
    const reported = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.delivery.external.status === 'awaiting_confirmation' ? order : null;
    });
    expect(reported.status).not.toBe('entregado');
    expect(reported.payment_status).toBe('pending');

    /*
     * REGLA FINANCIERA: ENTREGAR NO ES COBRAR.
     *
     * Ni el aviso del repartidor, ni la lectura de la IA, ni la transición
     * oficial a «entregado» escriben el pago: el pedido sigue «por cobrar»
     * hasta que alguien registre el cobro en el panel (con importe y medio).
     */
    await inbound(EXT_A, `CONFIRMAR ${created.order.order_number}`);
    const closed = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.status === 'entregado' ? order : null;
    });
    expect(closed.payment_status).toBe('pending');
    expect(closed.paid_at ?? null).toBeNull();
    expect(closed.payment?.entries ?? []).toHaveLength(0);
  }, 60000);
});

describe('posposición y conciliación diaria', () => {
  it('una posposición vencida reanuda el seguimiento una sola vez', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, { method: 'POST', body: JSON.stringify({ contactPhone: EXT_B }) });
    const until = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const postponed = await request(`/api/admin/orders/${orderId}/delivery/postpone`, {
      method: 'POST',
      body: JSON.stringify({ until, reason: 'Cliente pidió más tarde' }),
    });
    expect(postponed.status).toBe(200);

    // Antes de vencer: sigue pospuesto y no se le escribe.
    const sendsBefore = mockWhatsApp.sent.filter((row) => row.to === `+${EXT_B}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length;
    await request('/api/admin/delivery-supervisor/run', { method: 'POST' });
    expect(mockWhatsApp.sent.filter((row) => row.to === `+${EXT_B}` && row.template?.name === 'phyto_supervisor_recordatorio_v1').length).toBe(sendsBefore);
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    expect(snapshot.buckets.pospuestos.some((row) => row.id === orderId)).toBe(true);

    // Vencida: se reanuda (evento) y vuelve a la lista normal.
    now = new Date(Date.parse(until) + 5 * 60 * 1000);
    const resumed = await json(await request('/api/admin/delivery-supervisor/run', { method: 'POST' }));
    expect(resumed.result.postponedDue).toBeGreaterThanOrEqual(1);
    const events = await supervisorEvents();
    expect(events.filter((row) => row.order_id === orderId && row.kind === 'postpone_due')).toHaveLength(1);
    const after = await json(await request('/api/admin/delivery-supervisor'));
    expect(after.buckets.pospuestos.some((row) => row.id === orderId)).toBe(false);
  }, 60000);

  it('la conciliación diaria deja constancia y los pendientes siguen visibles', async () => {
    const daily = await json(await request('/api/admin/delivery-supervisor/daily', { method: 'POST' }));
    expect(daily.ok).toBe(true);
    expect(typeof daily.pendientes).toBe('number');
    const events = await supervisorEvents();
    expect(events.some((row) => row.kind === 'daily')).toBe(true);
    const snapshot = await json(await request('/api/admin/delivery-supervisor'));
    const pendientes = snapshot.counts.sin_iniciar + snapshot.counts.en_camino + snapshot.counts.atrasados + snapshot.counts.incidencias;
    expect(pendientes).toBeGreaterThan(0);
    // Nada se cerró por antigüedad.
    expect(snapshot.counts.confirmadas).toBeLessThanOrEqual(1);
  }, 30000);
});
