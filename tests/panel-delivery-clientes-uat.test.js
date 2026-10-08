// @vitest-environment jsdom
/**
 * UAT DEL PANEL — del listado de CLIENTES al CHAT.
 *
 * El negocio no tiene un equipo de reparto aparte: al pedido se le pasa un agente
 * (o un repartidor) y esa persona lo entrega. Así que quien reparte TIENE que
 * poder hablar con su cliente desde el panel, sin depender de administración.
 *
 * Aquí se entra con usuarios DE VERDAD (usuario y contraseña, contra el servidor
 * real) y se recorre en la pantalla real:
 *
 *   - REPARTIDOR (rol DELIVERY): Clientes → su cliente → se abre el CHAT (no hay
 *     ficha que no pueda usar, ni botones que le darían 403).
 *   - AGENTE (que también entrega): Clientes → su cliente → su FICHA → «Volver al
 *     chat», y sigue teniendo sus acciones de venta.
 *
 * Es la prueba de que la pestaña no solo se VE: se puede USAR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-delivery-clientes';
const APP_SECRET = 'uat-delivery-clientes-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PASS = 'Reparto-12345';
const PHONES = { reparto: '18095559200', agente: '18095559201' };
const NOMBRES = { reparto: 'Cliente Reparto', agente: 'Cliente Agente' };

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-DELIV',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.UATD${whatsapp.sent.length}` };
  },
  async sendTemplate(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.UATDT${whatsapp.sent.length}` };
  },
  async sendLocation(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.UATDL${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
/** Sesión de administración, para preparar el escenario desde Node. */
let cookieAdmin = '';
let repartidor = null;
let agente = null;
const ids = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 12000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(20);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return input;
}

async function adminJson(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: cookieAdmin, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function inbound(phone, id, body, nombre) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: nombre }, wa_id: phone }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  await sleep(150);
}

/**
 * Arranca el panel REAL en un DOM y entra con usuario y contraseña. Cada panel
 * lleva SU propia cookie: así el mismo archivo puede probar dos papeles sin que
 * uno se contamine con la sesión del otro.
 */
