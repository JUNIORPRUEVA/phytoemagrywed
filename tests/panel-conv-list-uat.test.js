// @vitest-environment jsdom
/**
 * UAT DEL PANEL — LISTA DE CONVERSACIONES (con el servidor de verdad y dobles).
 *
 * Lo que se demuestra aquí, que es lo que se pidió:
 *   - cada fila lleva la FECHA Y HORA exactas del último mensaje y, debajo,
 *     cuánto hace (el sello completo, con año, vive en el `title`);
 *   - la fila termina en un «⋯» con las acciones de ESA conversación, y ninguna
 *     de esas acciones manda un mensaje sola;
 *   - al elegir una o varias conversaciones, la cabecera (buscador y filtros) se
 *     retira y su sitio lo ocupa la barra de acciones, como en WhatsApp;
 *   - con la selección abierta, tocar una fila selecciona o quita; NO abre el
 *     chat (para abrirlo se cancela antes con la ✕);
 *   - la imagen que manda el cliente se recibe, se guarda y se pinta en el hilo
 *     como miniatura servida por el propio CRM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { calculateSale } from '../public/admin/pos-math.js';

import { startCrmServer } from '../server/crm-server.mjs';
import { addDays, dayIn } from '../server/followups.mjs';

const POS_SCRIPT = readFileSync(path.join(process.cwd(), 'public', 'admin', 'pos.js'), 'utf8').replace(/^import[^\n]+\n/, '');
const STORE_SCRIPT = readFileSync(path.join(process.cwd(), 'public', 'admin', 'store.js'), 'utf8');

const TOKEN = 'uat-conv-panel';
const APP_SECRET = 'uat-conv-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONES = { ana: '18095550111', luis: '18095550222', maria: '18095550333' };
const NOMBRES = { [PHONES.ana]: 'Ana Lista', [PHONES.luis]: 'Luis Lista', [PHONES.maria]: 'María Lista' };

const png = (extra = 40) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 9)]);

/** R2 de mentira: guarda en memoria, sin red y sin credenciales. */
const storage = {
  enabled: true,
  provider: 's3',
  bucket: 'uat-bucket',
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

/** Graph de mentira: NO hay una sola llamada real a Meta. */
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-CONV',
  businessAccountId: 'WABA1',
  sent: [],
  failWith: null,
  async sendText(to, body) {
    if (whatsapp.failWith) return { ok: false, status: 400, error: whatsapp.failWith };
    const messageId = `wamid.TXT${whatsapp.sent.length + 1}`;
    whatsapp.sent.push({ to, body, messageId });
    return { ok: true, status: 200, messageId: `wamid.TXT${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    if (whatsapp.failWith) return { ok: false, status: 400, error: whatsapp.failWith };
    const messageId = `wamid.TPL${whatsapp.sent.length + 1}`;
    whatsapp.sent.push({ to, template, messageId });
    return { ok: true, status: 200, messageId: `wamid.TPL${whatsapp.sent.length}` };
  },
  async downloadMedia() {
    return { ok: true, buffer: png(), mimeType: 'image/png' };
  },
  async downloadImage() {},
  async uploadMedia() {
    return { ok: true, mediaId: 'meta_1' };
  },
  async sendImage() {
    return { ok: true, waMessageId: 'wamid.SENT1' };
  },
  async sendAudio() {
    return { ok: true, waMessageId: 'wamid.SENT2' };
  },
  async markAsRead() {
    return { ok: true };
  },
};

let tmpDir;
let app;
let dom;
let cookie = '';
const ids = {};
let uxConversationId = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 6000) {
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
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

/** Escribe en un campo como una persona: valor + evento `input`. */
function setValue(selector, value) {
  const input = typeof selector === 'string' ? $(selector) : selector;
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  return input;
}

/** Mensaje entrante firmado (webhook real del CRM). */
async function inbound(phone, id, node) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              // Meta SIEMPRE manda el número de destino; el servidor lo exige (fail-closed).
              metadata: { phone_number_id: 'PN-UAT-CONV', display_phone_number: '18095550000' },
              contacts: [{ profile: { name: NOMBRES[phone] }, wa_id: phone }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
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

/** El estado de las conversaciones según el SERVIDOR (no según el DOM). */
async function conversations(filter = '') {
  const query = filter ? `?filter=${encodeURIComponent(filter)}` : '';
  const response = await fetch(`${app.url}/api/admin/conversations${query}`, { headers: { cookie } });
  return (await response.json()).conversations ?? [];
}

async function adminJson(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

/** Crea un pedido desde el flujo POS vigente, asociado a la conversación real. */
async function createGuidedOrder(conversationId, variantId = 'capsules_10') {
  if (dom.window.document.body.dataset.tab !== 'whatsapp') {
    click('#menu');
    click('[data-tab="whatsapp"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'whatsapp', 'pestaña WhatsApp');
  }
  click(`[data-conv="${conversationId}"]`);
  await waitFor(() => $('#wa-chat-pane') && $('#wa-edge-right'), 'chat seleccionado');
  await abrirAccionesChat();
  const create = await waitFor(
    () => $(`[data-order-new][data-conversation="${conversationId}"]`),
    'crear pedido desde la conversación',
  );
  click(create);
  await waitFor(() => $('#pos-client .pos-client-button strong')?.textContent.includes('Luis'), 'cliente cargado en POS');
  const product = await waitFor(() => $(`[data-pos-add="${variantId}"]`), 'catálogo POS');
  click(product);
  const pay = await waitFor(() => $('[data-pos-pay]')?.disabled === false ? $('[data-pos-pay]') : null, 'continuar pedido');
  click(pay);
  const pickup = await waitFor(() => $('.pos-order-dialog [data-order-method="pickup"]'), 'retiro POS');
  click(pickup);
  await waitFor(() => $('.pos-order-dialog [data-order-method="pickup"]')?.getAttribute('aria-pressed') === 'true', 'POS en modo retiro');
  const confirm = await waitFor(() => $('.pos-order-dialog [data-order-confirm]')?.disabled === false ? $('.pos-order-dialog [data-order-confirm]') : null, 'confirmar pedido');
  click(confirm);
  await waitFor(() => $('.pos-order-dialog h2')?.textContent.includes('Pedido guardado'), 'pedido persistido por POS', 12000);
  const number = $('.pos-order-dialog .pos-confirm-total span')?.textContent?.trim() ?? '';
  click('.pos-order-dialog [data-pos-close]');
  // El POS navega a su pestaña al abrir el carrito; vuelve al chat como lo
  // haría el operador antes de elegir una acción de conversación.
  click('#menu');
  click('[data-tab="whatsapp"]');
  await waitFor(() => dom.window.document.body.dataset.tab === 'whatsapp' && $('#wa-chat-pane'), 'regreso al chat');
  click(`[data-conv="${conversationId}"]`);
  await waitFor(() => $('#wa-chat-name')?.textContent.includes('Luis'), 'conversación activa después del POS');
  await waitFor(() => $('#wa-edge-right'), 'acciones del chat disponibles');
  return number;
}

/**
 * ACCIONES DEL CHAT — entrada vigente.
 *
 * El botón `#wa-actions` se retiró: el MISMO menú (crear pedido, plantilla,
 * ubicación, confirmación…) se pinta en la columna derecha del chat
 * (`#wa-chat-cols`), que se abre con la pestaña `#wa-edge-right`.
 */
async function abrirAccionesChat() {
  // La hoja anterior puede seguir abierta y tapar la pestaña del borde: se
  // cierra igual que lo haría la persona antes de abrir otra acción.
  if ($('[data-close-sheet]')) closeSheetForUat();
  if (dom.window.document.body.dataset.waCol) {
    const close = $('#wa-chat-cols [data-wa-col-close]');
    if (close) click(close);
    await waitFor(() => !dom.window.document.body.dataset.waCol, 'columna de acciones cerrada', 9000);
  }
  click('#wa-edge-right');
  await waitFor(() => dom.window.document.body.dataset.waCol === 'right', 'columna de acciones abierta', 9000);
  return waitFor(
    () => $('#wa-chat-cols [data-side="right"] .wa-col__body')?.children.length ? $('#wa-chat-cols [data-side="right"]') : null,
    'las acciones de la conversación',
    9000,
  );
}

function cerrarAccionesChat() {
  const close = $('#wa-chat-cols [data-wa-col-close]');
  if (close) click(close);
}

/**
 * El pedido COMPLETO de un ítem del panel.
 *
 * `/api/admin/data` trae el resumen plano (variant_id, quantity, total…) y el
 * detalle del pedido dentro de `order_json`, que es de donde lo lee el panel
 * (`itemOrder`). Igual que en la app: si el detalle no está, se cae al resumen.
 */
function orderOfItem(item) {
  try {
    const parsed = JSON.parse(item?.order_json ?? item?.orderJson ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function startConversation(phone, name, body = '') {
  const result = await adminJson('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone, name, body }),
  });
  if (result.response.status !== 200) throw new Error(`no se pudo iniciar conversación: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function approveTemplateForUat() {
  const result = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_followup_checkin',
      friendlyName: 'Seguimiento al cliente',
      status: 'APPROVED',
      body: 'Hola {{1}}, ¿cómo va todo?',
      variables: ['customer_name'],
      metaTemplateId: 'tpl-uat-followup',
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  if (result.response.status !== 200) throw new Error(`no se pudo aprobar plantilla: ${JSON.stringify(result.body)}`);
}

/** La plantilla que admite un mensaje escrito a mano (hueco libre declarado). */
async function approvePersonalTemplateForUat() {
  const result = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_mensaje_personalizado_v1',
      friendlyName: 'Mensaje personalizado',
      status: 'APPROVED',
      body: 'Hola {{1}}, te escribimos de Phytoemagry. {{2}} Cualquier duda, respóndenos por aquí y te ayudamos.',
      variables: ['customer_name', 'mensaje'],
      metaTemplateId: 'tpl-uat-personal',
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  if (result.response.status !== 200) throw new Error(`no se pudo aprobar plantilla libre: ${JSON.stringify(result.body)}`);
}

/** La plantilla con la que se PIDE la ubicación al cliente. */
async function approveLocationTemplateForUat() {
  const result = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_ubicacion_entrega_v1',
      friendlyName: 'Solicitar ubicación',
      status: 'APPROVED',
      body: 'Hola {{1}}, necesitamos confirmar la ubicación donde deseas recibir tu pedido {{2}}.',
      variables: ['customer_name', 'order_number'],
      metaTemplateId: 'tpl-uat-location',
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  if (result.response.status !== 200) throw new Error(`no se pudo aprobar la plantilla de ubicación: ${JSON.stringify(result.body)}`);
}

/** La plantilla con la que se le pide al cliente CONFIRMAR su pedido. */
async function approveOrderConfirmTemplateForUat() {
  const result = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_confirmacion_pedido_v1',
      friendlyName: 'Confirmación de pedido',
      status: 'APPROVED',
      body: 'Hola {{1}}, recibimos tu pedido {{2}} correctamente. Total: {{3}} Forma de pago: {{4}} Por favor confirma que los datos de tu pedido son correctos.',
      variables: ['customer_name', 'order_number', 'total', 'payment_method'],
      metaTemplateId: 'tpl-uat-confirm',
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  if (result.response.status !== 200) throw new Error(`no se pudo aprobar la plantilla de confirmación: ${JSON.stringify(result.body)}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-conv-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    storage,
    whatsappMedia: whatsapp,
    whatsapp,
    schedulerEnabled: false,
  });

  // Tres clientes: uno con imagen (la que manda el cliente), dos de texto.
  await inbound(PHONES.ana, 'wamid.CONV-A1', {
    type: 'image',
    image: { id: 'IMG-CONV-1', mime_type: 'image/png', caption: 'Mira el frasco' },
  });
  await inbound(PHONES.luis, 'wamid.CONV-L1', { type: 'text', text: { body: '¿Tienes el de 500 ml?' } });
  await inbound(PHONES.maria, 'wamid.CONV-M1', { type: 'text', text: { body: 'Gracias, llegó perfecto' } });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
  const soloDigitos = (value) => String(value ?? '').replace(/\D/g, '');
  const clientePorId = new Map((data.customers ?? []).map((customer) => [customer.id, customer]));
  for (const conversation of data.conversations ?? []) {
    const customer = clientePorId.get(conversation.customer_id) ?? conversation.customer ?? {};
    const phone = soloDigitos(customer.phone_e164 ?? customer.phone);
    const slot = Object.entries(PHONES).find(([, value]) => soloDigitos(value) === phone)?.[0];
    if (slot) ids[slot] = conversation.id;
  }
  if (!ids.ana || !ids.luis || !ids.maria) {
    throw new Error(
      `no se pudieron mapear las conversaciones: ${JSON.stringify({
        ids,
        conversaciones: (data.conversations ?? []).map((row) => [row.id, row.customer_id, row.customer?.phone_e164]),
        clientes: (data.customers ?? []).map((row) => [row.id, row.phone_e164]),
      })}`,
    );
  }
  const today = dayIn(new Date(), 'America/Santo_Domingo');
  await app.collections.update('conversations', ids.ana, { last_message_at: `${today}T16:42:00.000Z` });
  await app.collections.update('conversations', ids.luis, { last_message_at: `${addDays(today, -1)}T18:15:00.000Z` });
  await app.collections.update('conversations', ids.maria, { last_message_at: `${addDays(today, -10)}T10:08:00.000Z` });

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  win.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  win.structuredClone = structuredClone;
  win.calculateSale = calculateSale;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.alert = () => {};
  /*
   * DOBLE DE `EventSource`: jsdom no lo trae y el panel abre con él el canal en
   * vivo del chat. Aquí se guardan las conexiones y sus manejadores para poder
   * simular un aviso del servidor desde el test.
   */
  win.__eventSources = [];
  win.EventSource = class EventSourceFalso {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.closed = false;
      this.readyState = 1;
      win.__eventSources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    emit(type, payload = {}) {
      this.listeners.get(type)?.({ data: JSON.stringify(payload) });
    }
  };
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: { get: () => setCookie ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.eval(STORE_SCRIPT);
  win.eval(POS_SCRIPT);
  await waitFor(() => $$('[data-conv]').length >= 3, 'la lista con las tres conversaciones', 8000);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la fila de la lista', () => {
  it('muestra la hora del último mensaje cuando es de hoy (como WhatsApp)', () => {
    const row = $(`[data-conv="${ids.ana}"]`);
    const stamps = row.querySelector('.conv__stamps');
    const when = stamps.querySelector('.conv__when');
    expect(when.textContent).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(stamps.getAttribute('title')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('muestra «Ayer» CON la hora cuando el último mensaje fue ayer', () => {
    const row = $(`[data-conv="${ids.luis}"]`);
    expect(row.querySelector('.conv__when').textContent).toMatch(/^Ayer · \d{1,2}:\d{2} (AM|PM)$/);
  });

  it('muestra día y mes con la hora para conversaciones antiguas', () => {
    const row = $(`[data-conv="${ids.maria}"]`);
    expect(row.querySelector('.conv__when').textContent).toMatch(/^\d{1,2} [a-z]{3,4} · \d{1,2}:\d{2} (AM|PM)$/i);
  });

  it('muestra la imagen del cliente como último mensaje, no un JSON ni coordenadas', () => {
    const row = $(`[data-conv="${ids.ana}"]`);
    expect(row.querySelector('.conv__preview').textContent).toContain('Imagen');
    expect(row.querySelector('.conv__kind')).not.toBeNull();
  });

  it('la segunda línea lleva el mensaje a la izquierda y responsable · etapa a la derecha', () => {
    const row = $(`[data-conv="${ids.luis}"]`);
    // La etapa es texto pequeño y gris (`.conv__state`), dentro del bloque derecho.
    expect(row.querySelector('.conv__meta .conv__state').textContent).toBe('Prospecto');
    expect(row.querySelector('.conv__meta .conv__assign--empty').textContent).toBe('Sin asignar');
    // Ya NO existe una tercera línea de metadatos.
    expect(row.querySelector('.conv__line--meta')).toBeNull();
    // Los avisos que exigen acción sí llevan píldora, y sin comas (una idea por etiqueta).
    for (const tag of [...row.querySelectorAll('.conv__tag')]) expect(tag.textContent).not.toMatch(/,/);
  });

  it('cada fila termina en un «⋯» (y ya no hay un botón «Sel» aparte)', () => {
    expect($$('[data-conv-more]').length).toBe($$('[data-conv]').length);
    expect($$('[data-conv-select]').length).toBe(0);
  });
});

describe('el menú «⋯» de una conversación', () => {
  it('agrupa acciones y deja etapas y asignación fuera del menú principal', () => {
    const before = whatsapp.sent.length;
    click(`[data-conv-more="${ids.luis}"]`);
    const groups = $$('#sheet-body .menu-group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Acciones principales','Gestión','Asignación','Organizar conversación','Eliminar']);
    expect(groups[0].querySelector('[data-conv-act="open"]')).not.toBeNull();
    expect(groups.at(-1).querySelector('[data-conv-act="delete"]')).not.toBeNull();
    expect($('#sheet-body [data-customer-stage]')).toBeNull();
    expect($('#sheet-body [data-conv-take]')).toBeNull();
    expect($$('#sheet-body [data-conv-assign]').length).toBe(0);
    expect($('#sheet-body').textContent).toContain('Responsable de esta conversación');
    expect(whatsapp.sent.length).toBe(before);
  });

  it('Cliente abre ficha, etapa y etiquetas para la conversación elegida', () => {
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-client-menu]');
    const customerId = $('#sheet-body [data-customer]').dataset.customer;
    expect($('#sheet-body [data-customer-stage-menu]').dataset.customerStageMenu).toBe(customerId);
    expect($('#sheet-body [data-customer-tags]').dataset.customerTags).toBe(customerId);
    click('#sheet-body [data-customer-stage-menu]');
    /*
     * Solo se ofrecen las etapas que son una DECISIÓN (Prospecto, Interesado,
     * Inactivo). Cliente y Recompra las calcula el CRM con los pedidos
     * entregados, así que no aparecen como botones.
     */
    const opciones = $$('#sheet-body [data-customer-stage]').map((button) => button.dataset.stage);
    expect(opciones).toEqual(['PROSPECT', 'INTERESTED', 'INACTIVE']);
    expect(opciones).not.toContain('CUSTOMER');
    expect(opciones).not.toContain('REPEAT_CUSTOMER');
    expect($$('#sheet-body [data-customer-stage]').every((button) => button.dataset.customerStage === customerId)).toBe(true);
  });

  it('Seguimiento y volver conservan el contexto sin enviar ni asignar', async () => {
    const before = whatsapp.sent.length;
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-followup-menu]');
    expect($('#sheet-body [data-followup-new]').dataset.conversation).toBe(ids.luis);
    expect($('#sheet-body [data-scheduled-new]').dataset.conversation).toBe(ids.luis);
    click('#sheet-body [data-conv-menu-back]');
    expect($('#sheet-body [data-conv-act="open"]').dataset.convId).toBe(ids.luis);
    // La sesión de esta fixture usa token legado, sin una persona autenticada:
    // se muestra el responsable como dato, pero no se ofrece una acción inválida.
    expect($('#sheet-body [data-conv-assign]')).toBeNull();
    expect($('#sheet-body').textContent).toContain('Responsable de esta conversación');
    expect(whatsapp.sent.length).toBe(before);
  });

  it('ofrece las acciones de ESA conversación y ninguna manda nada sola', async () => {
    const enviadosAntes = whatsapp.sent.length;
    click(`[data-conv-more="${ids.luis}"]`);
    expect($('#sheet').hidden).toBe(false);
    expect($('#sheet-body [data-conv-act="open"]')).not.toBeNull();
    expect($('#sheet-body [data-conv-act="select"]')).not.toBeNull();
    expect($('#sheet-body [data-conv-act="archive"]')).not.toBeNull();
    expect(whatsapp.sent.length).toBe(enviadosAntes);
  });

  it('«Archivar» saca la conversación de la lista y no la borra', async () => {
    const enviadosAntes = whatsapp.sent.length;
    click(`[data-conv-more="${ids.maria}"]`);
    click('#sheet-body [data-conv-act="archive"]');
    await waitFor(() => !$(`[data-conv="${ids.maria}"]`), 'la conversación archivada fuera de la lista');
    expect(whatsapp.sent.length).toBe(enviadosAntes);
    // Archivada de verdad: sigue existiendo, ahora en el filtro de archivados.
    expect((await conversations()).some((row) => row.id === ids.maria)).toBe(false);
    expect((await conversations('archivados')).some((row) => row.id === ids.maria)).toBe(true);
  });
});

describe('selección de varias conversaciones (el gesto de WhatsApp)', () => {
  it('«Seleccionar varias» abre el panel de acciones ENCIMA de la lista', async () => {
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-act="select"]');
    await waitFor(() => $('#wa-sel').hidden === false, 'el panel de selección visible');
    /*
     * El panel FLOTA sobre la lista: la cabecera (con «WhatsApp») y los filtros
     * siguen ahí detrás; no se retiran ni se apilan dos barras.
     */
    expect($('.wa__list-head').hidden).toBe(false);
    expect($('#wa-filters').hidden).toBe(false);
    expect($('#wa-conversations').classList.contains('wa__convs--sel')).toBe(true);
    expect($('#wa-sel .wa-actions').dataset.open).toBe('1');
    expect($('#wa-sel .wa-bulk__count').textContent).toContain('1');
    /*
     * Con UNA conversación elegida el panel trae TODAS sus acciones, sin abrir
     * otra hoja que repita lo mismo: abrir, crear pedido, cliente, foto,
     * seguimiento, asignación, finalizar, archivar y eliminar.
     */
    expect($('#wa-sel [data-conv-more]')).toBeNull();
    expect($('#wa-sel [data-conv-act="open"]').dataset.convId).toBe(ids.luis);
    expect($('#wa-sel [data-order-new]')).not.toBeNull();
    expect($('#wa-sel [data-conv-client-menu]')).not.toBeNull();
    expect($('#wa-sel [data-customer]')).not.toBeNull();
    expect($('#wa-sel [data-conv-followup-menu]')).not.toBeNull();
    expect($('#wa-sel [data-conv-assign]').dataset.convAssign).toBe(ids.luis);
    expect($('#wa-sel [data-conversation-resolution]')).not.toBeNull();
    expect($('#wa-sel [data-conv-act="archive"]')).not.toBeNull();
    expect($('#wa-sel [data-conv-act="delete"]')).not.toBeNull();
    expect($('#wa-sel .wa-actions__label').textContent).toBeTruthy();
    expect($$('#wa-sel .wa-bulk__item .wa-bulk__icon svg').length).toBe($$('#wa-sel .wa-bulk__item').length);
    /*
     * Sin foto real NO hay avatar: la marca de "elegida" es un visto pequeño al
     * final de la tercera línea, no un círculo con iniciales.
     */
    expect($(`[data-conv="${ids.luis}"] .conv__avatar`)).toBeNull();
    expect($(`[data-conv="${ids.luis}"] .conv__picked svg`)).not.toBeNull();
  });

  it('cerrar el panel NO borra la selección y la píldora «Acciones» lo reabre', async () => {
    click('[data-wa-actions-close]');
    await waitFor(() => $('#wa-sel .wa-actions').dataset.open === '0', 'el panel cerrado');
    expect($('#wa-sel').hidden).toBe(false);
    expect($('#wa-sel .wa-bulk__count').textContent).toContain('1');
    expect($('#wa-sel .wa-actions__pill')).not.toBeNull();
    click('[data-wa-actions-open]');
    await waitFor(() => $('#wa-sel .wa-actions').dataset.open === '1', 'el panel abierto otra vez');
  });

  it('con la selección abierta, tocar una fila selecciona o quita: NO abre el chat', async () => {
    click(`[data-conv="${ids.ana}"]`);
    await waitFor(() => $('#wa-sel .wa-bulk__count').textContent.includes('2'), 'la segunda conversación elegida');
    // Abrir el chat dejaría de ocultar el panel de la conversación: no pasó.
    expect($('#wa-chat-pane').hidden).toBe(true);
    /*
     * Con VARIAS elegidas se ofrece la MISMA acción de organizar que con una
     * sola (finalizar); no hay dos botones distintos («marcar como leídas»
     * desaparece del panel).
     */
    expect($('#wa-sel [data-wa-bulk="resolve"]')).not.toBeNull();
    expect($('#wa-sel [data-wa-bulk="mark_read"]')).toBeNull();
    click(`[data-conv="${ids.ana}"]`);
    await waitFor(() => $('#wa-sel .wa-bulk__count').textContent.includes('1'), 'la conversación quitada');
    expect($('#wa-chat-pane').hidden).toBe(true);
    // Y con una sola, la misma acción (aquí en su forma de fila única).
    expect($('#wa-sel [data-conversation-resolution]')).not.toBeNull();
    expect($('#wa-sel [data-conv-act="mark_read"]')).toBeNull();
  });

  it('«Todas» elige todas las visibles y la ✕ cancela la selección', async () => {
    const visibles = $$('[data-conv]').length;
    click('[data-wa-sel-all]');
    await waitFor(
      () => $('#wa-sel .wa-bulk__count').textContent.includes(String(visibles)),
      'todas las conversaciones visibles elegidas',
    );
    click('[data-wa-sel-clear]');
    await waitFor(() => $('#wa-sel').hidden === true, 'la barra de selección oculta');
    expect($('.wa__list-head').hidden).toBe(false);
    expect($('#wa-filters').hidden).toBe(false);
    expect($('#wa-conversations').classList.contains('wa__convs--sel')).toBe(false);
  });

  it('«Abrir conversación» desde el panel abre el chat y suelta la selección', async () => {
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-act="select"]');
    await waitFor(() => $('#wa-sel [data-conv-act="open"]'), 'el panel con la acción de abrir');
    click('#wa-sel [data-conv-act="open"]');
    await waitFor(() => $('#wa-chat-pane').hidden === false, 'el chat abierto');
    // Al abrir el chat la selección se suelta: no queda un panel fantasma.
    await waitFor(() => $('#wa-sel').hidden === true, 'el panel de selección retirado');
  });

  it('«Asignación» del panel lo cierra y abre UNA sola hoja', async () => {
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-act="select"]');
    await waitFor(() => $('#wa-sel [data-conv-assign]'), 'el panel con la asignación');
    click('#wa-sel [data-conv-assign]');
    await waitFor(() => $('#sheet').hidden === false, 'la hoja de asignación');
    expect($('#sheet-title').textContent).toContain('Asignar');
    // El panel no se queda detrás de la hoja: antes se veían dos listas iguales.
    expect($('#wa-sel .wa-actions').dataset.open).toBe('0');
    click('#sheet [data-close-sheet]');
    // La selección sigue viva y la píldora permite volver a las acciones.
    await waitFor(() => $('#wa-sel').hidden === false, 'la selección intacta');
    click('[data-wa-sel-clear]');
    await waitFor(() => $('#wa-sel').hidden === true, 'selección cancelada');
  });
});

