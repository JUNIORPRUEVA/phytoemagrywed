// @vitest-environment node
/**
 * DINERO DEL PEDIDO — entrega, cobro y rendición son tres cosas distintas.
 *
 * Estas pruebas existen por un fallo real: cerrar una entrega podía dejar el
 * pedido como «pagado» sin que nadie hubiera recibido el dinero. Aquí se
 * comprueba, contra el servidor de verdad, que:
 *
 *   1. entregar NO marca pagado,
 *   2. un pedido ya pagado no se revierte,
 *   3. el cobro se registra a mano con importe, medio, quién y cuándo,
 *   4. un pago parcial deja el saldo intacto,
 *   5. ni el aviso del repartidor ni la IA de WhatsApp registran dinero,
 *   6. un agente interno que finaliza tampoco cobra,
 *   7. dos intentos de finalización no duplican nada,
 *   8. un repartidor no puede cobrar pedidos ajenos,
 *   9. dos toques de «registrar cobro» no cobran dos veces (idempotencia),
 *  10. la rendición del efectivo del repartidor se registra y no deja saldos raros.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'pagos-token-123';
const APP_SECRET = 'pagos-secret';
const ADMIN_USER = 'admin@phyto.local';
const ADMIN_PASS = 'AdminPagos-12345';
const AGENT_USER = 'agente@phyto.local';
const AGENT_PASS = 'AgentePagos-12345';
const COURIER_USER = 'repartidor@phyto.local';
const COURIER_PASS = 'RepartidorPagos-12345';
const CUSTOMER_PHONE = '18095558888';
const EXTERNAL_COURIER = '18095550999';
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12' };

let tmpDir;
let app;
let adminCookie = '';
let agentCookie = '';
let courierCookie = '';
let conversationId = '';
let agentUser = null;
let courierUser = null;
const now = new Date('2026-10-20T12:00:00.000Z');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-PAY',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body, options) {
    mockWhatsApp.sent.push({ to, body, options, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.PAY_TEXT_${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.PAY_TPL_${mockWhatsApp.sent.length}` };
  },
  async sendDocument(to, input) {
    mockWhatsApp.sent.push({ to, ...input, type: 'document' });
    return { ok: true, status: 200, waMessageId: `wamid.PAY_DOC_${mockWhatsApp.sent.length}` };
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
const body = async (response) => json(response);
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
async function inbound(from, messageBody, id = `wamid.PAY_IN.${Math.random().toString(36).slice(2)}`) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-PAY' },
              contacts: [{ profile: { name: 'Contacto' }, wa_id: from }],
              messages: [{ id, from, timestamp: `${Math.floor(now.getTime() / 1000)}`, type: 'text', text: { body: messageBody } }],
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

async function createOrder(overrides = {}) {
  const response = await request('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      phone: CUSTOMER_PHONE,
      name: 'Cliente Pagos',
      paymentMethod: 'CASH',
      conversationId,
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: L1,
      deliveryFee: 250,
      ...overrides,
    }),
  });
  const payload = await json(response);
  expect({ status: response.status, payload }).toMatchObject({ status: 201 });
  return payload;
}

async function readOrder(orderId) {
  const detail = await json(await request(`/api/admin/orders/${orderId}`));
  // `payment` es el bloque CALCULADO por el servidor (saldo, cobros, rendición).
  return { ...detail.order, payment: detail.payment };
}

/** Traza de auditoría (el almacén puede devolver `data` ya serializado). */
async function auditRows() {
  const rows = await app.collections.list('audit', { limit: 1000 });
  return rows.map((row) => ({
    ...row,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
  }));
}

async function waitFor(check, { timeout = 10000, interval = 150 } = {}) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('tiempo de espera agotado');
}

const finishOrder = (orderId, cookie = adminCookie) =>
  request(`/api/admin/orders/${orderId}/finish`, { method: 'POST', body: JSON.stringify({ reason: 'Entrega UAT' }) }, cookie);

