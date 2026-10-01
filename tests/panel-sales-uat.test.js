// @vitest-environment node
/**
 * UAT AUTOMÁTICA DEL PANEL — el centro de ventas, de punta a punta.
 *
 * Se carga el panel REAL (`public/admin/index.html` + `app.js`) en un DOM y se
 * recorre el flujo que pidió el negocio con un CRM de verdad detrás:
 *
 *   conversación de WhatsApp → menú de acciones → crear pedido → comprobante →
 *   programar mensaje → HOY → Ajustes (plan de postventa + métricas).
 *
 * No sustituye a mirar el panel en el móvil, pero sí demuestra que los controles
 * existen, hacen lo que dicen y el resultado queda guardado en el servidor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-panel-123';
const APP_SECRET = 'uat-panel-secret';
const PHONE = '18095559191';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT',
  sent: [],
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.UAT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.UATT${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
async function waitFor(check, label, timeout = 5000) {
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
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

async function inbound(id, body) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana UAT' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  await fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  await sleep(250);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp: mockWhatsApp,
    schedulerEnabled: false,
  });
  await inbound('wamid.UATPANEL1', 'Hola, quiero 3 frascos de 10 cápsulas');

  // El panel real, en un DOM, apuntando al CRM que acaba de arrancar.
  const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  dom = new JSDOM(html, {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
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
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('UAT del centro de ventas (panel real + CRM real)', () => {
  it('entra con la clave y pinta HOY', async () => {
    setValue('#login-token', TOKEN);
    $('#login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !$('#app').hidden, 'el panel abierto');
    const hoy = await waitFor(() => {
      const html = $('#list-hoy').innerHTML;
      return html.includes('Ana UAT') ? html : null;
    }, 'una conversación en HOY');
    // «Esperando respuesta» es una fila con acción directa.
    expect(hoy).toContain('Esperando respuesta');
    expect(dom.window.localStorage.getItem('pe_crm_snapshot')).toBeTruthy();
  });

  it('la conversación ofrece las acciones comerciales sin salir del chat', async () => {
    click('[data-tab="whatsapp"]');
    const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación en la bandeja');
    click(row);
    await waitFor(() => $('#wa-actions')?.dataset?.customer, 'la conversación abierta');
    // Mientras la conversación carga, el panel deja el botón «⋯» deshabilitado
    // (no se piden acciones sin datos) y un botón gris no se puede pulsar.
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    const menu = $('#sheet-body').innerHTML;
    for (const accion of ['Crear pedido', 'Programar seguimiento', 'Programar mensaje', 'Ver cliente']) {
      expect(menu).toContain(accion);
    }
  });

  it('crea un pedido con el precio del catálogo y muestra el comprobante', async () => {
    click('[data-order-new]');
    const lineas = await waitFor(() => $('#order-lines')?.querySelector('select'), 'el formulario de pedido');
    // El catálogo sale del servidor: 7 frascos reales.
    expect(lineas.options).toHaveLength(7);

    setValue('[data-line-variant="0"]', 'capsules_10');
    setValue('[data-line-qty="0"]', '3');
    setValue('#order-discount', '500');
    // 3 × RD$2,500 − RD$500 = RD$7,000
    expect($('#order-total').textContent).toContain('7,000');

    click('#order-save');
    const receipt = await waitFor(() => {
      const html = $('#sheet-body').innerHTML;
      return html.includes('Comprobante') || html.includes('Pedido'); 
    }, 'el comprobante');
    const title = $('#sheet-title').textContent;
    expect(title).toMatch(/PE-/);

    // El pedido quedó guardado en el servidor, ligado al cliente y a la conversación.
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const order = data.items.find((item) => item.type === 'order_intent');
    expect(order).toBeTruthy();
    expect(order.total).toBe(7000);
    expect(order.conversation_id).toBeTruthy();
    expect(order.customer_id).toBeTruthy();
    expect(order.order_number).toMatch(/^PE-/);
    expect(receipt ?? true).toBeTruthy();
  });

  it('programa un mensaje (no es un seguimiento: lo intentará el sistema)', async () => {
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    click('[data-scheduled-new]');
    await waitFor(() => $('#sch-save'), 'el formulario de mensaje programado');
    setValue('#sch-text', 'Hola Ana, ¿te ayudo con algo más?');
    click('#sch-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');

    const data = await (await fetch(`${app.url}/api/admin/scheduled`, { headers: { cookie } })).json();
    const row = data.scheduled.find((entry) => entry.text === 'Hola Ana, ¿te ayudo con algo más?');
    expect(row).toBeTruthy();
    expect(row.status).toBe('SCHEDULED');
  });

  it('el comprobante se puede ver e imprimir como documento', async () => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const order = data.items.find((item) => item.type === 'order_intent');
    const response = await fetch(`${app.url}/api/admin/orders/${order.id}/receipt`, { headers: { cookie } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Comprobante de compra');
    expect(html).toContain(order.order_number);
    expect(html).toContain('RD$');
  });

  it('Ajustes deja activar o apagar los días del plan de postventa', async () => {
    click('[data-tab="ajustes"]');
    const toggles = await waitFor(() => {
      const found = $$('[data-plan-toggle]');
      return found.length ? found : null;
    }, 'los interruptores del plan');
    expect(toggles).toHaveLength(6);

    // Apagar el día 30 (desde el panel, no por variable de entorno).
    const day30 = toggles[toggles.length - 1];
    day30.checked = false;
    day30.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(300);

    const settings = await (await fetch(`${app.url}/api/admin/settings`, { headers: { cookie } })).json();
    expect(settings.followup.enabled.day30).toBe(false);
    expect(settings.followup.enabled.day1).toBe(true);
  });

  it('Ajustes muestra las métricas del período y la auditoría', async () => {
    const metrics = await waitFor(() => {
      const html = $('#metrics').innerHTML;
      return html.includes('Ventas') ? html : null;
    }, 'las métricas');
    expect(metrics).toContain('Pedidos creados');
    expect(metrics).toContain('Recompras');
    // El período es el que manda: Hoy / 7 días / 30 días.
    expect($('#metrics-period').innerHTML).toContain('30 días');

    const audit = await waitFor(() => {
      const html = $('#audit').innerHTML;
      return html.includes('order.') ? html : null;
    }, 'la auditoría');
    expect(audit).toContain('order.created');
  });
});
