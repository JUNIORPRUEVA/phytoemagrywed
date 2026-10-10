// @vitest-environment jsdom
/**
 * UAT DEL PANEL — HISTORIAL DE CIERRES (panel real + CRM real).
 *
 * Lo que se pidió y aquí se sujeta:
 *   - hay una PÁGINA de historial de cierres, en el menú, junto a «Cierre diario»;
 *   - lista cada día cerrado con lo esencial (ventas, efectivo, transferencia,
 *     lo que se gana el delivery y el cuadre) y el total del intervalo;
 *   - se puede FILTRAR: 7 días / 30 días / mes y, sobre todo, por intervalo
 *     (desde/hasta) con el calendario;
 *   - al tocar un día se abre su cierre COMPLETO (la misma pantalla del cierre
 *     diario) y se puede volver al historial.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-historial-cierres';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const TZ = 'America/Santo_Domingo';

let tmpDir;
let app;
let dom;
let cookie = '';
let ahora = new Date();
let agenteId = '';
/** Los datos del panel (`/api/admin/data`) ya llegaron: sin esto el historial se
 * mide vacío solo porque la petición sigue en el aire. */
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
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
const setValue = (selector, value) => {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

/** El «hoy» del negocio (mismo criterio que el panel y el servidor). */
const diaDeNegocio = (fecha) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);

const restarDias = (diaISO, dias) => {
  const d = new Date(`${diaISO}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

const fmt = (diaISO) => {
  const [year, month, date] = String(diaISO).split('-');
  return `${date}/${month}/${year}`;
};

/** Un pedido ENTREGADO en el día indicado, asignado al agente y cobrado como se diga. */
async function ventaDelDia(dia, { nombre, telefono, pago = 'CASH', variantId = 'capsules_5' }) {
  ahora = new Date(`${dia}T16:00:00.000Z`); // 12:00 en RD: mismo día de negocio
  const alta = await fetch(`${app.url}/api/admin/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: nombre,
      phone: telefono,
      items: [{ variantId, quantity: 1 }],
      paymentMethod: pago,
    }),
  });
  const body = await alta.json();
  expect(alta.status).toBe(201);
  // Se pasa al repartidor y LUEGO se entrega (un pedido ya entregado no admite
  // asignación: está cerrado). La entrega sella la fecha con el reloj simulado.
  const asignado = await fetch(`${app.url}/api/admin/orders/${body.item.id}/delivery/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ deliveryUserId: agenteId }),
  });
  expect(asignado.status).toBe(200);
  const entregado = await fetch(`${app.url}/api/admin/orders/${body.item.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ status: 'ENTREGADO', reason: 'Entrega de prueba (UAT historial)' }),
  });
  expect(entregado.status).toBe(200);
  return body.item;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-cierres-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    clock: () => ahora,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  // Inventario y un repartidor para que el cierre tenga «efectivo en mano».
  await fetch(`${app.url}/api/admin/inventory/restock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ quantity: 500, unitCost: '120', reason: 'UAT historial' }),
  });
  const usuario = await fetch(`${app.url}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: 'reparto.cierre@phyto.local', password: 'Reparto-12345', displayName: 'Ruben Reparto', role: 'AGENT' }),
  });
  agenteId = (await usuario.json()).user.id;

  const hoy = diaDeNegocio(new Date());
  await ventaDelDia(hoy, { nombre: 'Cliente de hoy', telefono: '8095550101' });
  await ventaDelDia(restarDias(hoy, 1), { nombre: 'Cliente de ayer', telefono: '8095550102', pago: 'TRANSFER', variantId: 'capsules_10' });
  await ventaDelDia(restarDias(hoy, 3), { nombre: 'Cliente de hace tres días', telefono: '8095550103' });
  ahora = new Date();

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

const abrirHistorial = async () => {
  await waitFor(() => datosCargados, 'los datos del panel');
  click('[data-tab="historial-cierres"]');
  const pintado = await waitFor(() => $('#close-history-view')?.children.length, 'el historial pintado');
  await sleep(150);
  return pintado;
};

