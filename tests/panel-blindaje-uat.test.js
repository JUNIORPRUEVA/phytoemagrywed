// @vitest-environment jsdom
/**
 * UAT DEL PANEL — BLINDAJE visto por el AGENTE (no por el administrador).
 *
 * Aquí se entra al panel con un usuario AGENTE de verdad (usuario y contraseña,
 * contra el servidor de verdad) y se comprueba, en la pantalla, lo que pidió el
 * negocio:
 *   - la LISTA la ve entera (nombre y último mensaje), como en WhatsApp;
 *   - abrir una conversación que NO lleva muestra el motivo y el botón para
 *     PEDIRLA, sin hilo, sin compositor y sin acciones;
 *   - no hay forma de enviar: no existe el cuadro de texto ni el botón, y no
 *     sale ninguna petición de envío;
 *   - el menú «⋯» ofrece PEDIRLA (no «Tomar» ni «Asignármela a mí», que son de
 *     administración);
 *   - pedirla avisa a administración y NO la asigna;
 *   - en cuanto administración la asigna, el agente la abre y escribe normal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-blindaje-panel';
const APP_SECRET = 'uat-blindaje-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PASS = 'Agente-12345';
const PHONES = { mia: '18095559001', ajena: '18095559002' };
const NOMBRES = { [PHONES.mia]: 'Mía Blindaje', [PHONES.ajena]: 'Ajena Blindaje' };

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-BLIND',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.UATB${whatsapp.sent.length}` };
  },
  async sendTemplate(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.UATBT${whatsapp.sent.length}` };
  },
  async sendLocation(to) {
    whatsapp.sent.push({ to });
    return { ok: true, status: 200, messageId: `wamid.UATBL${whatsapp.sent.length}` };
  },
  async sendInteractive() {
    return { ok: false, skipped: true };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
/** La sesión del navegador simulado (empieza vacía: hay que entrar). */
let cookie = '';
/** La sesión legacy de administración, para preparar el escenario desde Node. */
let cookieAdmin = '';
let maria = null;
let pedro = null;
const ids = {};
/** Todas las llamadas que salen del panel, con su estado: la prueba de lo que NO pasó. */
const llamadas = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 8000) {
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
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return input;
}

/** Como administración (clave del panel), desde Node: prepara el escenario. */
async function adminJson(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: cookieAdmin, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function inbound(phone, id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: NOMBRES[phone] }, wa_id: phone }],
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
}

