// @vitest-environment node
/**
 * UAT DEL PANEL — LA PANTALLA DE HOY.
 *
 * Panel REAL (`public/admin/index.html` + `app.js`) con un CRM de verdad detrás.
 * Comprueba las tres cosas que pidió el negocio:
 *
 *   1. HOY solo enseña lo que se hace hoy: los contadores «por enviar», «por
 *      revisar», «enviados» y «programados» ya no están.
 *   2. Cada tarjeta lleva a su lista CON EL FILTRO PUESTO, y el número de la
 *      tarjeta es exactamente lo que se ve al entrar (ni uno más, ni uno menos).
 *   3. Borrar una notificación es borrarla: no vuelve en el siguiente refresco,
 *      aunque el servidor todavía la tenga.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-hoy-123';
const APP_SECRET = 'uat-hoy-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONE_A = '18095557001';
const PHONE_B = '18095557002';

/** Un día ISO (negativo = pasado), que es como se programa un seguimiento. */
const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-HOY',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.HOY${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.HOYT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let cookieAdmin = '';
let clienteA = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
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
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

/** Un mensaje entrante de verdad (webhook firmado): crea cliente y conversación. */
async function inboundWhatsapp(id, phone, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: `Cliente ${phone.slice(-3)}` }, wa_id: phone }],
              messages: [
                { from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } },
              ],
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

