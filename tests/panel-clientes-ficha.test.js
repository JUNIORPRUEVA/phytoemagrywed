/**
 * PERSONAS — filtro por fecha de ingreso y ficha compacta.
 *
 * Lo que se pidió:
 *   1. Poder filtrar por ESTADO y por FECHA DE INGRESO en el mismo panel, con la
 *      cabecera bien puesta (título en dos líneas y ✕ a la derecha).
 *   2. Que la ficha del cliente sea corta: WhatsApp y dirección primero, un «Ver
 *      más» pequeño para el resto, secciones plegadas, sin tarjetas enormes y sin
 *      repetir datos. Lo que no existe (cuenta de la tienda, etiquetas, nota) no
 *      se enseña.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-ficha-compacta';
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
const filas = () => $$('#list-clientes .client-row');
const chipFecha = (modo) => $(`#chips [data-client-date="${modo}"]`);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-ficha-'));
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

  // Dos clientes: uno de HOY y uno que entró hace diez días.
  const crear = async (phone, name) => {
    const respuesta = await fetch(`${app.url}/api/admin/conversations/start`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ phone, name }),
    });
    expect(respuesta.ok).toBe(true);
    return (await respuesta.json()).customer;
  };
  const nuevo = await crear('18095557021', 'Cliente De Hoy');
  const viejo = await crear('18095557022', 'Cliente De Hace Dias');
  await app.collections.update('customers', viejo.id, {
    created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
  });

  // El panel real.
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
  click('[data-tab="clientes"]');
  await waitFor(() => filas().length === 2, 'los dos clientes');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('personas: filtros', () => {
  it('el panel trae estado Y fecha de ingreso, con la cabecera en una fila', () => {
    expect($$('#chips [data-filter]')).toHaveLength(5);
    expect($$('#chips [data-client-date]')).toHaveLength(4);
    expect($$('#chips [data-client-date]').map((chip) => chip.textContent)).toEqual([
      'Todas',
      'Hoy',
      '7 días',
      'Este mes',
    ]);
    expect($('#chips').textContent).toContain('Fecha de ingreso');
    // La ✕ está dentro de la cabecera (no cae debajo del título).
    expect($('#chips .wa-filter-panel__head [data-client-filter-close]')).toBeTruthy();
  });

  it('filtrar por «Hoy» deja solo los clientes que entraron hoy', async () => {
    click(chipFecha('today'));
    await waitFor(() => filas().length === 1, 'un solo cliente de hoy');
    expect($('#list-clientes').textContent).toContain('Cliente De Hoy');
    expect($('#list-clientes').textContent).not.toContain('Cliente De Hace Dias');
    expect($('#clientes-count').textContent).toContain('1 de 2');
    click(chipFecha('all'));
    await waitFor(() => filas().length === 2, 'los dos clientes otra vez');
  });

  it('el estado y la fecha se combinan (no se pisan)', async () => {
    // Todos son prospectos: con «Interesados» no queda ninguno, con la fecha en «Todas».
    click('#chips [data-filter="interesados"]');
    await waitFor(() => filas().length === 0, 'ningún interesado');
    click('#chips [data-filter="prospectos"]');
    await waitFor(() => filas().length === 2, 'los dos prospectos');
  });
});

describe('ficha del cliente: compacta', () => {
  it('empieza por WhatsApp y dirección, con «Ver más» para el resto', async () => {
    click('#list-clientes .client-row__main');
    await waitFor(() => $('#customer-profile .profile-fold'), 'la ficha del cliente');
    const ficha = $('#customer-profile');
    expect(ficha.textContent).toContain('Información personal');
    expect(ficha.textContent).toContain('WhatsApp');
    expect(ficha.textContent).toContain('Dirección');
    expect(ficha.querySelector('.profile-more > summary')?.textContent).toContain('Ver más');
    // La fecha en que entró vive dentro de «Ver más», no en la primera línea.
    const mas = ficha.querySelector('.profile-more');
    expect(mas.textContent).toContain('Ingresó');
    expect(mas.open).toBe(false);
  });

  it('no enseña lo que el cliente no tiene y pliega lo demás', () => {
    const ficha = $('#customer-profile');
    const titulos = $$('#customer-profile .profile-fold__title').map((nodo) => nodo.textContent);
    // Sin cuenta de la tienda, sin etiquetas: esas secciones no existen.
    expect(ficha.textContent).not.toContain('Cuenta en FULLTECH Store');
    expect(titulos).not.toContain('Etiquetas');
    // Las notas vacías son un solo campo, no un bloque abierto con más datos.
    expect(ficha.textContent).toContain('Añadir una nota');
    // Lo demás está, pero plegado: solo se abre lo mínimo.
    expect(titulos).toContain('Información guardada de pedido');
    expect(titulos).toContain('Historial');
    const abiertos = $$('#customer-profile .profile-fold[open] .profile-fold__title').map((nodo) => nodo.textContent);
    expect(abiertos).toEqual(['Información personal', 'Añadir una nota']);
  });

  it('el nombre va en la barra, junto al volver, y no se repite', () => {
    // El volver vive en la barra (ya no flota sobre el contenido).
    const volver = $('#mobile-header .simple-head__back');
    expect(volver).toBeTruthy();
    expect(volver.getAttribute('data-simple-back')).not.toBe(null);
    expect($('#customer-profile .profile-back')).toBe(null);
    // El nombre aparece UNA vez en la barra y ninguna más en el expediente.
    const nombre = $('#mobile-header .simple-head--expediente strong').textContent.trim();
    expect(nombre).toMatch(/^Cliente De/);
    expect($('#customer-profile .profile-head h2')).toBe(null);
    const veces = ($('#customer-profile').textContent.match(new RegExp(nombre, 'g')) ?? []).length;
    expect(veces).toBe(0);
  });

  it('las secciones son filas planas, no tarjetas dentro de tarjetas', () => {
    const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
    expect(css).toMatch(/\.profile-fold \{[^}]*border:\s*0;/s);
    expect(css).toMatch(/\.profile-metric \{[^}]*border:\s*0;/s);
    // El botón de guardar la nota va pequeño y a la derecha (no ancho completo).
    expect(css).toMatch(/\.profile-note-actions \{[^}]*justify-content:\s*flex-end/s);
  });

  it('el botón flotante de acciones abre el cajón lateral', () => {
    click('#profile-actions');
    const cajon = $('#side-drawer');
    expect(cajon).toBeTruthy();
    expect(cajon.hidden).toBe(false);
    expect(cajon.textContent).toContain('Crear pedido');
    click('#side-drawer [data-side-drawer-close]');
    expect($('#side-drawer').hidden).toBe(true);
  });

  it('la cabecera es compacta y no inventa un avatar', () => {
    const ficha = $('#customer-profile');
    // El bloque enorme de antes ya no existe.
    expect(ficha.querySelector('.profile-hero')).toBe(null);
    expect(ficha.querySelector('.profile-head')).toBeTruthy();
    // El nombre va en la barra de arriba.
    expect($('#mobile-header').textContent).toMatch(/Cliente De/);
    // Sin foto real no se pinta ningún hueco.
    expect(ficha.querySelector('.profile-head__photo')).toBe(null);
    expect(ficha.querySelector('.profile-head__wa').getAttribute('href')).toContain('wa.me');
  });

  it('el resumen separa pedidos de compras entregadas y no inventa saldos', () => {
    const metricas = $$('#customer-profile .profile-metric').map((nodo) => nodo.textContent);
    expect(metricas.some((texto) => texto.startsWith('Pedidos'))).toBe(true);
    expect(metricas.some((texto) => texto.startsWith('Compras entregadas'))).toBe(true);
    expect(metricas.some((texto) => texto.startsWith('Etapa'))).toBe(true);
    // Sin datos de cobro no se enseña «Por cobrar».
    expect(metricas.some((texto) => texto.startsWith('Por cobrar'))).toBe(false);
  });

  it('la búsqueda del expediente encuentra y lleva a la sección', async () => {
    const input = $('#profile-search');
    expect(input.getAttribute('placeholder')).toContain('Buscar en este expediente');
    const nombre = $('#mobile-header .simple-head--expediente strong').textContent.trim();
    input.value = nombre;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const resultados = await waitFor(() => $$('#profile-search-results .profile-result'), 'los resultados');
    expect(resultados.length).toBeGreaterThan(0);
    expect($('#profile-search-results').textContent).toContain('Datos');
    click(resultados[0]);
    expect($('#customer-profile .profile-fold[data-fold="info"]').open).toBe(true);

    // Un texto que no existe se dice tal cual: no se finge una búsqueda.
    input.value = 'zzzznoexiste';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect($('#profile-search-results').textContent).toContain('Nada en este expediente');
  });
});
