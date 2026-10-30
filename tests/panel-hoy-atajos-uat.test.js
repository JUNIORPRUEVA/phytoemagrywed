// @vitest-environment node
/**
 * UAT DEL PANEL — ATAJOS DE «HOY»: CERO NO NAVEGA Y LA VUELTA ES EXACTA.
 *
 * Lo que se demuestra aquí, con el panel REAL (`public/admin`) y el CRM de
 * verdad detrás:
 *
 *   1. Un indicador en CERO no viaja a una lista vacía: se queda apagado, con
 *      su número real y una línea corta («Sin mensajes pendientes»), y no toca
 *      ningún filtro del destino.
 *   2. Un indicador con algo dentro sí entra en su pantalla CON el filtro puesto
 *      (lo de siempre, sin romperlo).
 *   3. Ese filtro es TEMPORAL: al volver a la pantalla, la persona recupera sus
 *      filtros, su etapa, sus fechas, su búsqueda, su conversación y su borrador.
 *   4. El filtro del atajo NO se guarda como preferencia (era el defecto: la
 *      bandeja se quedaba pegada en «Pendientes» para siempre).
 *   5. Si la persona toca algo dentro del viaje, manda su elección.
 *   6. Al volver se ven los datos de AHORA, no los de entonces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-hoy-atajos';
const APP_SECRET = 'uat-hoy-atajos-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONE_A = '18095559001'; // pregunta precio → INTERESADO
const PHONE_B = '18095559002'; // saluda sin más → PROSPECTO

/** Un día ISO (negativo = pasado), como se programa un seguimiento. */
const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-ATAJOS',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.ATAJOS${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.ATAJOST${mockWhatsApp.sent.length}` };
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
let conversacionA = null;
let conversacionB = null;
let clienteA = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 8000) {
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
const espiar = (tab) => dom.window.document.body.dataset.tab === tab;

async function admin(pathname, init = {}) {
  const response = await fetch(`${app.url}${pathname}`, {
    ...init,
    headers: { cookie: cookieAdmin, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return response;
}

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
              // Meta SIEMPRE manda el número de destino; el servidor lo exige (fail-closed).
              metadata: { phone_number_id: 'PN-UAT-ATAJOS', display_phone_number: '18095550000' },
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

async function crearPedido(id, createdAt) {
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
    }),
  });
}

/** Las tarjetas, tal y como las ve la persona. */
const tarjetas = () =>
  $$('#stats .stat').map((node) => ({
    label: node.querySelector('.stat__label')?.textContent?.trim() ?? '',
    value: Number(node.querySelector('.stat__value')?.textContent ?? '0'),
    empty: node.querySelector('.stat__hint')?.textContent?.trim() ?? '',
    disabled: node.disabled === true,
    goto: node.dataset.goto ?? '',
    wa: node.dataset.waFilter ?? '',
    order: node.dataset.orderFilter ?? '',
    followup: node.dataset.followupFilter ?? '',
    cliente: node.dataset.clientFilter ?? '',
    node,
  }));
const tarjeta = (label) => tarjetas().find((card) => card.label === label) ?? null;

/** Lo que hay puesto en la bandeja, leído de la propia pantalla. */
const waFiltroActivo = () => {
  const archivados = $('#wa-filters [data-wa-archived]');
  if (archivados?.getAttribute('aria-checked') === 'true') return 'archivados';
  return $$('#wa-filters [data-wa-filter]').find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.waFilter ?? null;
};
const waEtapaActiva = () =>
  $$('#wa-filters [data-wa-stage]').find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.waStage ?? '';
const waFilas = () => $$('#wa-conversations [data-conv]').length;

/** Las preferencias guardadas (lo que NO debe llevar el filtro del atajo). */
const preferencias = () => JSON.parse(dom.window.localStorage.getItem('pe_prefs') ?? '{}');

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-hoy-atajos-'));
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

