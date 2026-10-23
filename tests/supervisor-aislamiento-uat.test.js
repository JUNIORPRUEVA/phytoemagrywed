/**
 * UAT DE AISLAMIENTO — repartidor / cliente / chat operativo de la IA.
 *
 * Se demuestra, con el servidor real y WhatsApp simulado:
 *   1. La respuesta operativa de un repartidor («Voy para allá») llega al CHAT
 *      DEL PEDIDO y **no** lo marca como «no contactar» (regresión del falso
 *      opt-out por la preposición «para»).
 *   2. El mensaje de un CLIENTE entra en su conversación de WhatsApp y **no**
 *      aparece en el chat operativo del pedido.
 *   3. Lo que escribe el SISTEMA/IA (escalados) vive solo en el chat operativo y
 *      **no** se copia a la conversación del cliente.
 *   4. La baja REAL de un cliente sigue cortando el contacto (protección intacta).
 *
 * Nada sale a Meta: el webhook va firmado y el envío es simulado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'aislamiento-token';
const APP_SECRET = 'aislamiento-secret';
const ADMIN = { username: 'admin.aisla', password: 'AdminAisla-12345', name: 'Ana Aislamiento' };
const CUSTOMER_PHONE = '18095559031';
const CUSTOMER_LOCAL = '809 555 9031';
const COURIER_PHONE = '+18095551555';
const COURIER_LOCAL = '809 555 1555';

let tmpDir;
let app;
let cookie = '';
let courierId = '';
let orderId = '';
let orderNumber = '';
let ticketId = '';
let now = new Date('2026-10-22T13:00:00.000Z'); // 09:00 en RD

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-AISLA',
  businessAccountId: 'WABA-AISLA',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, messageId: `wamid.AISLA_T_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, messageId: `wamid.AISLA_TPL_${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const api = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

async function entrarPorWhatsApp(from, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-AISLA',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-AISLA' },
              contacts: [{ profile: { name: `Contacto ${from.slice(-4)}` }, wa_id: from }],
              messages: [
                {
                  id: `wamid.IN_${from}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                  from,
                  timestamp: `${Math.floor(now.getTime() / 1000)}`,
                  type: 'text',
                  text: { body },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const response = await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  expect(response.status).toBe(200);
}

async function aprobarPlantilla(name, variables) {
  const body = variables.map((_, index) => `{{${index + 1}}}`).join(' · ');
  const response = await api('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name,
      status: 'APPROVED',
      body,
      variables,
      lastSyncedAt: now.toISOString(),
      lastTemplateSyncAt: now.toISOString(),
    }),
  });
  expect(response.status).toBe(200);
}

const mensajesDelChat = async () =>
  (await app.collections.list('ops_ticket_messages', { limit: 500 })).filter((row) => String(row.ticket_id) === String(ticketId));

const conversacionDe = async (phoneE164) => {
  const customers = await app.collections.list('customers', { limit: 500 });
  const customer = customers.find((row) => String(row.phone_e164) === String(phoneE164)) ?? null;
  const mensajes = customer
    ? (await app.collections.list('wa_messages', { limit: 500 })).filter((row) => String(row.customer_id) === String(customer.id))
    : [];
  return { customer, mensajes };
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-aislamiento-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'aisla.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    clock: () => now,
    appSecret: APP_SECRET,
    whatsapp,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
  });

  const login = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const repartidor = await json(
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'aisla.reparto@local',
        password: 'Reparto-12345',
        displayName: 'Pedro Aislamiento',
        role: 'DELIVERY',
      }),
    }),
  );
  courierId = repartidor.user.id;
  const conNumero = await api(`/api/admin/users/${courierId}`, {
    method: 'PATCH',
    body: JSON.stringify({ personalPhone: COURIER_LOCAL }),
  });
  expect(conNumero.status).toBe(200);

  const ajustes = await api('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T12:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);

  const stock = await api('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 60, unitCost: '126.66', reason: 'Inventario UAT aislamiento' }),
  });
  expect(stock.status).toBe(201);

  await aprobarPlantilla('phyto_pedido_repartidor_v1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  await aprobarPlantilla('phyto_supervisor_recordatorio_v1', ['a', 'b', 'c']);
  await aprobarPlantilla('phyto_delivery_sin_atender_admin_v1', ['a', 'b']);

  const pedido = await json(
    await api('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        phone: CUSTOMER_PHONE,
        name: 'Cliente Aislamiento',
        paymentMethod: 'CASH',
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: { latitude: 18.6157, longitude: -68.7071, address: 'Calle Duarte 45' },
        deliveryFee: 250,
      }),
    }),
  );
  orderId = pedido.item.id;
  orderNumber = pedido.order.order_number;
  const asignado = await api(`/api/admin/orders/${orderId}/delivery/assign`, {
    method: 'POST',
    body: JSON.stringify({ deliveryUserId: courierId }),
  });
  expect(asignado.status).toBe(200);

  /* La pasada del programador abre el ticket del pedido (aviso interno, sin WhatsApp). */
  await app.ctx.scheduler.tick();
  expect(whatsapp.sent.length).toBe(0);

  const chats = await json(await api('/api/admin/ops/chats'));
  const chat = (chats.chats ?? []).find((row) => String(row.orderId) === String(orderId));
  expect(chat, 'el pedido supervisado tiene chat propio').toBeTruthy();
  ticketId = chat.ticketId;
}, 90_000);

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('aislamiento repartidor / cliente / chat operativo', () => {
  it('T+5: sale el aviso al repartidor y queda en el chat del pedido', async () => {
    now = new Date(now.getTime() + 5 * 60 * 1000);
    const pasada = await api('/api/admin/delivery-supervisor/run', { method: 'POST' });
    expect(pasada.status).toBe(200);
    const mensajes = await mensajesDelChat();
    const saliente = mensajes.find((row) => row.meta?.direction === 'outbound');
    expect(saliente, 'el aviso salió y está registrado').toBeTruthy();
    expect(saliente.meta?.channel).toBeTruthy();
    expect(String(saliente.body ?? '')).toContain(orderNumber);
  });

  it('la respuesta operativa del repartidor entra en el chat y NO lo marca como no contactar', async () => {
    await entrarPorWhatsApp(COURIER_PHONE.replace('+', ''), 'Voy para allá');
    const mensajes = await mensajesDelChat();
    const entrantes = mensajes.filter((row) => row.meta?.direction === 'inbound');
    expect(entrantes, `entrantes: ${JSON.stringify(entrantes.map((row) => row.body))}`).toHaveLength(1);
    const entrante = entrantes.find((row) => String(row.body).includes('Voy para allá'));
    expect(entrante, 'la respuesta quedó en el chat del pedido').toBeTruthy();

    /* El falso opt-out por la preposición «para» ya no ocurre. */
    const { customer } = await conversacionDe(COURIER_PHONE);
    expect(customer).toBeTruthy();
    expect(customer.do_not_contact === true).toBe(false);
    expect(customer.whatsapp_opt_out_at ?? null).toBeNull();
    expect(customer.automation_state).not.toBe('PAUSED');
  });

  it('el mensaje de un CLIENTE va a su conversación y no al chat operativo', async () => {
    await entrarPorWhatsApp(CUSTOMER_PHONE, 'Hola, ¿dónde está mi pedido?');
    const { customer, mensajes } = await conversacionDe(`+${CUSTOMER_PHONE}`);
    expect(customer).toBeTruthy();
    expect(mensajes.some((row) => String(row.body ?? row.text ?? '').includes('dónde está mi pedido'))).toBe(true);

    const operativo = await mensajesDelChat();
    expect(operativo.some((row) => String(row.body ?? '').includes('dónde está mi pedido'))).toBe(false);
  });

  it('el escalado del sistema vive solo en el chat operativo', async () => {
    /*
     * PEDIDO NUEVO, SIN RESPUESTA DEL REPARTIDOR.
     *
     * En el pedido anterior el repartidor contestó «Voy para allá», así que la
     * entrega ya empezó y NO corresponde escalar por aceptación (correcto). Para
     * ver el escalado hace falta un pedido que siga sin aceptar.
     */
    const pedido = await json(
      await api('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({
          phone: CUSTOMER_PHONE,
          name: 'Cliente Sin Aceptar',
          paymentMethod: 'CASH',
          items: [{ variantId: 'capsules_10', quantity: 1 }],
          deliveryLocation: { latitude: 18.6157, longitude: -68.7071, address: 'Calle Duarte 45' },
          deliveryFee: 250,
        }),
      }),
    );
    const sinAceptar = pedido.item.id;
    const asignado = await api(`/api/admin/orders/${sinAceptar}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: courierId }),
    });
    expect(asignado.status).toBe(200);
    await app.ctx.scheduler.tick();

    const chats = await json(await api('/api/admin/ops/chats'));
    const chat = (chats.chats ?? []).find((row) => String(row.orderId) === String(sinAceptar));
    expect(chat, 'el pedido sin aceptar tiene su chat').toBeTruthy();

    /* T+5: primer aviso (la política exige al menos un aviso antes de escalar). */
    now = new Date(now.getTime() + 5 * 60 * 1000);
    expect((await api('/api/admin/delivery-supervisor/run', { method: 'POST' })).status).toBe(200);
    /* T+30 sin aceptación: se escala a administración. */
    now = new Date(now.getTime() + 25 * 60 * 1000);
    const pasada = await api('/api/admin/delivery-supervisor/run', { method: 'POST' });
    expect(pasada.status).toBe(200);

    const operativo = (await app.collections.list('ops_ticket_messages', { limit: 500 })).filter(
      (row) => String(row.ticket_id) === String(chat.ticketId),
    );
    const sistema = operativo.find((row) => row.meta?.direction === 'system');
    expect(sistema, 'el escalado queda como hecho del sistema').toBeTruthy();

    /* Lo que es del sistema NO se copia a la conversación del cliente. */
    const { mensajes } = await conversacionDe(`+${CUSTOMER_PHONE}`);
    expect(mensajes.some((row) => String(row.body ?? '') === String(sistema.body))).toBe(false);
  });

  it('la baja REAL de un cliente sigue cortando el contacto', async () => {
    await entrarPorWhatsApp(CUSTOMER_PHONE, 'No me escribas más, gracias');
    const { customer } = await conversacionDe(`+${CUSTOMER_PHONE}`);
    expect(customer.do_not_contact).toBe(true);
    expect(customer.whatsapp_opt_out_at).toBeTruthy();
  });
});
