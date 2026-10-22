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
import { calculateSale } from '../public/admin/pos-math.js';

import { startCrmServer } from '../server/crm-server.mjs';

const POS_SCRIPT = readFileSync(path.join(process.cwd(), 'public', 'admin', 'pos.js'), 'utf8').replace(/^import[^\n]+\n/, '');
const STORE_SCRIPT = readFileSync(path.join(process.cwd(), 'public', 'admin', 'store.js'), 'utf8');

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
const sentTemplates = [];
let confirmAnswer = true;
let inboundSeq = 0;

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
  async sendTemplate(to, template) {
    sentTemplates.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.TPL${sentTemplates.length}` };
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
  inboundSeq += 1;
  const timestamp = Math.floor(Date.now() / 1000) - 10 + inboundSeq;
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
              messages: [{ from: PHONE, id, timestamp: String(timestamp), ...node }],
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
  win.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  win.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  win.structuredClone = structuredClone;
  win.calculateSale = calculateSale;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  win.cancelAnimationFrame = (timer) => clearTimeout(timer);
  win.confirm = () => confirmAnswer;
  win.alert = () => {};
  // Vigila que NADA de esto abra una pestaña nueva: el mapa se abre en la app.
  win.open = () => {
    win.__abrioPestana = true;
    return null;
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
  // El panel arranca solo: se espera a que pinte la lista.
  await waitFor(() => win.document.querySelector('[data-conv]'), 'la lista de conversaciones', 8000);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Abre la conversación donde está la ubicación. */
async function openChat() {
  if (dom.window.document.body.dataset.tab !== 'whatsapp') {
    click('#menu');
    click('[data-tab="whatsapp"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'whatsapp', 'la pestaña de WhatsApp', 8000);
  }
  click(`[data-conv="${conversationId}"]`);
  await waitFor(() => $('#wa-chat-pane') && $$('#thread .bubble').length > 0, 'el hilo con la ubicación', 8000);
}

async function openGuidedOrder() {
  await openChat();
  await waitFor(() => $('#wa-actions')?.disabled === false, 'acciones del chat habilitadas', 8000);
  click('#wa-actions');
  click(await waitFor(() => $(`[data-order-new="${customerId}"]`), 'crear pedido desde el chat', 8000));
  await waitFor(() => $('#pos-client .pos-client-button strong')?.textContent === 'Ana Ubicación', 'cliente cargado en POS', 8000);
  const add = await waitFor(() => $('[data-pos-add]'), 'el catálogo de POS', 8000);
  click(add);
  const pay = await waitFor(() => $('[data-pos-pay]')?.disabled === false ? $('[data-pos-pay]') : null, 'Continuar del pedido', 8000);
  click(pay);
  await waitFor(() => $('.pos-order-dialog [data-order-field="deliveryFee"]'), 'el pedido guiado de POS', 8000);
  await waitFor(() => $('#pos-order-where')?.textContent.includes('Calle Principal 12'), 'ubicación traída del chat', 8000);
}

describe('componente de ubicación en el chat', () => {
  /** El componente de la ubicación que dice 'Casa' (hay otro con nombre raro). */
  const chipCasa = () => $$('#thread .loc').find((node) => node.textContent.includes('Casa')) ?? null;

  it('la ubicación se ve en la burbuja y el mapa grande se abre desde «⋯»', async () => {
    await openChat();
    const chip = await waitFor(chipCasa, 'el componente de ubicación de Casa');
    expect(chip.textContent).toContain('Casa');
    expect(chip.textContent).toContain(L1.address);
    expect(chip.textContent).toMatch(/Compartida por el cliente/i);
    /*
     * LA UBICACIÓN SE VE SIN PULSAR NADA: miniatura del mapa con el punto exacto
     * del cliente. Ya no hay botón grande «Ver en mapa»: el mapa completo vive
     * en el menú «⋯» del componente, junto al resto de acciones.
     */
    const miniatura = chip.querySelector('.loc__map img');
    expect(miniatura).not.toBe(null);
    expect(miniatura.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    expect(miniatura.getAttribute('loading')).toBe('lazy');
    expect(chip.querySelector('.loc__map-pin')).not.toBe(null);
    expect(chip.textContent).not.toContain('Ver en mapa');
    // Un solo componente: nada de tarjeta dentro de tarjeta.
    expect($$('#thread .loc .loc')).toHaveLength(0);

    click(chip.querySelector('.loc__more'));
    click(await waitFor(() => $('#sheet-body [data-loc-map]'), 'la opción «Ver en el mapa»'));
    /*
     * Se abre LA PANTALLA DEL MAPA (la única que hay: mapa y entregas), centrada
     * en el punto y con su ficha de acciones encima. Nada de pestañas nuevas.
     */
    await waitFor(() => !$('#view-mapa').hidden, 'la pantalla del mapa');
    const lienzo = await waitFor(() => $('#orders-map'), 'el mapa dentro de la app');
    expect(dom.window.__abrioPestana).toBeUndefined();
    // En jsdom no hay Leaflet: el aviso de la pantalla lo dice en vez de quedarse mudo.
    const aviso = await waitFor(() => ($('#orders-map-notice')?.textContent ? $('#orders-map-notice') : null), 'el aviso del mapa');
    expect(aviso.textContent).toContain('No se pudo cargar el mapa');
    expect(aviso.hidden).toBe(false);
    expect(lienzo).toBeTruthy();
    // Y los botones para lo de siempre siguen ahí, dentro de la misma hoja.
    expect($('#sheet-body').textContent).toContain('¿A qué distancia estoy?');
    expect($('#sheet-body').textContent).toContain('Usar para un pedido');
    expect($('#sheet-body').textContent).toContain('Compartir con otra conversación');
    // La hoja se cierra y el hilo sigue donde estaba.
    click('[data-close-sheet]');
    expect($('#sheet').hidden).toBe(true);
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
    // El único <img> del componente es el mosaico del mapa: nada de imágenes de WhatsApp sin guardar.
    expect($$('#thread .loc img').filter((img) => !img.closest('.loc__map'))).toHaveLength(0);
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
    await openGuidedOrder();
    expect($('#order-city')).toBe(null);
    expect($('#order-address')).toBe(null);
    expect($('#pos-order-where').textContent).toContain('Calle Principal 12');
    expect($('.pos-order-dialog [data-order-field="deliveryFee"]').value).toBe('0');
    expect($('#pos-order-totals').textContent).toContain('Total');
  }, 20000);

  it('el delivery se suma al total al escribirlo', async () => {
    await waitFor(() => $('.pos-order-dialog [data-order-field="deliveryFee"]'), 'pedido guiado abierto');
    const amount = () => Number($('#pos-order-totals .total dd').textContent.replace(/[^\d,.]/g, '').replace(/,/g, ''));
    const before = amount();
    const field = $('.pos-order-dialog [data-order-field="deliveryFee"]');
    field.value = '250';
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(amount() - before).toBe(250);
  }, 20000);

  it('confirma el retiro y reinicia el costo de delivery', async () => {
    await waitFor(() => $('.pos-order-dialog [data-order-field="deliveryFee"]'), 'pedido guiado abierto');
    // POS exige coordenadas antes de confirmar un delivery. Una selección de
    // retiro sigue disponible sin solicitar ubicación del dispositivo.
    expect($('.pos-order-dialog [data-order-confirm]').disabled).toBe(false);
    click('.pos-order-dialog [data-order-method="pickup"]');
    await waitFor(() => $('.pos-order-dialog [data-order-method="pickup"]')?.getAttribute('aria-pressed') === 'true', 'retiro sin costo de delivery');
    const countBefore = (await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json()).items
      .filter((item) => item.customer_id === customerId && item.type === 'order_intent').length;
    click('.pos-order-dialog [data-order-confirm]');
    const saved = await waitFor(async () => {
      const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
      const orders = data.items.filter((item) => item.customer_id === customerId && item.type === 'order_intent');
      return orders.length > countBefore ? orders.sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0] : null;
    }, 'el pedido guardado en el servidor', 8000);
    const order = JSON.parse(saved.order_json);
    expect(order.delivery.method).toBe('pickup');
    expect(Number(order.delivery_fee ?? order.delivery.fee)).toBe(0);
    await waitFor(
      () => $('.pos-order-dialog h2')?.textContent.includes('Pedido guardado') ? true : null,
      'la confirmación de POS',
      8000,
    );
    $('#sheet').hidden = true;
  }, 20000);
});

describe('enviar una ubicación desde el chat', () => {
  it('no se pide el permiso de ubicación al abrir, solo al pulsar el botón', async () => {
    await openChat();
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
    await waitFor(() => $('[data-sharing-other-location]'), 'las ubicaciones configuradas');
    click('[data-sharing-other-location]');
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
    await openChat();
    dom.window.navigator.geolocation = {
      getCurrentPosition(success, error) {
        error({ code: 1 });
      },
    };
    $('#sheet').hidden = true;
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('[data-sharing-other-location]'), 'las ubicaciones configuradas');
    click('[data-sharing-other-location]');
    await waitFor(() => $('#loc-current'), 'el selector');
    click('#loc-current');
    await waitFor(() => $('#toast').textContent.match(/permiso/i), 'el aviso de permiso');
    expect(sentLocations).toHaveLength(0);
    // Se puede seguir: «Sin ubicación» + Usar deja continuar sin coordenadas.
    click('#loc-cancel');
  });

  it('si el navegador no sabe dar la ubicación, se dice igual', async () => {
    await openChat();
    dom.window.navigator.geolocation = undefined;
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('[data-sharing-other-location]'), 'las ubicaciones configuradas');
    click('[data-sharing-other-location]');
    await waitFor(() => $('#loc-current'), 'el selector');
    click('#loc-current');
    await waitFor(() => $('#toast').textContent.match(/no sabe dar la ubicación/i), 'el aviso de no soportado');
    click('#loc-cancel');
  });

  it('confirmar envía UNA ubicación con las coordenadas exactas', async () => {
    await openChat();
    dom.window.navigator.geolocation = {
      getCurrentPosition(success) {
        success({ coords: { latitude: L2.latitude, longitude: L2.longitude } });
      },
    };
    click('#wa-attach');
    await waitFor(() => $('#attach-location'), 'la opción de ubicación');
    click('#attach-location');
    await waitFor(() => $('[data-sharing-other-location]'), 'las ubicaciones configuradas');
    click('[data-sharing-other-location]');
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
    await waitFor(() => $('#sheet-body [data-loc-share-menu]'), 'las acciones de la ubicación');
    click('[data-loc-share-menu]');
    click(await waitFor(() => $('[data-loc-share-conv]'), 'el submenú de compartir'));
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

  it('con la ventana del destino CERRADA, se comparte por plantilla con el enlace del mapa', async () => {
    /*
     * Un cliente que nunca ha escrito: WhatsApp no deja mandarle una ubicación,
     * así que el panel tiene que ofrecer la única vía legítima (una plantilla
     * aprobada con el enlace) y decir que es eso lo que va a pasar.
     */
    const nuevo = await fetch(`${app.url}/api/admin/conversations/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ phone: '18095550999', name: 'Sin Ventana', body: '' }),
    });
    expect(nuevo.status).toBe(200);
    const destino = (await nuevo.json()).conversation;

    // La plantilla con hueco libre, aprobada como estaría en Meta.
    const plantilla = await fetch(`${app.url}/api/admin/wa-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'phyto_mensaje_personalizado_v1',
        status: 'APPROVED',
        body: 'Hola {{1}}, te escribimos de Phytoemagry. {{2}} Cualquier duda, respóndenos por aquí y te ayudamos.',
        variables: ['customer_name', 'mensaje'],
        metaTemplateId: 'tpl-uat-personal',
        lastSyncedAt: new Date().toISOString(),
      }),
    });
    expect(plantilla.status).toBe(200);

    /*
     * El panel recarga la bandeja al entrar en WhatsApp: se espera a que la
     * conversación nueva esté EN LA LISTA (el selector de destino se arma con lo
     * que el panel conoce en ese momento).
     */
    click('.tabs [data-tab="clientes"]');
    click('.tabs [data-tab="whatsapp"]');
    await waitFor(() => $(`[data-conv="${destino.id}"]`), 'la conversación nueva en la lista', 12000);
    click(`[data-conv="${conversationId}"]`);
    await waitFor(() => $$('#thread .loc').length > 0, 'el hilo con la ubicación');
    const chip = $$('#thread .loc').find((node) => node.textContent.includes('Casa'));
    click(chip.querySelector('[data-loc-menu]'));
    await waitFor(() => $('#sheet-body [data-loc-share-menu]'), 'las acciones de la ubicación');
    click('[data-loc-share-menu]');
    click(await waitFor(() => $('[data-loc-share-conv]'), 'el submenú de compartir'));
    const select = await waitFor(() => $('#loc-share-to'), 'el selector de destino');

    // El destino dice en la propia lista por dónde puede recibirla.
    expect(select.textContent).toContain('por plantilla (24 h cerradas)');
    select.value = destino.id;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    const boton = $('#loc-share-ok');
    expect(boton.textContent).toContain('por plantilla');
    expect($('#loc-share-warning').textContent).toContain('ENLACE del mapa');

    const antesLoc = sentLocations.length;
    const antesTpl = sentTemplates.length;
    click('#loc-share-ok');
    await waitFor(() => sentTemplates.length === antesTpl + 1, 'la plantilla con el enlace', 8000);
    // NUNCA se intenta la ubicación nativa fuera de la ventana: WhatsApp la rechaza.
    expect(sentLocations.length).toBe(antesLoc);
    const enviado = sentTemplates.at(-1);
    expect(enviado.to).toBe('+18095550999');
    expect(enviado.template.name).toBe('phyto_mensaje_personalizado_v1');
    const textos = enviado.template.components[0].parameters.map((parameter) => parameter.text);
    expect(textos[0]).toBe('Sin Ventana');
    expect(textos[1]).toContain('google.com/maps');
    expect(textos[1]).toContain(`${L1.latitude}`);
  }, 30000);
});
