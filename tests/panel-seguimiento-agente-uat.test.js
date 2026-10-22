// @vitest-environment jsdom
/**
 * UAT DE PANEL — AGENTE DE SEGUIMIENTO (Centro IA).
 *
 * Se carga el panel REAL y se navega como una persona: menú lateral → Centro IA
 * → Agente de Seguimiento → conversar / seguimientos / programados /
 * aprobaciones. Todo con datos ficticios y un WhatsApp simulado que solo apunta
 * lo que se envía (nunca sale a la red).
 *
 * Lo que se demuestra:
 *   - el menú ya no tiene «Seguimientos» ni «Mensajes programados», pero las
 *     pantallas antiguas (`?v=seguimientos`, `?v=mensajes`) siguen existiendo;
 *   - el agente se da de alta desde el propio Centro IA;
 *   - una propuesta NO crea nada; al aprobarla se crea de verdad y aparece en
 *     la lista del agente;
 *   - una programación aprobada se envía con el programador aunque no haya
 *     proveedor de IA y aunque el panel esté cerrado;
 *   - el estado «Programado» y «Enviado» se distinguen a simple vista.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'panel-work-token';
const ADMIN = { username: 'panel.work', password: 'Panel-Work-123', name: 'Ana Trabajo' };
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const sent = [];

let tmpDir;
let app;
let dom;
let cookie = '';
let customerId = '';
let conversationId = '';
let scheduledId = '';
let followupId = '';

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];
const text = (selector) => ($(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function waitFor(check, label, timeout = 12_000) {
  const started = Date.now();
  for (;;) {
    /* La comprobación puede ser síncrona o asíncrona: se espera en ambos casos. */
    const value = await check();
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-panel-work-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'panel-work.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    whatsapp: {
      enabled: true,
      phoneNumberId: 'pnid-uat',
      /* Simulado: apunta lo enviado y NUNCA sale a la red. */
      async sendText(to, body) {
        sent.push({ to, body, type: 'text' });
        return { ok: true, status: 200, messageId: `wamid.UAT${sent.length}` };
      },
      async sendTemplate(to, template) {
        sent.push({ to, template, type: 'template' });
        return { ok: true, status: 200, messageId: `wamid.UATT${sent.length}` };
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

  /* Un cliente REAL con conversación y ventana de 24 h abierta. */
  const start = await api('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone: '+18095550800', name: 'Cliente del agente' }),
  });
  const body = await start.json();
  customerId = body.customer?.id ?? body.customerId;
  conversationId = body.conversation?.id ?? body.conversationId;
  expect(customerId).toBeTruthy();
  await app.ctx.db.update('conversations', conversationId, { last_inbound_at: new Date().toISOString() });

  /* Un seguimiento REAL por la ruta de siempre (datos previos que se conservan). */
  const followup = await api('/api/admin/followups', {
    method: 'POST',
    body: JSON.stringify({ customerId, reason: 'Llamar para confirmar la recompra', date: '2030-01-15' }),
  });
  expect(followup.status).toBeLessThan(300);
  followupId = (await followup.json()).followup?.id ?? '';

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

/** Abre el Centro IA desde el menú lateral. */
async function openCentro() {
  click($('[data-tab="ops"]'));
  await waitFor(() => Boolean($('#view-ops')?.dataset.shell), 'el armazón del Centro IA', 15_000);
}

/** Entra en la oficina del Agente de Seguimiento. */
async function openWorkAgent() {
  await openCentro();
  const back = $('[data-centro-nav="agents"]');
  if (back) click(back);
  await waitFor(() => $$('.centro-card').length >= 1, 'el equipo de agentes', 15_000);
  const card = $$('.centro-card').find((node) => node.textContent.includes('Agente de Seguimiento'));
  expect(card).toBeTruthy();
  click(card);
  await waitFor(() => Boolean($('[data-work-tab]')), 'las secciones del agente', 15_000);
}

