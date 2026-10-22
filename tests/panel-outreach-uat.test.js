// @vitest-environment node
/** Real panel + isolated CRM: scheduling, recovery, delivery and followup actions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-programados';
const APP_SECRET = 'uat-programados-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONES = { compra: '18095559101', interes: '18095559102' };
const NOMBRES = { [PHONES.compra]: 'Ana Compra', [PHONES.interes]: 'Luis Interés' };

const COMPRA_TEMPLATE = 'phyto_seguimiento_compra_v1';

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-PROG',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.TXT${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.TPL${whatsapp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let clockNow = new Date();
let loseNextScheduleResponse = false;
let forceOffline = false;
const ids = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(20);
  }
}

const $ = (selector) => dom.window.document.querySelector(selector);
const $$ = (selector) => [...dom.window.document.querySelectorAll(selector)];

/**
 * Las pantallas de Seguimientos y Mensajes programados ya NO tienen entrada en
 * el menú: viven dentro de «Centro IA → Agente de Seguimiento». Se abren por la
 * navegación interna del panel, que es la misma que usan los enlaces antiguos
 * (`?v=seguimientos`, `?v=mensajes`).
 */
const PANELES_SIN_MENU = ['seguimientos', 'mensajes'];
function gotoTab(tab) {
  dom.window.dispatchEvent(new dom.window.CustomEvent('fulltech:navigate', { detail: { tab } }));
}

const click = (element) => {
  const selector = typeof element === 'string' ? element : null;
  const tab = selector?.match(/^\[data-tab="([a-z-]+)"\]$/)?.[1] ?? null;
  const target = selector ? $(selector) : element;
  if (!target && tab && PANELES_SIN_MENU.includes(tab)) {
    gotoTab(tab);
    return true;
  }
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};
function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return input;
}

async function inbound(phone, id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: NOMBRES[phone] }, wa_id: phone }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

async function adminJson(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const programados = async () => (await adminJson('/api/admin/scheduled')).body.scheduled ?? [];

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-prog-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp,
    schedulerEnabled: false,
    clock: () => clockNow,
  });

  await inbound(PHONES.compra, 'wamid.PROG-1', 'Hola, quiero información');
  await inbound(PHONES.interes, 'wamid.PROG-2', 'Hola, ¿me pasas precios?');

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const data = (await adminJson('/api/admin/data')).body;
  const soloDigitos = (value) => String(value ?? '').replace(/\D/g, '');
  for (const conversation of data.conversations ?? []) {
    const phone = soloDigitos(conversation.customer?.phone_e164);
    const slot = Object.entries(PHONES).find(([, value]) => soloDigitos(value) === phone)?.[0];
    if (slot) {
      ids[slot] = conversation.id;
      ids[`${slot}Customer`] = conversation.customer_id;
    }
  }
  expect(ids.compra).toBeTruthy();
  expect(ids.interes).toBeTruthy();

  // Ana compró 8 frascos (6 o más). Luis no ha comprado nada.
  await adminJson('/api/admin/purchases', {
    method: 'POST',
    body: JSON.stringify({
      customerId: ids.compraCustomer,
      variantId: 'capsules_10',
      quantity: 8,
      paymentMethod: 'CASH',
      status: 'entregado',
    }),
  });

  // Las plantillas tienen que existir (las siembra el CRM al consultarlas) antes
  // de aprobarlas: si no, la fila nacería sin nombre amable ni cuerpo.
  await adminJson('/api/admin/wa-templates');

  // Solo la plantilla de COMPRA está aprobada; la de interés sigue pendiente.
  await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({ name: COMPRA_TEMPLATE, status: 'APPROVED' }),
  });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.alert = () => {};
  win.confirm = () => true;
  win.EventSource = class EventSourceFalso {
    constructor() {
      this.listeners = new Map();
      this.closed = false;
      this.readyState = 1;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
  };
  win.fetch = async (input, init = {}) => {
    if (forceOffline) throw new TypeError('Network unavailable');
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    const text = await response.text();
    if (loseNextScheduleResponse && new URL(url).pathname === '/api/admin/scheduled' && init.method === 'POST' && JSON.parse(init.body).customerId === ids.interesCustomer) { loseNextScheduleResponse = false; throw new TypeError('Network response lost'); }
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => setCookie ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  await waitFor(() => $$('[data-conv]').length >= 2, 'la lista con las dos conversaciones');
});

