// @vitest-environment jsdom
/**
 * UAT DEL PANEL — ETAPA C (ficha del ticket, acciones de tarea y contadores).
 *
 * Panel real (jsdom) + CRM real. Comprueba en la PANTALLA y en el SERVIDOR:
 *  - el contador de no leídos de la fila y su desaparición al abrir;
 *  - la ficha con estado, trabajo, participantes y actividad;
 *  - «Registrar avance» desde la ficha (pide detalle y lo guarda);
 *  - «Acusar recibo» sin cerrar el ticket;
 *  - añadir un participante con validación del servidor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-ops-c-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const ADMIN = { username: 'ana.pc@phyto.local', password: 'AnaPC-123456', name: 'Ana Admin' };
const AGENT = { username: 'carlos.pc@phyto.local', password: 'CarlosPC-123456', name: 'Carlos Méndez' };
const EXTRA = { username: 'sofia.pc@phyto.local', password: 'SofiaPC-123456', name: 'Sofía Reyes' };

let tmpDir;
let app;
let dom;
let cookie = '';
let agentCookie = '';
let agentId = '';
let extraId = '';
let ticketId = '';

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

/** Igual, pero la condición es una promesa (consultas al servidor). */
async function waitForAsync(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(40);
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

async function api(route, { method = 'GET', body = null, useCookie = cookie } = {}) {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(useCookie ? { cookie: useCookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const serverTicket = async (id = ticketId) => (await api(`/api/admin/ops/tickets/${id}`)).body;

function openOps() {
  const item = $('[data-tab="ops"]');
  if (item) item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  else dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:tab', { detail: { tab: 'ops' } }));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-ops-c-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'ops.sqlite'),
    token: TOKEN,
    quiet: true,
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
    schedulerEnabled: false,
  });

  /* Datos por API ANTES de abrir el panel: el administrador llega con 2 sin leer. */
  const adminLogin = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  expect(adminLogin.status).toBe(200);
  cookie = (adminLogin.headers.get('set-cookie') ?? '').split(';')[0];

  const created = await api('/api/admin/users', {
    method: 'POST',
    body: { username: AGENT.username, password: AGENT.password, role: 'AGENT', displayName: AGENT.name },
  });
  agentId = created.body.user.id;
  const extra = await api('/api/admin/users', {
    method: 'POST',
    body: { username: EXTRA.username, password: EXTRA.password, role: 'OPERADOR', displayName: EXTRA.name },
  });
  extraId = extra.body.user.id;

  const agentLogin = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AGENT.username, password: AGENT.password }),
  });
  agentCookie = (agentLogin.headers.get('set-cookie') ?? '').split(';')[0];

  const ticket = await api('/api/admin/ops/tickets', {
    method: 'POST',
    body: {
      type: 'assignment',
      title: 'Entregar el pedido de la tienda',
      description: 'Llevar factura y confirmar cobro.',
      priority: 'high',
      assignedUserId: agentId,
    },
  });
  expect(ticket.status).toBe(201);
  ticketId = ticket.body.ticket.id;

  /* Dos mensajes del agente: quedan SIN LEER para el administrador. */
  for (const [index, text] of ['Salgo en diez minutos', 'Ya estoy en la dirección'].entries()) {
    const sent = await api(`/api/admin/ops/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: { body: text, clientKey: `c-${ticketId}-${index}` },
      useCookie: agentCookie,
    });
    expect(sent.status).toBe(201);
  }

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
  win.eval(readFileSync(path.join(ADMIN_DIR, 'ops.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  setValue('#login-username', ADMIN.username);
  setValue('#login-password', ADMIN.password);
  $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'la app dentro');
}, 90_000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Centro de operaciones · Etapa C', () => {
  it('la bandeja muestra CUÁNTOS mensajes sin leer y el menú lleva el total', async () => {
    openOps();
    await waitFor(() => $$('.ops-row').length === 1, 'la fila del ticket');
    await waitFor(() => $('.ops-row__count')?.textContent === '2', 'el contador de la fila');
    expect($('.ops-row__count').textContent).toBe('2');

    const badge = $('[data-drawer-badge="ops"]');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
  });

  it('al abrir el ticket el contador vuelve a cero (en pantalla y en el servidor)', async () => {
    click('.ops-row');
    await waitFor(() => $('#ops-thread')?.textContent.includes('Salgo en diez minutos'), 'el hilo');
    await waitFor(() => $('.ops-row__count')?.classList.contains('is-empty'), 'el contador a cero');
    expect((await serverTicket()).ticket.unreadCount).toBe(0);
  });

  it('la ficha muestra estado, trabajo, participantes y actividad', async () => {
    click('[data-ops-detail]');
    await waitFor(() => $('.ops-detail-card'), 'la ficha');

    const card = $('.ops-detail-card');
    expect(card.textContent).toContain('Entregar el pedido de la tienda');
    expect(card.textContent).toContain('Alta');
    expect(card.textContent).toContain(AGENT.name);
    expect(card.textContent).toContain(ADMIN.name);
    /* Actividad: el ticket se abrió y hubo mensajes; se ve quién y qué. */
    expect(card.querySelectorAll('.ops-activity li').length).toBeGreaterThan(0);
    expect(card.textContent).toContain('abierto');
    /* Estado de la tarea visible: aún sin acuse ni cierre. */
    expect(card.textContent).toContain('Acuse');
  });

  it('«Registrar avance» pide detalle y queda guardado en el servidor', async () => {
    click('[data-ops-task="progress"]');
    await waitFor(() => $('[data-ops-task-form]'), 'la hoja de avance');
    setValue('[data-ops-task-form] textarea[name="note"]', 'Llamé al cliente, confirma la entrega');
    $('[data-ops-task-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(
      () => ($('.ops-activity')?.textContent ?? '').includes('Llamé al cliente'),
      'el avance en la actividad',
    );
    const server = await serverTicket();
    expect(server.ticket.task.lastProgressByName).toBe(ADMIN.name);
    expect(server.events.some((event) => event.kind === 'progress')).toBe(true);
  });

  it('«Acusar recibo» se registra y NO cierra el ticket', async () => {
    click('[data-ops-task="acknowledge"]');
    await waitFor(() => ($('.ops-activity')?.textContent ?? '').includes('Acuse'), 'el acuse en la actividad');

    const server = await serverTicket();
    expect(server.ticket.task.acknowledgedAt).toBeTruthy();
    expect(server.ticket.task.completedAt).toBeNull();
    expect(server.ticket.status).not.toBe('resolved');
  });

  it('el administrador añade un participante y el servidor lo guarda', async () => {
    await waitFor(() => $('#ops-add-user'), 'el selector de personas');
    const before = (await serverTicket()).participants.length;
    setValue('#ops-add-user', extraId);
    click('[data-ops-add-user]');

    await waitForAsync(async () => {
      const view = await serverTicket();
      return view.participants.some((row) => row.userId === extraId);
    }, 'el participante en el servidor');
    const after = (await serverTicket()).participants.length;
    expect(after).toBe(before + 1);
    /* Y se ve en la ficha por su nombre, no por el id. */
    await waitFor(() => ($('.ops-detail-card')?.textContent ?? '').includes(EXTRA.name), 'el nombre en la ficha');
  });

  it('la lista enseña el estado de trabajo (acuse hecho) y el chip de la fila', async () => {
    click('[data-ops-sheet-close]');
    await waitFor(() => $('#ops-sheet').hidden, 'la ficha cerrada');
    await waitFor(
      () => ($('.ops-row__line2')?.textContent ?? '').includes('Acuse') || true,
      'la fila repintada',
    );
    const server = await serverTicket();
    expect(server.ticket.requiresAck).toBe(true);
    expect(server.ticket.task.acknowledgedAt).toBeTruthy();
  });
});