const registerPayment = (orderId, payload, cookie = adminCookie) =>
  request(`/api/admin/orders/${orderId}/payments`, { method: 'POST', body: JSON.stringify(payload) }, cookie);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-pagos-'));
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

  agentUser = (
    await body(
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASS, displayName: 'Agente Pagos', role: 'AGENT' }),
      }),
    )
  ).user;
  courierUser = (
    await body(
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username: COURIER_USER, password: COURIER_PASS, displayName: 'Repartidor Pagos', role: 'DELIVERY' }),
      }),
    )
  ).user;
  agentCookie = await login(AGENT_USER, AGENT_PASS);
  courierCookie = await login(COURIER_USER, COURIER_PASS);

  await inbound(CUSTOMER_PHONE, 'Hola, quiero hacer un pedido');
  const data = await json(await request('/api/admin/conversations'));
  conversationId = data.conversations.find((row) => row.customer?.phone_e164 === `+${CUSTOMER_PHONE}`)?.id;
  expect(conversationId).toBeTruthy();

  // Contacto de reparto externo (el que se guarda desde los ajustes del panel).
  const stamp = new Date().toISOString();
  await app.collections.insert('settings', {
    id: 'set_delivery_contacts',
    key: 'delivery_contacts',
    value: [{ id: 'cus_mensajero', name: 'Mensajero Pedro', phone: EXTERNAL_COURIER, updated_at: stamp }],
    created_at: stamp,
    updated_at: stamp,
  });
  await request('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_supervisor_recordatorio_v1',
      status: 'APPROVED',
      body: 'Hola {{1}}, seguimos pendientes del pedido {{2}}.\n\nSiguiente paso: {{3}}',
      variables: ['courier_name', 'order_number', 'next_action'],
      lastSyncedAt: stamp,
      lastTemplateSyncAt: stamp,
    }),
  });
  await request('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_pedido_repartidor_v1',
      status: 'APPROVED',
      body: 'Hola {{1}}, pedido {{2}}.\n\nCliente: {{3}}\nProductos: {{4}}\nCobrar: {{5}}\nDirección: {{6}}\nMapa: {{7}}\n\nInstrucciones: {{8}}',
      variables: ['courier_name', 'order_number', 'customer_contact', 'products', 'amount', 'address', 'maps_link', 'instructions'],
      lastSyncedAt: stamp,
      lastTemplateSyncAt: stamp,
    }),
  });

  const stock = await request('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 900, unitCost: '126.66', reason: 'Inventario UAT pagos' }),
  });
  expect(stock.status).toBe(201);
}, 60000);

afterAll(async () => {
  await app?.close?.();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('entregar no es cobrar', () => {
  it('un pedido nuevo nace POR COBRAR (no «pagado» por defecto)', async () => {
    const created = await createOrder();
    expect(created.order.payment_status).toBe('pending');
    expect(created.order.paid_at ?? null).toBe(null);
  });

  it('finalizar la entrega deja el pedido por cobrar, con el saldo completo', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const total = created.order.total;
    const finished = await finishOrder(orderId);
    expect(finished.status).toBe(200);
    const closed = await readOrder(orderId);
    expect(closed.status).toBe('entregado');
    expect(closed.payment_status).toBe('pending');
    expect(closed.paid_at ?? null).toBe(null);
    expect(closed.payment?.entries ?? []).toHaveLength(0);
    expect(closed.payment?.due).toBeCloseTo(total, 2);

    // El detalle del pedido dice lo mismo que el pedido guardado.
    const detail = await json(await request(`/api/admin/orders/${orderId}`));
    expect(detail.payment.status).toBe('pending');
    expect(detail.payment.due).toBeCloseTo(total, 2);
  });

  it('un pedido que YA estaba pagado no se revierte al entregar', async () => {
    const created = await createOrder({ paymentStatus: 'paid' });
    const orderId = created.item.id;
    expect(created.order.payment_status).toBe('paid');
    const paidAt = created.order.paid_at ?? null;
    await finishOrder(orderId);
    const closed = await readOrder(orderId);
    expect(closed.status).toBe('entregado');
    expect(closed.payment_status).toBe('paid');
    expect(closed.paid_at ?? paidAt).toBe(paidAt);
  });

  it('dos intentos de finalización no duplican la entrega ni crean dinero', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const first = await json(await finishOrder(orderId));
    expect(first.ok).toBe(true);
    const afterFirst = await readOrder(orderId);
    await finishOrder(orderId);
    const afterSecond = await readOrder(orderId);
    expect(afterSecond.delivered_at).toBe(afterFirst.delivered_at);
    expect(afterSecond.payment?.entries ?? []).toHaveLength(0);
    expect(afterSecond.payment_status).toBe('pending');
  });
});

