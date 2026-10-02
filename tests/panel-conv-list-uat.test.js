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

import { startCrmServer } from '../server/crm-server.mjs';
import { addDays, dayIn } from '../server/followups.mjs';

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
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.alert = () => {};
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
  await waitFor(() => $$('[data-conv]').length >= 3, 'la lista con las tres conversaciones', 8000);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la fila de la lista', () => {
  it('muestra Hoy + hora del último mensaje', () => {
    const row = $(`[data-conv="${ids.ana}"]`);
    const stamps = row.querySelector('.conv__stamps');
    const when = stamps.querySelector('.conv__when');
    expect(when.textContent).toMatch(/^Hoy · \d{1,2}:\d{2} (AM|PM)$/);
    expect(stamps.getAttribute('title')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('muestra Ayer + hora del último mensaje', () => {
    const row = $(`[data-conv="${ids.luis}"]`);
    expect(row.querySelector('.conv__when').textContent).toMatch(/^Ayer · \d{1,2}:\d{2} (AM|PM)$/);
  });

  it('muestra fecha corta para conversaciones antiguas', () => {
    const row = $(`[data-conv="${ids.maria}"]`);
    expect(row.querySelector('.conv__when').textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('muestra la imagen del cliente como último mensaje, no un JSON ni coordenadas', () => {
    const row = $(`[data-conv="${ids.ana}"]`);
    expect(row.querySelector('.conv__preview').textContent).toContain('Imagen');
    expect(row.querySelector('.conv__kind')).not.toBeNull();
  });

  it('la línea de estado es una etiqueta pequeña (no una frase con el día de la semana)', () => {
    const row = $(`[data-conv="${ids.luis}"]`);
    const tags = [...row.querySelectorAll('.conv__tag')].map((tag) => tag.textContent);
    expect(tags).toContain('Prospecto');
    expect(row.querySelector('.conv__assign--empty').textContent).toBe('Sin asignar');
    for (const tag of tags) expect(tag).not.toMatch(/,/);
  });

  it('cada fila termina en un «⋯» (y ya no hay un botón «Sel» aparte)', () => {
    expect($$('[data-conv-more]').length).toBe($$('[data-conv]').length);
    expect($$('[data-conv-select]').length).toBe(0);
  });
});

describe('el menú «⋯» de una conversación', () => {
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
  it('«Seleccionar varias» retira la cabecera y pone la barra de acciones', async () => {
    click(`[data-conv-more="${ids.luis}"]`);
    click('#sheet-body [data-conv-act="select"]');
    await waitFor(() => $('#wa-sel').hidden === false, 'la barra de selección visible');
    expect($('.wa__list-head').hidden).toBe(true);
    expect($('#wa-filters').hidden).toBe(true);
    expect($('#wa-conversations').classList.contains('wa__convs--sel')).toBe(true);
    expect($('#wa-sel .wa-bulk__count').textContent).toContain('1');
    // Cuatro acciones en iconos (caben en 360 px sin scroll horizontal).
    expect($$('#wa-sel .wa-bulk__btn').length).toBe(4);
    expect($(`[data-conv="${ids.luis}"] .conv__avatar svg`)).not.toBeNull();
  });

  it('con la selección abierta, tocar una fila selecciona o quita: NO abre el chat', async () => {
    click(`[data-conv="${ids.ana}"]`);
    await waitFor(() => $('#wa-sel .wa-bulk__count').textContent.includes('2'), 'la segunda conversación elegida');
    // Abrir el chat dejaría de ocultar el panel de la conversación: no pasó.
    expect($('#wa-chat-pane').hidden).toBe(true);
    click(`[data-conv="${ids.ana}"]`);
    await waitFor(() => $('#wa-sel .wa-bulk__count').textContent.includes('1'), 'la conversación quitada');
    expect($('#wa-chat-pane').hidden).toBe(true);
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

  it('después de enviar template queda WAITING_CUSTOMER_REPLY, cierra hoja y no habilita texto libre', async () => {
    const before = whatsapp.sent.length;
    click('#sheet-body #wa-send-template');
    await waitFor(() => $('#sheet').hidden === true, 'selector de plantilla cerrado tras enviar', 9000);
    await waitFor(() => $('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]'), 'estado esperando respuesta');
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(whatsapp.sent.at(-1).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Cliente UX Nuevo' }] },
    ]);
    expect($('#thread').textContent).toContain('Hola Cliente UX Nuevo');
    expect($('#wa-composer').textContent).toContain('Esperando respuesta de Cliente UX Nuevo');
    expect($('#wa-text')).toBeNull();
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
    expect($('#wa-text')).toBeNull();
  }, 12000);

  it('quick reply inbound abre OPEN_WINDOW sin recargar manualmente', async () => {
    await inbound('18095550666', 'wamid.UX-BUTTON-1', {
      type: 'button',
      button: { text: 'Continuar', payload: 'continuar' },
    });
    click('[data-wa-filter="todos"]');
    await waitFor(() => $('#wa-text'), 'composer libre tras quick reply inbound', 9000);
    expect($('#wa-composer [data-wa-contact-state="WAITING_CUSTOMER_REPLY"]')).toBeNull();
    expect($('#wa-composer').textContent).not.toContain('Esperando respuesta');
  }, 12000);

  it('con ventana expirada muestra CLOSED_WINDOW, no NEW_CONTACT', async () => {
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
    await waitFor(() => $('#wa-composer [data-wa-contact-state="CLOSED_WINDOW"]'), 'estado ventana cerrada', 9000);
    expect($('#wa-composer').textContent).toContain('Ventana de atención finalizada');
    expect($('#wa-composer').textContent).toContain('La ventana de atención de 24 horas terminó');
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
    whatsapp.failWith = null;
    expect(uxConversationId).toBeTruthy();
  }, 12000);
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
    expect(css).toContain('.wa-date');
    expect(app_js).toContain('data-wa-date');
    expect(app_js).toContain('America/Santo_Domingo');
    expect(css).toContain('.wa__list-head[hidden]');
    expect(css).toContain('.wa__convs--sel .conv__more');
    expect(css).toContain('.wa-bulk__btn');
    expect(app_js).toContain('wa-bulk__btn');
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
