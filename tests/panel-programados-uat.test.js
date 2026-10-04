// @vitest-environment jsdom
/**
 * UAT DEL PANEL — PANTALLA DE MENSAJES PROGRAMADOS.
 *
 * Es OTRA pantalla que el chat: aquí se elige la plantilla de seguimiento (la
 * propone el CRM), se revisa el mensaje COMPLETO que se enviará y se fija la
 * fecha y la hora. Nada de mezclar texto libre con plantilla sin que se sepa.
 *
 * Lo que se demuestra:
 *   - cliente con compra → propone «Seguimiento de compra» y el texto de cliente
 *     de volumen (6 frascos o más);
 *   - cliente sin compra → propone «Seguimiento de interés» y el texto general,
 *     SIN mencionar ningún «grupo»;
 *   - el mensaje sugerido se puede editar y lo que se guarda es lo editado;
 *   - con la plantilla pendiente de Meta NO se deja programar y se explica;
 *   - el mensaje programado se ve en la ficha en palabras (nunca un código
 *     técnico) y se puede cancelar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';
import { SUGGESTED_TEXT } from '../server/message-suggestions.mjs';

const TOKEN = 'uat-programados';
const APP_SECRET = 'uat-programados-secret';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const PHONES = { compra: '18095559101', interes: '18095559102' };
const NOMBRES = { [PHONES.compra]: 'Ana Compra', [PHONES.interes]: 'Luis Interés' };

const COMPRA_TEMPLATE = 'phyto_seguimiento_compra_v1';
const INTERES_TEMPLATE = 'phyto_seguimiento_interes_v1';

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
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
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

/** Abre «Programar mensaje» desde el chat de ese cliente. */
async function abrirProgramar(slot) {
  click(`[data-conv="${ids[slot]}"]`);
  await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
  click('#wa-actions');
  click(await waitFor(() => $('[data-scheduled-new]'), 'la acción de programar mensaje'));
  await waitFor(() => $('#sch-save'), 'la pantalla de programar mensaje');
  await waitFor(() => $('#sch-save')?.dataset?.schLoading === '0', 'la propuesta preparada');
}

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
  await waitFor(() => $$('[data-conv]').length >= 2, 'la lista con las dos conversaciones');
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('la pantalla de programar mensaje', () => {
  it('cliente que YA compró → propone seguimiento de compra y el texto de volumen', async () => {
    await abrirProgramar('compra');
    // El nombre que se va a usar es el del cliente de ESTA conversación.
    expect($('#sheet-title').textContent).toContain('Ana Compra');
    await waitFor(() => $('#sch-template-name')?.textContent?.includes('Seguimiento de compra'), 'la plantilla propuesta');
    expect($('#sch-tipo').value).toBe('compra');
    expect($('#sch-template').value).toBe(COMPRA_TEMPLATE);
    // 8 frascos = 6 o más → el mensaje de cliente de volumen.
    expect($('#sch-text').value).toBe(SUGGESTED_TEXT.purchaseMany);
    // El hueco del nombre viene puesto y se dice que es automático.
    const nombre = $('#sch-fields [data-sch-var="1"]');
    expect(nombre.value).toBe('Ana Compra');
    expect(nombre.closest('.field').textContent).toContain('automático');
  }, 25000);

  it('la vista previa enseña el mensaje COMPLETO que se enviará', async () => {
    await waitFor(() => $('#sch-preview')?.textContent?.includes('Ana Compra'), 'la vista previa');
    const previsto = $('#sch-preview').textContent;
    expect(previsto).toContain('Ana Compra');
    expect(previsto).toContain(SUGGESTED_TEXT.purchaseMany);
    expect(previsto).toContain('Cuéntanos cómo te ha ido');
    // Con sus saltos de línea del texto fijo.
    expect(previsto.split('\n\n')).toHaveLength(3);
  }, 15000);

  it('el mensaje sugerido se puede EDITAR y se guarda lo editado', async () => {
    const mio = 'Queríamos saber cómo te fue con tu pedido.';
    setValue('#sch-text', mio);
    expect($('#sch-preview').textContent).toContain(mio);
    expect($('#sch-preview').textContent).not.toContain(SUGGESTED_TEXT.purchaseMany);

    click('#sch-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada tras programar');
    const row = await waitFor(
      async () => (await programados()).find((entry) => entry.customer_id === ids.compraCustomer) ?? null,
      'el mensaje programado en el servidor',
    );
    expect(row.status).toBe('SCHEDULED');
    expect(row.template).toBe(COMPRA_TEMPLATE);
    // El contenido queda congelado con el nombre real y el texto editado.
    expect(row.template_components[0].parameters[0].text).toBe('Ana Compra');
    expect(row.template_components[0].parameters[1].text).toBe(mio);
    expect(row.template_body).toContain(mio);
    expect(row.template_language).toBe('es');
    expect(row.time_zone).toBeTruthy();
    ids.compraScheduled = row.id;
  }, 25000);

  it('cliente SIN compra → propone seguimiento de interés y NO menciona ningún grupo', async () => {
    await abrirProgramar('interes');
    await waitFor(() => $('#sch-template-name')?.textContent?.includes('Seguimiento de interés'), 'la plantilla propuesta');
    expect($('#sch-tipo').value).toBe('interes');
    expect($('#sch-text').value).toBe(SUGGESTED_TEXT.interestGeneral);
    expect($('#sheet-body').textContent).not.toMatch(/grupo/i);
  }, 25000);

  it('con la plantilla PENDIENTE de Meta no se puede programar y se explica por qué', async () => {
    // La de interés todavía no está aprobada: el botón está apagado…
    await waitFor(() => $('#sch-template-name')?.textContent?.includes('Seguimiento de interés'), 'la plantilla propuesta');
    expect($('#sch-save').disabled).toBe(true);
    expect($('#sch-note').textContent).toMatch(/no está aprobada en Meta/i);
    // …y pulsar no programa nada.
    click('#sch-save');
    await sleep(120);
    expect((await programados()).filter((entry) => entry.customer_id === ids.interesCustomer)).toHaveLength(0);
  }, 20000);

  it('cuando Meta la aprueba (y el CRM sincroniza) ya se puede programar', async () => {
    await adminJson('/api/admin/wa-templates', {
      method: 'POST',
      body: JSON.stringify({ name: INTERES_TEMPLATE, status: 'APPROVED' }),
    });
    // Se cierra y se vuelve a abrir: la pantalla refresca las plantillas sola.
    click('[data-close-sheet]');
    await abrirProgramar('interes');
    // El formulario es de ESTE cliente (no del anterior).
    expect($('#sheet-title').textContent).toContain('Luis Interés');
    await waitFor(() => $('#sch-save')?.disabled === false, 'el botón habilitado tras la aprobación');
    expect($('#sch-template').value).toBe(INTERES_TEMPLATE);
    click('#sch-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada tras programar');
    const row = await waitFor(
      async () => (await programados()).find((entry) => entry.customer_id === ids.interesCustomer) ?? null,
      'el mensaje programado de interés',
    );
    expect(row.status).toBe('SCHEDULED');
    expect(row.template).toBe(INTERES_TEMPLATE);
    expect(row.template_components[0].parameters[0].text).toBe('Luis Interés');
  }, 25000);
});

