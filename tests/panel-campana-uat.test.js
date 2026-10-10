// @vitest-environment jsdom
/**
 * UAT DEL PANEL — CAMPAÑA DE WHATSAPP (panel real + CRM real).
 *
 * Lo que el negocio pidió y aquí se sujeta:
 *   - la campaña sale con la presentación de FULLTECH («te escribimos de Fulltech,
 *     distribuidor de Phytoemagry en Higüey»), no con la genérica;
 *   - el mensaje que se programa es PALABRA POR PALABRA el que pidió el negocio
 *     (aviso de la mudanza incluido);
 *   - esa plantilla tiene que estar APROBADA por Meta: si no lo está, la campaña
 *     usa la genérica (nunca se finge una aprobación);
 *   - el hueco LIBRE del mensaje lo declara el CRM aunque la plantilla venga
 *     recién creada de Meta (si no, el panel no sabría por dónde va el mensaje).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-campana-panel';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

/** El texto fijo que aprueba Meta para las campañas. */
const CUERPO_FULLTECH =
  'Hola {{1}}, te escribimos de Fulltech, distribuidor de Phytoemagry en Higüey.\n\n{{2}}\n\nCualquier duda, respóndenos por aquí y te ayudamos.';
/** La genérica (la que se usa si la de Fulltech todavía no está aprobada). */
const CUERPO_GENERICA =
  'Hola {{1}}, te escribimos de Phytoemagry. {{2}} Cualquier duda, respóndenos por aquí y te ayudamos.';
/** El aviso de la mudanza: lo que escribe el negocio en el hueco libre. */
const AVISO_MUDANZA =
  'Nos mudamos temporalmente a La Otra Banda y ahora trabajamos de forma virtual, con almacen en Higuey. Tenemos delivery de 8 a. m. a 9 p. m. Para pedidos o consultas, escribenos por aqui. Entrega rapida.';

/** El mensaje final EXACTO que tiene que quedar programado (con el hueco sin rellenar). */
const MENSAJE_ESPERADO =
  `Hola {{nombre}}, te escribimos de Fulltech, distribuidor de Phytoemagry en Higüey.\n\n${AVISO_MUDANZA}\n\n` +
  'Cualquier duda, respóndenos por aquí y te ayudamos.';

let tmpDir;
let app;
let dom;
let cookie = '';
/** Lo que el panel manda al servidor (URL + cuerpo): así se comprueba de verdad. */
const peticiones = [];

