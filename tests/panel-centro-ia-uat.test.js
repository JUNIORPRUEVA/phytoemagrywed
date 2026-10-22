// @vitest-environment jsdom
/**
 * UAT DE PANEL — CENTRO IA (equipo, oficina y conversación compartida).
 *
 * Se carga el panel REAL (`public/admin/index.html` + `app.js` + `ops.js`) en
 * jsdom y se navega como una persona: menú → Centro IA → oficina del agente →
 * ticket → volver. Todo con pedidos, agentes y empleados ficticios y con un
 * WhatsApp simulado que revienta si alguien intenta enviar algo.
 *
 * Lo que se demuestra aquí:
 *   - la entrada del centro es EL EQUIPO, no una bandeja abierta;
 *   - los agentes aparecen solos (lista dinámica, sin tocar el código);
 *   - la oficina muestra sus tickets y abre LA MISMA conversación del centro;
 *   - el botón de volver regresa a la oficina de la que se vino;
 *   - la bandeja completa sigue disponible y el Supervisor IA se alcanza
 *     desde el centro (una sola pantalla, sin duplicar la administración).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'panel-centro-token';
const ADMIN = { username: 'panel.centro', password: 'Panel-123456', name: 'Ana Centro' };
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const SUPERVISOR = { key: 'delivery_supervisor', name: 'Supervisor de reparto', role: 'Seguimiento de entregas' };
const ADVISOR = { key: 'sales_advisor', name: 'Asesor comercial', role: 'Aclaraciones de pedido' };

let tmpDir;
let app;
let dom;
let cookie = '';
let ticketId = '';

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];

async function waitFor(check, label, timeout = 12_000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function click(target) {
  if (!target) throw new Error('no hay elemento que pulsar');
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function setValue(target, value) {
  target.value = value;
  target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function api(route, options = {}) {
  return fetch(`${app.url}${route}`, {
    ...options,
    headers: { cookie, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-panel-centro-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'panel.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    whatsapp: {
      enabled: false,
      async sendText() {
        throw new Error('UAT: no se envía WhatsApp');
      },
      async sendTemplate() {
        throw new Error('UAT: no se envía WhatsApp');
      },
      async markAsRead() {
        return { ok: true };
      },
    },
    bootstrapAdminUser: ADMIN.username,
    bootstrapAdminPassword: ADMIN.password,
    bootstrapAdminDisplayName: ADMIN.name,
  });
  const login = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  /* Dos agentes REALES por la API: la pantalla no tiene ninguno escrito a mano. */
  for (const agent of [
    {
      ...SUPERVISOR,
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.request_ack', 'agent.request_help'],
      ticketTypes: ['delivery'],
      responsibilities: ['Vigilar entregas sin confirmar', 'Pedir acuse al repartidor'],
      config: { followUpMinutes: 20 },
    },
    {
      ...ADVISOR,
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.complete_work'],
      ticketTypes: ['delivery'],
      responsibilities: ['Aclarar dudas del pedido'],
    },
  ]) {
    const created = await api('/api/admin/ops/agents', { method: 'POST', body: JSON.stringify(agent) });
    expect(created.status).toBe(201);
  }

  const ticket = await api('/api/admin/ops/tickets', {
    method: 'POST',
    body: JSON.stringify({
      type: 'delivery',
      title: 'Entrega sin confirmar (Centro IA)',
      description: 'El repartidor no confirma la entrega.',
      priority: 'high',
      requiresAck: true,
    }),
  });
  expect(ticket.status).toBe(201);
  ticketId = (await ticket.json()).ticket.id;
  const assign = await api(`/api/admin/ops/tickets/${ticketId}/agent`, {
    method: 'POST',
    body: JSON.stringify({ agentKey: SUPERVISOR.key }),
  });
  expect(assign.status).toBe(200);

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

  setValue($('#login-username'), ADMIN.username);
  setValue($('#login-password'), ADMIN.password);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'la app dentro');
}, 90_000);

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Entra al Centro IA como lo haría una persona (menú lateral) y va al EQUIPO. */
async function openCentro() {
  const item = $('[data-tab="ops"]');
  expect(item).toBeTruthy();
  click(item);
  await waitFor(() => Boolean($('#view-ops')?.dataset.shell), 'el armazón del Centro IA', 15_000);
  /* Si se llegó desde la bandeja o desde una oficina, se vuelve al equipo. */
  const back = $('[data-centro-nav="agents"]');
  if (back) click(back);
  await waitFor(() => $$('.centro-card').length >= 2, 'el equipo de agentes', 15_000);
}

