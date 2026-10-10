// @vitest-environment jsdom
/**
 * UAT DEL PANEL — INTERVALO EN REPORTES (panel real + CRM real).
 *
 * Lo que se pidió y aquí se sujeta:
 *   - en Reportes hay un filtro que dice «Intervalo»;
 *   - al pulsarlo se abre el calendario (dos fechas: DESDE y HASTA);
 *   - al aplicar, la pantalla filtra por ese rango de verdad: la petición lleva
 *     `period=custom&from=…&to=…` y el reporte cuenta SOLO esas fechas;
 *   - las fechas al revés no dejan el reporte vacío (se ordenan);
 *   - la pantalla deja a la vista qué días está contando.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-reportes-intervalo';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

let tmpDir;
let app;
let dom;
let cookie = '';
/** Todas las URLs que pide el panel: así se comprueba QUÉ se manda al servidor. */
const peticiones = [];

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

/** Un pedido ENTREGADO hoy por la API (así el reporte tiene una venta real). */
async function ordenEntregadaHoy() {
  const response = await fetch(`${app.url}/api/admin/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'Cliente Intervalo',
      phone: '8095550777',
      items: [{ variantId: 'capsules_5', quantity: 1 }],
      paymentMethod: 'CASH',
      status: 'entregado',
    }),
  });
  return response.json();
}

const hoyISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** 2026-10-10 → 10/10/2026 (como lo pinta la nota del reporte). */
const fmt = (dia) => {
  const [year, month, date] = String(dia).split('-');
  return `${date}/${month}/${year}`;
};

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-intervalo-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });

  // Sesión de administración (la clave del panel): el reporte de ganancia es de ADMIN.
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

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
    peticiones.push(url);
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
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

/** Abre la pestaña de reportes y espera el filtro. */
async function abrirReportes() {
  click('[data-tab="reportes"]');
  return waitFor(() => $('#sales-report-period'), 'el filtro de períodos');
}

const chipIntervalo = () => $$('[data-report-period]').find((chip) => chip.dataset.reportPeriod === 'custom') ?? null;

describe('intervalo (desde/hasta) en reportes', () => {
  it('hay un filtro que dice «Intervalo», junto a Hoy/Ayer/7 días/30 días/Mes', async () => {
    await abrirReportes();
    const etiquetas = $$('[data-report-period]').map((chip) => chip.textContent.trim());
    expect(etiquetas).toEqual(['Hoy', 'Ayer', '7 días', '30 días', 'Mes', 'Intervalo']);
    expect(chipIntervalo()).not.toBeNull();
  });

  it('al pulsarlo se abre el calendario con DESDE y HASTA', async () => {
    await abrirReportes();
    click(chipIntervalo());
    const form = await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    expect($('#report-from')?.type).toBe('date');
    expect($('#report-to')?.type).toBe('date');
    // Las dos etiquetas que se pidieron.
    const etiquetas = [...form.querySelectorAll('.field__label')].map((el) => el.textContent.trim());
    expect(etiquetas).toEqual(['Desde', 'Hasta']);
    // Viene con un rango puesto (los últimos 7 días), no vacío.
    expect($('#report-from')?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect($('#report-to')?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('filtra de una fecha a otra: la petición lleva desde y hasta, y la pantalla lo dice', async () => {
    await abrirReportes();
    peticiones.length = 0;
    click(chipIntervalo());
    await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    setValue('#report-from', '2026-01-05');
    setValue('#report-to', '2026-01-20');
    click('#report-range-form button[type="submit"]');

    const pedido = await waitFor(
      () => peticiones.find((url) => url.includes('/api/admin/reports/sales?') && url.includes('period=custom')),
      'la petición del intervalo',
    );
    expect(pedido).toContain('from=2026-01-05');
    expect(pedido).toContain('to=2026-01-20');

    // La nota ya existía (la pinta el reporte anterior): se espera al TEXTO nuevo.
    const nota = await waitFor(
      () => ($('#report-range-note')?.textContent === 'Del 05/01/2026 al 20/01/2026' ? $('#report-range-note') : null),
      'los días que se están contando',
    );
    expect(nota.textContent).toBe('Del 05/01/2026 al 20/01/2026');
    expect(chipIntervalo()?.getAttribute('aria-pressed')).toBe('true');
    // La hoja del calendario se cierra al aplicar.
    expect($('#sheet')?.hidden).toBe(true);
  });

  it('un intervalo que incluye hoy cuenta la venta de hoy; uno de otro mes no cuenta nada', async () => {
    await abrirReportes();
    const alta = await ordenEntregadaHoy();
    const numero = alta?.item?.order_number ?? '';
    expect(numero).toMatch(/^PE-/);
    const hoy = hoyISO();
    click(chipIntervalo());
    await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    setValue('#report-from', hoy);
    setValue('#report-to', hoy);
    click('#report-range-form button[type="submit"]');

    // Con el día de hoy en el rango, la venta aparece en el detalle.
    await waitFor(
      () => $('#report-range-note')?.textContent?.includes(fmt(hoy)) && $('#sales-report-view')?.textContent?.includes(numero),
      'la venta de hoy dentro del intervalo',
    );

    // Un mes sin ventas: el detalle ya no la tiene (el filtro va de verdad).
    click(chipIntervalo());
    await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    setValue('#report-from', '2025-03-01');
    setValue('#report-to', '2025-03-31');
    click('#report-range-form button[type="submit"]');
    await waitFor(() => $('#report-range-note')?.textContent === 'Del 01/03/2025 al 31/03/2025', 'el rango sin ventas');
    await waitFor(() => !$('#sales-report-view').textContent.includes(numero), 'el reporte sin la venta de hoy');
    expect($('#sales-report-view').textContent).toMatch(/No hay entregas en este período|No hay detalle/);
  });

  it('si las fechas van al revés, las ordena (no deja el reporte vacío por error)', async () => {
    await abrirReportes();
    peticiones.length = 0;
    click(chipIntervalo());
    await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    setValue('#report-from', '2026-01-20');
    setValue('#report-to', '2026-01-05');
    click('#report-range-form button[type="submit"]');
    const pedido = await waitFor(
      () => peticiones.find((url) => url.includes('period=custom') && url.includes('from=')),
      'la petición del intervalo',
    );
    expect(pedido).toContain('from=2026-01-05');
    expect(pedido).toContain('to=2026-01-20');
    await waitFor(() => $('#report-range-note')?.textContent === 'Del 05/01/2026 al 20/01/2026', 'el rango ordenado');
  });

  it('sin fechas no inventa nada: avisa y no manda la petición', async () => {
    await abrirReportes();
    click(chipIntervalo());
    await waitFor(() => $('#report-range-form'), 'el calendario del intervalo');
    setValue('#report-from', '');
    setValue('#report-to', '');
    peticiones.length = 0;
    click('#report-range-form button[type="submit"]');
    await sleep(400);
    expect(peticiones.filter((url) => url.includes('period=custom'))).toHaveLength(0);
    // La hoja sigue abierta para que corrija.
    expect($('#sheet')?.hidden).toBe(false);
  });
});
