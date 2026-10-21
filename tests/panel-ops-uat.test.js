// @vitest-environment jsdom
/**
 * UAT DEL PANEL — CENTRO DE OPERACIONES (panel real + CRM real).
 *
 * Demuestra lo que la Etapa B promete en la PANTALLA, no en el mock:
 *   - la pestaña «Centro IA» existe en el menú y abre una bandeja vacía de verdad;
 *   - se crea un ticket desde el formulario y aparece en la lista Y en el servidor;
 *   - al abrirlo se carga su hilo, se escribe un mensaje y queda guardado;
 *   - el mensaje se pinta como propio (lado derecho) con el nombre real;
 *   - «Acusar recibo» deja un hecho en la línea de tiempo sin cerrar el ticket;
 *   - los filtros y la búsqueda recortan la lista;
 *   - los tickets siguen ahí al volver a pedirlos (recarga / reinicio).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-ops-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const USER = 'ops@phyto.local';
const PASS = 'OpsPanel-12345';

let tmpDir;
let app;
let dom;
let cookie = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(30);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];

function click(element) {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
}

function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

async function apiGet(route) {
  const response = await fetch(`${app.url}${route}`, { headers: { cookie } });
  return { status: response.status, body: await response.json() };
}

async function apiPost(route, body) {
  const response = await fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function openOps() {
  /*
   * Se navega como lo hace una persona: el botón del menú. Así se ejercita de
   * verdad `setTab` (permisos, visibilidad de la vista y el evento de pestaña).
   */
  const item = $('[data-tab="ops"]');
  if (item) {
    item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    return;
  }
  dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:tab', { detail: { tab: 'ops' } }));
}

