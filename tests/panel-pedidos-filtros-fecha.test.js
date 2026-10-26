/**
 * PEDIDOS — el número del filtro y la fecha de entrega.
 *
 * Dos fallos reales que esta prueba deja cerrados:
 *
 *  1. El chip «Entregados» decía 11 y la lista solo enseñaba 6. Contaba sobre
 *     TODOS los pedidos (todas las fechas) mientras la lista aplicaba también el
 *     rango de fechas: dos cifras para lo mismo. Ahora cada chip cuenta lo que
 *     se va a ver al pulsarlo.
 *
 *  2. La fila de un pedido entregado ponía «ayer» o «hace 2 días» (la fecha en
 *     que ENTRÓ, en relativo). Ahora pone el día en que se finalizó, exacto y en
 *     la zona del negocio (República Dominicana).
 *
 * La prueba levanta el CRM de verdad y pinta el panel real en un DOM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-pedidos-filtros';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(25);
  }
}

let tmpDir;
let app;
let dom;
let cookie = '';

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];
const click = (selector) => {
  const target = typeof selector === 'string' ? $(selector) : selector;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${selector}`);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};
const filas = () => $$('#list-pedidos .order-row');
const chip = (filter) => $(`#pedidos-filtros [data-order-filter="${filter}"]`).textContent;
/** El número que enseña un chip («Entregados 2» → 2), o 0 si no lleva número. */
const numeroDelChip = (filter) => Number((chip(filter).match(/(\d+)\s*$/) ?? [])[1] ?? 0);

