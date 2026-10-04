// @vitest-environment jsdom
/**
 * UAT DEL PANEL — CHAT DIRECTO con «Contacto personalizado».
 *
 * Lo que se demuestra aquí, que es lo que se pidió:
 *   - el NOMBRE viene puesto solo y se dice que es automático;
 *   - el MENSAJE se escribe en un campo amplio y es editable;
 *   - la VISTA PREVIA enseña el texto exacto que se va a enviar, con sus saltos
 *     de línea, antes de tocar «Enviar»;
 *   - las plantillas que Meta todavía NO ha aprobado se ven aparte y se dice que
 *     no se pueden enviar (nada de fingir que están listas);
 *   - abrir la hoja no manda nada, y al enviar viajan los dos parámetros exactos.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-chat-directo';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONE = '18095559071';
const NOMBRE = 'Juan Pérez';

const CUERPO =
  'Hola {{1}}, te escribimos de Phytoemagry.\n\n{{2}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.';

/** Graph de mentira: NO hay una sola llamada real a Meta. */
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-CHAT',
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
let conversationId = '';

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
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
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

async function adminJson(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-chat-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    whatsappPhoneNumber: '+18095550000',
    whatsapp,
    schedulerEnabled: false,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  /*
   * Solo se aprueba ESTA plantilla (como si Meta la hubiera aprobado) y con su
   * cuerpo EXACTO: la prueba no puede pasar con un texto distinto al que hay que
   * registrar en Meta. Las demás se quedan pendientes a propósito.
   */
  const guardada = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_contacto_personalizado_v1',
      friendlyName: 'Contacto personalizado',
      status: 'APPROVED',
      body: CUERPO,
      variables: ['customer_name', 'mensaje'],
    }),
  });
  if (guardada.response.status !== 200) throw new Error(`no se pudo aprobar la plantilla: ${JSON.stringify(guardada.body)}`);

  const started = await adminJson('/api/admin/conversations/start', {
    method: 'POST',
    body: JSON.stringify({ phone: PHONE, name: NOMBRE, body: '' }),
  });
  expect(started.response.status).toBe(200);
  conversationId = started.body.conversation.id;

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
  await waitFor(() => $$('[data-conv]').length >= 1, 'la lista con la conversación');
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la hoja de plantilla del chat directo', () => {
  it('trae el NOMBRE del cliente puesto y avisado como automático', async () => {
    click(`[data-conv="${conversationId}"]`);
    await waitFor(() => $('#wa-open-template'), 'el botón de plantilla del compositor');
    click('#wa-open-template');
    await waitFor(() => $('#wa-template-fields [data-wa-var="1"]'), 'los huecos de la plantilla');

    expect($('#wa-template').value).toBe('phyto_contacto_personalizado_v1');
    const nombre = $('#wa-template-fields [data-wa-var="1"]');
    expect(nombre.value).toBe(NOMBRE);
    expect(nombre.closest('.field').textContent).toContain('Nombre del cliente');
    expect(nombre.closest('.field').textContent).toContain('automático');
    // Ya no hay ningún hueco de saludo por hora.
    expect($('#wa-template-fields [data-wa-var="3"]')).toBeNull();
    expect($('#wa-template-fields').textContent).not.toMatch(/Buenos|Buenas/);
  }, 20000);

  it('el MENSAJE se escribe en un campo amplio de varias líneas, no en un renglón', () => {
    const libre = $('#wa-template-fields [data-wa-var="2"]');
    expect(libre.tagName).toBe('TEXTAREA');
    expect(libre.closest('.field').textContent).toContain('lo escribes tú');
    expect($('#wa-template-fields [data-wa-var="1"]').tagName).toBe('INPUT');
  });

  it('la VISTA PREVIA es exacta, con los saltos de línea del texto fijo', () => {
    const texto = 'Queremos confirmar si todavía deseas recibir tu pedido mañana.';
    setValue('#wa-template-fields [data-wa-var="2"]', texto);
    const esperado = CUERPO.replace('{{1}}', NOMBRE).replace('{{2}}', texto);
    expect($('#wa-template-preview').textContent).toBe(esperado);
    expect($('#wa-template-preview').textContent.split('\n\n')).toHaveLength(3);
  });

  it('enseña lo que FALTA en vez de un hueco vacío', () => {
    setValue('#wa-template-fields [data-wa-var="2"]', '');
    expect($('#wa-template-preview').textContent).toContain('⟨falta Tu mensaje⟩');
  });

  it('las plantillas que Meta NO ha aprobado se ven aparte y avisadas', () => {
    // El aviso existe y nombra la plantilla nueva de seguimiento programado.
    const aviso = $('.wa-pending');
    expect(aviso).not.toBeNull();
    expect(aviso.textContent).toContain('Pendientes de aprobación de Meta');
    expect(aviso.textContent).toContain('phyto_seguimiento_compra_v1');
    expect(aviso.textContent).toContain('phyto_seguimiento_interes_v1');
    // Y NO aparece entre las que se pueden enviar.
    expect([...$$('#wa-template option')].map((option) => option.value)).not.toContain(
      'phyto_seguimiento_compra_v1',
    );
  });

  it('abrir la hoja y mirar la vista previa NO manda nada', () => {
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('al enviar viajan los dos parámetros y el texto final es el previsto', async () => {
    const texto = 'Queremos confirmar si todavía deseas recibir tu pedido mañana.';
    setValue('#wa-template-fields [data-wa-var="2"]', texto);
    const previsto = $('#wa-template-preview').textContent;

    click('#wa-send-template');
    await waitFor(() => whatsapp.sent.length === 1, 'la plantilla enviada');

    const enviado = whatsapp.sent[0];
    expect(enviado.to).toBe(`+${PHONE}`);
    expect(enviado.template.name).toBe('phyto_contacto_personalizado_v1');
    expect(enviado.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: NOMBRE },
          { type: 'text', text: texto },
        ],
      },
    ]);
    // Lo que se envió es EXACTAMENTE lo que decía la vista previa.
    await waitFor(() => $('#thread').textContent.includes('te escribimos de Phytoemagry'), 'el mensaje en el hilo');
    expect($('#thread').textContent).toContain(previsto.split('\n\n')[1]);
    expect($('#thread').textContent).not.toContain(PHONE);
  }, 20000);
});