/** Pide al CRM con la sesión de administración de la suite. */
async function admin(pathname, init = {}) {
  const response = await fetch(`${app.url}${pathname}`, {
    ...init,
    headers: { cookie: cookieAdmin, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return response;
}

/** Un pedido directo al CRM (es lo que deja la web y lo que usan las pruebas). */
async function crearPedido(id, createdAt, extra = {}) {
  await fetch(`${app.url}/api/crm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      type: 'order_intent',
      name: `Pedido ${id}`,
      source: 'checkout',
      status: 'nuevo',
      variantName: '5 cápsulas',
      quantity: 1,
      total: 1250,
      createdAt,
      ...extra,
    }),
  });
}

/** Las notificaciones que el servidor tiene AHORA para este panel. */
async function notificacionesEnServidor() {
  const response = await admin('/api/admin/notifications');
  const body = await response.json();
  return body.notifications ?? [];
}

async function insertarNotificacion(id, titulo, createdAt = new Date().toISOString()) {
  await app.collections.insert('user_notifications', {
    id,
    recipient_user_id: 'LEGACY_PANEL',
    type: 'WHATSAPP_MESSAGE_RECEIVED',
    title: titulo,
    body: 'Mensaje de prueba',
    entity_type: 'conversation',
    entity_id: null,
    deep_link: null,
    data: null,
    status: 'unread',
    read_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    idempotency_key: `uat-hoy:${id}`,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-hoy-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookieAdmin = login.headers.get('set-cookie').split(';')[0];

  // Dos conversaciones: las dos esperando respuesta (dos «Sin responder»), una
  // sin asignar (el reparto es a mano en este negocio).
  await inboundWhatsapp('wamid.HOY1', PHONE_A, 'Hola, quiero información de los frascos');
  await inboundWhatsapp('wamid.HOY2', PHONE_B, '¿Cuánto cuesta el de 10 cápsulas?');

  const datos = await (await admin('/api/admin/data')).json();
  clienteA = (datos.customers ?? []).find((row) => String(row.phone_e164 ?? '').includes(PHONE_A.slice(-8))) ?? null;
  expect(clienteA).toBeTruthy();

  /*
   * TRES pedidos de hoy y UNO VIEJO, los cuatro pendientes: así se demuestra que
   * la tarjeta entra con el filtro de estado Y con el de fecha en «todas» (si
   * entrara con el «hoy» que trae la lista por defecto, el viejo no saldría y el
   * número de la tarjeta no cuadraría con lo que se ve).
   */
  const ahora = new Date().toISOString();
  await crearPedido('pedido-hoy-1', ahora);
  await crearPedido('pedido-hoy-2', ahora);
  await crearPedido('pedido-hoy-3', ahora);
  await crearPedido('pedido-viejo', '2020-01-15T10:00:00.000Z');

  // Un seguimiento vencido y otro para hoy (los dos bloques de la tarjeta).
  await admin('/api/admin/followups', {
    method: 'POST',
    body: JSON.stringify({ customerId: clienteA.id, type: 'manual', reason: 'Llamar', scheduledAt: dia(-30) }),
  });
  await admin('/api/admin/followups', {
    method: 'POST',
    body: JSON.stringify({ customerId: clienteA.id, type: 'manual', reason: 'Escribir', scheduledAt: dia(0) }),
  });

  await insertarNotificacion('not-hoy-1', 'Notificación uno');
  await insertarNotificacion('not-hoy-2', 'Notificación dos');

  // El panel real, en un DOM, apuntando al CRM que acaba de arrancar.
  const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only', pretendToBeVisual: false });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.requestAnimationFrame = (callback) => win.setTimeout(callback, 0);
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
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');
  setValue('#login-token', TOKEN);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  await waitFor(() => $('#stats')?.textContent?.includes('Sin responder'), 'las tarjetas de HOY');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('HOY: tarjetas limpias', () => {
  it('quita los contadores que no se usan y deja los importantes', () => {
    const tarjetas = $('#stats').textContent;
    for (const fuera of ['Por enviar', 'Por revisar', 'Enviados', 'Programados activos', 'Programados hoy', 'Entregas activas']) {
      expect(tarjetas).not.toContain(fuera);
    }
    for (const dentro of [
      'Sin responder',
      'Sin asignar',
      'Pedidos pendientes',
      'Seguimientos vencidos',
      'Seguimientos de hoy',
      'Clientes',
      'Interesados',
      'Con compra',
    ]) {
      expect(tarjetas).toContain(dentro);
    }
  });

  it('se ve de dos en dos y sin cortar las etiquetas (móvil y escritorio)', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.stats\s*\{[^}]*gap:\s*10px;/s);
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.stat\s*\{[^}]*border-radius:\s*18px;/s);
    // La etiqueta va a ANCHO COMPLETO y con salto de línea: «Seguimientos
    // vencidos» no puede salir como «Seguimiento…».
    expect(css).toMatch(/body\[data-tab='hoy'\]\s+\.stat__label\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*white-space:\s*normal;[^}]*text-overflow:\s*clip;/s);
    expect(css).toMatch(/@media \(max-width: 375px\)[\s\S]*body\[data-tab='hoy'\]\s+\.stat\s*\{[^}]*grid-template-columns:\s*36px/s);
    expect(css).toMatch(/@media \(min-width: 980px\)[\s\S]*body\[data-tab='hoy'\]\s+\.stats\s*\{[^}]*repeat\(4,/s);
  });
});

describe('HOY: cada tarjeta lleva su filtro', () => {
  it('«Pedidos pendientes» entra en Pedidos con el estado puesto y el día de hoy', async () => {
    /*
     * Primero se deja la fecha en «Todas»: al pulsar la tarjeta tiene que VOLVER
     * al día de hoy (su lista de trabajo), no arrastrar el filtro que hubiera.
     */
    click('[data-tab="pedidos"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'pedidos', 'la pantalla de pedidos');
    click('#pedidos-fecha-chip');
    click('#sheet-body [data-order-date="all"]');
    await waitFor(() => $('#pedidos-fecha-chip').getAttribute('aria-pressed') === 'false', 'la fecha en todas');

    click('[data-tab="hoy"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'hoy', 'HOY');
    const valor = Number($('[data-goto="pedidos"] .stat__value').textContent);
    expect(valor).toBe(3); // los tres de hoy (el de 2020 es otra fecha)

    click('[data-goto="pedidos"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'pedidos', 'la pantalla de pedidos');
    // El estado se ve SIN abrir el panel de filtros: nadie tiene que adivinar por
    // qué la lista no enseña todos los pedidos.
    expect($('#pedidos-estado-chip').textContent).toContain('Pendientes');
    expect($('#pedidos-estado-chip').getAttribute('aria-pressed')).toBe('true');
    expect($('#pedidos-fecha-chip').textContent.trim()).toBe('Hoy');
    expect($('#pedidos-fecha-chip').getAttribute('aria-pressed')).toBe('true');
    const filas = await waitFor(() => {
      const encontradas = $$('#list-pedidos .order-row');
      return encontradas.length ? encontradas : null;
    }, 'los pedidos pendientes');
    // El número de la tarjeta y lo que se ve al entrar: lo mismo.
    expect(filas.length).toBe(valor);
    expect($('#list-pedidos').textContent).not.toContain('pedido-viejo');
  });

  it('«Seguimientos vencidos» deja a la vista solo ese bloque', async () => {
    click('[data-goto="seguimientos"][data-followup-filter="vencidos"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'seguimientos', 'la pantalla de seguimientos');
    expect($('#seguimientos-filtros [data-followup-filter="vencidos"]').getAttribute('aria-pressed')).toBe('true');
    const lista = $('#list-seguimientos').textContent;
    expect(lista).toContain('Vencidos');
    expect(lista).not.toContain('Para hoy');
    expect(lista).not.toContain('Próximos');
  });

  it('«Seguimientos de hoy» deja a la vista solo los de hoy', async () => {
    click('[data-goto="seguimientos"][data-followup-filter="hoy"]');
    await waitFor(() => $('#list-seguimientos').textContent.includes('Para hoy'), 'los seguimientos de hoy');
    const lista = $('#list-seguimientos').textContent;
    expect(lista).not.toContain('Vencidos');
    expect($('#seguimientos-filtros [data-followup-filter="hoy"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('«Sin responder» entra en la bandeja con el filtro de pendientes', async () => {
    const valor = Number($('[data-wa-filter="pendientes"] .stat__value').textContent);
    click('[data-wa-filter="pendientes"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'whatsapp', 'la bandeja');
    expect($('#wa-filters [data-wa-filter="pendientes"]').getAttribute('aria-pressed')).toBe('true');
    const filas = await waitFor(() => {
      const encontradas = $$('#wa-conversations [data-conv]');
      return encontradas.length ? encontradas : null;
    }, 'las conversaciones pendientes');
    expect(filas.length).toBe(valor);
  });

  it('«Interesados» entra en Clientes con ese filtro puesto', async () => {
    click('[data-goto="clientes"][data-client-filter="interesados"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'clientes', 'la pantalla de clientes');
    expect($('#chips [data-filter="interesados"]').getAttribute('aria-pressed')).toBe('true');
    expect($('#chips [data-filter="todos"]').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('HOY: las notificaciones borradas no vuelven', () => {
  it('«Eliminar todas» las borra en el panel y en el servidor', async () => {
    click('[data-tab="hoy"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'hoy', 'HOY otra vez');
    expect(await notificacionesEnServidor()).toHaveLength(2);

    click('[data-dashboard-notifications]');
    await waitFor(() => $$('#sheet-body .notice').length >= 2, 'las notificaciones en la hoja');
    click('[data-notifications-delete-all]');
    await waitFor(() => $('#sheet-body').textContent.includes('No hay notificaciones'), 'la lista vacía');
    await waitFor(async () => (await notificacionesEnServidor()).length === 0, 'el borrado sincronizado');

    const respuesta = await admin('/api/admin/notifications');
    const cuerpo = await respuesta.json();
    expect(cuerpo.notifications).toHaveLength(0);
    expect(cuerpo.unread).toBe(0);
  });

  it('aunque el servidor las tenga otra vez, no reaparecen — ni aquí ni en otro teléfono', async () => {
    /*
     * Se vuelven a poner las MISMAS dos notificaciones en la base (es lo que
     * pasaba de verdad: el servidor seguía teniéndolas) y se fuerza una
     * sincronización como la que hace el panel al volver a la aplicación.
     *
     * Y lo importante: el SERVIDOR tampoco las devuelve. El borrado se recuerda
     * allí­ (por aviso y por suceso), así­ que no reaparecen en ningún teléfono
     * —ni con los datos del navegador limpios, que es cuando volví­an—.
     */
    await insertarNotificacion('not-hoy-1', 'Notificación uno', new Date(Date.now() + 1000).toISOString());
    await insertarNotificacion('not-hoy-2', 'Notificación dos', new Date(Date.now() + 2000).toISOString());
    // Las filas EXISTEN (se han vuelto a crear)…
    expect((await app.collections.list('user_notifications')).length).toBeGreaterThanOrEqual(2);
    // …y aun así­ el panel no las ve: ni por la campana ni preguntando al servidor.
    expect(await notificacionesEnServidor()).toHaveLength(0);

    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await sleep(600);

    const campana = $('[data-dashboard-notifications]');
    expect(campana.className).not.toContain('--alert');
    expect(campana.querySelector('.dashboard-head__badge')).toBeNull();
    click(campana);
    await waitFor(() => $('#sheet-body').textContent.includes('No hay notificaciones'), 'sigue vacía');
    expect($$('#sheet-body .notice')).toHaveLength(0);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('borrar UNA la quita del panel y del servidor', async () => {
    await insertarNotificacion('not-hoy-3', 'Notificación tres', new Date(Date.now() + 3000).toISOString());
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await sleep(600);
    // La hoja se repinta al abrirla (la sincronización NO recarga la pantalla).
    click('[data-dashboard-notifications]');
    await waitFor(() => $$('#sheet-body .notice').length === 1, 'la notificación visible');
    click('#sheet-body [data-notification-delete="not-hoy-3"]');
    await waitFor(() => $('#sheet-body').textContent.includes('No hay notificaciones'), 'la hoja vacía');
    /*
     * El servidor también la pierde DE VERDAD: la fila desaparece de la base (no
     * basta con que el filtro de borrados la esconda). Las otras dos siguen en la
     * base a propósito: son el caso de «el servidor todavía la tiene» y no deben
     * volver a pintarse aquí­.
     */
    await waitFor(
      async () => !(await app.collections.list('user_notifications')).some((row) => row.id === 'not-hoy-3'),
      'el borrado real en el servidor',
      4000,
    );
  });
});


describe('HOY: navegación independiente y finalizar chats', () => {
  it('Sin responder vuelve a la lista aunque antes hubiera una conversación abierta', async () => {
    click('[data-tab="hoy"]');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => $$('#wa-conversations [data-conv]').length === 2, 'los dos pendientes');
    click($('#wa-conversations [data-conv]'));
    await waitFor(() => $('#wa-text'), 'el chat abierto');
    expect(dom.window.document.body.dataset.waView).toBe('chat');
    click('[data-tab="hoy"]');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    expect(dom.window.document.body.dataset.waView).toBe('list');
    expect($('#wa-chat-pane').hidden).toBe(true);
    await waitFor(() => $$('#wa-conversations [data-conv]').length === 2, 'la lista filtrada');
  });

  it('las tarjetas limpian búsquedas anteriores de Pedidos y Clientes', async () => {
    click('[data-tab="pedidos"]');
    click('[data-order-search-open]');
    setValue('#order-appbar-search', 'no-existe-este-pedido');
    expect($$('#list-pedidos .order-row')).toHaveLength(0);
    click('[data-tab="hoy"]');
    click('[data-goto="pedidos"]');
    await waitFor(() => $$('#list-pedidos .order-row').length === 3, 'los pedidos sin búsqueda antigua');
    click('[data-tab="clientes"]');
    setValue('#search', 'no-existe-este-cliente');
    expect($$('#list-clientes .client-row')).toHaveLength(0);
    click('[data-tab="hoy"]');
    click('[data-goto="clientes"][data-client-filter="todos"]');
    expect($('#search').value).toBe('');
    expect($('#chips [data-filter="todos"]').getAttribute('aria-pressed')).toBe('true');
    expect($$('#list-clientes .client-row').length).toBeGreaterThan(0);
  });

  it('los segmentos Clientes, Interesados y Con compra muestran las cantidades de sus tarjetas', async () => {
    for (const filter of ['todos', 'interesados', 'clientes']) {
      click('[data-tab="hoy"]');
      const card = $('[data-goto="clientes"][data-client-filter="' + filter + '"]');
      const expected = Number(card.querySelector('.stat__value').textContent);
      click(card);
      expect($$('#list-clientes .client-row')).toHaveLength(expected);
      expect($('#chips [data-filter="' + filter + '"]').getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('Sin responder limpia una búsqueda de chats anterior', async () => {
    click('[data-tab="whatsapp"]');
    click('[data-wa-search-open]');
    setValue('#wa-appbar-search', 'ningun-chat-coincide');
    await waitFor(() => !$('#wa-conversations [data-conv]'), 'la búsqueda vacía');
    click('[data-tab="hoy"]');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    expect(dom.window.document.body.dataset.waView).toBe('list');
    await waitFor(() => $$('#wa-conversations [data-conv]').length === 2, 'los pendientes sin búsqueda');
    expect($('#wa-search').value).toBe('');
  });

  it('finalizar desde las acciones del chat actualiza Sin responder y mantiene el compositor', async () => {
    click('[data-tab="hoy"]');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => $('#wa-conversations [data-conv]'), 'un chat pendiente');
    const id = $('#wa-conversations [data-conv]').dataset.conv;
    click($('#wa-conversations [data-conv]'));
    await waitFor(() => $('#wa-text') && !$('#wa-actions').disabled, 'el compositor');
    const before = mockWhatsApp.sent.length;
    click('#wa-actions');
    const action = $('#sheet-body [data-conversation-resolution]');
    expect(action.textContent).toContain('Marcar como finalizado');
    click(action);
    await waitFor(async () => {
      const rows = await (await admin('/api/admin/conversations?filter=pendientes')).json();
      return rows.counts.pendientes === 1;
    }, 'el pendiente finalizado en el servidor');
    await waitFor(() => $('#sheet').hidden && $('#wa-text'), 'el chat sigue abierto');
    expect(mockWhatsApp.sent.length).toBe(before);
    expect($('#wa-text').disabled).toBe(false);
    click('[data-tab="hoy"]');
    await waitFor(() => Number($('[data-goto="whatsapp"][data-wa-filter="pendientes"] .stat__value').textContent) === 1, 'el contador actualizado');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => $$('#wa-conversations [data-conv]').length === 1, 'solo queda el pendiente real');
    expect($('#wa-conversations [data-conv]').dataset.conv).not.toBe(id);
    click('[data-tab="hoy"]');
    click('[data-goto="whatsapp"][data-wa-filter="sin-asignar"]');
    await waitFor(() => $$('#wa-conversations [data-conv]').length === 1, 'sin asignar ya no incluye el finalizado');
    /*
     * Finalizar ARCHIVA: el chat sale de la bandeja y se encuentra en «Archivados»,
     * desde donde se puede reabrir (que además lo desarchiva).
     */
    click('[data-wa-filter="archivados"]');
    await waitFor(() => $(`#wa-conversations [data-conv="${id}"]`), 'el chat finalizado está en Archivados');
    click($$(`#wa-conversations [data-conv-more]`).find((button) => button.dataset.convMore === id));
    expect($('#sheet-body [data-conversation-resolution]').textContent).toContain('Reabrir conversación');
    click($('#sheet-body [data-conversation-resolution]'));
    await waitFor(async () => (await (await admin('/api/admin/conversations?filter=pendientes')).json()).counts.pendientes === 2, 'reabrir recupera el pendiente');
  });
});