afterAll(async () => {
  dom?.window.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('seguimiento y programación desde el menú', () => {
  it('el grupo «Seguimiento» ya no está en el menú y las dos pantallas siguen funcionando', async () => {
    /* Se movieron al Centro IA: «Agente de Seguimiento». */
    expect($('nav[aria-label="Seguimiento"]')).toBeNull();
    expect($('[data-tab="seguimientos"]')).toBeNull();
    expect($('[data-tab="mensajes"]')).toBeNull();

    /* Y no se ha perdido nada: la pantalla abre con su enlace de siempre. */
    click('[data-tab="mensajes"]');
    await waitFor(() => $('#scheduled-refresh').disabled === false && $('#scheduled-list-caption').textContent.includes('mensajes'), 'bandeja cargada');
    expect($('#view-mensajes').hidden).toBe(false);
    expect($('#view-mensajes').textContent).not.toContain('Añadir plantilla');
  });

  it('muestra la búsqueda en el appbar y conserva el campo y su funcionamiento al navegar', async () => {
    expect($('#mobile-header #scheduled-search')).toBeTruthy();
    expect($('#scheduled-overview')).toBeNull();
    click('[data-tab="seguimientos"]');
    const search = $('#mobile-header #followup-search');
    expect(search).toBeTruthy();
    expect($('#followup-overview')).toBeNull();
    setValue(search, 'sin coincidencias uat');
    expect($$('#list-seguimientos .outreach-row')).toHaveLength(0);
    click('[data-tab="clientes"]');
    expect($('#view-seguimientos .outreach-search-store #followup-search')).toBe(search);
    click('[data-tab="seguimientos"]');
    expect($('#mobile-header #followup-search')).toBe(search);
    expect(search.value).toBe('sin coincidencias uat');
    setValue(search, '');
    expect($$('#list-seguimientos .outreach-row').length).toBeGreaterThan(0);
    click('[data-tab="mensajes"]');
  });

  it('abre los filtros en el drawer, aplica el estado y devuelve el foco al cerrarlo', async () => {
    const button = $('[data-outreach-filter-open]');
    const drawer = $('#outreach-filter-mensajes');
    expect(drawer.hidden).toBe(true);
    click(button);
    expect(drawer.hidden).toBe(false);
    expect(drawer.contains(dom.window.document.activeElement)).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    click('#scheduled-filters [data-schedule-filter="problems"]');
    expect($('#scheduled-list-caption').textContent).toContain('Sin enviar');
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer.hidden).toBe(true);
    expect(dom.window.document.activeElement).toBe(button);
    click(button);
    click('#scheduled-filters [data-schedule-filter="pending"]');
    click('#outreach-filter-mensajes aside [data-outreach-filter-close]:last-child');
    expect(drawer.hidden).toBe(true);
  });

  it('conserva la selección al buscar y muestra el mensaje personalizado para cada destinatario', async () => {
    click('#scheduled-create');
    await waitFor(() => $('#outreach-schedule-form'), 'formulario');
    const select = (id) => {
      const input = $(`[data-outreach-recipient="${id}"]`);
      input.checked = true;
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    };
    select(ids.compraCustomer);
    setValue('#outreach-client-search', 'Luis');
    select(ids.interesCustomer);
    expect($('#outreach-selected').textContent).toContain('2 clientes');
    setValue('#outreach-text', 'Te esperamos esta semana');
    setValue('#outreach-preview-client', ids.compraCustomer).dispatchEvent(new dom.window.Event('change'));
    expect($('#outreach-preview-text').textContent).toContain('Ana Compra');
    setValue('#outreach-preview-client', ids.interesCustomer).dispatchEvent(new dom.window.Event('change'));
    expect($('#outreach-preview-text').textContent).toContain('Luis Interés');
    expect($('#outreach-preview-text').textContent).not.toContain('Ana Compra');
    expect($('#outreach-preview-text').textContent).toContain('Te esperamos esta semana');
  });

  it('rechaza una hora pasada sin crear mensajes', async () => {
    setValue('#outreach-date', '2020-01-01');
    $('#outreach-schedule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect($('#outreach-save-feedback').textContent).toContain('futuras');
    expect(await programados()).toHaveLength(0);
  });

  it('recupera un fallo parcial sin duplicar mensajes, y envía una vez a cada cliente', async () => {
    const future = new Date(Date.now() + 3600000);
    setValue('#outreach-date', `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`);
    setValue('#outreach-time', `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`);
    loseNextScheduleResponse = true;
    const submit = () => $('#outreach-schedule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    submit();
    await waitFor(() => $('#outreach-save-feedback')?.textContent.includes('siguen seleccionados'), 'resultado parcial');
    expect($('#outreach-selected').textContent).toContain('1 cliente');
    expect(await programados()).toHaveLength(2); // The response was lost after persistence.
    submit();
    await waitFor(() => $('#sheet').hidden, 'reintento completado');
    const messages = await programados();
    expect(messages).toHaveLength(2);
    expect(messages.map((row) => row.customer_id).sort()).toEqual([ids.compraCustomer, ids.interesCustomer].sort());
    expect(messages.every((row) => row.template_body.includes('Te esperamos esta semana'))).toBe(true);
    clockNow = new Date(Math.max(...messages.map((row) => Date.parse(row.scheduled_at))) + 1000);
    // The server timer keeps working while the operator is on another screen.
    click('[data-tab="seguimientos"]');
    const stop = app.scheduler.start({ intervalMs: 1000 });
    try { await waitFor(async () => (await programados()).filter((row) => row.status === 'SENT').length === 2, 'envío automático'); } finally { stop(); }
    click('[data-tab="mensajes"]');
    const again = await app.scheduler.tick();
    expect(again.sent).toBe(0);
    expect(whatsapp.sent).toHaveLength(2);
    click('#scheduled-refresh');
    await waitFor(() => $('#scheduled-filters [data-schedule-filter="sent"]').textContent.includes('Enviados2'), 'estados de envío');
    click('[data-schedule-filter="sent"]');
    expect($$('#scheduled-list [data-schedule-row]')).toHaveLength(2);
  });

  it('crea un mensaje individual y permite editarlo y cancelarlo desde la bandeja', async () => {
    clockNow = new Date();
    click('#scheduled-create');
    await waitFor(() => $('#outreach-schedule-form'), 'formulario individual');
    const input = $(`[data-outreach-recipient="${ids.compraCustomer}"]`);
    input.checked = true;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    setValue('#outreach-text', 'Mensaje individual');
    $('#outreach-schedule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => $('#sheet').hidden, 'mensaje individual guardado');
    const row = (await programados()).find((row) => row.status === 'SCHEDULED');
    expect(row).toBeTruthy();
    await waitFor(() => $(`#scheduled-list [data-schedule-details="${row.id}"]`), 'mensaje pendiente en bandeja');
    click(`#scheduled-list [data-schedule-details="${row.id}"]`);
    click(`[data-scheduled-edit="${row.id}"]`);
    setValue('#sch-edit-text', 'Mensaje individual actualizado');
    click('#sch-edit-save');
    await waitFor(async () => (await programados()).find((entry) => entry.id === row.id)?.template_body.includes('actualizado'), 'cambio persistido');
    await waitFor(() => $('#sheet').hidden, 'edición cerrada');
    click(`#scheduled-list [data-schedule-details="${row.id}"]`);
    click(`#sheet [data-scheduled-cancel="${row.id}"]`);
    await waitFor(async () => (await programados()).find((entry) => entry.id === row.id)?.status === 'CANCELLED', 'cancelación persistida');
  });

  it('crea un seguimiento, lo encuentra con el buscador y lo marca hecho', async () => {
    click('[data-tab="seguimientos"]');
    click('#followup-create');
    const input = $(`[data-outreach-recipient="${ids.compraCustomer}"]`);
    input.checked = true;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click('#outreach-followup-next');
    setValue('#fu-reason', 'Revisar satisfacción UAT');
    click('#fu-save');
    await waitFor(() => $('#sheet').hidden, 'seguimiento guardado');
    setValue('#followup-search', 'Revisar satisfacción UAT');
    const done = await waitFor(() => $('#list-seguimientos [data-followup-done]'), 'nuevo seguimiento');
    const id = done.dataset.followupDone;
    click(`[data-followup-more="${id}"]`);
    const newDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    setValue('#outreach-followup-date', newDate);
    click('#outreach-followup-reschedule');
    await waitFor(() => $('#sheet').hidden, 'nueva fecha guardada');
    const rescheduled = (await adminJson('/api/admin/followups')).body.upcoming.find((row) => row.id === id);
    expect(rescheduled.scheduled_at).toBe(newDate);
    click(`#list-seguimientos [data-followup-done="${id}"]`);
    await waitFor(() => !$(`#list-seguimientos [data-followup-done="${id}"]`), 'seguimiento completado');
    const followups = (await adminJson('/api/admin/followups')).body;
    expect([...followups.today, ...followups.upcoming, ...followups.overdue].some((row) => row.id === id)).toBe(false);
  });

  it('excluye las plantillas que necesitan archivos y el servidor rechaza programarlas sin ellos', async () => {
    await adminJson('/api/admin/wa-templates', { method: 'POST', body: JSON.stringify({ name: 'phyto_envio_factura_v1', status: 'APPROVED' }) });
    const count = (await programados()).length;
    const result = await adminJson('/api/admin/scheduled', { method: 'POST', body: JSON.stringify({ customerId: ids.compraCustomer, type: 'template', template: 'phyto_envio_factura_v1', scheduledAt: new Date(Date.now() + 3600000).toISOString() }) });
    expect(result.response.status).toBe(422);
    expect(result.body.error).toBe('unsupported_scheduled_template');
    expect(await programados()).toHaveLength(count);
    click('[data-tab="mensajes"]');
    click('#scheduled-create');
    await waitFor(() => $('#outreach-template'), 'plantillas aptas para programación');
    expect($$('#outreach-template option').some((option) => option.value === 'phyto_envio_factura_v1')).toBe(false);
  });

  it('al completar sin conexión retira la tarea de su grupo y la sincroniza al volver la red', async () => {
    click('[data-close-sheet]');
    click('[data-tab="seguimientos"]');
    setValue('#followup-search', '');
    const button = await waitFor(() => $('#list-seguimientos [data-followup-done]'), 'tarea pendiente');
    const id = button.dataset.followupDone;
    forceOffline = true;
    try {
      click(button);
      await waitFor(() => !$(`#list-seguimientos [data-followup-done="${id}"]`), 'tarea completada en copia local');
      const remote = (await adminJson('/api/admin/followups')).body;
      expect([...remote.today, ...remote.upcoming, ...remote.overdue].some((row) => row.id === id)).toBe(true);
    } finally { forceOffline = false; }
    const synced = await dom.window.FullTECHLegacyOffline.synchronize();
    expect(synced.dropped).toBe(0);
    const remote = (await adminJson('/api/admin/followups')).body;
    expect([...remote.today, ...remote.upcoming, ...remote.overdue].some((row) => row.id === id)).toBe(false);
  });
});