const llamadasA = (filtro) => llamadas.filter(filtro);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-blindaje-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    schedulerEnabled: false,
    // Una administradora de verdad: es quien recibe los avisos de las peticiones.
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
  // La administradora entra por la puerta normal (queda como única ADMIN activa).
  const jefa = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'jefa@phyto.local', password: 'Jefa-12345' }),
  });
  expect(jefa.status).toBe(200);

  // Dos agentes de verdad y tres conversaciones: una de cada uno y una sin asignar.
  maria = (await adminJson('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'maria@phyto.local', password: PASS, displayName: 'María', role: 'AGENT' }),
  })).body.user;
  pedro = (await adminJson('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'pedro@phyto.local', password: PASS, displayName: 'Pedro', role: 'AGENT' }),
  })).body.user;
  expect(maria?.id && pedro?.id).toBeTruthy();

  await inbound(PHONES.mia, 'wamid.UATB-1', 'Hola, quiero mi pedido');
  await inbound(PHONES.ajena, 'wamid.UATB-2', 'Hola, quiero el de 30 cápsulas');

  const data = (await adminJson('/api/admin/data')).body;
  const clientePorId = new Map((data.customers ?? []).map((customer) => [customer.id, customer]));
  for (const conversation of data.conversations ?? []) {
    const customer = clientePorId.get(conversation.customer_id) ?? {};
    if (customer.phone_e164 === `+${PHONES.mia}`) ids.mia = conversation.id;
    if (customer.phone_e164 === `+${PHONES.ajena}`) ids.ajena = conversation.id;
  }
  expect(ids.mia && ids.ajena).toBeTruthy();

  await adminJson(`/api/admin/conversations/${ids.mia}/assign`, { method: 'POST', body: JSON.stringify({ userId: maria.id }) });
  await adminJson(`/api/admin/conversations/${ids.ajena}/assign`, { method: 'POST', body: JSON.stringify({ userId: pedro.id }) });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/?v=whatsapp`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.alert = () => {};
  win.confirm = () => true;
  /*
   * DOBLE DE `EventSource`: jsdom no lo trae y el panel abre con él el canal en
   * vivo. Se guardan las conexiones por si hiciera falta simular un aviso.
   */
  win.__eventSources = [];
  win.EventSource = class EventSourceFalso {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.closed = false;
      this.readyState = 1;
      win.__eventSources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    emit(type, payload = {}) {
      this.listeners.get(type)?.({ data: JSON.stringify(payload) });
    }
  };
  /*
   * El navegador simulado NO guarda cookies: la sesión se lleva aquí. Al entrar
   * con usuario y contraseña, el `set-cookie` del servidor pasa a ser la sesión
   * del panel (y por eso el agente es el agente de verdad).
   */
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    llamadas.push({
      url,
      ruta: new URL(url).pathname,
      method: (init.method ?? 'GET').toUpperCase(),
      status: response.status,
      body: init.body ?? null,
    });
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
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  // Entrar como AGENTE (usuario y contraseña), no como administración.
  setValue('#login-username', 'maria@phyto.local');
  setValue('#login-password', PASS);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  await waitFor(() => $$('[data-conv]').length >= 2, 'la lista con las conversaciones', 10000);
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el agente entra de verdad (sesión de usuario, no la clave del panel)', () => {
  it('la sesión del panel es la de María, con permisos de agente', async () => {
    const sesion = llamadasA((row) => row.ruta === '/api/admin/login' && row.method === 'POST').at(-1);
    expect(sesion.status).toBe(200);
    /*
     * La MISMA cookie que usa el panel (la que quedó tras entrar por el
     * formulario) contra el servidor de verdad: es una sesión de AGENTE.
     */
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    expect(data.auth.user.role).toBe('AGENT');
    expect(data.auth.user.display_name).toBe('María');
    expect(data.auth.legacy).toBe(false);
    expect(data.auth.permissions).not.toContain('chats.take_unassigned');
    expect(data.auth.permissions).not.toContain('users.manage');
  });

  it('la LISTA se ve entera: la suya y la de otro', () => {
    expect($(`[data-conv="${ids.mia}"]`)).toBeTruthy();
    expect($(`[data-conv="${ids.ajena}"]`)).toBeTruthy();
  });
});

describe('blindaje en el panel', () => {
  it('abrir una conversación ajena NO muestra el hilo: motivo + botón para pedirla', async () => {
    click(`[data-conv="${ids.ajena}"]`);
    const bloqueo = await waitFor(() => $('.wa-locked'), 'el bloqueo del chat');
    expect(bloqueo.textContent).toContain('no está a tu nombre');
    expect(bloqueo.textContent).toContain('Pide que te la asignen');
    expect($('#wa-chat-name').textContent).toBe(NOMBRES[PHONES.ajena]);
    expect($('#wa-chat-meta').textContent).toContain('Al frente de Pedro');
    expect($('#wa-ask-assign')).toBeTruthy();

    // El hilo del cliente NO se ha pintado (el servidor tampoco lo manda).
    expect($('#thread').textContent).not.toContain('30 cápsulas');
    const hilo = llamadasA((row) => row.ruta === `/api/admin/conversations/${ids.ajena}/messages` && row.method === 'GET').at(-1);
    expect(hilo.status).toBe(403);

    // Y las acciones de la conversación quedan apagadas.
    expect($('#wa-actions').disabled).toBe(true);
  });

  it('no hay forma de enviar: ni cuadro de texto, ni botón, ni petición', async () => {
    expect($('#wa-text')).toBeNull();
    expect($('#wa-send')).toBeNull();
    expect($('#wa-composer').innerHTML.trim()).toBe('');
    expect(whatsapp.sent).toHaveLength(0);
    expect(llamadasA((row) => row.method === 'POST' && row.ruta.endsWith('/messages'))).toHaveLength(0);
  });

  it('el «⋯» ofrece PEDIRLA (y no asignársela sola)', async () => {
    click(`[data-conv-more="${ids.ajena}"]`);
    await waitFor(() => $('#sheet').hidden === false, 'la hoja del menú');
    const pedir = $('[data-conv-ask-assign]');
    expect(pedir).toBeTruthy();
    expect(pedir.textContent).toContain('Solicitar que me la asignen');
    expect($('[data-conv-take]')).toBeNull();
    expect($('[data-conv-reassign]')).toBeNull();
    expect($('#sheet').textContent).toContain('Asignada a otra persona');
    click('[data-close-sheet]');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');
  });

  it('pedirla avisa a administración y NO le asigna nada', async () => {
    click(`[data-conv-more="${ids.ajena}"]`);
    await waitFor(() => $('#sheet').hidden === false, 'la hoja del menú');
    click('[data-conv-ask-assign]');
    const peticion = await waitFor(
      () => llamadasA((row) => row.ruta === `/api/admin/conversations/${ids.ajena}/assignment-request`).at(-1),
      'la petición de asignación',
    );
    expect(peticion.method).toBe('POST');
    expect(peticion.status).toBe(202);

    // El aviso existe para administración…
    const avisos = (await app.collections.list('user_notifications', { limit: 300 }))
      .filter((row) => row.type === 'CONVERSATION_ASSIGNMENT_REQUESTED' && row.entity_id === ids.ajena);
    expect(avisos.length).toBeGreaterThanOrEqual(1);
    expect(avisos[0].data.requested_by_user_id).toBe(maria.id);
    expect(avisos[0].recipient_user_id).not.toBe(maria.id);

    // …y la conversación sigue siendo de Pedro (pedir no es asignarse).
    const filas = (await adminJson('/api/admin/conversations')).body.conversations;
    expect(filas.find((row) => row.id === ids.ajena).assigned_user_id).toBe(pedro.id);
  });

  it('cuando administración la asigna, el agente la abre y escribe', async () => {
    const asignada = await adminJson(`/api/admin/conversations/${ids.ajena}/assign`, {
      method: 'POST',
      body: JSON.stringify({ userId: maria.id }),
    });
    expect(asignada.status).toBe(200);

    // Se vuelve a abrir la conversación: ya es suya.
    click(`[data-conv="${ids.mia}"]`);
    await waitFor(() => $('#wa-text'), 'el compositor de la conversación propia');
    click(`[data-conv="${ids.ajena}"]`);
    await waitFor(() => $('#wa-text') && $('.wa-locked') === null, 'el hilo de la conversación asignada');
    expect($('#thread').textContent).toContain('30 cápsulas');

    setValue('#wa-text', 'Ya me la asignaron, aquí estoy');
    click('#wa-send');
    await waitFor(() => whatsapp.sent.length > 0, 'el mensaje enviado a WhatsApp');
    expect(whatsapp.sent.at(-1)).toMatchObject({ to: `+${PHONES.ajena}` });
    expect(whatsapp.sent.at(-1).body).toContain('Ya me la asignaron');
  });
});