const filas = () => $$('[data-close-history-day]').map((fila) => fila.dataset.closeHistoryDay);

describe('historial de cierres', () => {
  it('está en el menú y tiene su propia página', async () => {
    expect($('[data-tab="historial-cierres"]')?.textContent.trim()).toBe('Historial de cierres');
    expect($('#view-historial-cierres')).not.toBeNull();
    await abrirHistorial();
    expect($('#view-historial-cierres')?.hidden).toBe(false);
    expect($$('[data-close-history-period]').map((chip) => chip.textContent.trim())).toEqual(['7 días', '30 días', 'Este mes', 'Intervalo']);
  });

  it('lista cada día cerrado con su total y el resumen del intervalo', async () => {
    await abrirHistorial();
    const hoy = diaDeNegocio(new Date());
    // Los días con ventas entregadas, del más reciente al más viejo.
    expect(filas()).toEqual([hoy, restarDias(hoy, 1), restarDias(hoy, 3)]);

    const resumen = $('#close-history-view').textContent;
    expect(resumen).toContain('Días con cierre');
    expect(resumen).toContain('Ventas entregadas');
    expect(resumen).toContain('Efectivo en mano (del delivery)');
    expect(resumen).toContain('Ganancia del delivery');
    // La nota dice qué días se están mirando y de quién.
    expect($('#close-history-note')?.textContent).toContain(`Del ${fmt(restarDias(hoy, 6))} al ${fmt(hoy)}`);
    expect($('#close-history-note')?.textContent).toContain('Todo el equipo');
    // Cada fila trae el día, las ventas y el cuadre.
    const primera = $('[data-close-history-day]');
    expect(primera.textContent).toMatch(/venta · efectivo/);
    expect(primera.textContent).toMatch(/El delivery se gana/);
  });

  it('filtra por 30 días y por «Este mes»', async () => {
    await abrirHistorial();
    click('[data-close-history-period="30d"]');
    expect($('[data-close-history-period="30d"]')?.getAttribute('aria-pressed')).toBe('true');
    const hoy = diaDeNegocio(new Date());
    expect(filas()).toEqual([hoy, restarDias(hoy, 1), restarDias(hoy, 3)]);

    click('[data-close-history-period="mes"]');
    expect($('[data-close-history-period="mes"]')?.getAttribute('aria-pressed')).toBe('true');
    expect($('#close-history-note')?.textContent).toContain(`Del 01/${hoy.slice(5, 7)}/${hoy.slice(0, 4)} al ${fmt(hoy)}`);
    // Cada día listado cae dentro del mes (los que se pasan del día 1 no salen).
    expect(filas().every((dia) => dia.slice(0, 7) === hoy.slice(0, 7))).toBe(true);
  });

  it('filtra por intervalo (desde/hasta) con el calendario', async () => {
    await abrirHistorial();
    click('[data-close-history-period="custom"]');
    const form = await waitFor(() => $('#close-range-form'), 'el calendario del historial');
    expect([...form.querySelectorAll('.field__label')].map((el) => el.textContent.trim())).toEqual(['Desde', 'Hasta']);
    expect($('#close-from')?.type).toBe('date');

    const ayer = restarDias(diaDeNegocio(new Date()), 1);
    setValue('#close-from', ayer);
    setValue('#close-to', ayer);
    click('#close-range-form button[type="submit"]');
    await waitFor(() => filas().length === 1 && filas()[0] === ayer, 'solo el día elegido');
    expect($('#close-history-note')?.textContent).toBe(`Del ${fmt(ayer)} al ${fmt(ayer)} · Todo el equipo`);
    expect($('#sheet')?.hidden).toBe(true);

    // Y un intervalo sin cierres lo dice claro.
    click('[data-close-history-period="custom"]');
    await waitFor(() => $('#close-range-form'), 'el calendario otra vez');
    setValue('#close-from', '2025-02-01');
    setValue('#close-to', '2025-02-28');
    click('#close-range-form button[type="submit"]');
    await waitFor(() => $('#close-history-view')?.textContent?.includes('No hay cierres en estos días'), 'el aviso sin cierres');
    expect(filas()).toEqual([]);
  });

  it('al tocar un día se abre su cierre completo y se puede volver', async () => {
    await abrirHistorial();
    click('[data-close-history-period="7d"]');
    const ayer = restarDias(diaDeNegocio(new Date()), 1);
    const fila = await waitFor(() => $(`[data-close-history-day="${ayer}"]`), 'la fila del día de ayer');
    click(fila);

    // Se abre la pantalla del cierre diario, pero con ESE día.
    await waitFor(() => $('#view-cierre')?.hidden === false, 'el cierre del día');
    expect($('#daily-close-view')?.textContent).toContain(`Cierre del ${fmt(ayer)}`);
    expect($('#daily-close-view')?.textContent).toContain(`día ya cerrado`);
    // El detalle del día: su venta, el cuadre y el desglose por delivery.
    expect($('#daily-close-view')?.textContent).toContain('Cliente de ayer');
    expect($('#daily-close-view')?.textContent).toContain('Ruben Reparto');
    expect($('#daily-close-view')?.textContent).toContain('Ganancia del delivery');
    // Y las ventas de otro día NO se cuelan.
    expect($('#daily-close-view')?.textContent).not.toContain('Cliente de hoy');

    // Volver al historial.
    click('[data-close-back]');
    await waitFor(() => $('#view-historial-cierres')?.hidden === false, 'el historial otra vez');
    expect(filas().length).toBeGreaterThan(0);

    // El cierre de HOY sigue siendo el de hoy (con su botón de cierre manual).
    click('[data-tab="cierre"]');
    await waitFor(() => $('#daily-close-view')?.textContent?.includes('Cierre de hoy'), 'el cierre de hoy');
    expect($('#daily-close-view')?.textContent).toContain('Cliente de hoy');
  });

  it('se salta del cierre de hoy al historial (y vuelta) con el atajo de la barra', async () => {
    await waitFor(() => datosCargados, 'los datos del panel');
    click('[data-tab="cierre"]');
    await waitFor(() => $('#daily-close-view')?.textContent?.includes('Cierre de hoy'), 'el cierre de hoy');

    // El atajo vive en la barra de arriba, junto al volver: si no está, no hay
    // forma razonable de llegar al historial desde el cierre.
    const atajoHistorial = $('[data-close-history-go]');
    expect(atajoHistorial).not.toBeNull();
    expect(atajoHistorial.textContent).toContain('Historial');
    expect($('.simple-head__actions')?.contains(atajoHistorial)).toBe(true);

    click(atajoHistorial);
    await waitFor(() => $('#view-historial-cierres')?.hidden === false, 'el historial desde el atajo');
    expect(filas().length).toBeGreaterThan(0);

    // Y de vuelta al cierre de hoy con el atajo del historial.
    const atajoCierre = await waitFor(() => $('[data-close-today-go]'), 'el atajo hacia el cierre de hoy');
    expect(atajoCierre.textContent).toContain('Cierre de hoy');
    click(atajoCierre);
    await waitFor(() => $('#view-cierre')?.hidden === false, 'el cierre de hoy otra vez');
    expect($('#daily-close-view')?.textContent).toContain('Cierre de hoy');
  });

  it('cuando no hay nada en el intervalo lo dice, no deja la página vacía', async () => {
    await abrirHistorial();
    click('[data-close-history-period="custom"]');
    await waitFor(() => $('#close-range-form'), 'el calendario del historial');
    setValue('#close-from', '2025-03-01');
    setValue('#close-to', '2025-03-02');
    click('#close-range-form button[type="submit"]');
    await waitFor(() => $('#close-history-view')?.textContent?.includes('No hay cierres'), 'el aviso de intervalo vacío');
    // La página sigue teniendo la nota y el resumen: nunca queda en blanco.
    expect($('#close-history-note')).not.toBeNull();
    expect($('#close-history-view')?.querySelector('.card')).not.toBeNull();
    // Y se puede volver a un intervalo con datos.
    click('[data-close-history-period="7d"]');
    await waitFor(() => filas().length > 0, 'las filas de vuelta');
  });

  it('el cierre diario deja elegir VARIOS días y da el resumen de todo el tramo', async () => {
    await waitFor(() => datosCargados, 'los datos del panel');
    click('[data-tab="cierre"]');
    await waitFor(() => $('#daily-close-view')?.textContent?.includes('Cierre de hoy'), 'el cierre de hoy');

    // Los dos modos están en la propia pantalla del cierre.
    expect($$('[data-close-scope]').map((chip) => chip.textContent.trim())).toEqual(['Un día', 'Varios días']);
    expect($('[data-close-scope="dia"]')?.getAttribute('aria-pressed')).toBe('true');

    click('[data-close-scope="rango"]');
    const form = await waitFor(() => $('#close-period-range-form'), 'el calendario de varios días');
    expect([...form.querySelectorAll('.field__label')].map((el) => el.textContent.trim())).toEqual(['Desde', 'Hasta']);

    // Tres días seguidos: hoy, ayer y anteayer (las tres ventas del UAT caen ahí).
    const hoy = diaDeNegocio(new Date());
    setValue('#close-period-from', restarDias(hoy, 3));
    setValue('#close-period-to', hoy);
    click('#close-period-range-form button[type="submit"]');

    const resumen = await waitFor(
      () => ($('#daily-close-view')?.textContent?.includes('Resumen de varios días') ? $('#daily-close-view') : null),
      'el resumen de varios días',
    );
    expect($('[data-close-scope="rango"]')?.getAttribute('aria-pressed')).toBe('true');
    // El cuadro suma los días elegidos: 3 ventas entregadas.
    expect(resumen.textContent).toContain('Ventas entregadas');
    expect(resumen.textContent).toMatch(/Ventas entregadas\s*3/);
    expect(resumen.querySelectorAll('[data-close-history-day]')).toHaveLength(3);
    // Y dice el cuadre del tramo y lo que se gana el delivery.
    expect(resumen.textContent).toContain('Ganancia del delivery');
    expect(resumen.textContent).toMatch(/El delivery entrega|La empresa le entrega|Cierre cuadrado/);
    expect(resumen.textContent).toContain('Ruben Reparto');
    expect($('#daily-close-view')?.textContent).toContain(`del ${fmt(restarDias(hoy, 3))} al ${fmt(hoy)}`);

    // Tocar un día del resumen abre el cierre de ESE día (no el de hoy).
    const ayer = restarDias(hoy, 1);
    click($(`[data-close-history-day="${ayer}"]`));
    await waitFor(() => $('#daily-close-view')?.textContent?.includes(`Cierre del ${fmt(ayer)}`), 'el cierre del día elegido');
    expect($('[data-close-scope="dia"]')?.getAttribute('aria-pressed')).toBe('true');
    expect($('#daily-close-view')?.textContent).toContain('Cliente de ayer');

    // Un tramo de UN SOLO día abre su cierre, no el resumen.
    click('[data-close-scope="rango"]');
    await waitFor(() => $('#close-period-range-form'), 'el calendario otra vez');
    setValue('#close-period-from', ayer);
    setValue('#close-period-to', ayer);
    click('#close-period-range-form button[type="submit"]');
    await waitFor(() => $('#daily-close-view')?.textContent?.includes(`Cierre del ${fmt(ayer)}`), 'el cierre del día único');
    expect($('#daily-close-view')?.textContent).not.toContain('Resumen de varios días');

    // Y «Un día» vuelve al cierre de hoy.
    click('[data-close-scope="dia"]');
    await waitFor(() => $('#daily-close-view')?.textContent?.includes('Cierre de hoy'), 'el cierre de hoy otra vez');
    expect($('#daily-close-view')?.textContent).toContain('Cliente de hoy');
  });
});