describe('HOY: un indicador en cero no es un atajo', () => {
  it('con la casa vacía, las ocho tarjetas están en cero, apagadas y con su mensaje', () => {
    const cards = tarjetas();
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      expect(card.value, card.label).toBe(0);
      expect(card.disabled, `${card.label} debe estar apagada`).toBe(true);
      expect(card.node.getAttribute('aria-disabled'), card.label).toBe('true');
      expect(card.node.className).toContain('stat--empty');
      expect(card.empty.length, `${card.label} sin mensaje de vacío`).toBeGreaterThan(3);
      // Nada de rojos ni ámbar: un cero no es una alerta.
      expect(card.node.className, card.label).not.toContain('stat--alert');
    }
    expect(tarjeta('Sin responder').empty).toBe('Sin mensajes pendientes');
    expect(tarjeta('Pedidos pendientes').empty).toBe('Sin pedidos pendientes');
    expect(tarjeta('Seguimientos de hoy').empty).toBe('Nada agendado para hoy');
  });

  it('pulsar una tarjeta en cero no cambia de pantalla ni toca filtros', () => {
    const antes = { ...preferencias() };
    for (const card of tarjetas()) click(card.node);
    expect(espiar('hoy')).toBe(true);
    expect(preferencias()).toEqual(antes);
  });

  it('el número de la tarjeta se actualiza y la tarjeta vuelve a viajar cuando hay trabajo', async () => {
    // Dos conversaciones: una pregunta precio (interesado), otra solo saluda.
    await inboundWhatsapp('wamid.ATAJOS1', PHONE_A, '¿Cuánto cuesta el frasco de 10 cápsulas?');
    await inboundWhatsapp('wamid.ATAJOS2', PHONE_B, 'Hola, buenos días');
    // Un pedido de hoy (pendiente) y uno viejo (no entra en el día de trabajo).
    await crearPedido('pedido-atajos-hoy', new Date().toISOString());
    await crearPedido('pedido-atajos-viejo', '2020-01-15T10:00:00.000Z');
    // Un seguimiento vencido y otro para hoy.
    const datos = await (await admin('/api/admin/data')).json();
    const clientes = datos.customers ?? [];
    clienteA = clientes.find((row) => String(row.phone_e164 ?? '').includes(PHONE_A.slice(-8))) ?? null;
    const conv = datos.conversations ?? [];
    conversacionA = conv.find((row) => row.customer_id === clienteA?.id) ?? null;
    conversacionB = conv.find((row) => row.customer_id !== clienteA?.id) ?? null;
    expect(clienteA).toBeTruthy();
    expect(conversacionA).toBeTruthy();

    await admin('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: clienteA.id, type: 'manual', reason: 'Llamar', scheduledAt: dia(-30) }),
    });
    await admin('/api/admin/followups', {
      method: 'POST',
      body: JSON.stringify({ customerId: clienteA.id, type: 'manual', reason: 'Escribir', scheduledAt: dia(0) }),
    });

    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await waitFor(() => tarjeta('Sin responder')?.value === 2, 'las tarjetas con datos');

    const sinResponder = tarjeta('Sin responder');
    expect(sinResponder.disabled).toBe(false);
    expect(sinResponder.empty).toBe('');
    expect(sinResponder.node.className).not.toContain('stat--empty');
    expect(tarjeta('Pedidos pendientes').value).toBe(1);
    expect(tarjeta('Seguimientos vencidos').value).toBe(1);
    expect(tarjeta('Clientes').value).toBe(2);
    expect(tarjeta('Interesados').value).toBe(1);
    // La única que sigue en cero es la que no tiene nada: con compra.
    expect(tarjeta('Con compra').value).toBe(0);
    expect(tarjeta('Con compra').disabled).toBe(true);
    expect(tarjeta('Con compra').empty).toBe('Sin clientes con compra');
  }, 20000);
});

