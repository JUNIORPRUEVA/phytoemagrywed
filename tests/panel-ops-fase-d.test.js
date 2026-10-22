// @vitest-environment jsdom
/**
 * UAT DEL PANEL — ETAPA D (agentes de IA y aprobación humana).
 *
 * Panel real (jsdom) + CRM real. Comprueba en la PANTALLA y en el SERVIDOR:
 *  - el mensaje de un agente se distingue del de una persona (chip «IA»);
 *  - la petición de cierre se pinta como TARJETA con sus parámetros a la vista;
 *  - «Aprobar y ejecutar» cierra el ticket de verdad y consume la aprobación;
 *  - la ficha muestra el agente asignado y el estado de su ejecución.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';
import { opsAgentTick } from '../server/ops/agents.mjs';

const TOKEN = 'uat-ops-d-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const ADMIN = { username: 'ana.pd@phyto.local', password: 'AnaPD-123456', name: 'Ana Admin' };

let tmpDir;
let app;
let dom;
let cookie = '';
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

async function api(route, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const serverTicket = async () => (await api(`/api/admin/ops/tickets/${ticketId}`)).body;

/** Una vuelta del motor de agentes (lo que hace el scheduler cada pasada). */
const tick = () =>
  opsAgentTick({
    ctx: app.ctx,
    deps: { notify: (input) => app.notifyUser(input) },
  });