describe('la imagen que manda el cliente', () => {
  it('se recibe, se guarda y se pinta en el hilo (y el CRM la sirve)', async () => {
    click(`[data-conv="${ids.ana}"]`);
    const img = await waitFor(() => $('#thread .media-thumb img'), 'la miniatura de la imagen entrante');
    const src = img.getAttribute('src');
    expect(src).toContain('/api/admin/media/');
    const response = await fetch(new URL(src, app.url).toString(), { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // La pieza no se rompe: la burbuja sigue siendo una sola tarjeta.
    expect($('#thread .bubble .media-thumb')).not.toBeNull();
  });
});

describe('nuevo chat desde la lista de WhatsApp', () => {
  it('crea o abre el cliente por teléfono sin enviar mensajes automáticamente', async () => {
    const enviadosAntes = whatsapp.sent.length;
    const response = await fetch(`${app.url}/api/admin/conversations/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
        'x-forwarded-host': 'localhost:5173',
      },
      body: JSON.stringify({
        phone: '18095550444',
        name: 'Cliente Nuevo',
        body: 'Hola, te escribo de Phytoemagry',
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.conversation?.id).toBeTruthy();
    expect(body.customer?.phone_e164).toBe('+18095550444');
    expect(whatsapp.sent.length).toBe(enviadosAntes);

    const rows = await conversations();
    const row = rows.find((candidate) => candidate.id === body.conversation.id);
    expect(row?.customer?.name).toBe('Cliente Nuevo');
    expect(row?.last_message).toBeNull();
  });

  it('la lista tiene el botón flotante que abre el formulario', () => {
    const button = $('#wa-new-chat');
    expect(button).not.toBeNull();
    click(button);
    expect($('#sheet').hidden).toBe(false);
    expect($('#sheet-title').textContent).toBe('Nuevo WhatsApp');
    expect($('#wa-start-phone')).not.toBeNull();
  });

  it('pinta una conversación sin mensajes sin inventar hora', async () => {
    $('#wa-start-phone').value = '18095550555';
    $('#wa-start-name').value = 'Cliente Sin Mensajes';
    $('#wa-start-body').value = '';
    click('#wa-start-open');
    await waitFor(() => [...$$('[data-conv]')].find((row) => row.textContent.includes('Cliente Sin Mensajes')), 'fila sin mensajes');
    const row = [...$$('[data-conv]')].find((candidate) => candidate.textContent.includes('Cliente Sin Mensajes'));
    expect(row.querySelector('.conv__preview').textContent).toContain('Sin mensajes');
    expect(row.querySelector('.conv__when')).toBeNull();
  });
});

describe('UX de ventana 24 h y plantillas en el chat', () => {
  it('chat vacío muestra NEW_CONTACT y abre selector compacto en hoja', async () => {
    click('#wa-new-chat');
    $('#wa-start-phone').value = '18095550666';
    $('#wa-start-name').value = 'Cliente UX Nuevo';
    $('#wa-start-body').value = '';
    click('#wa-start-open');
    await waitFor(() => $('#wa-chat-name')?.textContent.includes('Cliente UX Nuevo'), 'chat nuevo abierto', 9000);
    const row = (await conversations()).find((candidate) => candidate.customer?.name === 'Cliente UX Nuevo');
    uxConversationId = row.id;
    await waitFor(() => $('#wa-composer [data-wa-contact-state="NEW_CONTACT"]'), 'estado NEW_CONTACT');
    expect($('#thread').textContent).toContain('Todavía no has iniciado una conversación');
    expect($('#wa-composer').textContent).toContain('Iniciar conversación');
    expect($('#wa-composer').textContent).not.toContain('La ventana de atención de 24 horas terminó');
    await approveTemplateForUat();
    await click('[data-wa-filter="todos"]');
    await waitFor(() => $('#wa-composer [data-wa-contact-state="NEW_CONTACT"]'), 'estado NEW_CONTACT recargado');
    click('#wa-open-template');
    expect($('#sheet').hidden).toBe(false);
    expect($('#sheet-title').textContent).toBe('Enviar plantilla');
    await waitFor(() => $('#sheet-body #wa-send-template'), 'selector con plantilla aprobada');
  }, 12000);

  it('después de enviar template queda WAITING_CUSTOMER_REPLY y el texto va dentro de una plantilla', async () => {
    const before = whatsapp.sent.length;
    click('#sheet-body #wa-send-template');
    await waitFor(() => $('#sheet').hidden === true, 'selector de plantilla cerrado tras enviar', 9000);
    await waitFor(() => $('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]'), 'estado esperando respuesta');
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(whatsapp.sent.at(-1).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Cliente UX Nuevo' }] },
    ]);
    expect($('#thread').textContent).toContain('Hola Cliente UX Nuevo');
    /*
     * El aviso de «esperando respuesta» es COMPACTO a propósito: una sola línea
     * con la etiqueta y la acción pequeña. El estado se identifica por su
     * atributo y el texto sigue diciendo si WhatsApp confirmó la entrega.
     */
    const estadoEspera = $('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]');
    expect(estadoEspera.classList.contains('wa-state--mini')).toBe(true);
    expect(estadoEspera.textContent).toContain('Plantilla');
    expect(estadoEspera.textContent).toContain('Enviar plantilla');
    expect(estadoEspera.querySelectorAll('p, small').length).toBe(0);
    // «Enviado» no es «entregado»: WhatsApp solo aceptó el mensaje, así que la
    // burbuja y el estado lo dicen sin prometer una entrega que no se confirmó.
    expect($('#wa-composer').textContent).toContain('sin confirmar');
    expect($('#thread').textContent).toContain('Enviado · sin confirmar');
    // Hay dónde escribir (lo escrito viaja dentro de una plantilla), pero NO es
    // texto libre: ni adjuntos ni notas de voz fuera de la ventana de 24 h.
    expect($('#wa-text')).not.toBeNull();
    expect($('#wa-mic')).toBeNull();
    expect($('#wa-attach')).toBeNull();
    expect($('#wa-composer').textContent).not.toContain('La ventana de atención de 24 horas terminó');
    expect(uxConversationId).toBeTruthy();
  }, 12000);

  it('template delivered/read sin inbound sigue WAITING_CUSTOMER_REPLY', async () => {
    const messageId = whatsapp.sent.at(-1)?.messageId ?? 'wamid.TPL1';
    const message = (await app.collections.list('wa_messages', { limit: 1000 })).find((row) => row.wa_message_id === messageId);
    expect(message).toBeTruthy();
    await app.collections.update('wa_messages', message.id, {
      ...message,
      status: 'read',
      delivered_at: new Date().toISOString(),
      read_at: new Date().toISOString(),
    });
    await app.collections.update('conversations', uxConversationId, { updated_at: new Date().toISOString() });
    await waitFor(() => $('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]'), 'sigue esperando');
    expect($('#wa-send')).not.toBeNull();
    // Con la entrega YA confirmada por Meta, el estado deja de decir «sin confirmar».
    click('[data-wa-filter="todos"]');
    await waitFor(
      () => $('#wa-composer')?.textContent.includes('Plantilla entregada'),
      'estado de entrega confirmada',
      9000,
    );
  }, 15000);

  it('el contenido de la plantilla se escribe en el panel (huecos + vista previa)', async () => {
    click('[data-wa-filter="todos"]');
    await waitFor(() => $('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]'), 'estado esperando respuesta');
    click('#wa-open-template');
    const hueco = await waitFor(() => $('#wa-template-fields [data-wa-var="1"]'), 'los huecos de la plantilla', 9000);
    // El nombre del cliente viene puesto y se ve el mensaje tal como se enviará.
    expect(hueco.value).toBe('Cliente UX Nuevo');
    expect($('#wa-template-preview').textContent).toBe('Hola Cliente UX Nuevo, ¿cómo va todo?');

    const antes = whatsapp.sent.length;
    hueco.value = 'Vecino';
    hueco.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect($('#wa-template-preview').textContent).toBe('Hola Vecino, ¿cómo va todo?');

    click('#sheet-body #wa-send-template');
    await waitFor(() => whatsapp.sent.length === antes + 1, 'la plantilla con el texto escrito', 9000);
    expect(whatsapp.sent.at(-1).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Vecino' }] },
    ]);
    await waitFor(() => $('#thread').textContent.includes('Hola Vecino'), 'el texto escrito en el hilo', 9000);
  }, 30000);

  it('quick reply inbound abre OPEN_WINDOW sin recargar manualmente', async () => {
    await inbound('18095550666', 'wamid.UX-BUTTON-1', {
      type: 'button',
      button: { text: 'Continuar', payload: 'continuar' },
    });
    click('[data-wa-filter="todos"]');
    // El compositor LIBRE se reconoce por el botón de adjuntar (que fuera de la
    // ventana no existe): el campo de texto está en los dos casos.
    await waitFor(() => $('#wa-attach'), 'composer libre tras quick reply inbound', 9000);
    expect($('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]')).toBeNull();
    expect($('#wa-composer').textContent).not.toContain('Esperando respuesta');
  }, 12000);

  it('con ventana expirada NO se anuncia la ventana: el compositor pasa a «Plantilla»', async () => {
    const phone = '18095550777';
    NOMBRES[phone] = 'Cliente UX Expirado';
    await inbound(phone, 'wamid.UX-OLD-1', {
      timestamp: String(Math.floor((Date.now() - 3 * 86400000) / 1000)),
      type: 'text',
      text: { body: 'Hola, escribí hace días' },
    });
    click('[data-wa-filter="todos"]');
    const row = await waitFor(
      () => [...$$('[data-conv]')].find((candidate) => candidate.textContent.includes('Cliente UX Expirado')),
      'fila expirada',
      9000,
    );
    click(row);
    /*
     * Ya no hay tarjeta de «Ventana de atención finalizada»: el estado se ve solo
     * en el compositor (modo Plantilla + su placeholder). Quien atiende sabe
     * cuándo se cerró la ventana sin que se lo repitan en el hilo.
     */
    await waitFor(() => $('#wa-text'), 'el compositor cerrado', 9000);
    expect($('#wa-composer [data-wa-contact-state="CLOSED_WINDOW"]')).toBeNull();
    expect($('#wa-composer').textContent).not.toContain('Ventana de atención finalizada');
    expect($('#wa-composer').textContent).not.toContain('La ventana de atención de 24 horas terminó');
    expect($('#wa-open-template').textContent).toContain('Plantilla');
    expect($('#wa-text').getAttribute('placeholder')).toContain('Conversación cerrada. Escribe aquí para abrirla');
  }, 12000);

  it('template fallido renderiza tarjeta amigable y mapea #132000', async () => {
    whatsapp.failWith = { status: 400, code: 132000, message: 'Number of parameters does not match the expected number of params' };
    click('#wa-open-template');
    await waitFor(() => $('#sheet-body #wa-send-template'), 'selector con plantilla aprobada');
    click('#sheet-body #wa-send-template');
    await waitFor(() => $('#thread .template-fail'), 'tarjeta de plantilla fallida', 9000);
    expect($('#thread .template-fail').textContent).toContain('Plantilla no enviada');
    expect($('#thread .template-fail').textContent).toContain('Seguimiento al cliente');
    expect($('#thread .template-fail').textContent).toContain('faltan o sobran datos requeridos');
    expect($('#thread .template-fail').textContent).toContain('#132000');
    expect($('#thread .template-fail').textContent).not.toContain('Archivo recibido');
    // El compositor dice que NO se entregó (y por qué) en vez de fingir que no
    // se intentó nada.
    expect($('#wa-composer [data-wa-contact-state="TEMPLATE_FAILED"]')).toBeTruthy();
    expect($('#wa-composer').textContent).toContain('La plantilla no se entregó');
    expect($('#wa-composer').textContent).toContain('faltan o sobran datos requeridos');
    whatsapp.failWith = null;
    expect(uxConversationId).toBeTruthy();
  }, 12000);
});

describe('escribir el mensaje de un chat nuevo (fuera de la ventana de 24 h)', () => {
  /*
   * Lo que se pidió: al abrir una conversación por primera vez, escribir en el
   * compositor y que ESE texto salga dentro de la plantilla aprobada, sin tener
   * que copiarlo a mano en un hueco.
   */
  it('lo escrito entra en el hueco libre de la plantilla y se revisa antes de enviar', async () => {
    await approvePersonalTemplateForUat();
    click('#wa-new-chat');
    $('#wa-start-phone').value = '18095550888';
    $('#wa-start-name').value = 'Cliente Escribe';
    $('#wa-start-body').value = '';
    click('#wa-start-open');
    await waitFor(() => $('#wa-chat-name')?.textContent.includes('Cliente Escribe'), 'chat nuevo abierto', 9000);
    await waitFor(() => $('#wa-composer [data-wa-contact-state="NEW_CONTACT"]'), 'estado NEW_CONTACT', 9000);

    const area = await waitFor(() => $('#wa-text'), 'el compositor del chat nuevo', 9000);
    expect(area.getAttribute('aria-label')).toBe('Mensaje que se enviará dentro de la plantilla');
    expect(area.getAttribute('placeholder')).toContain('Conversación cerrada. Escribe aquí para abrirla');
    area.value = 'Tu pedido ya salió para tu dirección.';
    area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    const antes = whatsapp.sent.length;
    click('#wa-send');
    const libre = await waitFor(() => $('#wa-template-fields [data-wa-var="2"]'), 'el hueco libre de la plantilla', 9000);
    // La plantilla con hueco libre viene elegida y el texto ya está dentro.
    expect($('#wa-template').value).toBe('phyto_mensaje_personalizado_v1');
    expect($('#wa-template-fields [data-wa-var="1"]').value).toBe('Cliente Escribe');
    expect(libre.value).toBe('Tu pedido ya salió para tu dirección.');
    expect($('#wa-template-preview').textContent).toContain('Tu pedido ya salió para tu dirección.');
    // Abrir la hoja NO ha enviado nada.
    expect(whatsapp.sent.length).toBe(antes);

    click('#sheet-body #wa-send-template');
    await waitFor(() => whatsapp.sent.length === antes + 1, 'la plantilla con el mensaje escrito', 9000);
    const enviado = whatsapp.sent.at(-1);
    expect(enviado.to).toBe('+18095550888');
    expect(enviado.template.name).toBe('phyto_mensaje_personalizado_v1');
    expect(enviado.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Cliente Escribe' },
          { type: 'text', text: 'Tu pedido ya salió para tu dirección.' },
        ],
      },
    ]);
    await waitFor(
      () => $('#thread').textContent.includes('Tu pedido ya salió para tu dirección.'),
      'el mensaje final en el hilo',
      9000,
    );
    expect($('#sheet').hidden).toBe(true);
  }, 40000);

  it('sin nada escrito no se inventa texto: la hoja solo trae lo que el CRM ya sabe', async () => {
    click('#wa-open-template');
    const nombre = await waitFor(
      () => $('#wa-template-fields [data-wa-var="1"]'),
      'los huecos de la plantilla por defecto',
      9000,
    );
    expect($('#wa-template').value).toBe('phyto_mensaje_personalizado_v1');
    expect(nombre.value).toBe('Cliente Escribe');
    // El hueco libre existe, pero queda vacío: no se inventa ni se reutiliza texto.
    expect($('#wa-template-fields [data-wa-var="2"]').value).toBe('');
    expect($('#wa-template-preview').textContent).toContain('Hola Cliente Escribe');
    closeSheetForUat();
  });
});

/** Cierra la hoja desde el propio panel (el mismo botón que usa una persona). */
function closeSheetForUat() {
  click('[data-close-sheet]');
}

describe('enviar una plantilla y pedir la ubicación desde el chat', () => {
  /*
   * Lo que se preguntó: desde el chat, ¿dónde se elige una plantilla? ¿y cómo se
   * pide la ubicación? Antes, con la ventana abierta, no había NINGUNA entrada.
   */
  it('el menú ⋯ abre las plantillas aprobadas (sin botón repetido en el compositor)', async () => {
    await approveLocationTemplateForUat();
    click(`[data-conv="${ids.luis}"]`);
    await waitFor(() => $('#wa-chat-name')?.textContent.includes('Luis'), 'el chat de Luis', 9000);

    /*
     * El icono de plantilla del compositor se QUITÓ: estaba repetido con esta
     * misma entrada del menú de acciones del chat.
     */
    expect($('#wa-template-open')).toBeNull();

    await abrirAccionesChat();
    await waitFor(() => $('#wa-chat-cols [data-wa-template]'), 'la entrada «Enviar plantilla»', 9000);
    expect($('#wa-chat-cols [data-wa-ask-location]')).not.toBeNull();
    expect($('#wa-chat-cols').textContent).toContain('Pedir / confirmar ubicación');

    click($('#wa-chat-cols [data-wa-template]'));
    await waitFor(() => $('#sheet-body #wa-send-template'), 'la hoja de plantillas', 9000);
    const opciones = $$('#wa-template option').map((option) => option.value);
    expect(opciones).toContain('phyto_ubicacion_entrega_v1');
    expect(opciones).toContain('phyto_followup_checkin');
    closeSheetForUat();
  }, 30000);

  it('«Pedir / confirmar ubicación» sin ubicación guardada: solo la pide (texto, sin plantilla)', async () => {
    // La columna de acciones se cierra al abrir una hoja: se vuelve a abrir.
    await abrirAccionesChat();
    const pedirUbicacion = await waitFor(() => $('#wa-chat-cols [data-wa-ask-location]'), 'el menú de acciones del chat', 9000);
    click(pedirUbicacion);    /*
     * Luis todavía NO ha mandado ninguna ubicación: ni se inventa un mapa ni se
     * manda una plantilla. Solo se le pide que la envíe (la ventana está abierta).
     */
    const preview = await waitFor(() => $('#sheet-body .wa-preview'), 'la previsualización del mensaje', 9000);
    expect(preview.textContent).toBe('Por favor, envíanos tu ubicación para realizar la entrega de tu pedido.');
    expect($('#wa-template')).toBeNull();

    const antes = whatsapp.sent.length;
    click('#sheet-body #wa-preview-send');
    await waitFor(() => whatsapp.sent.length === antes + 1, 'el mensaje enviado', 9000);
    const enviado = whatsapp.sent.at(-1);
    expect(enviado.body).toBe('Por favor, envíanos tu ubicación para realizar la entrega de tu pedido.');
    // Es TEXTO libre, no una plantilla.
    expect(enviado.template).toBeUndefined();
    // Se cierra la hoja: el test siguiente abre otra acción y no debe leer
    // una previsualización vieja.
    closeSheetForUat();
  }, 30000);

  it('«Pedir confirmación» usa el pedido REAL de esa conversación (no una plantilla)', async () => {
    // El pedido se crea desde el POS actual y se conserva ligado al chat.
    const numero = await createGuidedOrder(ids.luis, 'capsules_10');
    expect(numero).toBeTruthy();

    await abrirAccionesChat();
    const pedirConfirmacion = await waitFor(() => $('#wa-chat-cols [data-wa-confirm-order]'), 'el menú de acciones del chat', 9000);
    click(pedirConfirmacion);

    // Con UN solo pedido abierto no hay que elegir: va directo al mensaje.
    // La hoja conserva su HTML al cerrarse, así que se espera al texto NUEVO
    // (el resumen del pedido), no a que exista cualquier `.wa-preview`.
    const preview = await waitFor(() => {
      const node = $('#sheet-body .wa-preview');
      return node && /revísalo y confírmalos/i.test(node.textContent) ? node : null;
    }, 'el resumen del pedido', 9000);
    // Nadie tiene que saberse el número de la factura: sale del pedido real.
    expect(preview.textContent).toContain(numero);
    expect(preview.textContent).toContain('10 cápsulas');
    expect(preview.textContent).toContain('revísalo y confírmanos si está correcto');
    expect($('#wa-template')).toBeNull();
    closeSheetForUat();
  }, 40000);
});

describe('preferencias del pedido del cliente', () => {
  /*
   * Lo que pidió el negocio: guardar aparte lo que se repite (frasco, cantidad,
   * pago, ubicación de entrega y una nota) para que un pedido nuevo se cree
   * confirmando solo la cantidad; y ver cuántas compras y cuánto ha invertido.
   */
  it('la ficha guarda las preferencias y el pedido nuevo viene ya relleno', async () => {
    const luis = (await conversations()).find((row) => row.id === ids.luis);

    // 1) En la ficha del cliente se guardan sus preferencias (como lo haría una persona).
    click(`[data-conv="${ids.luis}"]`);
    await waitFor(() => $('#wa-chat-avatar'), 'el chat de Luis', 9000);
    click('#wa-chat-avatar');
    await waitFor(() => $('#prefs-save'), 'la sección de preferencias en la ficha', 9000);
    // La ficha se pinta dos veces (lo que ya sabe y luego lo que confirma el
    // servidor): se espera a la segunda para no escribir sobre un render viejo.
    await waitFor(
      () => !$('#customer-profile').textContent.includes('Todavía no tiene pedidos registrados'),
      'la ficha completa del cliente',
      9000,
    );
    expect($('#customer-profile').textContent).toContain('Información guardada de pedido');
    expect($('#customer-profile').textContent).toContain('Compras');

    $('#prefs-variant').value = 'capsules_15';
    $('#prefs-quantity').value = '3';
    $('#prefs-payment').value = 'TRANSFER';
    $('#prefs-note').value = 'Entregar después de las 5 pm';
    click('#prefs-save');

    const prefs = await waitFor(async () => {
      const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
      const cliente = (data.customers ?? []).find((row) => row.id === luis.customer_id);
      return cliente?.orderPrefs?.quantity === 3 ? cliente.orderPrefs : null;
    }, 'las preferencias guardadas en el servidor', 9000);
    expect(prefs.variant_id).toBe('capsules_15');
    expect(prefs.payment_method).toBe('TRANSFER');
    expect(prefs.note).toContain('5 pm');

    // 2) Crear pedido desde el POS actual: el carrito recupera «lo de siempre».
    closeSheetForUat();
    click('.tabs [data-tab="whatsapp"]');
    const fila = await waitFor(() => $(`[data-conv="${ids.luis}"]`), 'la fila de Luis', 9000);
    click(fila);
    await waitFor(() => $('#wa-chat-name')?.textContent.includes('Luis'), 'el chat de Luis', 9000);
    await abrirAccionesChat();
    const crearPedido = await waitFor(() => $('#wa-chat-cols [data-order-new]'), 'el menú de acciones del chat', 9000);
    click(crearPedido);
    await waitFor(() => $('.pos-cart-lines [data-pos-quantity="0"]')?.textContent === '3', 'frasco y cantidad preferidos en el POS');
    expect($('.pos-cart-lines .pos-line-info strong').textContent).toContain('15');
    click('.pos-cart-lines [data-pos-edit="0"]');
    const cantidad = await waitFor(() => $('dialog [name="quantity"]'), 'editor de cantidad del POS');
    cantidad.value = '2';
    cantidad.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click('dialog form [type="submit"]');
    await waitFor(() => !$('dialog').open, 'carrito actualizado');
    click('[data-pos-pay]');
    await waitFor(() => $('.pos-order-dialog [data-order-field="paymentMethod"]'), 'forma de pago preferida');
    expect($('.pos-order-dialog [data-order-field="paymentMethod"]').value).toBe('TRANSFER');
    expect($('.pos-order-dialog [data-order-save-prefs]').checked).toBe(true);

    // Solo se confirma la cantidad.
    const retiro = await waitFor(() => $('.pos-order-dialog [data-order-method="pickup"]'), 'retiro');
    click(retiro);
    await waitFor(() => $('.pos-order-dialog [data-order-method="pickup"]')?.getAttribute('aria-pressed') === 'true', 'pedido en modo retiro');
    await waitFor(() => $('.pos-order-dialog [data-order-open-ack]') || $('.pos-order-dialog [data-order-confirm]')?.disabled === false, 'resumen de pedido actualizado', 20000);
    const ack = $('.pos-order-dialog [data-order-open-ack]');
    if (ack) {
      expect($('.pos-order-dialog .pos-open-warning').textContent).toMatch(/pedido.*sin cerrar|pedidos.*sin cerrar/i);
      ack.checked = true;
      ack.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
    await waitFor(() => $('.pos-order-dialog [data-order-confirm]')?.disabled === false, 'confirmación habilitada', 20000);
    $('.pos-order-dialog [data-order-confirm]').click();
    await waitFor(() => $('.pos-order-dialog h2')?.textContent.includes('Pedido guardado'), 'pedido guardado', 20000);
    click('.pos-order-dialog [data-pos-close]');
    await waitFor(async () => {
      const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
      const cliente = (data.customers ?? []).find((row) => row.id === luis.customer_id);
      return Number(cliente?.orderPrefs?.quantity) === 2 ? cliente : null;
    }, 'preferencias actualizadas con el pedido confirmado', 9000);

    const datos = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const pedidos = datos.items.filter((item) => item.type === 'order_intent' && item.customer_id === luis.customer_id);
    expect(pedidos.length).toBe(2);
    const nuevo = pedidos.find((item) => item.variant_id === 'capsules_15');
    expect(Number(nuevo.quantity)).toBe(2);
    expect(orderOfItem(nuevo).payment_method).toBe('TRANSFER');
    // «Lo de siempre» se actualiza por defecto con lo último confirmado.
    const cliente = datos.customers.find((row) => row.id === luis.customer_id);
    expect(Number(cliente.orderPrefs.quantity)).toBe(2);
  }, 60000);
});

describe('pedir al cliente que confirme su pedido', () => {
  it('«Pedir confirmación» manda el pedido REAL como texto (con varios, se elige CUÁL)', async () => {
    await abrirAccionesChat();
    const pedirConfirmacion = await waitFor(() => $('#wa-chat-cols [data-wa-confirm-order]'), 'el menú de acciones del chat', 9000);
    click(pedirConfirmacion);

    /*
     * Luis ya tiene MÁS DE UN pedido abierto: el CRM pregunta CUÁL, porque
     * mandarle el que no es sería un error grave. La primera fila es el más
     * reciente.
     */
    const filas = await waitFor(() => {
      const rows = $$('#sheet-body [data-order-confirm-pick]');
      return rows.length ? rows : null;
    }, 'la elección de pedido', 9000);
    expect(filas.length).toBeGreaterThan(1);

    const luis = (await conversations()).find((row) => row.id === ids.luis);
    const datos = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const ultimo = datos.items
      .filter((item) => item.type === 'order_intent' && item.customer_id === luis.customer_id)
      .sort((a, b) => String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')))[0];
    expect(ultimo).toBeTruthy();

    click(filas[0]);

    // El mensaje que se ENSEÑA es el que se envía: lo arma el servidor y aquí solo
    // se lee. Lleva los datos comerciales del pedido y nada técnico.
    const preview = await waitFor(() => $('#sheet-body .wa-preview'), 'el resumen del pedido', 9000);
    expect(preview.textContent).toContain(ultimo.order_number);
    expect(preview.textContent).toContain('este es tu pedido');
    expect(preview.textContent).toContain('revísalo y confírmanos si está correcto');
    expect(preview.textContent).not.toContain(ultimo.id);

    const antes = whatsapp.sent.length;
    click('#sheet-body #order-confirm-send');
    await waitFor(() => whatsapp.sent.length === antes + 1, 'la confirmación enviada', 9000);
    const enviado = whatsapp.sent.at(-1);
    // Es el pedido REAL como TEXTO: ninguna plantilla de por medio.
    expect(enviado.template).toBeUndefined();
    expect(enviado.body).toContain(ultimo.order_number);
    // Lo que se envía es EXACTAMENTE lo que se revisó en pantalla.
    expect(enviado.body).toBe(preview.textContent);
  }, 40000);
});

describe('la foto del cliente', () => {
  /*
   * WhatsApp NO entrega la foto de perfil de los contactos por su API (el webhook
   * solo trae `profile.name` y el wa_id del cliente no es un nodo de Graph), así
   * que la foto la pone el equipo: se guarda con el cliente y se ve en toda la
   * interfaz (lista, cabecera del chat y ficha).
   */
  const FOTO =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  let clienteAna = '';

  const clienteDe = async (phone) => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const soloDigitos = (value) => String(value ?? '').replace(/\D/g, '');
    return (data.customers ?? []).find((row) => soloDigitos(row.phone_e164) === phone) ?? null;
  };

  it('se guarda con el cliente y la API valida lo que recibe', async () => {
    clienteAna = (await clienteDe(PHONES.ana))?.id ?? '';
    expect(clienteAna).toBeTruthy();

    // Ni una URL de script ni un "data:" enorme: 422 y la ficha no cambia.
    const basura = await adminJson(`/api/admin/customers/${clienteAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_url: 'javascript:alert(1)' }),
    });
    expect(basura.response.status).toBe(422);
    expect(basura.body.error).toBe('invalid_photo');

    const enorme = await adminJson(`/api/admin/customers/${clienteAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_url: `data:image/png;base64,${'A'.repeat(150000)}` }),
    });
    expect(enorme.response.status).toBe(422);
    expect((await clienteDe(PHONES.ana))?.photo_url ?? null).toBe(null);

    const buena = await adminJson(`/api/admin/customers/${clienteAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_url: FOTO }),
    });
    expect(buena.response.status).toBe(200);
    expect((await clienteDe(PHONES.ana))?.photo_url).toBe(FOTO);
  });

  it('la foto aparece en la cabecera del chat, en la lista y en la ficha', async () => {
    // La foto se cambió en el test anterior directamente por API; refresca los
    // datos del panel igual que al volver a cargar el espacio de trabajo.
    dom.window.dispatchEvent(new dom.window.Event('fulltech:pos-saved'));
    await waitFor(() => $(`[data-conv="${ids.ana}"]`), 'lista actualizada desde el servidor', 9000);
    click('[data-wa-filter="todos"]');
    await waitFor(() => $(`[data-conv="${ids.ana}"]`), 'la fila de la conversación', 9000);
    /*
     * La lista es la de WhatsApp: el avatar redondo va delante del nombre y usa la
     * foto del cliente cuando la tiene (si no, las iniciales sobre un color fijo).
     */
    const enLista = await waitFor(
      () => $(`[data-conv="${ids.ana}"] .conv__avatar img`),
      'la foto del cliente como avatar de la fila',
      9000,
    );
    expect(enLista.getAttribute('src')).toBe(FOTO);

    click(`[data-conv="${ids.ana}"]`);
    const enCabecera = await waitFor(() => $('#wa-chat-avatar img'), 'la foto en la cabecera del chat', 9000);
    expect(enCabecera.getAttribute('src')).toBe(FOTO);

    click('#wa-chat-avatar');
    // La ficha se pinta dos veces (lo que ya sabemos y luego lo que confirma el
    // servidor): se espera a la segunda, que es la que trae la foto.
    const conFoto = await waitFor(
      () => $('.profile-head__photo'),
      'la foto en la cabecera de la ficha',
      9000,
    );
    // La foto real se enseña pequeña en la cabecera compacta (sin bloque enorme).
    expect(conFoto.getAttribute('data-profile-photo')).toBe(FOTO);
    expect(conFoto.getAttribute('style')).toContain(FOTO.slice(0, 40));
    expect($('#customer-photo-pick')).not.toBeNull();
    expect($('#customer-photo-clear')).not.toBeNull();
    expect($('#customer-photo-file').getAttribute('accept')).toContain('image/');
  }, 15000);

  it('se puede quitar y vuelven las iniciales', async () => {
    const quitada = await adminJson(`/api/admin/customers/${clienteAna}`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_url: null }),
    });
    expect(quitada.response.status).toBe(200);
    expect((await clienteDe(PHONES.ana))?.photo_url ?? null).toBe(null);
  });
});