/** Espera a que la bandeja haya pedido los datos al servidor. */
async function waitInbox(label = 'la bandeja cargada') {
  await waitFor(() => {
    const text = $('.ops-empty')?.textContent ?? '';
    return $$('.ops-row').length > 0 || (text && !text.includes('Cargando'));
  }, label);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-ops-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'ops.sqlite'),
    token: TOKEN,
    quiet: true,
    bootstrapAdminUser: USER,
    bootstrapAdminPassword: PASS,
    bootstrapAdminDisplayName: 'Ana Ops',
    schedulerEnabled: false,
  });

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
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  /* El módulo del centro de operaciones no tiene imports: se evalúa igual. */
  win.eval(readFileSync(path.join(ADMIN_DIR, 'ops.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  setValue('#login-username', USER);
  setValue('#login-password', PASS);
  $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'la app dentro');
}, 90_000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Centro de operaciones', () => {
  it('la pestaña existe en el menú y pinta una bandeja vacía de verdad', async () => {
    const item = $('[data-tab="ops"]');
    expect(item).toBeTruthy();
    expect(item.textContent).toContain('Centro IA');

    openOps();
    await waitFor(() => $('#view-ops')?.dataset.ready === '1', 'el armazón del centro');
    await waitInbox();
    expect($('#view-ops').hidden).toBe(false);
    /* Sin tickets, la pantalla lo dice; no hay filas inventadas. */
    expect($$('.ops-row')).toHaveLength(0);
    expect($('.ops-empty')?.textContent).toContain('Sin tickets');
  });

  it('crea un ticket desde el formulario y queda guardado en el servidor', async () => {
    click('[data-ops-new]');
    await waitFor(() => !$('#ops-sheet').hidden, 'la hoja de nuevo ticket');

    setValue('[data-ops-new-form] input[name="title"]', 'Cuadrar el cierre del turno');
    setValue('[data-ops-new-form] textarea[name="description"]', 'Falta el comprobante de una transferencia.');
    const priority = $('[data-ops-new-form] select[name="priority"]');
    setValue(priority, 'low');

    $('[data-ops-new-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $$('.ops-row').length === 1, 'la fila creada');

    expect($('.ops-row__title').textContent).toContain('Cuadrar el cierre');
    expect($('.ops-row__num').textContent).toMatch(/^TK-[0-9A-F]{6}$/);

    const inbox = await apiGet('/api/admin/ops/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0].title).toBe('Cuadrar el cierre del turno');
    expect(inbox.body.items[0].priority).toBe('low');
  });

  it('abre el hilo, escribe un mensaje propio y lo persiste', async () => {
    click('.ops-row');
    await waitFor(() => $('#ops-thread') && $('#ops-text'), 'el compositor del ticket');

    setValue('#ops-text', 'Ya encontré el comprobante, lo adjunto en la ficha del pedido.');
    $('#ops-text').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    await waitFor(() => $$('.ops-msg').length === 1, 'la burbuja enviada');
    const bubble = $('.ops-msg');
    expect(bubble.classList.contains('is-mine')).toBe(true);
    expect(bubble.textContent).toContain('Ya encontré el comprobante');
    expect(bubble.querySelector('.ops-msg__who').textContent).toContain('Ana Ops');

    /* En el servidor, no solo en pantalla. */
    const inbox = await apiGet('/api/admin/ops/inbox');
    const ticketId = inbox.body.items[0].id;
    const detail = await apiGet(`/api/admin/ops/tickets/${ticketId}`);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].body).toContain('Ya encontré el comprobante');
    expect(detail.body.messages[0].authorName).toBe('Ana Ops');
    expect(detail.body.ticket.status).toBe('in_progress');
  });

  it('«Acusar recibo» se registra sin cerrar el ticket', async () => {
    await waitFor(() => $('[data-ops-ack]'), 'el botón de acuse');
    click('[data-ops-ack]');
    await waitFor(() => $('#ops-thread').textContent.includes('Acuse'), 'el hecho en la línea de tiempo');

    const inbox = await apiGet('/api/admin/ops/inbox');
    const ticketId = inbox.body.items[0].id;
    const detail = await apiGet(`/api/admin/ops/tickets/${ticketId}`);
    expect(detail.body.ticket.status).toBe('in_progress');
    expect(detail.body.events.some((event) => event.kind === 'ack')).toBe(true);
    expect($('[data-ops-ack]')).toBeNull();
  });

  it('los filtros y la búsqueda recortan la lista con datos reales', async () => {
    /* Segundo ticket, creado por API (el panel ya está probado para crear). */
    const created = await apiPost('/api/admin/ops/tickets', {
      type: 'incident',
      title: 'Revisar factura de proveedor',
      priority: 'urgent',
    });
    expect(created.status).toBe(201);

    click('[data-ops-filter="todos"]');
    await waitFor(() => $$('.ops-row').length === 2, 'dos filas');

    click('[data-ops-filter="urgentes"]');
    await waitFor(() => $$('.ops-row').length === 1, 'filtro urgentes');
    expect($('.ops-row__title').textContent).toContain('factura de proveedor');

    click('[data-ops-filter="todos"]');
    await waitFor(() => $$('.ops-row').length === 2, 'vuelta a todos');

    setValue('#ops-search', 'factura');
    await waitFor(() => $$('.ops-row').length === 1, 'la búsqueda');

    setValue('#ops-search', '');
    await waitFor(() => $$('.ops-row').length === 2, 'búsqueda limpia');
  });

  it('el ticket y su hilo siguen ahí al volver a la pestaña', async () => {
    /* Se sale y se vuelve a entrar: la pantalla vuelve a pedir todo al servidor. */
    dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:tab', { detail: { tab: 'hoy' } }));
    openOps();
    await waitInbox('las filas al volver');
    await waitFor(() => $$('.ops-row').length === 2, 'las filas al volver');

    /* Se abre EL ticket de la conversación (el orden es por actividad, no por título). */
    const target = $$('.ops-row').find((row) => row.textContent.includes('Cuadrar el cierre'));
    expect(target).toBeTruthy();
    click(target);
    await waitFor(() => $('#ops-thread')?.textContent.includes('Ya encontré el comprobante'), 'el hilo al volver');
  });
});