describe('Centro IA · oficina de agentes', () => {
  it('la entrada es el EQUIPO, no una bandeja de tickets abierta', async () => {
    await openCentro();
    expect($('#view-ops').hidden).toBe(false);
    expect($('#ops-rows')).toBeNull();
    expect($$('.centro-card').length).toBe(2);
    expect($('.centro-dir__title')?.textContent).toContain('Agentes');
  });

  it('los agentes se listan solos, con su responsabilidad y su estado real', async () => {
    const cards = $$('.centro-card').map((card) => card.textContent.replace(/\s+/g, ' '));
    const supervisor = cards.find((text) => text.includes('Supervisor de reparto'));
    expect(supervisor).toBeTruthy();
    expect(supervisor).toContain('Seguimiento de entregas');
    /* Con un run vivo el estado es «Trabajando»; nunca se inventa otro. */
    expect(supervisor).toMatch(/Trabajando|En espera|Esperando aprobación/);
    expect(cards.some((text) => text.includes('Asesor comercial'))).toBe(true);
  });

  it('abre la oficina del agente con sus tickets y sus herramientas', async () => {
    const card = $$('.centro-card').find((node) => node.textContent.includes('Supervisor de reparto'));
    click(card);
    await waitFor(() => $('.centro-off'), 'la oficina del agente');
    await waitFor(() => $$('[data-centro-ticket]').length >= 1, 'los tickets asignados');

    expect($('.centro-id__name')?.textContent).toContain('Supervisor de reparto');
    const row = $('[data-centro-ticket]');
    expect(row.textContent).toContain('Entrega sin confirmar');

    /* Herramientas: las que el agente TIENE, con su riesgo. */
    const toolsTab = $$('[data-centro-office-tab]').find((node) => node.dataset.centroOfficeTab === 'tools');
    click(toolsTab);
    await waitFor(() => $$('.centro-toolrow').length >= 1, 'las herramientas');
    const tools = $$('.centro-toolrow').map((node) => node.textContent);
    expect(tools.join(' ')).toContain('agent.request_help');
    expect(tools.join(' ')).toContain('riesgo medio');
  });

  it('abre LA MISMA conversación del centro y el botón de volver regresa a la oficina', async () => {
    click($('[data-centro-office-tab="tickets"]'));
    await waitFor(() => Boolean($('[data-centro-ticket]')), 'la lista de asignados');
    click($('[data-centro-ticket]'));

    /* Se reutiliza el chat de la bandeja (no hay un segundo motor). */
    await waitFor(() => Boolean($('#ops-thread')), 'el hilo del ticket');
    await waitFor(() => ($('#ops-chat-head')?.textContent ?? '').includes('Entrega sin confirmar'), 'la cabecera del chat');
    expect($('#ops-search')).toBeTruthy();

    const back = $('[data-ops-back]');
    expect(back.getAttribute('aria-label')).toContain('oficina');
    click(back);
    await waitFor(() => Boolean($('.centro-off')), 'de vuelta en la oficina');
    expect($('.centro-id__name')?.textContent).toContain('Supervisor de reparto');
  });

  it('la bandeja completa sigue disponible desde el centro', async () => {
    click($('[data-centro-nav="tickets"]'));
    await waitFor(() => Boolean($('#ops-rows')), 'la bandeja');
    await waitFor(() => $$('.ops-row').length >= 1, 'la fila del ticket');
    expect($('.ops-row').textContent).toContain('Entrega sin confirmar');

    /* Y se vuelve al equipo sin perder el Centro IA. */
    dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:tab', { detail: { tab: 'hoy' } }));
    await openCentro();
    expect($$('.centro-card').length).toBe(2);
  }, 30_000);

  it('el Supervisor IA se alcanza desde el centro (una sola pantalla)', async () => {
    await openCentro();
    const nav = $$('[data-centro-nav]').find((node) => node.dataset.centroNav === 'supervisor');
    expect(nav).toBeTruthy();
    click(nav);
    await waitFor(() => dom.window.document.body.dataset.tab === 'supervisor', 'la pestaña del supervisor', 15_000);
    expect($('#view-supervisor')).toBeTruthy();
    /* La administración del supervisor NO se duplica en el centro. */
    expect($('#view-ops')?.querySelector('[data-sup-run]')).toBeNull();
  }, 30_000);

  it('la barra del centro ofrece aprobaciones y administración a quien puede', async () => {
    await openCentro();
    expect($('[data-ops-approvals]')).toBeTruthy();
    expect($('[data-ops-agents]')).toBeTruthy();
  }, 30_000);

  it('no se ha enviado ni un WhatsApp', () => {
    expect(app.whatsapp?.sent?.length ?? 0).toBe(0);
  });
});
