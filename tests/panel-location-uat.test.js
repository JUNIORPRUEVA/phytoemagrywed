// @vitest-environment jsdom
/**
 * UAT DEL PANEL — UBICACIÓN GPS + DELIVERY (con el servidor de verdad y dobles).
 *
 * Lo que se demuestra aquí, que es lo que decide si esto sirve en el mostrador:
 *   - una ubicación recibida se ve como UN componente compacto, con su enlace de
 *     mapa calculado desde las coordenadas (no guardado);
 *   - lo que manda WhatsApp (nombre/dirección) se ESCAPA: no puede ejecutar HTML;
 *   - la lista de chats dice «📍 Ubicación» y nunca un JSON ni coordenadas;
 *   - el formulario de pedido ya NO pide ciudad ni dirección, ofrece la ubicación
 *     compartida (con su edad), permite no usar ninguna, y el total suma el
 *     delivery;
 *   - el permiso de ubicación del navegador NO se pide al abrir: solo al pulsar;
 *   - enviar una ubicación exige PREVISUALIZAR y CONFIRMAR (el servidor además
 *     exige `confirmed: true`);
 *   - compartir con otro chat avisa y pide confirmación explícita.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-loc-panel';
const APP_SECRET = 'uat-loc-secret';
const PHONE = '18095550222';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' };
const L2 = { latitude: 18.4861, longitude: -69.9312, name: 'Trabajo', address: 'Av. Duarte 45, Santo Domingo' };

let tmpDir;
let app;
let dom;
let cookie = '';
let conversationId = '';
let customerId = '';
const sentLocations = [];
let confirmAnswer = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 4000) {
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
 * Pulsa como un NAVEGADOR de verdad: devuelve `false` y no hace NADA si el
 * control está deshabilitado (`dispatchEvent` sí dispararía el listener de un
 * botón gris, que es justo lo que un dedo no puede hacer).
 */
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-LOC',
  businessAccountId: 'WABA1',
  sent: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.TXT${whatsapp.sent.length}` };
  },
  async sendTemplate() {
    return { ok: true, status: 200, messageId: 'wamid.TPL1' };
  },
  async sendLocation(to, location) {
    sentLocations.push({ to, location });
    return { ok: true, status: 200, messageId: `wamid.LOC${sentLocations.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

/** Mensaje entrante firmado (webhook real del CRM). */
async function inbound(id, node) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana Ubicación' }, wa_id: PHONE }],
              messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
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

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-loc-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    schedulerEnabled: false,
  });

  /*
   * Se manda PRIMERO el texto y DESPUÉS las ubicaciones: así el último mensaje del
   * hilo es una ubicación (que es lo que comprueba la vista previa de la lista) y
   * el componente XSS ya está guardado cuando el panel carga.
   */
  await inbound('wamid.UAT-TXT', { type: 'text', text: { body: 'Voy a pagar' } });
  await inbound('wamid.UAT-XSS-LOC', {
    type: 'location',
    location: {
      latitude: 18.5,
      longitude: -68.5,
      name: '<script>window.__xss = 1</script>',
      address: '<img src=x onerror="window.__xss=2">',
    },
  });
  // Y la buena, con nombre y dirección normales, como las manda WhatsApp.
  await inbound('wamid.UAT-LOC1', {
    type: 'location',
    location: { latitude: L1.latitude, longitude: L1.longitude, name: L1.name, address: L1.address },
  });

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
  const conversation = data.conversations[0];
  conversationId = conversation.id;
  customerId = conversation.customer_id;

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => confirmAnswer;
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
  // El panel arranca solo: se espera a que pinte la lista.
  await waitFor(() => win.document.querySelector('[data-conv]'), 'la lista de conversaciones', 8000);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Abre la conversación donde está la ubicación. */
async function openChat() {
  click(`[data-conv="${conversationId}"]`);
  await waitFor(() => $('#wa-chat-pane') && $$('#thread .bubble').length > 0, 'el hilo con la ubicación', 8000);
}