describe('la lista que se pinta es la nueva', () => {
  const app_js = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');
  const css = readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
  const html = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');

  it('la fila usa «⋯» con acciones y ya no un selector crudo aparte', () => {
    expect(app_js).toContain('data-conv-more');
    expect(app_js).toContain('data-conv-act');
    expect(app_js).not.toContain('data-conv-select');
  });

  it('el CSS sostiene la fila fina, los sellos de tiempo y el cambio de cabecera', () => {
    expect(css).toContain('.conv__more');
    expect(css).toContain('.conv__stamps');
    /*
     * El filtro de fecha dejó de ser un icono con reloj pegado al buscador: es un
     * CHIP más de la lista, que enseña el rango activo y se cambia desde el mismo
     * sitio en el móvil y en el escritorio.
     */
    expect(css).toContain('.chip--date');
    expect(app_js).toContain('waDateChipHtml');
    expect(html).not.toContain('id="wa-date-menu"');
    expect(css).not.toContain('.wa-date__text');
    expect(app_js).toContain('data-wa-date');
    expect(app_js).toContain('America/Santo_Domingo');
    expect(css).toContain('.wa__list-head[hidden]');
    expect(css).toContain('.wa__convs--sel .conv__more');
    /*
     * La fila ENTERA es la tarjeta (el «⋯» queda dentro). Agregar cliente es un
     * botón FLOTANTE redondo, solo el icono, en la esquina.
     */
    expect(app_js).not.toContain('conv__avatar--profile');
    expect(css).toContain('.conv-wrap:has(.conv--active)');
    expect(css).toContain('.wa-new-chat');
    expect(css).toContain('position: fixed');
    expect(html).not.toContain('wa-new-chat__label');
    expect(css).toContain('.wa-bulk__btn');
    expect(app_js).toContain('wa-bulk__item');
  });

  it('la lista tiene la piel de WhatsApp (dos líneas, icono de cliente, contador verde)', () => {
    const wa = readFileSync(path.join(ADMIN_DIR, 'wa-lista.css'), 'utf8');
    // La hoja va la última y solo toca la pantalla de chats.
    expect(html).toContain('/admin/wa-lista.css');
    expect(wa).toContain("body[data-tab='whatsapp']");
    // Fila compacta (56 px), nombre 16, vista previa 13 y foto/avatar pequeño (18).
    expect(wa).toContain('min-height: 56px');
    expect(wa).toContain('width: 18px');
    expect(wa).toContain('width: 17px');
    expect(wa).toContain('font-size: 16px');
    expect(wa).toContain('font-size: 13px');
    // Dos filas × dos columnas: izquierda (icono+nombre / mensaje) y derecha
    // (hora / responsable · etapa). Las iniciales ya no se pintan.
    expect(wa).toMatch(/\.conv__body \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
    expect(wa).toMatch(/\.conv__stamps \{[^}]*grid-column: 2/);
    expect(wa).toMatch(/\.conv__meta \{[^}]*grid-column: 2/);
    expect(wa).toContain('.conv__icon');
    expect(wa).toMatch(/\.conv__avatar-initials \{\s*display: none;/);
    expect(wa).toContain('background: var(--wa-accent)');
    expect(wa).toContain('.conv__flags');
    expect(app_js).toContain('conv__icon');
    expect(app_js).toContain('/admin/assets/icons/ui/clientes.png');
  });

  it('la barra de selección vive en la cabecera de la lista', () => {
    expect(html).toContain('id="wa-sel"');
    expect(html).toContain('id="wa-new-chat"');
    expect(app_js).toContain('/api/admin/conversations/start');
    expect(css).toContain('.wa-new-chat');
    // El idioma de siempre: lo que se envía solo se dice, no se esconde.
    expect(app_js).toContain('data-wa-bulk');
  });
});

describe('el chat va EN VIVO (sin esperar al sondeo de 8 s)', () => {
  it('abre el canal del servidor y refresca la pantalla al recibir un aviso', async () => {
    click('[data-tab="whatsapp"]');
    const canal = await waitFor(
      () => dom.window.__eventSources.at(-1) ?? null,
      'el canal en vivo del chat',
      8000,
    );
    expect(canal.url).toBe('/api/admin/whatsapp/events');

    /*
     * Se cuentan las peticiones de la LISTA: el aviso del servidor tiene que
     * provocar el refresco por sí solo (sin esperar a los 8 s del sondeo).
     */
    const win = dom.window;
    const original = win.fetch;
    let listas = 0;
    win.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (url.includes('/api/admin/conversations?')) listas += 1;
      return original(input, init);
    };
    try {
      canal.emit('wa.message', { conversationId: ids.ana, direction: 'inbound', at: new Date().toISOString() });
      await waitFor(() => listas > 0, 'el refresco que dispara el aviso', 4000);
    } finally {
      win.fetch = original;
    }
  });

  it('al enviar, la burbuja sale AL INSTANTE y después se confirma', async () => {
    click(`[data-conv="${ids.luis}"]`);
    await waitFor(() => $('#wa-text'), 'el compositor de la conversación');
    const antes = whatsapp.sent.length;
    /*
     * SIN LA VENTANA DE DESHACER. En el panel son 8 s para poder retirar un
     * mensaje escrito a prisa; aquí se apaga (0) para no hacer esperar a la suite:
     * lo que se está probando es la burbuja instantánea y su confirmación, no la
     * ventana (esa tiene su propia prueba en `panel-mensajes-uat`).
     */
    dom.window.__PHYTO_UNDO_MS = 0;
    /*
     * Se anotan TODAS las peticiones que salen durante el envío: si la prueba
     * falla, el mensaje del fallo dice qué contestó el servidor (y qué avisó la
     * pantalla) en vez de dejar adivinando.
     */
    const win = dom.window;
    const original = win.fetch;
    const registro = [];
    win.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input.url);
      const response = await original(input, init);
      const texto = await response.text();
      registro.push({
        method: (init.method ?? 'GET').toUpperCase(),
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        status: response.status,
        cuerpo: String(texto).slice(0, 200),
      });
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => texto,
        json: async () => JSON.parse(texto),
      };
    };
    setValue('#wa-text', 'Te lo llevo hoy mismo');
    click('#wa-send');

    // SIN esperar a nadie: el mensaje ya está en el hilo diciendo que se envía.
    expect($('#thread').textContent).toContain('Te lo llevo hoy mismo');
    expect($('#thread').textContent).toContain('Enviando');

    try {
      // Cuando el servidor confirma, la provisional se sustituye (no se duplica).
      await waitFor(() => whatsapp.sent.length === antes + 1, 'el envío real al servidor', 8000);
      await waitFor(() => !$('#thread').textContent.includes('Enviando'), 'la confirmación del envío', 8000);
      const burbujas = [...$$('#thread .bubble')].filter((bubble) =>
        bubble.textContent.includes('Te lo llevo hoy mismo'),
      );
      expect(
        burbujas,
        `hilo: ${$('#thread').textContent.replace(/\s+/g, ' ').slice(0, 200)} | aviso: ${$('#toast').textContent} | peticiones: ${JSON.stringify(registro.slice(-6))}`,
      ).toHaveLength(1);
    } finally {
      win.fetch = original;
    }
  });

  /*
   * LA CARRERA DE VERDAD (y la que se veía en producción): un refresco de fondo
   * —el aviso del servidor, el sondeo— sale ANTES del envío y vuelve DESPUÉS, con
   * la foto del hilo de antes. Si esa respuesta manda, el mensaje recién enviado
   * desaparece de la pantalla («aparece, se va y vuelve»).
   *
   * Aquí se provoca a propósito y de forma determinista: la lectura del hilo se
   * retrasa, y la respuesta del envío TAMBIÉN (el servidor ya lo guardó, pero la
   * pantalla se entera tarde). Así la lectura vieja aterriza con el envío aún en
   * el aire, que es el hueco exacto.
   */
  it('un refresco LENTO que llega mientras el mensaje sale no se lleva la burbuja', async () => {
    click(`[data-conv="${ids.luis}"]`);
    await waitFor(() => $('#wa-text'), 'el compositor de la conversación');

    const win = dom.window;
    const original = win.fetch;
    let hiloRetrasado = false;
    let postRetrasado = false;
    win.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input.url);
      const method = (init.method ?? 'GET').toUpperCase();
      const esHilo = method === 'GET' && /\/api\/admin\/conversations\/[^/]+\/messages$/.test(url);
      const esEnvio = method === 'POST' && /\/api\/admin\/conversations\/[^/]+\/messages$/.test(url);
      if (esHilo && !hiloRetrasado) {
        hiloRetrasado = true;
        await sleep(300); // sale AHORA (sin el mensaje) y vuelve tarde
      }
      if (esEnvio && !postRetrasado) {
        postRetrasado = true;
        const respuesta = await original(input, init); // el servidor YA lo guardó…
        await sleep(450); // …pero la pantalla se entera 450 ms después
        return respuesta;
      }
      return original(input, init);
    };
    try {
      // El aviso del servidor arranca un refresco que se quedará en el aire…
      const canal = win.__eventSources.at(-1);
      canal.emit('wa.message', { conversationId: ids.luis, direction: 'inbound', at: new Date().toISOString() });
      await sleep(280);

      // …y el mensaje sale mientras esa lectura vieja viene de camino.
      whatsapp.sent.length = 0;
      setValue('#wa-text', 'Llego en media hora');
      click('#wa-send');
      await waitFor(() => whatsapp.sent.length === 1, 'el envío real', 8000);
      await waitFor(() => !$('#thread').textContent.includes('Enviando'), 'la confirmación del envío', 8000);

      // Y al final hay UNA sola burbuja con el mensaje (ni dos, ni ninguna).
      const burbujas = [...$$('#thread .bubble')].filter((bubble) =>
        bubble.textContent.includes('Llego en media hora'),
      );
      expect(
        burbujas,
        `hilo: ${$('#thread').textContent.replace(/\s+/g, ' ').slice(0, 240)}`,
      ).toHaveLength(1);
      expect($('#thread').textContent).not.toContain('Cargando');
    } finally {
      win.fetch = original;
    }
  });
});
