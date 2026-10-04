// @vitest-environment node
/**
 * UAT DEL PANEL — «Enviar factura por WhatsApp» desde el CRM.
 *
 * Se carga el panel REAL (`public/admin/index.html` + `app.js`) en un DOM, con un
 * CRM de verdad detrás, y se recorre la acción tal y como la pulsa un agente:
 *
 *   pedido → factura → botón flotante → «Enviar factura por WhatsApp» → confirmar.
 *
 * Lo que se protege aquí:
 *   - el botón NO abre WhatsApp Web, ni la app, ni el menú de compartir del
 *     sistema (`navigator.share`), ni manda a descargar el PDF;
 *   - antes de enviar se dice a quién y QUÉ documento va a salir (vista previa del
 *     servidor: el panel no inventa el texto ni el nombre del archivo);
 *   - un toque envía UNA factura y el botón no acepta un segundo toque mientras
 *     envía (y si llegara, el servidor reconoce la misma operación);
 *   - la factura queda EN EL HILO, con su nombre de archivo y su documento;
 *   - fuera de la ventana de 24 h, sin plantilla aprobada, se explica y NO se envía.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-factura-panel-123';
const APP_SECRET = 'uat-factura-panel-secreto';
const PHONE = '18095553001';

const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const APP_JS = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');

/** R2 de mentira: guarda en memoria, sin red ni credenciales. */
const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'uat-factura-panel',
  objects: new Map(),
  async put(key, buffer) {
    storage.objects.set(key, Buffer.from(buffer));
    return { ok: true, objectKey: key, size: buffer.length };
  },
  async get(key) {
    const found = storage.objects.get(key);
    return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
  },
};

/** Graph de mentira: anota TODO lo que se intenta enviar (nunca sale a la red). */
const graph = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-FACTURA',
  businessAccountId: 'WABA1',
  sent: [],
  documents: [],
  uploads: [],
  templateList: [],
  secuencia: 0,
  async sendText(to, body) {
    graph.secuencia += 1;
    graph.sent.push({ kind: 'text', to, body });
    return { ok: true, status: 200, messageId: `wamid.PANEL-TXT${graph.secuencia}` };
  },
  async sendTemplate(to, template) {
    graph.secuencia += 1;
    graph.sent.push({ kind: 'template', to, template });
    return { ok: true, status: 200, messageId: `wamid.PANEL-TPL${graph.secuencia}` };
  },
  async sendDocument(to, input) {
    graph.secuencia += 1;
    graph.documents.push({ to, ...input });
    return { ok: true, status: 200, waMessageId: `wamid.PANEL-DOC${graph.secuencia}` };
  },
  async sendImage() {
    return { ok: true, status: 200, waMessageId: 'wamid.PANEL-IMG' };
  },
  async sendAudio() {
    return { ok: true, status: 200, waMessageId: 'wamid.PANEL-AUD' };
  },
  async uploadMedia(input) {
    graph.uploads.push({ mimeType: input.mimeType, filename: input.filename, bytes: input.buffer.length });
    return { ok: true, status: 200, mediaId: `mid_panel_${graph.uploads.length}` };
  },
  async listTemplates() {
    return { ok: true, status: 200, templates: graph.templateList };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
let ordenId = '';
let conversacionId = '';
let /** Enlaces externos que intentó abrir el panel (`window.open`). */ aperturas = [];
let /** Menú de compartir del sistema: si alguien lo llama, la prueba lo caza. */ compartir = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (selector) => dom.window.document.querySelector(selector);

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
async function waitFor(check, label, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(25);
  }
}

const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
  // Un botón deshabilitado es un botón que NO se puede pulsar (segundo toque).
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