describe('componente de ubicación en el chat', () => {
  /** El componente de la ubicación que dice 'Casa' (hay otro con nombre raro). */
  const chipCasa = () => $$('#thread .loc').find((node) => node.textContent.includes('Casa')) ?? null;

  it('se ve como una pieza compacta con enlace de mapa calculado', async () => {
    await openChat();
    const chip = await waitFor(chipCasa, 'el componente de ubicación de Casa');
    expect(chip.textContent).toContain('Casa');
    expect(chip.textContent).toContain(L1.address);
    expect(chip.textContent).toMatch(/Compartida por el cliente/i);
    const link = chip.querySelector('.loc__link');
    expect(link.getAttribute('href')).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${L1.latitude},${L1.longitude}`)}`,
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    // Un solo componente: nada de tarjeta dentro de tarjeta.
    expect($$('#thread .loc .loc')).toHaveLength(0);
  });

  it('respeta la alineación del mensaje (entrante a la izquierda)', async () => {
    const bubble = chipCasa()?.closest('.bubble');
    expect(bubble.classList.contains('bubble--in')).toBe(true);
  });

  it('el nombre y la dirección de WhatsApp se ESCAPAN (XSS)', async () => {
    await openChat();
    await waitFor(() => $$('#thread .loc').length >= 2, 'los dos componentes de ubicación', 8000);
    const textos = $$('#thread .loc').map((node) => node.textContent).join(' ');
    // El texto se VE (es un dato), pero no se ejecuta: viene escapado.
    expect(textos).toContain('<script>');
    expect(dom.window.__xss).toBeUndefined();
    expect($$('#thread .loc script')).toHaveLength(0);
    expect($$('#thread .loc img')).toHaveLength(0);
  }, 20000);

  it('la lista de chats muestra «Ubicación», no el JSON', async () => {
    const row = $(`[data-conv="${conversationId}"]`);
    const preview = row.querySelector('.conv__preview').textContent;
    expect(preview).toMatch(/Ubicación/);
    expect(preview).not.toContain('{');
    expect(preview).not.toContain('latitude');
  });
});

describe('crear pedido: sin ciudad, sin dirección, con delivery opcional', () => {
  it('el formulario ya no pide ciudad ni dirección y deja el total sin delivery', async () => {
    // El pedido se crea desde «Acciones del cliente», como en el panel real.
    // El botón «⋯» está deshabilitado mientras la conversación carga: se espera
    // a que esté listo antes de pulsarlo (un botón gris no hace nada).
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado', 8000);
    click($('#wa-actions'));
    await waitFor(() => $(`[data-order-new="${customerId}"]`), 'las acciones del cliente', 8000);
    click(`[data-order-new="${customerId}"]`);
    await waitFor(() => $('#order-fee'), 'el formulario de pedido', 8000);
    expect($('#order-city')).toBe(null);
    expect($('#order-address')).toBe(null);
    // La ubicación compartida se ofrece, con su edad.
    expect($('#order-loc').textContent).toMatch(/Sin ubicación/);
    expect($('#order-loc').textContent).toMatch(/Casa/);
    expect($('#order-loc').textContent).toMatch(/Compartida hoy/);
    // Total de 10 cápsulas (RD$2,500) sin delivery.
    expect($('#order-total').textContent).toContain('1,250');
  }, 20000);

  it('el delivery se suma al total al escribirlo', async () => {
    $('#order-fee').value = '250';
    $('#order-fee').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect($('#order-total').textContent).toContain('Delivery');
    expect($('#order-total').textContent).toContain('1,500');
  }, 20000);

  it('guardar sin ubicación funciona (y manda deliveryLocation null)', async () => {
    let payload = null;
    const original = dom.window.fetch;
    dom.window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (String(url).includes('/api/admin/orders') && init.method === 'POST') {
        payload = JSON.parse(init.body);
      }
      return original(input, init);
    };
    click('#order-save');
    await waitFor(() => payload, 'el guardado del pedido', 8000);
    expect(payload.deliveryLocation).toBe(null);
    expect(payload.deliveryFee).toBe(250);
    expect(payload.delivery).toBeUndefined();
    dom.window.fetch = original;
    /*
     * El panel sigue con su trabajo (recarga y comprobante) después de responder:
     * se espera a que termine antes de seguir, o el comprobante se abriría encima
     * del siguiente paso (carrera del propio test, no del producto).
     */
    await waitFor(() => $('#receipt-open'), 'el comprobante del pedido', 8000);
    $('#sheet').hidden = true;
  }, 20000);
});

