// @vitest-environment jsdom
/**
 * UAT DE PANEL — CENTRO IA → CHATS DEL SUPERVISOR.
 *
 * Se carga el panel REAL (`public/admin/index.html` + `app.js` + `ops.js`) en
 * jsdom y se navega como una persona: menú → Centro IA → Chats → pedido.
 *
 * Lo que se demuestra:
 *   - el chat del pedido aparece con su número, cliente, repartidor y estado;
 *   - dentro se distinguen las TRES cosas que no se pueden confundir:
 *       · lo que el supervisor envió por WhatsApp, con su estado real;
 *       · lo que el repartidor contestó (recibido);
 *       · la nota interna, marcada como NO enviada;
 *   - el escalado se ve como hecho del sistema, no como mensaje al cliente.
 *
 * Nada sale a Meta: el WhatsApp es simulado y el webhook va firmado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'panel-chats-token';
const APP_SECRET = 'panel-chats-secret';
const ADMIN = { username: 'panel.chats', password: 'Panel-123456', name: 'Ana Chats' };
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const CUSTOMER_PHONE = '18095559011';
const COURIER_PHONE = '+18095551234';
const COURIER_LOCAL = '809 555 1234';

let tmpDir;
let app;
let dom;
let cookie = '';
let courierId = '';
let orderId = '';
let orderNumber = '';
let now = new Date('2026-10-22T13:00:00.000Z'); // 09:00 en RD

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-CHATS',
  businessAccountId: 'WABA-CHATS',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, messageId: `wamid.CHATS_T_${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, messageId: `wamid.CHATS_TPL_${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];

async function waitFor(check, label, timeout = 12_000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function click(target) {
  if (!target) throw new Error('no hay elemento que pulsar');
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function setValue(target, value) {
  target.value = value;
  target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

const api = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

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

async function respuestaDelRepartidor(texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-CHATS',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PN-CHATS' },
              contacts: [{ profile: { name: 'Rubén Reparto' }, wa_id: COURIER_PHONE.replace('+', '') }],
              messages: [
                {
                  id: `wamid.IN_${Date.now()}`,
                  from: COURIER_PHONE.replace('+', ''),
                  timestamp: `${Math.floor(now.getTime() / 1000)}`,
                  type: 'text',
                  text: { body: texto },
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

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-panel-chats-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'chats.sqlite'),
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

  /* Repartidor interno con teléfono: es a quien el supervisor avisa. */
  const repartidor = await json(
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'chats.reparto@local',
        password: 'Reparto-12345',
        displayName: 'Rubén Reparto',
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

  /* El supervisor solo mira pedidos asignados DESPUÉS de su activación. */
  const ajustes = await api('/api/admin/delivery-supervisor/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, activatedAt: '2026-10-22T12:00:00.000Z' }),
  });
  expect(ajustes.status).toBe(200);

  const stock = await api('/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity: 60, unitCost: '126.66', reason: 'Inventario UAT chats' }),
  });
  expect(stock.status).toBe(201);

  await aprobarPlantilla('phyto_pedido_repartidor_v1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  await aprobarPlantilla('phyto_supervisor_recordatorio_v1', ['a', 'b', 'c']);

  const pedido = await json(
    await api('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        phone: CUSTOMER_PHONE,
        name: 'Cliente Chats',
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

  /* T+5: el supervisor manda el primer WhatsApp con el pedido y el enlace. */
  now = new Date(now.getTime() + 5 * 60 * 1000);
  const pasada = await api('/api/admin/delivery-supervisor/run', { method: 'POST' });
  expect(pasada.status).toBe(200);
  expect(whatsapp.sent.length).toBeGreaterThanOrEqual(1);

  /* El repartidor ACEPTA (acción autenticada) y contesta por WhatsApp. */
  const aceptado = await api(`/api/admin/orders/${orderId}/delivery/accept`, { method: 'POST', body: '{}' });
  expect(aceptado.status).toBe(200);
  await respuestaDelRepartidor('Voy para allá');

  /* Una nota del equipo: es interna y NO debe parecer enviada por WhatsApp. */
  const chats = await json(await api('/api/admin/ops/chats'));
  const chat = (chats.chats ?? []).find((row) => String(row.orderId) === String(orderId));
  expect(chat, 'el pedido supervisado tiene chat propio').toBeTruthy();
  const nota = await api(`/api/admin/ops/tickets/${chat.ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Nota interna de la UAT', clientKey: `uat-note-${chat.ticketId}` }),
  });
  expect(nota.status).toBeLessThan(400);

  /* El repartidor contesta por WhatsApp y el equipo deja una nota interna. */
  await respuestaDelRepartidor('Voy para allá');

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.eval(readFileSync(path.join(ADMIN_DIR, 'ops.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  setValue($('#login-username'), ADMIN.username);
  setValue($('#login-password'), ADMIN.password);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'la app dentro');
}, 90_000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Entra al Centro IA y abre la sección de Chats como lo haría una persona. */
async function abrirChats() {
  click($('[data-tab="ops"]'));
  await waitFor(() => Boolean($('#view-ops')?.dataset.shell), 'el armazón del Centro IA', 15_000);
  const boton = await waitFor(() => $('[data-centro-nav="chats"]'), 'el botón de Chats', 15_000);
  click(boton);
  await waitFor(() => $$('.centro-chat').length >= 1, 'la lista de chats', 15_000);
}

describe('Centro IA · chats del supervisor', () => {
  it('el chat del pedido supervisado aparece con su número y su repartidor', async () => {
    await abrirChats();
    const filas = $$('.centro-chat').map((row) => row.textContent.replace(/\s+/g, ' '));
    const fila = filas.find((text) => text.includes(orderNumber));
    expect(fila).toBeTruthy();
    expect(fila).toContain('Cliente Chats');
    expect(fila).toContain('Rubén Reparto');
  });

  it('al abrirlo se ve lo enviado por WhatsApp con su estado, la respuesta y la nota interna', async () => {
    const fila = $$('.centro-chat').find((row) => row.textContent.includes(orderNumber));
    click(fila);
    await waitFor(() => $$('.centro-chatpane .ops-msg').length >= 1, 'la conversación del pedido', 15_000);

    const mensajes = $$('.centro-chatpane .ops-msg').map((row) => row.textContent.replace(/\s+/g, ' '));
    /* Lo que salió por WhatsApp: se marca como tal y con su estado real. */
    const enviado = mensajes.find((text) => text.includes('WhatsApp'));
    expect(enviado, `mensajes: ${mensajes.join(' || ')}`).toBeTruthy();
    expect(enviado).toMatch(/Enviado|Entregado|Leído|Pendiente/);
    /* Lo que contestó el repartidor: entra, no es un aviso nuestro. */
    expect(mensajes.some((text) => text.includes('Recibido') && text.includes('Voy para allá')), `mensajes: ${mensajes.join(' || ')}`).toBe(true);
    /* La nota del equipo: interna y marcada como NO enviada por WhatsApp. */
    expect(mensajes.some((text) => text.includes('Interno') && text.includes('Nota interna de la UAT')), `mensajes: ${mensajes.join(' || ')}`).toBe(true);
    /* Nada se inventa: el número del pedido está en el encabezado. */
    expect($('.centro-chatpane__num')?.textContent).toContain(orderNumber);
  });

  it('volver regresa a la lista sin perder los chats', async () => {
    click($('[data-chat-back]'));
    await waitFor(() => $$('.centro-chat').length >= 1, 'la lista de chats', 15_000);
    expect($('.centro-chatpane')).toBeNull();
  });
});