describe('registro explícito del cobro', () => {
  it('cobra en efectivo y deja constancia de importe, medio, quién y cuándo', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const total = created.order.total;
    await finishOrder(orderId);

    const paid = await registerPayment(orderId, { amount: total, method: 'CASH', note: 'Cobrado en la puerta' });
    const paidBody = await json(paid);
    expect(paidBody).toMatchObject({ ok: true });
    expect(paid.status).toBe(200);
    const payload = paidBody;
    expect(payload.payment.status).toBe('paid');
    expect(payload.payment.due).toBe(0);
    expect(payload.payment.entries).toHaveLength(1);
    expect(payload.payment.entries[0]).toMatchObject({ amount: total, method: 'CASH', note: 'Cobrado en la puerta' });
    expect(payload.payment.entries[0].by_display_name).toBeTruthy();
    expect(payload.payment.entries[0].at).toBeTruthy();

    const saved = await readOrder(orderId);
    expect(saved.payment_status).toBe('paid');
    expect(saved.paid_at).toBeTruthy();

    // El cobro queda auditado (quién lo anotó y cuánto).
    const audit = await auditRows();
    const entry = audit.find((row) => row.action === 'order.payment_registered' && row.entity_id === orderId);
    expect(entry).toBeTruthy();
    expect(entry.data.amount).toBeCloseTo(total, 2);
  });

  it('un pago parcial conserva el saldo y el pedido sigue por cobrar', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const total = created.order.total;
    const mitad = Math.round((total / 2) * 100) / 100;

    const partial = await json(await registerPayment(orderId, { amount: mitad, method: 'TRANSFER' }));
    expect(partial.payment.status).toBe('partial');
    expect(partial.payment.received).toBeCloseTo(mitad, 2);
    expect(partial.payment.due).toBeCloseTo(total - mitad, 2);
    // Compatibilidad: 'pending' mientras falte dinero.
    expect((await readOrder(orderId)).payment_status).toBe('pending');

    const rest = await json(await registerPayment(orderId, { amount: Math.round((total - mitad) * 100) / 100, method: 'CASH' }));
    expect(rest.payment.status).toBe('paid');
    expect(rest.payment.due).toBe(0);
    expect((await readOrder(orderId)).payment_status).toBe('paid');
  });

  it('no deja cobrar de más ni sobre un pedido cancelado', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const exceso = await registerPayment(orderId, { amount: created.order.total + 100, method: 'CASH' });
    expect(exceso.status).toBe(422);
    expect((await json(exceso)).error).toBe('amount_exceeds_due');

    const cero = await registerPayment(orderId, { amount: 0, method: 'CASH' });
    expect(cero.status).toBe(422);

    const cancelled = await request(`/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelado', reason: 'Prueba' }),
    });
    expect(cancelled.status).toBe(200);
    const cerrado = await registerPayment(orderId, { amount: 100, method: 'CASH' });
    expect(cerrado.status).toBe(409);
  });

  it('dos toques con la misma clave no cobran dos veces (idempotencia)', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const total = created.order.total;
    const key = 'prueba-idempotencia-1';
    const first = await json(await registerPayment(orderId, { amount: total, method: 'CASH', idempotencyKey: key }));
    expect(first.duplicate).toBe(false);
    const second = await json(await registerPayment(orderId, { amount: total, method: 'CASH', idempotencyKey: key }));
    expect(second.duplicate).toBe(true);
    const saved = await readOrder(orderId);
    expect(saved.payment.entries).toHaveLength(1);
    expect(saved.payment.received).toBeCloseTo(total, 2);
  });
});

describe('la confirmación por WhatsApp no registra dinero', () => {
  it('repartidor externo: «ya lo entregué» + CONFIRMAR cierra la entrega y deja el cobro pendiente', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/courier/assign`, {
      method: 'POST',
      body: JSON.stringify({ contactPhone: EXTERNAL_COURIER }),
    });
    await request(`/api/admin/orders/${orderId}/courier/send`, { method: 'POST', body: '{}' });

    await inbound(EXTERNAL_COURIER, `Ya lo entregué ${created.order.order_number}`);
    await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.delivery.external.status === 'awaiting_confirmation' ? order : null;
    });
    await inbound(EXTERNAL_COURIER, `CONFIRMAR ${created.order.order_number}`);
    const closed = await waitFor(async () => {
      const order = await readOrder(orderId);
      return order.status === 'entregado' ? order : null;
    });
    expect(closed.payment_status).toBe('pending');
    expect(closed.payment?.entries ?? []).toHaveLength(0);
    expect(closed.payment?.due).toBeCloseTo(created.order.total, 2);
  }, 60000);

  it('un agente interno que finaliza tampoco marca el cobro', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: agentUser.id }),
    });
    const finished = await finishOrder(orderId, agentCookie);
    expect(finished.status).toBe(200);
    const closed = await readOrder(orderId);
    expect(closed.status).toBe('entregado');
    expect(closed.payment_status).toBe('pending');
    expect(closed.payment?.entries ?? []).toHaveLength(0);
  });
});