/** Un pedido directo al CRM, con la fecha de entrada que se quiera. */
async function crearPedido(id, createdAt) {
  const response = await fetch(`${app.url}/api/crm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      type: 'order_intent',
      name: `Cliente ${id}`,
      source: 'checkout',
      status: 'nuevo',
      variantName: '5 cápsulas',
      quantity: 1,
      total: 1250,
      createdAt,
    }),
  });
  expect(response.ok).toBe(true);
}

/** Finalizar (entregado) desde la ruta real del panel. */
async function finalizar(id) {
  const response = await fetch(`${app.url}/api/admin/orders/${id}/finish`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'Entrega de prueba' }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()).item;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-pedidos-filtros-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];

  /*
   * TRES PEDIDOS: dos de hoy (uno entregado y uno pendiente) y uno de hace diez
   * días, también entregado. Con la lista abierta en HOY por defecto, el de hace
   * diez días NO se ve: es justo la situación del fallo (el chip contaba 2
   * entregados y solo había 1 fila).
   */
  await crearPedido('hoy-entregado', new Date().toISOString());
  await crearPedido('hoy-pendiente', new Date().toISOString());
  await crearPedido('viejo-entregado', new Date(Date.now() - 10 * 86400000).toISOString());
  await finalizar('hoy-entregado');
  const viejo = await finalizar('viejo-entregado');

  // El sello de entrega tiene que venir del servidor: sin él no hay fecha que dar.
  expect(JSON.parse(viejo.order_json).delivered_at).toBeTruthy();

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
  $('#login-token').value = TOKEN;
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  click('[data-tab="pedidos"]');
  await waitFor(() => win.document.body.dataset.tab === 'pedidos' && filas().length, 'la lista de pedidos');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pedidos: el filtro cuenta lo que se ve', () => {
  it('con la lista en HOY, cada chip dice las filas que va a enseñar', async () => {
    // La lista entra en HOY: el pedido de hace diez días queda fuera.
    await waitFor(() => filas().length === 2, 'las dos filas de hoy');
    expect($('#pedidos-fecha-chip').textContent.trim()).toBe('Hoy');
    expect(numeroDelChip('todo')).toBe(2);
    expect(numeroDelChip('entregado')).toBe(1);
    expect(numeroDelChip('pendiente')).toBe(1);
    expect($('#pedidos-count').textContent).toContain('2');
  });

  it('al pulsar «Entregados» sale exactamente lo que decía el chip', async () => {
    click('#pedidos-filtros [data-order-filter="entregado"]');
    await waitFor(() => filas().length === 1, 'la fila entregada de hoy');
    // La fila abre la PÁGINA del pedido (ya no la hoja): su destino va en
    // `data-order-page`.
    expect(filas()[0].getAttribute('data-order-page')).toBe('hoy-entregado');
    expect(numeroDelChip('entregado')).toBe(1);
  });

  it('al abrir «Todas» el chip y la lista crecen juntos (nunca 2 arriba y 1 abajo)', async () => {
    click('#pedidos-filtros [data-order-date="all"]');
    await waitFor(() => filas().length === 2, 'los dos entregados');
    // Sigue el estado «Entregados» puesto: el chip y las filas, el mismo número.
    expect(numeroDelChip('entregado')).toBe(filas().length);
    expect(numeroDelChip('todo')).toBe(3);
    click('#pedidos-filtros [data-order-filter="todo"]');
    await waitFor(() => filas().length === 3, 'los tres pedidos');
    expect(numeroDelChip('todo')).toBe(filas().length);
  });
});

describe('pedidos: la fecha de entrega es la de la entrega', () => {
  it('el entregado enseña el día exacto en RD, no «ayer» ni «hace 2 días»', () => {
    const fila = $(`[data-order-card="hoy-entregado"] .order-row__when`);
    expect(fila).toBeTruthy();
    const sello = new Date(Date.now()).toISOString();
    // Mismo formato que el panel: día de la semana + fecha, en hora dominicana.
    const esperado = new Intl.DateTimeFormat('es-DO', {
      timeZone: 'America/Santo_Domingo',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(sello));
    expect(fila.textContent.trim()).toBe(esperado);
    expect(fila.textContent).not.toMatch(/ayer|hace \d+/i);
    expect(fila.getAttribute('title')).toContain('República Dominicana');
  });
});

describe('pedidos: el panel de filtros es un cajón de alto completo', () => {
  it('ocupa todo el alto y la mitad del ancho en el móvil', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    // Hay dos reglas para el mismo panel (la base compartida y la de pedidos):
    // se busca la de pedidos, la que fija el ancho a la mitad.
    const bloques = [...css.matchAll(/body\[data-tab='pedidos'\] #pedidos-filtros \{([^}]*)\}/gs)].map((m) => m[1]);
    const bloque = bloques.find((texto) => /width:\s*50vw/.test(texto)) ?? '';
    expect(bloque).toBeTruthy();
    expect(bloque).toMatch(/height:\s*100dvh/);
    expect(bloque).toMatch(/top:\s*0/);
    expect(bloque).toMatch(/bottom:\s*0/);
    expect(bloque).toMatch(/max-width:\s*50vw/);
  });
});

/** Un deslizamiento horizontal de verdad (pointerdown → pointerup). */
function swipe(direction) {
  const win = dom.window;
  const desde = direction < 0 ? 320 : 60;
  const hasta = direction < 0 ? 60 : 320;
  const opciones = { bubbles: true, clientY: 320, button: 0 };
  win.document.body.dispatchEvent(new win.MouseEvent('pointerdown', { ...opciones, clientX: desde }));
  win.document.body.dispatchEvent(new win.MouseEvent('pointerup', { ...opciones, clientX: hasta }));
}

describe('pedidos: monto vendido y cajón de acciones', () => {
  it('cada fila enseña el total en su propio hueco, no dentro de la línea que se recorta', () => {
    const tarjeta = $('[data-order-card="hoy-entregado"]');
    const total = tarjeta.querySelector('.order-row__total');
    expect(total).toBeTruthy();
    expect(total.textContent).toMatch(/\d/);
    expect(tarjeta.querySelector('.order-row__meta').textContent).not.toContain(total.textContent.trim());
  });

  it('el botón de la lista abre la columna de acciones a la derecha', () => {
    click('#pedidos-acciones');
    const cajon = $('#side-drawer');
    expect(cajon).toBeTruthy();
    expect(cajon.hidden).toBe(false);
    expect(dom.window.document.body.dataset.sideDrawer).toBe('open');
    expect(cajon.textContent).toContain('Finalizar los seleccionados');
    click('#side-drawer [data-side-drawer-close]');
    expect($('#side-drawer').hidden).toBe(true);
    expect(dom.window.document.body.dataset.sideDrawer).toBeUndefined();
  });

  it('deslizar de derecha a izquierda abre los filtros, y al contrario los cierra', () => {
    click('[data-tab="pedidos"]');
    swipe(-1);
    expect(dom.window.document.body.dataset.orderFilters).toBe('open');
    swipe(1);
    expect(dom.window.document.body.dataset.orderFilters).toBe('closed');
  });
});

describe('clientes: menú lateral y cajón de filtros', () => {
  it('el botón de Clientes abre el menú con crear cliente y crear campaña', () => {
    click('[data-tab="clientes"]');
    // El botón usa el icono de ACCIONES (tres renglones con su pastilla), el
    // mismo que el de Pedidos; ya no hay botón de campaña suelto.
    const fab = $('#clientes-acciones');
    expect(fab.querySelector('[data-icon]').dataset.icon).toBe('actions');
    expect($('#pedidos-acciones').querySelector('[data-icon]').dataset.icon).toBe('actions');
    expect($('#customer-campaign-fab')).toBe(null);
    click('#clientes-acciones');
    const cajon = $('#side-drawer');
    expect(cajon.hidden).toBe(false);
    expect(cajon.textContent).toContain('Crear cliente');
    expect(cajon.textContent).toContain('Crear campaña');
    expect(cajon.textContent).toContain('Registrar compra');
    // Tocar el velo lo cierra.
    click('#side-drawer-scrim');
    expect($('#side-drawer').hidden).toBe(true);
  });

  it('deslizar de derecha a izquierda abre los filtros de clientes', () => {
    swipe(-1);
    expect(dom.window.document.body.dataset.clientFilters).toBe('open');
    swipe(1);
    expect(dom.window.document.body.dataset.clientFilters).toBe('closed');
  });

  it('el cajón de clientes también ocupa todo el alto y la mitad del ancho', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    const bloques = [...css.matchAll(/body\[data-tab='clientes'\] #chips \{([^}]*)\}/gs)].map((m) => m[1]);
    const bloque = bloques.find((texto) => /width:\s*50vw/.test(texto)) ?? '';
    expect(bloque).toBeTruthy();
    expect(bloque).toMatch(/height:\s*100dvh/);
    expect(bloque).toMatch(/top:\s*0/);
    expect(bloque).toMatch(/bottom:\s*0/);
  });

  it('la lista de clientes ocupa el alto que sobra (no queda tirada al fondo)', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    // La vista es columna y la lista se queda con el resto y hace su scroll.
    expect(css).toMatch(/body\[data-tab='clientes'\] #view-clientes \{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/body\[data-tab='clientes'\] #list-clientes \{[^}]*flex:\s*1 1 0/s);
  });
});

describe('pedidos: el menú de cada pedido (los tres puntos)', () => {
  it('abre la columna lateral al 50 % y sin las opciones que ya están a un toque', () => {
    click('[data-tab="pedidos"]');
    click('[data-order-card="hoy-entregado"] [data-order-more]');
    const cajon = $('#side-drawer');
    expect(cajon).toBeTruthy();
    expect(cajon.hidden).toBe(false);
    expect(cajon.classList.contains('side-drawer--half')).toBe(true);
    expect(cajon.textContent).toContain('Cambiar el estado');
    // Lo que se quitó a propósito: el pedido se abre con la fila y el reparto no
    // se gestiona desde aquí.
    expect(cajon.textContent).not.toContain('Ver el pedido completo');
    expect(cajon.textContent).not.toContain('Pasar a un delivery');
    // Y no hay dos botones para escribir lo mismo.
    expect(cajon.textContent.match(/Plantilla o mensaje libre/g) ?? []).toHaveLength(1);
    click('#side-drawer [data-side-drawer-close]');
    expect($('#side-drawer').hidden).toBe(true);
  });

  it('el alta de compra vive en el menú de la lista (ya no hay «+» flotante)', () => {
    expect($('#compra-nueva-ped')).toBe(null);
    click('#pedidos-acciones');
    expect($('#side-drawer [data-purchase]')).toBeTruthy();
    expect($('#side-drawer').textContent).toContain('Registrar compra');
    click('#side-drawer [data-side-drawer-close]');
  });

  it('el cajón tiene versión de noche y el de un pedido va al 70 %', () => {
    const tema = readFileSync(path.join(ADMIN_DIR, 'shell-v2-tema.css'), 'utf8');
    expect(tema).toMatch(/:root\[data-theme='dark'\] \.side-drawer \{/);
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    // El menú del pedido y el de la lista comparten ancho (70 % del móvil).
    expect(css).toMatch(/\.side-drawer--half \{[^}]*width:\s*min\(70vw, 420px\)/s);
    // Y nada se sale: las etiquetas parten de línea dentro del cajón.
    expect(css).toMatch(/\.side-drawer \.menu-item strong[\s\S]{0,200}overflow-wrap:\s*anywhere/);
  });

  it('la fila abre el pedido en una página completa, no en la hoja', async () => {
    click('#pedidos-filtros [data-order-filter="todo"]');
    await waitFor(() => filas().length >= 1, 'las filas del día');
    click(filas()[0]);
    await waitFor(() => $('body').dataset.tab === 'pedido', 'la página del pedido');
    // Es una pantalla propia: la vista del pedido se ve y la hoja queda cerrada.
    expect($('#view-pedido').hidden).toBe(false);
    expect($('#sheet').hidden).toBe(true);
    // Con su barra y su volver, como el expediente del cliente.
    expect($('#mobile-header .simple-head--expediente')).toBeTruthy();
    expect($('#mobile-header [data-simple-back]')).toBeTruthy();
    // Y el contenido de la ficha (resumen, secciones y acciones).
    expect($('#pedido-ficha .profile-summary')).toBeTruthy();
    expect($('#pedido-ficha [data-sheet-actions]')).toBeTruthy();
    expect($$('#pedido-ficha .profile-fold').length).toBeGreaterThan(2);
    // El volver devuelve a la lista de Pedidos.
    click('#mobile-header [data-simple-back]');
    await waitFor(() => $('body').dataset.tab === 'pedidos', 'de vuelta a Pedidos');
  });

  it('las notificaciones se abren en un cajón del 90 % del ancho y todo el alto', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    expect(css).toMatch(
      /#sheet\[data-variant='notices-drawer'\] \.sheet__panel \{[^}]*width:\s*90%;[\s\S]*?height:\s*100%;/s,
    );
    // La hoja se abre como cajón: entra desde la derecha y ocupa todo el alto.
    expect(css).toMatch(/sheet-notices-drawer-in/);
    expect(css).toMatch(/#sheet\[data-variant='notices-drawer'\] \.sheet__panel \{[^}]*bottom:\s*0;/s);
  });
});