const mockWhatsApp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN123',
  businessAccountId: 'WABA1',
  sent: [],
  /** Lo que «existe» en Meta. Se cambia en cada prueba. */
  metaTemplates: [],
  async listTemplates() {
    return { ok: true, templates: mockWhatsApp.metaTemplates };
  },
  async sendText(to, body) {
    mockWhatsApp.sent.push({ to, body, type: 'text' });
    return { ok: true, status: 200, messageId: `wamid.TXT${mockWhatsApp.sent.length}` };
  },
  async sendTemplate(to, template) {
    mockWhatsApp.sent.push({ to, template, type: 'template' });
    return { ok: true, status: 200, messageId: `wamid.TPL${mockWhatsApp.sent.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const plantillaAprobada = (name, text) => ({
  name,
  id: `meta_${name}`,
  language: 'es',
  category: 'MARKETING',
  status: 'APPROVED',
  components: [{ type: 'BODY', text }],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 12000) {
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
  if (!input) throw new Error(`no existe el campo: ${selector}`);
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

/** Abre la hoja de campaña desde Clientes (el botón flotante de administración). */
async function abrirCampana() {
  click('[data-tab="clientes"]');
  const fab = await waitFor(() => $('#customer-campaign-fab'), 'el botón de campaña');
  click(fab);
  await waitFor(() => $('#campaign-message'), 'la hoja de campaña');
  // La hoja sincroniza plantillas con Meta antes de pintar los desplegables.
  await waitFor(() => $$('#campaign-template option').length > 0, 'las plantillas de la hoja');
  await sleep(150);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-campana-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    whatsapp: mockWhatsApp,
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  // Dos clientes con teléfono: la campaña necesita destinatarios.
  await app.customers.findOrCreateByPhone({ phone: '18095557701', name: 'Ana Campaña', source: 'test' });
  await app.customers.findOrCreateByPhone({ phone: '18095557702', name: 'Luis Campaña', source: 'test' });

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
    if (init.body && String(url).includes('/api/')) peticiones.push({ url, body: String(init.body) });
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await waitFor(() => !$('#app')?.hidden, 'el panel cargado');
});

afterAll(async () => {
  dom?.window?.close();
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('campaña de WhatsApp: la presentación de Fulltech', () => {
  it('con la plantilla de Fulltech aprobada, la campaña la usa y el mensaje final es el del negocio', async () => {
    mockWhatsApp.metaTemplates = [
      plantillaAprobada('phyto_aviso_fulltech_v1', CUERPO_FULLTECH),
      plantillaAprobada('phyto_mensaje_personalizado_v1', CUERPO_GENERICA),
    ];
    // Se fuerza el sync para que el CRM las vea como aprobadas de verdad.
    await fetch(`${app.url}/api/admin/wa-templates/sync`, { method: 'POST', headers: { cookie }, body: '{}' });

    await abrirCampana();
    const select = $('#campaign-template');
    expect(select.value).toBe('phyto_aviso_fulltech_v1');
    // El nombre amable sale del catálogo del CRM, no del nombre técnico.
    const opcion = [...select.options].find((row) => row.value === 'phyto_aviso_fulltech_v1');
    expect(opcion.textContent).toContain('Fulltech');
    // El mensaje que se va a programar es el del negocio, palabra por palabra.
    expect($('#campaign-message').value).toBe(MENSAJE_ESPERADO);
    // Y la vista previa enseña el nombre de ejemplo en vez del hueco.
    expect($('#campaign-preview').textContent).toContain('Fulltech, distribuidor de Phytoemagry en Higüey');
    // Nada de avisos de «la plantilla agrega texto fijo»: encaja exacto.
    expect($('#campaign-summary').textContent).not.toMatch(/agrega texto fijo/i);
  });

  it('al programarla, el servidor recibe ESA plantilla y ESE mensaje (requireExactBody)', async () => {
    await abrirCampana();
    peticiones.length = 0;
    click('#campaign-review');
    await waitFor(() => $('#campaign-result')?.textContent?.trim(), 'el resultado de la revisión');
    click('#campaign-schedule');
    const envio = await waitFor(
      () => peticiones.find((row) => row.url.includes('/api/admin/customer-campaigns/schedule') && row.body.includes('"dryRun":false')),
      'la petición de programar la campaña',
    );
    const body = JSON.parse(envio.body);
    expect(body.template).toBe('phyto_aviso_fulltech_v1');
    expect(body.customMessage).toBe(MENSAJE_ESPERADO);
    expect(body.requireExactBody).toBe(true);
    // Todavía no se manda nada: queda programado y el servidor revalida al enviar.
    expect(mockWhatsApp.sent).toHaveLength(0);
  });

  it('si la de Fulltech NO está aprobada, la campaña usa la genérica (nunca finge)', async () => {
    mockWhatsApp.metaTemplates = [plantillaAprobada('phyto_mensaje_personalizado_v1', CUERPO_GENERICA)];
    await fetch(`${app.url}/api/admin/wa-templates/sync`, { method: 'POST', headers: { cookie }, body: '{}' });

    await abrirCampana();
    expect($('#campaign-template').value).toBe('phyto_mensaje_personalizado_v1');
    expect($('#campaign-message').value).toContain('te escribimos de Phytoemagry');
    expect($('#campaign-message').value).not.toContain('Fulltech');
    expect($('#campaign-message').value).toContain(AVISO_MUDANZA);
  });

  it('cambiar de plantilla rehace el mensaje con su texto fijo (y se ve en la vista previa)', async () => {
    mockWhatsApp.metaTemplates = [
      plantillaAprobada('phyto_aviso_fulltech_v1', CUERPO_FULLTECH),
      plantillaAprobada('phyto_mensaje_personalizado_v1', CUERPO_GENERICA),
    ];
    await fetch(`${app.url}/api/admin/wa-templates/sync`, { method: 'POST', headers: { cookie }, body: '{}' });

    await abrirCampana();
    setValue('#campaign-template', 'phyto_mensaje_personalizado_v1');
    expect($('#campaign-message').value).toContain('te escribimos de Phytoemagry');
    expect($('#campaign-preview').textContent).not.toContain('Fulltech');
    setValue('#campaign-template', 'phyto_aviso_fulltech_v1');
    expect($('#campaign-message').value).toBe(MENSAJE_ESPERADO);
    expect($('#campaign-preview').textContent).toContain('Fulltech');
  });
});