const setValue = (selector, value) => {
  const input = $(selector);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

async function call(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, response };
}

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
              contacts: [{ profile: { name: 'Ana Factura UAT' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
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

/** pedido → factura → botón flotante → menú de acciones de la factura. */
async function abrirMenuFactura() {
  click('[data-tab="pedidos"]');
  const fila = await waitFor(() => $('#list-pedidos .order-row'), 'la lista de pedidos');
  click(fila);
  const fabPedido = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
  click(fabPedido);
  const verFactura = await waitFor(() => $('[data-receipt]'), 'la acción de ver factura');
  click(verFactura);
  await waitFor(() => ($('#sheet-title')?.textContent?.startsWith('Factura') ? true : null), 'el comprobante');
  const fabFactura = await waitFor(() => $('#sheet-body [data-receipt-actions]'), 'el botón flotante de la factura');
  click(fabFactura);
  return waitFor(() => ($('#sheet-body .menu-list') ? $('#sheet-body') : null), 'las acciones de la factura');
}

/** Abre la hoja de envío y devuelve su contenido. */
async function abrirHojaEnvio() {
  await abrirMenuFactura();
  const boton = await waitFor(() => $('[data-receipt-wa]'), 'la acción de enviar la factura por WhatsApp');
  click(boton);
  return waitFor(
    () => ($('#sheet-title')?.textContent === 'Enviar factura por WhatsApp' ? $('#sheet-body') : null),
    'la hoja de envío',
  );
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-panel-factura-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsappPhoneNumber: '+18095550000',
    whatsapp: graph,
    whatsappMedia: graph,
    storage,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0];

  // El cliente escribe: así nace su conversación (y la ventana de 24 h abierta).
  await inbound('wamid.PANEL-1', 'Hola, quiero mi factura');
  await sleep(200);
  const bandeja = await call('/api/admin/conversations');
  conversacionId = bandeja.body.conversations[0].id;
  const clienteId = bandeja.body.conversations[0].customer_id;

  const pedido = await call('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      customerId: clienteId,
      conversationId: conversacionId,
      items: [{ variantId: 'capsules_10', quantity: 2, unitPrice: 2500 }],
      paymentMethod: 'CASH',
    }),
  });
  if (pedido.status !== 201) throw new Error(`no se pudo crear el pedido: ${JSON.stringify(pedido.body)}`);
  ordenId = pedido.body.item.id;

  // El panel real, en un DOM, apuntando al CRM que acaba de arrancar.
  const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: `${app.url}/admin/`, runScripts: 'outside-only', pretendToBeVisual: false });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  /*
   * Aquí se cazan las salidas EXTERNAS: si el panel intentara abrir WhatsApp Web,
   * la app, o el menú de compartir del teléfono, estas funciones se llamarían y
   * las pruebas de abajo fallarían.
   */
  win.open = (...args) => {
    aperturas.push(args);
    return null;
  };
  compartir = vi.fn(async () => {});
  Object.defineProperty(win.navigator, 'share', { value: compartir, configurable: true });
  Object.defineProperty(win.navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(win.navigator, 'canShareFiles', { value: () => true, configurable: true });
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  win.eval(APP_JS);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#login').hidden || !$('#app').hidden, 'la pantalla de acceso');

  setValue('#login-token', TOKEN);
  $('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !$('#app').hidden, 'el panel abierto');
  await waitFor(() => $('#list-pedidos .order-row'), 'los pedidos del CRM');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('enviar la factura por WhatsApp desde el panel', () => {
  it('el menú de la factura ofrece ENVIARLA (ya no «compartir» con el sistema)', async () => {
    const menu = await abrirMenuFactura();
    expect(menu.textContent).toContain('Enviar factura por WhatsApp');
    expect(menu.textContent).not.toContain('Compartir factura');
    // Y no queda ni rastro del camino viejo en el código del panel.
    expect(APP_JS).not.toContain('shareReceiptPdf');
    expect(APP_JS).not.toContain('data-receipt-share');
    expect(APP_JS).not.toContain('navigator.canShare');
  });

  it('antes de enviar dice a quién, qué documento y con qué texto (vista previa)', async () => {
    const hoja = await abrirHojaEnvio();
    expect(hoja.textContent).toContain('Cliente');
    expect(hoja.textContent).toContain('Pedido');
    expect(hoja.textContent).toContain('Documento');
    expect(hoja.querySelector('#invoice-preview').textContent).toContain('Ana Factura UAT');
    expect(hoja.querySelector('#invoice-preview').textContent).toContain('te compartimos la factura de tu pedido');
    // La hoja NO ofrece ninguna salida a WhatsApp de fuera del CRM.
    expect(hoja.innerHTML).not.toContain('wa.me');
    expect(hoja.innerHTML).not.toContain('whatsapp://');
    expect(hoja.querySelector('#invoice-send').disabled).toBe(false);
    // El botón se anuncia con la acción real, no con «compartir».
    expect(hoja.querySelector('#invoice-send').textContent).toContain('Enviar factura');
    click('[data-close-sheet]');
  });

  it('un toque la envía de verdad: documento nativo con su nombre, sin salir del CRM', async () => {
    compartir.mockClear();
    aperturas = [];
    const antesDocumentos = graph.documents.length;
    const antesTextos = graph.sent.length;

    const hoja = await abrirHojaEnvio();
    const nombreArchivo = hoja.querySelector('.facts').textContent.match(/Factura-[A-Za-z0-9_-]+\.pdf/)[0];
    click('#invoice-send');

    await waitFor(() => graph.documents.length > antesDocumentos ? true : null, 'el documento en WhatsApp');
    await waitFor(() => ($('#toast')?.hidden === false ? true : null), 'el aviso de enviado');

    expect(graph.documents).toHaveLength(antesDocumentos + 1);
    expect(graph.sent).toHaveLength(antesTextos + 1);
    expect(graph.documents.at(-1).to).toBe(`+${PHONE}`);
    expect(graph.documents.at(-1).filename).toBe(nombreArchivo);
    expect($('#toast').textContent).toContain('Factura enviada por WhatsApp');
    // Nada de WhatsApp Web, ni la app, ni el menú de compartir del teléfono.
    expect(aperturas).toHaveLength(0);
    expect(compartir).not.toHaveBeenCalled();
    // La hoja se cierra sola: la acción terminó.
    expect($('#sheet').hidden).toBe(true);
  });

  it('un segundo toque NO manda otra factura (y el servidor tampoco la duplicaría)', async () => {
    compartir.mockClear();
    aperturas = [];
    const antesDocumentos = graph.documents.length;

    await abrirHojaEnvio();
    // Dos toques seguidos: el botón se bloquea en el primero (estado «Enviando…»).
    const primero = click('#invoice-send');
    const segundo = click('#invoice-send');
    expect(primero).toBe(true);
    expect(segundo).toBe(false);

    await waitFor(() => graph.documents.length > antesDocumentos ? true : null, 'la factura enviada');
    await sleep(300);
    expect(graph.documents).toHaveLength(antesDocumentos + 1);
    expect(aperturas).toHaveLength(0);
    expect(compartir).not.toHaveBeenCalled();
  });

  it('la factura queda EN EL HILO con su nombre, y se abre desde el propio CRM', async () => {
    click('[data-tab="whatsapp"]');
    const fila = await waitFor(() => $(`[data-conv="${conversacionId}"]`), 'la conversación en la bandeja');
    click(fila);
    const tarjeta = await waitFor(
      () => $('#thread').querySelector('.doc-card'),
      'la factura en el hilo',
    );
    expect(tarjeta.textContent).toMatch(/Factura-[A-Za-z0-9_-]+\.pdf/);
    expect(tarjeta.textContent).toContain('Enviado');
    // Se abre desde el archivo privado del CRM (con sesión), no con un enlace de fuera.
    expect(tarjeta.getAttribute('href')).toMatch(/^\/api\/admin\/media\//);
    expect(tarjeta.getAttribute('target')).toBe('_blank');
  });

  it('fuera de la ventana y SIN plantilla aprobada lo explica y no envía nada', async () => {
    // La conversación se queda sin ventana de 24 h (el cliente escribió hace 30 h).
    await app.collections.update('conversations', conversacionId, {
      last_inbound_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    compartir.mockClear();
    aperturas = [];
    const antesDocumentos = graph.documents.length;
    const antesTextos = graph.sent.length;

    const hoja = await abrirHojaEnvio();
    const nota = hoja.querySelector('#invoice-note').textContent;
    expect(nota).toContain('24 h');
    expect(nota).toContain('phyto_envio_factura_v1');
    expect(hoja.querySelector('#invoice-send').disabled).toBe(true);

    // Pulsar (aunque el botón está deshabilitado) no envía nada.
    click('#invoice-send');
    await sleep(300);
    expect(graph.documents).toHaveLength(antesDocumentos);
    expect(graph.sent).toHaveLength(antesTextos);
    expect(aperturas).toHaveLength(0);
    expect(compartir).not.toHaveBeenCalled();
    // Y la vista previa del servidor dice lo mismo (una sola verdad).
    const vista = await call(`/api/admin/orders/${ordenId}/invoice-whatsapp`);
    expect(vista.body.sendable).toBe(false);
    expect(vista.body.insideWindow).toBe(false);
    click('[data-close-sheet]');
  });
});