describe('enviar una ubicación desde el chat', () => {
  it('no se pide el permiso de ubicación al abrir, solo al pulsar el botón', async () => {
    let pedidos = 0;
    dom.window.navigator.geolocation = {
      getCurrentPosition(success) {
        pedidos += 1;
        success({ coords: { latitude: -34.6, longitude: -58.4 } });
      },
    };
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    expect(pedidos).toBe(0); // abrir el menú NO pide permiso
    click('#attach-location');
    await waitFor(() => $('#loc-current'), 'el selector de ubicación');
    expect(pedidos).toBe(0); // abrir el selector tampoco
    click('#loc-current');
    await waitFor(() => pedidos === 1, 'la petición de ubicación al pulsar');
    // Se elige, se previsualiza y NO se ha enviado nada todavía.
    await waitFor(() => $('#loc-send'), 'la confirmación de envío');
    expect(sentLocations).toHaveLength(0);
    expect($('#sheet').textContent).toMatch(/No se envía nada hasta que pulses/i);
  });

  it('si el usuario rechaza el permiso, se avisa y el pedido sigue sin ubicación', async () => {
    dom.window.navigator.geolocation = {
      getCurrentPosition(success, error) {
        error({ code: 1 });
      },
    };
    $('#sheet').hidden = true;
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('#loc-current'), 'el selector');
    click('#loc-current');
    await waitFor(() => $('#toast').textContent.match(/permiso/i), 'el aviso de permiso');
    expect(sentLocations).toHaveLength(0);
    // Se puede seguir: «Sin ubicación» + Usar deja continuar sin coordenadas.
    click('#loc-cancel');
  });

  it('si el navegador no sabe dar la ubicación, se dice igual', async () => {
    dom.window.navigator.geolocation = undefined;
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('#loc-current'), 'el selector');
    click('#loc-current');
    await waitFor(() => $('#toast').textContent.match(/no sabe dar la ubicación/i), 'el aviso de no soportado');
    click('#loc-cancel');
  });

  it('confirmar envía UNA ubicación con las coordenadas exactas', async () => {
    dom.window.navigator.geolocation = {
      getCurrentPosition(success) {
        success({ coords: { latitude: L2.latitude, longitude: L2.longitude } });
      },
    };
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('#loc-current'), 'el selector');
    // En vez del dispositivo, se reutiliza la que compartió el cliente.
    const radio = $$('#sheet input[name="loc-pick"]').find((input) => input.value);
    expect(radio).toBeTruthy();
    radio.checked = true;
    click('#loc-ok');
    await waitFor(() => $('#loc-send'), 'la confirmación');
    click('#loc-send');
    await waitFor(() => sentLocations.length === 1, 'la ubicación enviada', 8000);
    expect(sentLocations[0].location.latitude).toBeCloseTo(L1.latitude, 4);
    expect(sentLocations[0].to).toBe(`+${PHONE}`);
    // Y aparece en el hilo como saliente, a la derecha.
    await waitFor(() => $$('#thread .bubble--out .loc').length >= 1, 'la ubicación saliente en el hilo', 8000);
  });
});

describe('compartir una ubicación con otro chat', () => {
  it('avisa con quién y exige confirmación explícita', async () => {
    const before = sentLocations.length;
    // El menú de la ubicación de Casa (no la de nombre raro).
    const chip = $$('#thread .loc').find((node) => node.textContent.includes('Casa'));
    const menu = await waitFor(() => chip?.querySelector('[data-loc-menu]'), 'el menú de la ubicación');
    click(menu);
    await waitFor(() => $('#loc-share'), 'las acciones de la ubicación');
    click('#loc-share');
    await waitFor(() => $('#loc-share-ok'), 'el selector de destino');
    expect($('#loc-share-warning').textContent).toMatch(/Vas a compartir esta ubicación con/i);

    // Si el usuario no confirma, NO sale nada.
    confirmAnswer = false;
    click('#loc-share-ok');
    await sleep(150);
    expect(sentLocations).toHaveLength(before);

    // Con confirmación, se comparte.
    confirmAnswer = true;
    click('#loc-share-ok');
    await waitFor(() => sentLocations.length > before, 'la ubicación compartida', 8000);
    expect(sentLocations.at(-1).location.latitude).toBeCloseTo(L1.latitude, 4);
  }, 20000);
});
