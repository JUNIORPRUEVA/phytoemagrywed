// @vitest-environment jsdom
/**
 * UAT DEL PANEL — PLANTILLA PRINCIPAL «Contacto personalizado».
 *
 * Lo que se demuestra aquí, que es lo que se pidió:
 *   - el saludo viene PUESTO y calculado por el servidor con la hora local del
 *     negocio (y se dice que es automático, para poder corregirlo);
 *   - el hueco libre se escribe en un CAMPO AMPLIO (varias líneas), no en un
 *     renglón suelto, porque es un mensaje;
 *   - la VISTA PREVIA enseña el texto exacto que se va a enviar, con sus saltos
 *     de línea, antes de tocar «Enviar»;
 *   - abrir la hoja no manda nada, y al enviar viajan solo los tres parámetros.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-plantilla-contacto';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONE = '18095559001';
const NOMBRE = 'Juan Pérez';

const CUERPO =
  '{{1}}, {{2}}.\n\nTe escribimos de Phytoemagry en relación con tu solicitud.\n\n{{3}}\n\nSi necesitas alguna información adicional, estamos disponibles para ayudarte.';

/** Graph de mentira: NO hay una sola llamada real a Meta. */
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-TPL',
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
  /*
   * A PROPÓSITO no hay `listTemplates`, igual que en el resto de UAT del panel:
   * si Meta devolviera una lista SIN la plantilla, el CRM la marcaría como «no
   * aprobada» (que es lo correcto). Aquí interesa el camino normal: la plantilla
   * ya está aprobada y el CRM la conserva tal cual hasta que alguien la cambie.
   */
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-tpl-contacto-'));
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
   * La plantilla se aprueba SOLO aquí (como si Meta ya la hubiera aprobado) y con
   * su cuerpo EXACTO: la prueba no puede pasar con un texto distinto al que hay
   * que registrar en Meta. El cuerpo y las variables son los del CRM; nada se
   * inventa en la prueba.
   */
  const guardada = await adminJson('/api/admin/wa-templates', {
    method: 'POST',
    body: JSON.stringify({
      name: 'phyto_contacto_personalizado_v1',
      friendlyName: 'Contacto personalizado',
      status: 'APPROVED',
      body: CUERPO,
      variables: ['saludo', 'customer_name', 'mensaje'],
      metaTemplateId: 'tpl-uat-contacto',
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  if (guardada.response.status !== 200) throw new Error(`no se pudo aprobar la plantilla: ${JSON.stringify(guardada.body)}`);
  // No hay ninguna otra aprobada: la hoja tiene que elegir ESTA.
  for (const row of guardada.body.templates ?? []) {
    if (row.name !== 'phyto_contacto_personalizado_v1' && row.sendable) {
      await adminJson('/api/admin/wa-templates', {
        method: 'POST',
        body: JSON.stringify({ name: row.name, status: 'PENDING' }),
      });
    }
  }

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

describe('la hoja de la plantilla principal', () => {
  it('el saludo viene puesto por el servidor, avisado como automático', async () => {
    click(`[data-conv="${conversationId}"]`);
    await waitFor(() => $('#wa-open-template'), 'el botón de plantilla del compositor');
    click('#wa-open-template');
    await waitFor(() => $('#wa-template-fields [data-wa-var="1"]'), 'los huecos de la plantilla');

    // La plantilla nueva es la que se elige (y es la única aprobada).
    expect($('#wa-template').value).toBe('phyto_contacto_personalizado_v1');

    // El saludo lo dice el SERVIDOR: el panel solo lo trae puesto.
    const delServidor = await adminJson('/api/admin/wa-templates');
    const saludo = $('#wa-template-fields [data-wa-var="1"]');
    expect(saludo.value).toBe(delServidor.body.greeting);
    expect(['Buenos días', 'Buenas tardes', 'Buenas noches']).toContain(saludo.value);
    // Y se avisa de que es automático, para poder corregirlo.
    expect(saludo.closest('.field').textContent).toContain('Saludo');
    expect(saludo.closest('.field').textContent).toContain('automático según la hora');

    // El nombre real del cliente también viene puesto.
    expect($('#wa-template-fields [data-wa-var="2"]').value).toBe(NOMBRE);
  }, 20000);

  it('el hueco libre es un campo AMPLIO de varias líneas, no un renglón suelto', () => {
    const libre = $('#wa-template-fields [data-wa-var="3"]');
    expect(libre.tagName).toBe('TEXTAREA');
    expect(libre.closest('.field').textContent).toContain('lo escribes tú');
    // Los otros huecos siguen siendo campos de una línea.
    expect($('#wa-template-fields [data-wa-var="1"]').tagName).toBe('INPUT');
    expect($('#wa-template-fields [data-wa-var="2"]').tagName).toBe('INPUT');
  });

  it('la vista previa es EXACTA, con los saltos de línea del texto fijo', () => {
    const saludo = $('#wa-template-fields [data-wa-var="1"]').value;
    const texto = 'Queremos confirmar si todavía deseas recibir tu pedido mañana.';
    setValue('#wa-template-fields [data-wa-var="3"]', texto);
    const esperado = CUERPO.replace('{{1}}', saludo).replace('{{2}}', NOMBRE).replace('{{3}}', texto);
    expect($('#wa-template-preview').textContent).toBe(esperado);
    // Con saltos de línea de verdad (no todo en una línea).
    expect($('#wa-template-preview').textContent.split('\n\n')).toHaveLength(4);
  });

  it('enseña lo que FALTA en vez de un hueco vacío o un `{{3}}` suelto', () => {
    setValue('#wa-template-fields [data-wa-var="3"]', '');
    expect($('#wa-template-preview').textContent).toContain('⟨falta Tu mensaje⟩');
  });

  it('abrir la hoja y mirar la vista previa NO manda nada', () => {
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('al enviar viajan los tres parámetros y el texto final es el previsto', async () => {
    const saludo = $('#wa-template-fields [data-wa-var="1"]').value;
    const texto = 'Queremos confirmar si todavía deseas recibir tu pedido mañana.';
    setValue('#wa-template-fields [data-wa-var="3"]', texto);
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
          { type: 'text', text: saludo },
          { type: 'text', text: NOMBRE },
          { type: 'text', text: texto },
        ],
      },
    ]);
    // Lo que se envió es EXACTAMENTE lo que la vista previa decía.
    await waitFor(() => $('#thread').textContent.includes('Te escribimos de Phytoemagry'), 'el mensaje en el hilo');
    expect($('#thread').textContent).toContain(previsto.split('\n\n')[2]);
    expect($('#thread').textContent).not.toContain(PHONE);
  }, 20000);
});