async function bootPanel(username, password) {
  let cookie = '';
  const panel = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = panel.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.alert = () => {};
  win.confirm = () => true;
  win.EventSource = class EventSourceFalso {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.readyState = 1;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.readyState = 2;
    }
  };
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => setCookie ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));

  dom = panel;
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');
  setValue('#login-username', username);
  setValue('#login-password', password);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  await waitFor(() => $$('[data-conv]').length >= 1, 'la lista de conversaciones', 15000);
  return { dom: panel, cookie: () => cookie };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-deliv-clientes-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    schedulerEnabled: false,
    bootstrapAdminUser: 'jefa@phyto.local',
    bootstrapAdminPassword: 'Jefa-12345',
    bootstrapAdminDisplayName: 'Jefa Admin',
  });

  const legacy = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookieAdmin = (legacy.headers.get('set-cookie') ?? '').split(';')[0];
  await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'jefa@phyto.local', password: 'Jefa-12345' }),
  });

  repartidor = (
    await adminJson('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'reparto@phyto.local', password: PASS, displayName: 'Reparto UAT', role: 'DELIVERY' }),
    })
  ).body.user;
  agente = (
    await adminJson('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'agente@phyto.local', password: PASS, displayName: 'Agente UAT', role: 'AGENT' }),
    })
  ).body.user;
  expect(repartidor?.id && agente?.id).toBeTruthy();

  // Dos clientes con conversación: uno lo reparte el repartidor, otro el agente.
  await inbound(PHONES.reparto, 'wamid.UATD-1', 'Hola, quiero mi pedido', NOMBRES.reparto);
  await inbound(PHONES.agente, 'wamid.UATD-2', 'Hola, quiero el de 30 cápsulas', NOMBRES.agente);

  const data = (await adminJson('/api/admin/data')).body;
  const porTelefono = new Map((data.customers ?? []).map((customer) => [customer.phone_e164, customer]));
  ids.clienteReparto = porTelefono.get(`+${PHONES.reparto}`)?.id;
  ids.clienteAgente = porTelefono.get(`+${PHONES.agente}`)?.id;
  expect(ids.clienteReparto && ids.clienteAgente).toBeTruthy();
  ids.convReparto = (data.conversations ?? []).find((row) => row.customer_id === ids.clienteReparto)?.id;
  ids.convAgente = (data.conversations ?? []).find((row) => row.customer_id === ids.clienteAgente)?.id;
  expect(ids.convReparto && ids.convAgente).toBeTruthy();

  const variantId = data.catalog?.[0]?.id;
  expect(variantId).toBeTruthy();

  /*
   * UN PEDIDO POR CLIENTE, asignado a quien lo va a entregar. Es lo que abre la
   * puerta: el repartidor solo ve (y solo puede abrir) lo que lleva él.
   */
  for (const [cliente, conversacion, destino, clave] of [
    [ids.clienteReparto, ids.convReparto, repartidor.id, 'orderReparto'],
    [ids.clienteAgente, ids.convAgente, agente.id, 'orderAgente'],
  ]) {
    const creado = await adminJson('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId: cliente,
        conversationId: conversacion,
        channel: 'whatsapp',
        items: [{ variantId, quantity: 1 }],
        paymentMethod: 'CASH',
      }),
    });
    expect(creado.status).toBe(201);
    const asignado = await adminJson(`/api/admin/orders/${creado.body.item.id}/delivery/assign`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: destino }),
    });
    expect(asignado.status).toBe(200);
    ids[clave] = creado.body.item.id;
  }

  // La conversación del agente, a su nombre (es su chat).
  await adminJson(`/api/admin/conversations/${ids.convAgente}/assign`, {
    method: 'POST',
    body: JSON.stringify({ userId: agente.id }),
  });
}, 90000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el REPARTIDOR (rol DELIVERY) va de Clientes al chat', () => {
  let panel;
  beforeAll(async () => {
    panel = await bootPanel('reparto@phyto.local', PASS);
  }, 60000);

  it('la sesión es la de un repartidor (rol DELIVERY)', async () => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie: panel.cookie() } })).json();
    expect(data.auth.user.role).toBe('DELIVERY');
    expect(data.auth.legacy).toBe(false);
    expect(data.auth.permissions).toContain('chats.reply');
    expect(data.auth.permissions).not.toContain('clients.read');
  });

  it('la pestaña Clientes está disponible y lista su cliente', async () => {
    expect($('[data-tab="clientes"]').hidden).toBe(false);
    click('[data-tab="clientes"]');
    await waitFor(() => !$('#view-clientes').hidden, 'la vista de Clientes');
    const fila = await waitFor(
      () => $(`[data-customer-chat="${ids.clienteReparto}"]`)?.closest('.client-row'),
      'la fila de su cliente',
    );
    expect(fila).toBeTruthy();
  });

  it('no le ofrece acciones que no puede hacer (crear pedido, registrar compra)', () => {
    expect($(`.client-row [data-order-new="${ids.clienteReparto}"]`)).toBeNull();
    expect($('#clientes-acciones').hidden).toBe(true);
  });

  it('el icono de la fila abre el chat del cliente', async () => {
    click(`[data-customer-chat="${ids.clienteReparto}"]`);
    await waitFor(() => !$('#view-whatsapp').hidden, 'la pestaña de WhatsApp');
    const nombre = await waitFor(
      () => ($('#wa-chat-name')?.textContent?.includes(NOMBRES.reparto) ? $('#wa-chat-name').textContent : null),
      'el nombre del cliente en el chat',
    );
    expect(nombre).toContain(NOMBRES.reparto);
    expect(dom.window.document.body.dataset.waView).toBe('chat');
  });

  it('tocar al cliente abre el chat (no rebota a Mis entregas ni a una ficha a medias)', async () => {
    click('[data-tab="clientes"]');
    await waitFor(() => !$('#view-clientes').hidden, 'la vista de Clientes');
    const fila = await waitFor(
      () => $(`[data-customer-chat="${ids.clienteReparto}"]`)?.closest('.client-row'),
      'la fila de su cliente',
    );
    click(fila.querySelector('.client-row__main'));
    await waitFor(() => !$('#view-whatsapp').hidden, 'la pestaña de WhatsApp');
    const nombre = await waitFor(
      () => ($('#wa-chat-name')?.textContent?.includes(NOMBRES.reparto) ? $('#wa-chat-name').textContent : null),
      'el nombre del cliente en el chat',
    );
    expect(nombre).toContain(NOMBRES.reparto);
    expect($('#view-perfil-cliente').hidden).toBe(true);
  });

  it('en el chat de reparto escribe, pero no hay menús comerciales que no le tocan', async () => {
    await waitFor(() => $('#wa-actions')?.dataset?.customer, 'las acciones del chat listas');
    /*
     * El chat abierto DESDE EL REPARTO va en modo entrega: el servidor manda
     * `deliveryContext`, y el panel apaga el botón «⋯» (crear pedido, ficha,
     * programar) para no ofrecer lo que ese papel no puede hacer. Lo que sí
     * tiene es el cuadro de texto para hablar con el cliente.
     */
    expect($('#wa-actions').hidden).toBe(true);
    expect($('#wa-text')).toBeTruthy();
  });

  it('no le lista ni le abre el cliente de otra persona', async () => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie: panel.cookie() } })).json();
    const telefonos = (data.customers ?? []).map((customer) => customer.phone_e164);
    expect(telefonos).toContain(`+${PHONES.reparto}`);
    expect(telefonos).not.toContain(`+${PHONES.agente}`);
    expect($(`[data-customer-chat="${ids.clienteAgente}"]`)).toBeNull();
  });
});