async function workTab(key) {
  click($(`[data-work-tab="${key}"]`));
  await waitFor(() => $(`[data-work-tab="${key}"]`)?.getAttribute('aria-current') === 'true', `la sección ${key}`);
}

describe('menú lateral', () => {
  it('ya no tiene entradas de Seguimientos ni de Mensajes programados', async () => {
    await openCentro();
    const drawer = [...dom.window.document.querySelectorAll('.drawer__section')].map((node) => node.textContent.replace(/\s+/g, ' '));
    expect(drawer.some((entry) => /Seguimientos/i.test(entry))).toBe(false);
    expect(drawer.some((entry) => /Mensajes programados/i.test(entry))).toBe(false);
    expect($('[data-tab="seguimientos"]')).toBeNull();
    expect($('[data-tab="mensajes"]')).toBeNull();
  }, 40_000);

  it('las pantallas antiguas siguen existiendo (enlaces viejos, sin romper nada)', () => {
    expect($('#view-seguimientos')).toBeTruthy();
    expect($('#view-mensajes')).toBeTruthy();
    /* Y conservan su creación manual (la funcionalidad no se ha perdido). */
    expect($('#followup-create')).toBeTruthy();
    expect($('#scheduled-create') ?? $('#list-mensajes')).toBeTruthy();
  }, 40_000);
});

describe('alta y oficina del agente', () => {
  it('se da de alta desde el propio Centro IA y queda su ficha', async () => {
    await openCentro();
    const seed = await waitFor(() => $('[data-work-seed]'), 'el aviso de alta del agente', 15_000);
    click(seed);
    await waitFor(() => $$('.centro-card').some((node) => node.textContent.includes('Agente de Seguimiento')), 'la ficha del agente', 15_000);
    const card = $$('.centro-card').find((node) => node.textContent.includes('Agente de Seguimiento'));
    expect(card.textContent).toContain('Seguimientos y mensajes programados');
  }, 40_000);

  it('la oficina tiene las cuatro secciones y los datos reales del agente', async () => {
    await openWorkAgent();
    const tabs = $$('[data-work-tab]').map((node) => node.dataset.workTab);
    expect(tabs).toEqual(['chat', 'followups', 'scheduled', 'approvals']);
    expect(text('.centro-id__name')).toContain('Agente de Seguimiento');
    /* Los números salen de los datos, no de un texto fijo. */
    const work = await (await api('/api/admin/ops/work')).json();
    expect(work.followups.counts.today + work.followups.counts.overdue).toBeGreaterThanOrEqual(1);
  }, 40_000);
});

describe('seguimientos dentro del agente', () => {
  it('muestra el seguimiento que ya existía y lo completa con la ruta de siempre', async () => {
    await openWorkAgent();
    await workTab('followups');
    await waitFor(() => $$('[data-work-fu]').length >= 1, 'la fila del seguimiento');
    expect(text('.centro-off__body')).toContain('Llamar para confirmar la recompra');

    const completed = await app.ctx.db.get('followups', followupId);
    expect(completed.status).toBe('pending');

    const button = $$('[data-work-fu="complete"]')[0];
    click(button);
    await waitFor(async () => {
      const row = await app.ctx.db.get('followups', followupId);
      return row.status === 'completed';
    }, 'el seguimiento completado', 15_000);
    expect((await app.ctx.db.get('followups', followupId)).status).toBe('completed');
  }, 40_000);
});