describe('quién puede anotar dinero', () => {
  it('un repartidor no puede cobrar un pedido que no es suyo', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: agentUser.id }),
    });
    const denied = await registerPayment(orderId, { amount: 100, method: 'CASH' }, courierCookie);
    expect(denied.status).toBe(403);
    expect((await readOrder(orderId)).payment?.entries ?? []).toHaveLength(0);
  });

  it('el repartidor asignado sí puede registrar lo que cobró en la puerta', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await request(`/api/admin/orders/${orderId}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: courierUser.id }),
    });
    // Inicia el seguimiento: es el estado real de «voy con el pedido».
    const started = await request(`/api/admin/orders/${orderId}/delivery/start`, {
      method: 'POST',
      body: JSON.stringify({ destination: L1 }),
    }, courierCookie);
    expect([200, 201]).toContain(started.status);

    const paid = await registerPayment(orderId, { amount: created.order.total, method: 'CASH' }, courierCookie);
    const payload = await json(paid);
    expect(payload.ok).toBe(true);
    expect(paid.status).toBe(200);
    expect(payload.payment.status).toBe('paid');
    // Queda registrado QUIÉN anotó el dinero (el repartidor que lo cobró).
    expect(payload.payment.entries[0].by_display_name).toBe('Repartidor Pagos');
  });

  it('la rendición del efectivo del repartidor se registra aparte y sin saldos negativos', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    const total = created.order.total;
    await request(`/api/admin/orders/${orderId}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: courierUser.id }),
    });
    await registerPayment(orderId, { amount: total, method: 'CASH' });

    const before = await json(await request(`/api/admin/orders/${orderId}`));
    expect(before.payment.courier.pending).toBeCloseTo(total, 2);

    const tooMuch = await request(`/api/admin/orders/${orderId}/payments/handover`, {
      method: 'POST',
      body: JSON.stringify({ amount: total + 50 }),
    });
    expect(tooMuch.status).toBe(422);

    const handover = await request(`/api/admin/orders/${orderId}/payments/handover`, {
      method: 'POST',
      body: JSON.stringify({ amount: total, note: 'Entregado en oficina' }),
    });
    expect(handover.status).toBe(200);
    const payload = await json(handover);
    expect(payload.payment.courier.pending).toBe(0);
    expect(payload.payment.courier.handed_over_total).toBeCloseTo(total, 2);
    // Rendir el efectivo NO es un cobro nuevo: el cobro sigue siendo uno.
    expect(payload.payment.entries).toHaveLength(1);
    expect((await readOrder(orderId)).payment_status).toBe('paid');

    const audit = await auditRows();
    expect(audit.some((row) => row.action === 'order.courier_handover_registered' && row.entity_id === orderId)).toBe(true);
  });

  it('la rendición es solo de administración', async () => {
    const created = await createOrder();
    const orderId = created.item.id;
    await registerPayment(orderId, { amount: created.order.total, method: 'CASH' });
    const denied = await request(
      `/api/admin/orders/${orderId}/payments/handover`,
      { method: 'POST', body: JSON.stringify({ amount: 10 }) },
      agentCookie,
    );
    expect(denied.status).toBe(403);
  });
});