describe('el AGENTE (que también entrega) va de Clientes al chat por su ficha', () => {
  let panel;
  beforeAll(async () => {
    dom?.window?.close();
    panel = await bootPanel('agente@phyto.local', PASS);
  }, 60000);

  it('la sesión es la de un agente con permisos de cliente y de reparto', async () => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie: panel.cookie() } })).json();
    expect(data.auth.user.role).toBe('AGENT');
    expect(data.auth.permissions).toContain('clients.read');
    expect(data.auth.permissions).toContain('chats.reply');
    expect(data.auth.permissions).toContain('delivery.tracking.start');
  });

  it('tocar al cliente abre su FICHA y sus acciones comerciales siguen ahí', async () => {
    click('[data-tab="clientes"]');
    await waitFor(() => !$('#view-clientes').hidden, 'la vista de Clientes');
    expect($(`.client-row [data-order-new="${ids.clienteAgente}"]`)).toBeTruthy();
    expect($('#clientes-acciones').hidden).toBe(false);
    const fila = await waitFor(
      () => $(`[data-customer="${ids.clienteAgente}"]`)?.closest('.client-row'),
      'la fila de su cliente',
    );
    click(fila.querySelector('.client-row__main'));
    await waitFor(() => !$('#view-perfil-cliente').hidden, 'la ficha del cliente');
    expect($('#customer-profile')?.textContent).toContain(NOMBRES.agente);
  });

  it('desde la ficha vuelve al chat de ese cliente', async () => {
    await waitFor(() => $('#profile-actions'), 'las acciones de la ficha');
    click('#profile-actions');
    const volver = await waitFor(
      () => $$('[data-chat]').find((node) => node.textContent.includes('Volver al chat')),
      'el botón Volver al chat',
    );
    click(volver);
    await waitFor(() => !$('#view-whatsapp').hidden, 'la pestaña de WhatsApp');
    const nombre = await waitFor(
      () => ($('#wa-chat-name')?.textContent?.includes(NOMBRES.agente) ? $('#wa-chat-name').textContent : null),
      'el nombre del cliente en el chat',
    );
    expect(nombre).toContain(NOMBRES.agente);
    expect(dom.window.document.body.dataset.waView).toBe('chat');
  });
});