describe('HOY: el atajo es temporal y la vuelta es exacta', () => {
  it('entra con el filtro del atajo y al volver devuelve el filtro de la persona', async () => {
    // La persona deja la bandeja en «Sin asignar» (su preferencia).
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja');
    await waitFor(() => waFilas() > 0, 'las conversaciones');
    click('#wa-filters [data-wa-filter="sin-asignar"]');
    await waitFor(() => waFiltroActivo() === 'sin-asignar', 'el filtro elegido');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    expect(waFiltroActivo()).toBe('pendientes');
    await waitFor(() => waFilas() === 2, 'los dos pendientes');

    // Sale y vuelve por donde quiera: el panel recupera SU filtro.
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY otra vez');
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja de vuelta');
    await waitFor(() => waFiltroActivo() === 'sin-asignar', 'el filtro de la persona');
    expect(waFiltroActivo()).not.toBe('pendientes');
  }, 20000);

  it('al volver también vuelve la etapa comercial', async () => {
    click('#wa-filters [data-wa-filter="todos"]');
    click('#wa-filters [data-wa-stage="interesados"]');
    await waitFor(() => waEtapaActiva() === 'interesados', 'la etapa interesados');
    await waitFor(() => waFilas() === 1, 'solo el interesado');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    // El atajo limpia la etapa para que el número cuadre con lo que se ve.
    expect(waEtapaActiva()).toBe('');
    await waitFor(() => waFilas() === 2, 'los dos pendientes sin etapa');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => waEtapaActiva() === 'interesados', 'la etapa de vuelta');
    await waitFor(() => waFilas() === 1, 'solo el interesado, otra vez');
    // Se deja como estaba para las pruebas siguientes.
    click('#wa-filters [data-wa-stage="interesados"]');
    await waitFor(() => waEtapaActiva() === '', 'sin etapa');
  }, 20000);

  it('al volver vuelve el rango de fechas de Pedidos', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => espiar('pedidos'), 'pedidos');
    click('#pedidos-fecha-chip');
    click('#sheet-body [data-order-date="all"]');
    await waitFor(() => $('#pedidos-fecha-chip').getAttribute('aria-pressed') === 'false', 'la fecha en todas');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="pedidos"][data-order-filter="pendiente"]');
    await waitFor(() => espiar('pedidos'), 'pedidos por el atajo');
    // El atajo entra en el día de HOY, que es la lista de trabajo.
    expect($('#pedidos-fecha-chip').textContent.trim()).toBe('Hoy');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="pedidos"]');
    await waitFor(() => espiar('pedidos'), 'pedidos de vuelta');
    expect($('#pedidos-fecha-chip').getAttribute('aria-pressed')).toBe('false');
  }, 20000);

  it('al volver vuelve la búsqueda de Clientes', async () => {
    click('[data-tab="clientes"]');
    await waitFor(() => espiar('clientes'), 'clientes');
    // El texto entra por el buscador de la lista; la barra de búsqueda lo refleja.
    setValue('#search', 'Cliente 001');
    click('[data-client-search-open]');
    await waitFor(() => $('#client-appbar-search')?.value === 'Cliente 001', 'la búsqueda escrita');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="clientes"][data-client-filter="todos"]');
    await waitFor(() => espiar('clientes'), 'clientes por el atajo');
    expect($('#client-appbar-search')).toBeNull();

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="clientes"]');
    await waitFor(() => $('#client-appbar-search')?.value === 'Cliente 001', 'la búsqueda de vuelta');
    click('[data-client-search-close]');
  }, 20000);

  it('al volver se reabre la conversación CON el texto que se estaba escribiendo', async () => {
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja');
    await waitFor(() => waFilas() > 0, 'las conversaciones');
    click('#wa-filters [data-wa-filter="todos"]');
    await waitFor(() => waFilas() === 2, 'las dos conversaciones');
    click($(`#wa-conversations [data-conv="${conversacionA.id}"]`));
    await waitFor(() => $('#wa-text'), 'el compositor');
    setValue('#wa-text', 'Te paso el precio en un momento');
    await waitFor(() => $('#wa-text').value === 'Te paso el precio en un momento', 'el texto escrito');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    expect(dom.window.document.body.dataset.waView).toBe('list');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => dom.window.document.body.dataset.waView === 'chat', 'el chat de vuelta');
    await waitFor(() => $('#wa-text')?.value === 'Te paso el precio en un momento', 'el borrador intacto');
    // Se deja el compositor limpio para no arrastrar texto a otras pruebas.
    setValue('#wa-text', '');
  }, 25000);

  it('si la persona toca un filtro dentro del viaje, manda su elección', async () => {
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    // Dentro del viaje la persona cambia de filtro: eso ya es suyo.
    click('#wa-filters [data-wa-filter="todos"]');
    await waitFor(() => waFiltroActivo() === 'todos', 'el filtro elegido dentro del viaje');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja de vuelta');
    // No se le pisa lo que eligió.
    expect(waFiltroActivo()).toBe('todos');
    await waitFor(() => waFilas() === 2, 'las dos conversaciones');
  }, 20000);

  it('dos atajos seguidos no corrompen la instantánea de la persona', async () => {
    click('#wa-filters [data-wa-filter="sin-asignar"]');
    await waitFor(() => waFiltroActivo() === 'sin-asignar', 'sin asignar');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'primer atajo');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="sin-asignar"]');
    await waitFor(() => espiar('whatsapp'), 'segundo atajo');
    expect(waFiltroActivo()).toBe('sin-asignar');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'de vuelta');
    // La instantánea sigue siendo la de la PERSONA (sin asignar), no la del
    // primer atajo (pendientes).
    expect(waFiltroActivo()).toBe('sin-asignar');
  }, 25000);

  it('el filtro del atajo no se guarda como preferencia', async () => {
    click('#wa-filters [data-wa-filter="todos"]');
    await waitFor(() => waFiltroActivo() === 'todos', 'todos');
    await waitFor(() => preferencias().waFilter === 'todos', 'la preferencia guardada');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    // Lo guardado sigue siendo «todos»: el atajo no secuestra la preferencia.
    expect(preferencias().waFilter).toBe('todos');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => waFiltroActivo() === 'todos', 'la preferencia de vuelta');
    expect(preferencias().waFilter).toBe('todos');
  }, 20000);

  it('el atajo de Pedidos tampoco escribe sus filtros en las preferencias', async () => {
    const antes = { ...preferencias() };
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="pedidos"][data-order-filter="pendiente"]');
    await waitFor(() => espiar('pedidos'), 'pedidos por el atajo');
    expect(preferencias().pedidosFilter).toBe(antes.pedidosFilter);
    expect(preferencias().pedidosDate?.mode).toBe(antes.pedidosDate?.mode);
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
  }, 20000);

  it('al volver vuelve también el ámbito de Archivados', async () => {
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja');
    click('#wa-filters [data-wa-archived]');
    await waitFor(() => waFiltroActivo() === 'archivados', 'el ámbito de archivados');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    expect(waFiltroActivo()).toBe('pendientes');

    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-tab="whatsapp"]');
    await waitFor(() => waFiltroActivo() === 'archivados', 'el ámbito de archivados de vuelta');
    // Se deja la bandeja como estaba para no arrastrar el ámbito a otras pruebas.
    click('#wa-filters [data-wa-filter="todos"]');
    await waitFor(() => waFiltroActivo() === 'todos', 'todos');
  }, 20000);

  it('al volver se ven los datos de AHORA, no los de entonces', async () => {
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    click('[data-goto="whatsapp"][data-wa-filter="pendientes"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja por el atajo');
    await waitFor(() => waFilas() === 2, 'los dos pendientes');
    click('[data-tab="hoy"]');
    await waitFor(() => espiar('hoy'), 'HOY');
    // Mientras la persona está fuera entra un cliente nuevo.
    await inboundWhatsapp('wamid.ATAJOS3', '18095559003', '¿Tienen disponibilidad del de 30?');
    click('[data-tab="whatsapp"]');
    await waitFor(() => espiar('whatsapp'), 'la bandeja de vuelta');
    await waitFor(() => waFilas() === 3, 'el cliente nuevo aparece');
  }, 25000);
});