describe('lo que se ve en la ficha del cliente', () => {
  it('los mensajes programados se cuentan en palabras, sin códigos técnicos', async () => {
    click('[data-close-sheet]');
    // Se abre la ficha del cliente desde su chat.
    click(`[data-conv="${ids.compra}"]`);
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    click(await waitFor(() => $('#sheet-body [data-customer]'), 'la acción de abrir la ficha'));
    const lista = await waitFor(() => $('.sch-list'), 'la lista de mensajes programados');
    expect(lista.textContent).toContain('Pendiente de envío');
    expect(lista.textContent).toContain('Seguimiento de compra');
    // El texto que se va a enviar, a la vista.
    expect(lista.textContent).toContain('Queríamos saber cómo te fue con tu pedido.');
    // Y NADA de códigos técnicos de Meta.
    for (const codigo of ['131026', '132000', '132001', 'SCHEDULED', 'PROCESSING', 'BLOCKED']) {
      expect(lista.textContent).not.toContain(codigo);
    }
  }, 25000);

  it('se puede CANCELAR y la ficha lo dice en palabras', async () => {
    const boton = await waitFor(() => $('.sch-item [data-scheduled-cancel]'), 'el botón de cancelar');
    click(boton);
    await waitFor(async () => {
      const data = await programados();
      return data.find((entry) => entry.id === ids.compraScheduled)?.status === 'CANCELLED';
    }, 'el mensaje cancelado');
    await waitFor(() => $('.sch-item')?.textContent?.includes('Cancelado'), 'el estado en palabras');
    expect($('.sch-item').textContent).not.toContain('CANCELLED');
  }, 25000);
});
