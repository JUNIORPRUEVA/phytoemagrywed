// @vitest-environment node
/**
 * UAT DEL PANEL — QUÉ SE PUEDE HACER CON UN MENSAJE YA ENVIADO.
 *
 * La pregunta del negocio fue directa: «¿se puede eliminar o editar un mensaje
 * después de enviarlo?». La respuesta honesta es que en WhatsApp NO —la API
 * oficial no borra ni edita nada que ya salió, y el cliente lo tiene en su
 * teléfono—, así que aquí se prueba exactamente lo que el panel SÍ hace, con el
 * CRM de verdad detrás:
 *
 *   · DESHACER: el mensaje escrito a mano no sale hasta que pasa la ventana, y si
 *     se deshace no se envía NADA (el cliente no lo recibe nunca).
 *   · QUITAR DEL CRM: se aparta de la vista —deja de mostrarse y deja de ser el
 *     resumen de la conversación— y queda registrado quién lo hizo.
 *   · DEVOLVERLO al hilo, si alguien se equivocó al quitarlo.
 *   · EDITAR Y REENVIAR: el texto vuelve al compositor para corregirlo.
 *   · Y QUIÉN PUEDE: administración; un agente, solo lo que escribió él.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-mensajes-123';
const APP_SECRET = 'uat-mensajes-secret';
const PHONE = '18095559222';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.MSG${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.MSGT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let conversationId = '';
let agenteId = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(25);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
const setValue = (selector, value) => {
  const input = typeof selector === 'string' ? $(selector) : selector;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

/** Llama a la API con la sesión del panel (o con la cookie que se le pase). */
async function apiNuestro(camino, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${app.url}${camino}`, { ...init, headers });
  const texto = await response.text();
  let body = {};
  try {
    body = texto ? JSON.parse(texto) : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Los mensajes que el servidor tiene guardados en la conversación. */
async function mensajesDelServidor() {
  const { body } = await apiNuestro(`/api/admin/conversations/${encodeURIComponent(conversationId)}/messages`);
  return body.messages ?? [];
}

async function inbound(id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              // Meta SIEMPRE manda el número de destino; el servidor lo exige (fail-closed).
              metadata: { phone_number_id: 'PN-UAT', display_phone_number: '18095550000' },
              contacts: [{ profile: { name: 'Ana Mensajes UAT' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  await sleep(250);
}

/** Abre la conversación de la suite y deja listo el compositor. */
async function abrirConversacion() {
  click('[data-tab="whatsapp"]');
  const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación en la bandeja');
  conversationId = row.dataset.conv;
  click(row);
  await waitFor(() => $('#wa-text'), 'el compositor de la conversación');
  await waitFor(() => $('#wa-actions')?.disabled === false, 'la conversación cargada');
}

/** Escribe y envía un mensaje libre, sin ventana de deshacer. */
async function enviarSinVentana(texto) {
  dom.window.__PHYTO_UNDO_MS = 0;
  const enviados = mockWhatsApp.sent.length;
  setValue('#wa-text', texto);
  click('#wa-send');
  await waitFor(() => mockWhatsApp.sent.length > enviados, `el envío de «${texto}»`);
  await waitFor(() => $('#thread').textContent.includes(texto), 'la burbuja en el hilo');
}

/** Abre el menú de un mensaje igual que la pulsación larga (clic derecho). */
async function abrirMenuDelMensaje(texto) {
  const burbuja = await waitFor(
    () => $$('#thread [data-message]').find((b) => b.textContent.includes(texto)) ?? null,
    `la burbuja de «${texto}»`,
  );
  burbuja.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await waitFor(() => $('#sheet-body .menu-list'), 'el menú del mensaje');
  return burbuja.dataset.message;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-mensajes-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    adminDir: ADMIN_DIR,
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });

  // Un cliente que escribe: con eso la conversación existe y la ventana de 24 h
  // está abierta, que es cuando se puede escribir un mensaje libre.
  await inbound('wamid.MSGSUAT1', 'Hola, quiero información del frasco grande');

  // Un AGENTE para comprobar los permisos (el que no escribió no puede quitarlo).
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookieAdmin = login.headers.get('set-cookie').split(';')[0];
  const creado = await fetch(`${app.url}/api/admin/users`, {
    method: 'POST',
    headers: { cookie: cookieAdmin, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'agente.mensajes@phyto.local',
      password: 'Agente-12345',
      displayName: 'Agente Mensajes',
      role: 'AGENT',
    }),
  });
  agenteId = (await creado.json()).user?.id ?? '';

  const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only', pretendToBeVisual: false });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
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
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  setValue('#login-token', TOKEN);
  $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('mensajes ya enviados: deshacer, quitar del CRM y corregir', () => {
  it('deshacer borra DE VERDAD: el mensaje no llega a salir', async () => {
    await abrirConversacion();
    /*
     * La ventana se acorta solo para la prueba (en el panel son 5 s): es la misma
     * máquina, medida en milisegundos para no hacer esperar a la suite.
     */
    dom.window.__PHYTO_UNDO_MS = 1200;
    const enviados = mockWhatsApp.sent.length;
    setValue('#wa-text', 'Mensaje escrito con prisa');
    click('#wa-send');

    const chip = await waitFor(() => $('#thread [data-undo]'), 'el botón Deshacer en la burbuja');
    expect(chip.textContent).toContain('Deshacer');
    // Todavía NO salió: esto es lo que hace que deshacer sea un borrado de verdad.
    expect(mockWhatsApp.sent.length).toBe(enviados);
    expect($('#thread').textContent).toContain('Mensaje escrito con prisa');

    click(chip);
    await waitFor(() => !$('#thread [data-undo]'), 'la burbuja retirada');
    await waitFor(() => !$('#thread').textContent.includes('Mensaje escrito con prisa'), 'el texto fuera del hilo');
    // Ni salió, ni quedó en el CRM, y el texto vuelve al compositor para corregirlo.
    expect(mockWhatsApp.sent.length).toBe(enviados);
    expect(await mensajesDelServidor()).toHaveLength(1);
    expect($('#wa-text').value).toBe('Mensaje escrito con prisa');
  });

  it('si nadie lo deshace, el mensaje sale y queda guardado en el CRM', async () => {
    await enviarSinVentana('Mensaje que sí sale');
    const mensajes = await mensajesDelServidor();
    expect(mensajes.some((row) => row.body === 'Mensaje que sí sale' && row.direction === 'outbound')).toBe(true);
    expect(mockWhatsApp.sent.some((row) => row.body === 'Mensaje que sí sale')).toBe(true);
    // El compositor se vacía cuando sale de verdad.
    expect($('#wa-text').value).toBe('');
  });

  it('quitar del CRM: deja de verse, deja de ser el resumen y queda el rastro', async () => {
    const mensajeId = await abrirMenuDelMensaje('Mensaje que sí sale');
    // El menú dice la verdad de WhatsApp antes de ofrecer nada.
    expect($('#sheet-body').textContent).toContain('WhatsApp no deja borrar ni cambiar un mensaje ya enviado');
    dom.window.confirm = () => true;
    click('#sheet-body [data-message-remove]');

    const quitado = await waitFor(async () => {
      const fila = (await mensajesDelServidor()).find((row) => row.id === mensajeId);
      return fila?.deleted_at ? fila : null;
    }, 'el mensaje quitado en el servidor');
    expect(quitado.deleted_by_display_name_snapshot).toBeTruthy();

    // En el hilo se dice lo que pasó y NO se pinta el texto (para eso se quitó).
    // Se vuelve a buscar la burbuja DESPUÉS de pintar: el nodo de antes ya no vale.
    const burbujaMarcada = await waitFor(() => {
      const nodo = $(`#thread [data-message="${mensajeId}"]`);
      return nodo?.className.includes('bubble--removed') ? nodo : null;
    }, 'el hueco del mensaje quitado');
    expect(burbujaMarcada.textContent).toContain('Mensaje quitado del CRM');
    expect(burbujaMarcada.textContent).not.toContain('Mensaje que sí sale');

    // Y la fila de la bandeja vuelve a resumirse con lo ANTERIOR, no con lo quitado.
    await waitFor(() => !$('[data-conv]').textContent.includes('Mensaje que sí sale'), 'el resumen de la fila al día');
    expect($('[data-conv]').textContent).toContain('Hola, quiero información del frasco grande');
  });

  it('devolver al hilo: administración lo trae de vuelta', async () => {
    const mensajeId = await abrirMenuDelMensaje('Mensaje quitado del CRM');
    expect($('#sheet-body').textContent).toContain('Devolver al hilo');
    click('#sheet-body [data-message-restore]');
    const devuelto = await waitFor(async () => {
      const fila = (await mensajesDelServidor()).find((row) => row.id === mensajeId);
      return fila && !fila.deleted_at ? fila : null;
    }, 'el mensaje devuelto');
    expect(devuelto.body).toBe('Mensaje que sí sale');
    await waitFor(() => $('#thread').textContent.includes('Mensaje que sí sale'), 'el texto otra vez en el hilo');
  });

  it('editar y reenviar: el texto vuelve al compositor para corregirlo', async () => {
    await abrirMenuDelMensaje('Mensaje que sí sale');
    click('#sheet-body [data-message-resend]');
    await waitFor(() => $('#wa-text')?.value === 'Mensaje que sí sale', 'el texto en el compositor');
    // El original NO se toca: sigue en el hilo con su estado (eso no lo cambia nadie).
    expect($('#thread').textContent).toContain('Mensaje que sí sale');
    setValue('#wa-text', '');
  });

  it('quién puede: administración sí, y un agente solo lo que escribió él', async () => {
    const mensajes = await mensajesDelServidor();
    const deAdmin = mensajes.find((row) => row.body === 'Mensaje que sí sale');
    expect(deAdmin).toBeTruthy();
    expect(agenteId).toBeTruthy();

    const entrada = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'agente.mensajes@phyto.local', password: 'Agente-12345' }),
    });
    const cookieAgente = entrada.headers.get('set-cookie').split(';')[0];

    // El agente no escribió ese mensaje: no puede quitarlo.
    const ajeno = await fetch(
      `${app.url}/api/admin/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(deAdmin.id)}`,
      { method: 'DELETE', headers: { cookie: cookieAgente } },
    );
    expect(ajeno.status).toBe(403);

    // Y un mensaje con una conversación que no es la suya tampoco se toca.
    const mezclado = await apiNuestro(
      `/api/admin/conversations/cnv_inexistente/messages/${encodeURIComponent(deAdmin.id)}`,
      { method: 'DELETE' },
    );
    expect(mezclado.status).toBe(404);

    // Administración sí puede.
    const propio = await apiNuestro(
      `/api/admin/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(deAdmin.id)}`,
      { method: 'DELETE' },
    );
    expect(propio.status).toBe(200);
    expect(propio.body.message.deleted_at).toBeTruthy();
    // Y la respuesta lo dice tal cual: el cliente lo sigue teniendo en WhatsApp.
    expect(propio.body.note).toContain('El cliente lo sigue teniendo en su WhatsApp');
  });
});
