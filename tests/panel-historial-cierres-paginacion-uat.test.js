// @vitest-environment jsdom
/**
 * UAT DEL HISTORIAL DE CIERRES — PAGINACIÓN (defecto reproducido y corregido).
 *
 * DEFECTO (auditoría 2026-10-22):
 *   El historial se calculaba con `state.items`, y `/api/admin/data` entrega
 *   como mucho los 500 registros MÁS NUEVOS de todos los tipos
 *   (`SELECT * FROM items ORDER BY received_at DESC LIMIT ?`). Con más volumen,
 *   los días de cierre antiguos DESAPARECÍAN del historial y los totales del
 *   intervalo salían a menos, aunque la nota dijera otro rango.
 *
 * CORRECCIÓN:
 *   El historial pide los pedidos entregados del tramo a
 *   `GET /api/admin/reports/delivered-orders`, que los lee de la base completa
 *   (con el mismo criterio de día de negocio y el mismo alcance de permisos).
 *
 * Esta prueba crea 505 registros de relleno MÁS NUEVOS que la venta, comprueba
 * que la venta YA NO llega en el paquete del panel y que el historial, aun así,
 * enseña su día y su importe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-cierres-paginacion';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const TZ = 'America/Santo_Domingo';
const RELLENO = 505;

let tmpDir;
let dataFile;
let app;
let dom;
let cookie = '';
let ahora = new Date();
let agenteId = '';
let venta = null;
let diaVenta = '';
let datosCargados = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = check();
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

const diaDeNegocio = (fecha) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);

const restarDias = (diaISO, dias) => {
  const d = new Date(`${diaISO}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-cierres-pag-'));
  dataFile = path.join(tmpDir, 'phytoemagry.sqlite');
  const opciones = {
    port: 0,
    host: '127.0.0.1',
    dataFile,
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    clock: () => ahora,
  };

  // 1) Un arranque corto solo para que exista el esquema.
  const esquema = await startCrmServer(opciones);
  await esquema.close();

  // 2) El servidor de verdad, con el reloj simulado en la fecha de la venta.
  app = await startCrmServer(opciones);

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await fetch(`${app.url}/api/admin/inventory/restock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ quantity: 500, unitCost: '120', reason: 'UAT paginación' }),
  });
  const usuario = await fetch(`${app.url}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      username: 'reparto.paginacion@phyto.local',
      password: 'Reparto-12345',
      displayName: 'Rosa Reparto',
      role: 'AGENT',
    }),
  });
  agenteId = (await usuario.json()).user.id;

  // La venta es de hace 5 días: ya está fuera de los 500 registros más nuevos.
  diaVenta = restarDias(diaDeNegocio(new Date()), 5);
  ahora = new Date(`${diaVenta}T16:00:00.000Z`);
  const alta = await fetch(`${app.url}/api/admin/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'Cliente antiguo',
      phone: '8095550199',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      paymentMethod: 'CASH',
    }),
  });
  expect(alta.status).toBe(201);
  venta = (await alta.json()).item;
  const asignado = await fetch(`${app.url}/api/admin/orders/${venta.id}/delivery/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ deliveryUserId: agenteId }),
  });
  expect(asignado.status).toBe(200);
  const entregado = await fetch(`${app.url}/api/admin/orders/${venta.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'ENTREGADO', reason: 'Entrega de prueba (UAT paginación)' }),
  });
  expect(entregado.status).toBe(200);
  ahora = new Date();

  /*
   * 3) RELLENO MÁS NUEVO QUE LA VENTA.
   * `store.insert` sella `received_at` con el reloj REAL, así que el relleno se
   * inserta después y con marcas posteriores: así la venta queda en el puesto
   * 501 y YA NO viaja en el paquete del panel (el defecto que se corrige).
   */
  const db = new DatabaseSync(dataFile);
  db.exec('PRAGMA busy_timeout = 5000');
  const insertar = db.prepare('INSERT INTO items (id, type, received_at, name, payload) VALUES (?, ?, ?, ?, ?)');
  const base = Date.now() + 60 * 1000;
  for (let indice = 0; indice < RELLENO; indice += 1) {
    const etiqueta = String(indice + 1).padStart(3, '0');
    insertar.run(
      `relleno${etiqueta}`,
      'contact',
      new Date(base + indice * 1000).toISOString(),
      `Relleno ${etiqueta}`,
      JSON.stringify({ name: `Relleno ${etiqueta}`, phone: `8095000${etiqueta}` }),
    );
  }
  db.close();

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
    if (url.includes('/api/admin/data')) datosCargados = true;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#app')?.hidden, 'el panel cargado');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('historial de cierres con más de 500 registros', () => {
  it('la venta antigua NO llega en el paquete del panel (el defecto existía)', async () => {
    const respuesta = await fetch(`${app.url}/api/admin/data`, { headers: { cookie } });
    const datos = await respuesta.json();
    expect(datos.items).toHaveLength(500);
    expect(datos.items.some((item) => item.id === venta.id)).toBe(false);
    expect(datos.items.filter((item) => item.type === 'order_intent')).toHaveLength(0);
  });

  it('el servidor sí conoce el tramo completo (fuente del historial)', async () => {
    const respuesta = await fetch(
      `${app.url}/api/admin/reports/delivered-orders?from=${restarDias(diaVenta, 2)}&to=${diaVenta}`,
      { headers: { cookie } },
    );
    expect(respuesta.status).toBe(200);
    const datos = await respuesta.json();
    expect(datos.count).toBe(1);
    expect(datos.items[0].id).toBe(venta.id);
  });

  it('el panel sigue enseñando el cierre de ese día aunque no esté en su copia', async () => {
    await waitFor(() => datosCargados, 'los datos del panel');
    const grupo = $$('#drawer details.drawer__fold').find((fold) => fold.querySelector('[data-close-view="actual"]'));
    if (grupo && !grupo.open) click(grupo.querySelector(':scope > summary'));
    click('[data-close-view="history"]');
    await waitFor(() => $('#close-history-view')?.children.length, 'el historial pintado');

    const fila = await waitFor(() => $(`[data-close-history-day="${diaVenta}"]`), 'la fila del día de la venta');
    expect(fila).not.toBeNull();
    expect(fila.textContent).toContain('1 venta');
    expect($('#close-history-note')?.textContent).toContain('1 cierre');
    expect($('#close-history-note')?.textContent).toContain('Del ');
  });
});