/** Abre el Centro IA y entra en la sección de TICKETS (la entrada es el equipo). */
async function openOps() {
  const item = $('[data-tab="ops"]');
  if (item) item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  else dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:tab', { detail: { tab: 'ops' } }));
  await waitFor(() => Boolean($('#view-ops')?.dataset.shell), 'el armazón del centro', 15_000);
  /* Si ya estamos en la sección de tickets no hay pestaña que pulsar. */
  const tickets = $('[data-centro-nav="tickets"]');
  if (tickets) tickets.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-ops-d-'));
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

  const login = await fetch(`${app.url}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  /* Un agente autorizado a escribir y a PEDIR el cierre (no a cerrar solo). */
  const agent = await api('/api/admin/ops/agents', {
    method: 'POST',
    body: {
      key: 'asistente_uat',
      name: 'Asistente de reparto',
      tools: ['ticket.get_context', 'ticket.post_message', 'ticket.complete_work', 'ticket.close'],
      ticketTypes: ['admin'],
    },
  });
  expect(agent.status).toBe(201);

  const ticket = await api('/api/admin/ops/tickets', {
    method: 'POST',
    body: { type: 'admin', title: 'Cerrar cuando esté todo listo' },
  });
  expect(ticket.status).toBe(201);
  ticketId = ticket.body.ticket.id;

  const assigned = await api(`/api/admin/ops/tickets/${ticketId}/agent`, {
    method: 'POST',
    body: { agentKey: 'asistente_uat' },
  });
  expect(assigned.status).toBe(200);

  /* El agente saluda (dos pasos: contexto + mensaje). */
  await tick();
  await tick();

  /* El TRABAJO lo da por hecho una persona y el agente pide cerrar. */
  const run = (await app.collections.list('ops_agent_runs', { where: { ticket_id: ticketId }, limit: 10 }))[0];
  await app.ctx.db.update('ops_agent_runs', run.id, {
    state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
  });
  await app.ctx.db.update('ops_tickets', ticketId, { task: { completed_at: new Date().toISOString() } });
  await tick();

  const approvals = await app.collections.list('ops_agent_approvals', { where: { ticket_id: ticketId }, limit: 10 });
  expect(approvals.filter((row) => row.status === 'pending')).toHaveLength(1);

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.prompt = () => '';
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

describe('Centro de operaciones · Etapa D', () => {
  it('el mensaje del agente se distingue del de una persona', async () => {
    await openOps();
    await waitFor(() => $$('.ops-row').length >= 1, 'la fila del ticket');
    click('.ops-row');

    await waitFor(() => $('.ops-msg--agent'), 'la burbuja del agente');
    const agentMessage = $('.ops-msg--agent');
    expect(agentMessage.textContent).toContain('Asistente de reparto');
    expect(agentMessage.querySelector('.ops-chip--ai')).toBeTruthy();
    /* En la cabecera también aparece que el ticket tiene un agente asignado. */
    await waitFor(() => ($('#ops-chat-head')?.textContent ?? '').includes('IA · Asistente de reparto'), 'el chip de la cabecera');
  });

  it('la petición de cierre se pinta como tarjeta con sus parámetros', async () => {
    await waitFor(() => $('.ops-approval'), 'la tarjeta de aprobación');
    const card = $('.ops-approval');
    expect(card.dataset.state).toBe('pending');
    expect(card.textContent).toContain('ticket.close');
    /* Sin los parámetros a la vista, «Aprobar» sería un cheque en blanco. */
    expect(card.querySelectorAll('.ops-approval__params li').length).toBeGreaterThan(0);
    expect(card.textContent).toContain('Trabajo completado');
    expect($('[data-ops-approve]')).toBeTruthy();
    expect($('[data-ops-reject]')).toBeTruthy();
  });

  it('«Aprobar y ejecutar» cierra el ticket y consume la aprobación', async () => {
    const before = await serverTicket();
    expect(before.ticket.status).not.toBe('resolved');

    click('[data-ops-approve]');

    await waitForAsync(async () => (await serverTicket()).ticket.status === 'resolved', 'el ticket resuelto', 10_000);

    const after = await serverTicket();
    expect(after.ticket.status).toBe('resolved');
    const approval = (after.approvals ?? []).find((row) => row.tool === 'ticket.close');
    expect(approval.status).toBe('consumed');
    expect(approval.decidedByName).toBe(ADMIN.name);

    /* La tarjeta se repinta en su estado final y ya no deja volver a aprobar. */
    await waitFor(() => $('.ops-approval')?.dataset.state === 'consumed', 'la tarjeta ejecutada');
    expect($('[data-ops-approve]')).toBeNull();
  });

  it('la ficha muestra el agente asignado y el estado de su ejecución', async () => {
    click('[data-ops-detail]');
    await waitFor(() => $('.ops-detail-card'), 'la ficha');
    const card = $('.ops-detail-card');
    expect(card.textContent).toContain('Agentes');
    expect(card.textContent).toContain('Asistente de reparto');
    /* El estado de la ejecución se ve en la propia fila del agente. */
    const meta = card.querySelector('.ops-agent-run .ops-person__meta')?.textContent ?? '';
    expect(meta).toMatch(/En cola|Trabajando|Espera tu aprobación|En espera|Terminado|Con error|Cancelado/);
    /* El selector para asignar agentes solo lo ve administración. */
    expect($('#ops-agent-pick')).toBeTruthy();
  });

  it('el hilo conserva el rastro del cierre en la actividad', async () => {
    const view = await serverTicket();
    expect(view.events.some((event) => event.kind === 'approval_executed')).toBe(true);
    expect(view.events.some((event) => event.kind === 'resolved')).toBe(true);
  });

  /* ------------- bandeja de aprobaciones (R5), registro de agentes (R4) y
                motivo del rechazo en hoja propia (R7) ------------- */

  /** Deja un ticket con una aprobación de cierre pendiente, por API y motor. */
  async function pendingApprovalTicket(title) {
    const created = await api('/api/admin/ops/tickets', { method: 'POST', body: { type: 'admin', title } });
    const id = created.body.ticket.id;
    const assigned = await api(`/api/admin/ops/tickets/${id}/agent`, {
      method: 'POST',
      body: { agentKey: 'asistente_uat' },
    });
    expect(assigned.status).toBe(200);
    const run = (await app.collections.list('ops_agent_runs', { where: { ticket_id: id }, limit: 10 }))[0];
    await app.ctx.db.update('ops_agent_runs', run.id, {
      state: { contextLoaded: true, greeted: true, lastSeenSeq: 0, workCompleted: true },
    });
    await app.ctx.db.update('ops_tickets', id, { task: { completed_at: new Date().toISOString() } });
    await tick();
    return id;
  }

  it('la bandeja reúne lo pendiente, dice de qué ticket es y se decide ahí', async () => {
    const pendingId = await pendingApprovalTicket('Cierre que espera en la bandeja');
    const pendingNumber = (await api(`/api/admin/ops/tickets/${pendingId}`)).body.ticket.number;

    /* Se cierra la ficha que quedó abierta y se entra por la barra del centro. */
    if ($('#ops-sheet') && !$('#ops-sheet').hidden) click('[data-ops-sheet-close]');
    await waitFor(() => $('#ops-sheet').hidden, 'la hoja cerrada');

    await waitFor(() => $('[data-ops-approvals]'), 'el botón de aprobaciones');
    click('[data-ops-approvals]');
    await waitFor(() => $('.ops-approvals-card .ops-inbox-approval'), 'la petición en la bandeja');

    const card = $('.ops-approvals-card');
    expect(card.textContent).toContain('ticket.close');
    /* Antes había que entrar al ticket para saber a cuál pertenecía. */
    expect(card.textContent).toContain(pendingNumber);
    expect(card.querySelector('[data-ops-approve]')).toBeTruthy();

    click('.ops-approvals-card [data-ops-approve]');
    await waitForAsync(
      async () => (await api(`/api/admin/ops/tickets/${pendingId}`)).body.ticket.status === 'resolved',
      'el ticket resuelto desde la bandeja',
      12_000,
    );
    /* Ya no queda nada pendiente: la tarjeta desaparece de la bandeja. */
    await waitFor(() => !$('.ops-approvals-card [data-ops-approve]'), 'la bandeja sin pendientes');
  }, 30_000);

  it('el alta de agentes se hace desde el panel, no solo por API', async () => {
    click('[data-ops-agents]');
    await waitFor(() => $('.ops-agentform'), 'el formulario de agentes');
    /* En «Nuevo agente» los campos van VACÍOS: si se heredara el último agente,
       se editaría el existente sin querer. */
    expect($('.ops-agentform').dataset.editing).toBe('');
    expect($('.ops-agentform input[name="key"]').value).toBe('');

    setValue('.ops-agentform input[name="key"]', 'asistente_panel');
    setValue('.ops-agentform input[name="name"]', 'Asistente del panel');
    /* Se marcan dos herramientas del catálogo REAL que sirve el servidor. */
    for (const name of ['ticket.get_context', 'ticket.post_message']) {
      const input = $(`.ops-agentform input[name="tools"][value="${name}"]`);
      expect(input).toBeTruthy();
      input.checked = true;
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
    $('.ops-agentform').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await waitForAsync(async () => {
      /* Si el servidor rechaza el alta, se dice POR QUÉ en vez de esperar a ciegas. */
      if ($('.ops-error')) throw new Error(`el panel rechazó el alta: ${$('.ops-error').textContent}`);
      return (await api('/api/admin/ops/agents')).body.agents.some((row) => row.key === 'asistente_panel');
    }, 'el agente creado desde el panel');
    /* Los permisos los deriva el servidor de las herramientas marcadas. */
    const stored = (await api('/api/admin/ops/agents')).body.agents.find((row) => row.key === 'asistente_panel');
    expect(stored.permissions).toEqual(expect.arrayContaining(['tickets.read', 'tickets.reply']));
    expect(stored.permissions).not.toContain('tickets.close');
    await waitFor(() => ($('.ops-agents-card')?.textContent ?? '').includes('Asistente del panel'), 'el agente en la lista');
  }, 30_000);

  it('rechazar pide el motivo en una hoja del panel, no en un diálogo del sistema', async () => {
    const pendingId = await pendingApprovalTicket('Cierre que se va a rechazar');
    /* Si alguien vuelve a `window.prompt`, esta prueba lo canta. */
    dom.window.prompt = () => {
      throw new Error('se usó window.prompt');
    };

    /* Se reabre SIEMPRE: la bandeja anterior quedó sin pendientes. */
    click('[data-ops-approvals]');
    await waitFor(() => $('.ops-approvals-card [data-ops-reject]'), 'el botón de rechazar');    click('.ops-approvals-card [data-ops-reject]');
    await waitFor(() => $('[data-ops-reject-form]'), 'la hoja del motivo');

    setValue('[data-ops-reject-form] textarea[name="note"]', 'Falta la firma del cliente');
    $('[data-ops-reject-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await waitForAsync(async () => {
      const view = await api(`/api/admin/ops/tickets/${pendingId}`);
      return (view.body.approvals ?? []).some((row) => row.status === 'rejected');
    }, 'el rechazo guardado');

    const view = await api(`/api/admin/ops/tickets/${pendingId}`);
    expect(view.body.ticket.status).not.toBe('resolved');
    const rejected = view.body.approvals.find((row) => row.status === 'rejected');
    expect(rejected.decisionNote).toBe('Falta la firma del cliente');
  }, 30_000);
});
