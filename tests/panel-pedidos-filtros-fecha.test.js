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
    expect(filas()[0].getAttribute('data-open')).toBe('hoy-entregado');
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