describe('propuesta → aprobación → ejecución', () => {
  it('una propuesta no crea nada y al aprobarla crea el mensaje programado', async () => {
    await openWorkAgent();
    const when = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const body = 'Recordatorio aprobado desde el Centro IA: su pedido sigue en preparación.';
    const proposal = await (
      await api('/api/admin/ops/work/propose', {
        method: 'POST',
        body: JSON.stringify({ action: 'schedule.create', params: { customerId, text: body, scheduledAt: when } }),
      })
    ).json();
    expect(proposal.ok).toBe(true);
    scheduledId = proposal.proposal.id;

    const queueBefore = await app.ctx.db.list('scheduled_messages', { limit: 20 });
    await workTab('approvals');
    await waitFor(() => Boolean($(`[data-work-approve="${scheduledId}"]`)), 'la propuesta pendiente', 15_000);
    expect(text('.centro-off__body')).toContain('Pendiente');
    /* Nada creado todavía. */
    expect((await app.ctx.db.list('scheduled_messages', { limit: 20 })).length).toBe(queueBefore.length);

    click($(`[data-work-approve="${scheduledId}"]`));
    await waitFor(async () => (await app.ctx.db.list('scheduled_messages', { limit: 20 })).length === queueBefore.length + 1, 'la fila en cola', 15_000);

    const rows = await app.ctx.db.list('scheduled_messages', { limit: 20 });
    const row = rows.find((item) => item.text === body);
    expect(row).toBeTruthy();
    expect(row.status).toBe('SCHEDULED');
    expect(row.scheduled_at).toBe(when);
    scheduledId = row.id;

    /* Y las DOS cosas se ven distintas: propuesta aprobada ≠ mensaje enviado. */
    await workTab('scheduled');
    await waitFor(() => text('.centro-off__body').includes('Programado'), 'el estado Programado');
    expect(sent.length).toBe(0);
  }, 40_000);
});

describe('el programador trabaja solo', () => {
  it('envía lo aprobado sin panel, sin modelo y sin volver a preguntar', async () => {
    const llmDown = await api('/api/admin/ops/work/chat', {
      method: 'POST',
      body: JSON.stringify({ message: '¿qué toca hoy?' }),
    });
    /* Sin proveedor de IA configurado en la UAT: se dice, no se inventa. */
    expect(llmDown.status).toBe(503);

    await app.ctx.db.update('scheduled_messages', scheduledId, { scheduled_at: new Date(Date.now() - 60_000).toISOString() });
    await app.scheduler.tick();

    await waitFor(async () => (await app.ctx.db.get('scheduled_messages', scheduledId)).status !== 'SCHEDULED', 'el envío', 15_000);
    const row = await app.ctx.db.get('scheduled_messages', scheduledId);
    expect(['SENT', 'DELIVERED', 'READ']).toContain(row.status);
    expect(sent.length).toBe(1);
    expect(sent[0].body).toContain('Recordatorio aprobado desde el Centro IA');
  }, 40_000);

  it('la cola lo refleja como Enviado y el chat sigue funcionando sin modelo', async () => {
    await openWorkAgent();
    await workTab('scheduled');
    await waitFor(() => text('.centro-off__body').includes('Enviado'), 'el estado Enviado', 15_000);

    await workTab('chat');
    await waitFor(() => Boolean($('[data-work-ask] textarea')), 'la caja de preguntas');
    setValue($('[data-work-ask] textarea'), '¿qué clientes necesitan seguimiento hoy?');
    $('[data-work-ask]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $$('.ops-msg--agent').length >= 1, 'la respuesta del agente', 15_000);
    expect(text('.ops-msg--agent')).toBeTruthy();
    expect(text('.ops-msg--agent')).not.toContain('No tengo una respuesta');
  }, 40_000);
});

describe('ida y vuelta con las pantallas de siempre', () => {
  it('«Pantalla completa» lleva a la pantalla antigua sin duplicar funciones', async () => {
    await openWorkAgent();
    await workTab('followups');
    const full = $('[data-work-full]');
    expect(full.dataset.workFull).toBe('seguimientos');
    click(full);
    await waitFor(() => $('#view-seguimientos')?.hidden === false, 'la pantalla de seguimientos', 15_000);

    await openWorkAgent();
    await workTab('scheduled');
    click($('[data-work-full]'));
    await waitFor(() => $('#view-mensajes')?.hidden === false, 'la pantalla de mensajes programados', 15_000);
  }, 40_000);
});
