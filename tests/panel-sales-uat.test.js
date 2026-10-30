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
import {calculateSale} from '../public/admin/pos-math.js';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-panel-123';
const APP_SECRET = 'uat-panel-secret';
const PHONE = '18095559191';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
/*
 * El ÚNICO aviso que recibe el cliente al pasarle el pedido al mensajero. Lo
 * manda el servidor al asignar; el panel ya no manda el suyo (eran dos seguidos).
 */
const AVISO_AL_MENSAJERO = 'Ya pasamos tu pedido al mensajero. Él te va a contactar cuando vaya a salir.';

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
/** Id del AGENTE de la suite: en este negocio reparte un agente, no un rol aparte. */
let agenteUatId = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
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
              // Meta SIEMPRE manda el número de destino; el servidor lo exige (fail-closed).
              metadata: { phone_number_id: 'PN-UAT', display_phone_number: '18095550000' },
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

/** Ubicación entrante tal y como la manda WhatsApp (`type: location`). */
async function inboundLocation(id, coords) {
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
              messages: [
                {
                  from: PHONE,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'location',
                  location: {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    ...(coords.name ? { name: coords.name } : {}),
                    ...(coords.address ? { address: coords.address } : {}),
                  },
                },
              ],
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

  /*
   * UN REPARTIDOR DE VERDAD. El servidor solo admite usuarios con rol DELIVERY
   * para pasarle un pedido, y la lista de repartidores viaja en `/api/admin/data`:
   * se crea ANTES de que el panel cargue, para que la vea desde el principio.
   */
  const loginAdmin = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  await fetch(`${app.url}/api/admin/users`, {
    method: 'POST',
    headers: {
      cookie: loginAdmin.headers.get('set-cookie').split(';')[0],
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'reparto@phyto.local',
      password: 'Reparto-12345',
      displayName: 'Reparto UAT',
      role: 'DELIVERY',
    }),
  });
  /*
   * Y UN AGENTE: en este negocio el pedido se le pasa a un AGENTE (no hay equipo
   * de reparto aparte). Tiene que salir en la MISMA lista de «pasar a delivery».
   */
  const agenteUat = await (
    await (
      await fetch(`${app.url}/api/admin/users`, {
        method: 'POST',
        headers: {
          cookie: loginAdmin.headers.get('set-cookie').split(';')[0],
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          username: 'agente@phyto.local',
          password: 'Agente-12345',
          displayName: 'Agente UAT',
          role: 'AGENT',
        }),
      })
    ).json()
  ).user;
  agenteUatId = agenteUat.id;

  /*
   * UN PEDIDO SIN CLIENTE: es lo que llega de la web cuando el registro entra sin
   * teléfono (y lo que dejan las pruebas). No tiene `customer_id` ni número de pedido,
   * así que sus acciones de cliente no se pueden ofrecer: el menú debe DECIRLO.
   */
  await fetch(`${app.url}/api/crm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'pedido-sin-cliente',
      type: 'order_intent',
      name: 'UAT Sin Cliente',
      source: 'checkout',
      status: 'nuevo',
      variantName: '5 cápsulas',
      quantity: 1,
      total: 1250,
      createdAt: new Date().toISOString(),
    }),
  });

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
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  win.HTMLDialogElement.prototype.close=function(){this.open=false;};
  win.HTMLElement.prototype.scrollIntoView=function(){};
  win.structuredClone=structuredClone;win.calculateSale=calculateSale;
  win.EventSource=class{addEventListener(){}close(){}};
  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  win.eval(readFileSync(path.join(ADMIN_DIR, 'store.js'), 'utf8'));
  win.eval(readFileSync(path.join(ADMIN_DIR, 'pos.js'), 'utf8').replace(/^import[^\n]+\n/,''));
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
    const stats = await waitFor(() => ($('#stats')?.textContent?.includes('Sin responder') ? $('#stats').textContent : null), 'el panel Hoy');
    // HOY solo enseña lo que se hace hoy: los contadores internos («enviados»,
    // «por enviar», «por revisar», «programados») ya no están.
    expect(stats).toContain('Sin asignar');
    expect(stats).toContain('Pedidos pendientes');
    expect(stats).toContain('Seguimientos vencidos');
    expect(stats).toContain('Clientes');
    expect(stats).toContain('Interesados');
    expect(stats).toContain('Con compra');
    expect(stats).not.toContain('Por enviar');
    expect(stats).not.toContain('Por revisar');
    expect(stats).not.toContain('Enviados');
    expect(stats).not.toContain('Programados activos');
    expect($('#list-hoy').innerHTML.trim()).toBe('');
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
    for (const accion of ['Crear pedido', 'Respuesta rápida', 'Enviar plantilla', 'Ver cliente', 'Asignación']) {
      expect(menu).toContain(accion);
    }
    // Las dos acciones de seguimiento van en el cajón, sin submenú.
    expect(menu).toContain('Programar seguimiento');
    expect(menu).toContain('Programar mensaje');
    // Sin ruido: ni subtítulos por fila ni la búsqueda repetida del encabezado.
    expect(menu).not.toContain('<small>');
    expect(menu).not.toContain('Buscar en esta conversación');
  });

  it('crea el pedido desde Facturación con el cliente del chat y los descuentos exactos', async () => {
    click('[data-order-new]');
    await waitFor(() => $('#pos-client')?.textContent.includes('Ana UAT') && $('[data-pos-add="capsules_10"]'), 'el POS con el cliente');
    expect($('#sheet').hidden).toBe(true);
    for(let i=0;i<3;i++)click('[data-pos-add="capsules_10"]');
    click('[data-pos-discount="total"]');setValue('.pos-dialog [name=value]','500');
    $('.pos-modal-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    expect($('.pos-total').textContent).toContain('7,000');
    click('[data-pos-expand]');click('[data-pos-pending]');
    await waitFor(() => $('.pos-dialog').textContent.includes('Guardar pedido'),'confirmación');
    $('.pos-modal-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await waitFor(() => $('.pos-dialog').textContent.includes('Pedido guardado'),'pedido guardado');
    expect($('.pos-dialog a').getAttribute('href')).toMatch(/orders.*receipt/);
    const data=await (await fetch(`${app.url}/api/admin/data`,{headers:{cookie}})).json();
    const order=data.items.find(i=>i.type==='order_intent'&&i.total===7000);
    expect(order.conversation_id).toBeTruthy();expect(order.customer_id).toBeTruthy();expect(order.order_number).toMatch(/^PE-/);
  });

  it('guarda desde POS y continúa la entrega con ubicación y nota sin duplicar el aviso', async () => {
    await inboundLocation('wamid.UATPANEL-LOC-DELIVERY',{latitude:18.4764,longitude:-69.9362,name:'Ubicación cliente',address:'Av. Winston Churchill, Santo Domingo'});
    click('[data-tab="whatsapp"]');click(await waitFor(() => $$('[data-conv]')[0],'conversación'));
    await waitFor(() => $('#wa-actions')?.disabled===false,'acciones');click('#wa-actions');click('[data-order-new]');
    await waitFor(() => documentReady(),'POS');
    click('[data-pos-add="capsules_10"]');click('[data-pos-expand]');click('[data-pos-pending]');
    await waitFor(() => $('.pos-dialog [name=acknowledgeOpen]'),'aviso de pedido abierto');
    $('.pos-dialog [name=acknowledgeOpen]').checked=true;
    $('.pos-modal-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    click(await waitFor(() => $('[data-pos-delivery]'),'continuar entrega'));
    await waitFor(() => $('#delivery-assign-note'),'asignación');setValue('#delivery-assign-note','Llamar al llegar');
    const before=mockWhatsApp.sent.length;
    click(await waitFor(() => $(`[data-order-delivery-user="${agenteUatId}"]`),'agente'));
    await waitFor(() => mockWhatsApp.sent.slice(before).some(m=>m.body===AVISO_AL_MENSAJERO),'aviso');
    expect(mockWhatsApp.sent.slice(before).filter(m=>m.body===AVISO_AL_MENSAJERO)).toHaveLength(1);
    function documentReady(){return dom.window.document.body.dataset.tab==='catalogo'&&$('[data-pos-add="capsules_10"]');}
  },10000);

  it('programa un mensaje (no es un seguimiento: lo intentará el sistema)', async () => {
    if (!$('#sheet')?.hidden) click('[data-close-sheet]');
    click('[data-tab="whatsapp"]');
    click(await waitFor(() => $$('[data-conv]')[0], 'la conversación para programar'));
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    click('[data-scheduled-new]');
    await waitFor(() => $('#sch-save'), 'el formulario de mensaje programado');
    // La pantalla propone una plantilla de seguimiento; aquí se prueba el TEXTO LIBRE.
    // Se espera a que termine de preparar la propuesta (mientras, el botón está apagado).
    await waitFor(() => $('#sch-save')?.dataset?.schLoading === '0', 'la pantalla lista');
    setValue('#sch-tipo', 'libre');
    setValue('#sch-text', 'Hola Ana, ¿te ayudo con algo más?');
    click('#sch-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');

    /*
     * Se espera al CRM, no a la pantalla: el mensaje queda guardado en el servidor
     * un instante después de que el panel cierre la hoja.
     */
    const row = await waitFor(async () => {
      const data = await (await fetch(`${app.url}/api/admin/scheduled`, { headers: { cookie } })).json();
      return data.scheduled.find((entry) => entry.text === 'Hola Ana, ¿te ayudo con algo más?') ?? null;
    }, 'el mensaje programado en el CRM');
    expect(row.status).toBe('SCHEDULED');
  });

  it('el comprobante se puede ver e imprimir como documento', async () => {
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const order = data.items.find((item) => item.type === 'order_intent');
    const response = await fetch(`${app.url}/api/admin/orders/${order.id}/receipt`, { headers: { cookie } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Factura de compra');
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

describe('pedidos: lista compacta, aviso de pedido abierto y datos al pedido', () => {
  const LUGAR = { latitude: 18.6157, longitude: -68.7071, name: 'Casa UAT', address: 'Calle Principal 12, Higüey' };

  const datos = async () => (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
  const pedidos = async () => (await datos()).items.filter((item) => item.type === 'order_intent');
  /*
   * Una fila CON cliente (el teléfono se ve en la línea de referencia). Se busca por
   * lo que dice la fila y no por su posición: la lista va de más nuevo a más viejo y
   * el orden CAMBIA cada vez que un test toca un pedido (`updated_at`).
   */
  const filaConCliente = () =>
    $$('#list-pedidos .order-row').find((fila) =>
      /\+\d{6,}/.test(fila.querySelector('.order-row__ref')?.textContent ?? ''),
    ) ?? null;
  const ordenDe = (item) => {
    const raw = item?.order_json ?? item?.orderJson;
    if (!raw) return null;
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  };
  const esperar = async (check, label, timeout = 6000) => {
    const start = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
      await sleep(50);
    }
  };
  const abrirPedidoDeAna = async () => {
    click('[data-tab="whatsapp"]');
    const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación en la bandeja');
    click(row);
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    click('[data-order-new]');
    return waitFor(() => dom.window.document.body.dataset.tab==='catalogo'&&$('[data-pos-add="capsules_10"]'),'Facturación');
  };

  it('la lista de pedidos es una fila por pedido, sin repetir el título ni botones dentro', async () => {
    click('[data-tab="pedidos"]');
    const fila = await waitFor(() => $('#list-pedidos .order-row'), 'una fila de pedido');
    /*
     * El nombre de la pantalla ya está en la barra de arriba: aquí NO se repite
     * (antes había un «Pedidos y compras» + un párrafo explicando qué era).
     */
    expect($('#view-pedidos').querySelector('h2')).toBe(null);
    // Dos líneas: quién y cuándo arriba; datos y estado abajo.
    expect(fila.querySelector('.order-row__name').textContent.trim()).toBeTruthy();
    expect(fila.querySelector('.order-row__when')).toBeTruthy();
    expect(fila.querySelector('.order-row__meta').textContent).toMatch(/PE-/);
    expect(fila.querySelector('.order-row__status').textContent).toMatch(
      /Pendiente|En camino|Entregado|Cancelado/,
    );
    // La referencia del cliente (teléfono) y QUIÉN ATENDIÓ, en su línea corta.
    expect(fila.querySelector('.order-row__ref').textContent).toContain('+18095559191');
    expect(fila.querySelector('.order-row__ref').textContent).toMatch(/Atendido por .+/);
    /*
     * LA FORMA DE PAGO, EN LA LISTA: al cuadrar el día hay que saber si el dinero
     * entró en efectivo o por transferencia sin abrir cada pedido.
     */
    const conPago = $$('#list-pedidos .order-row').find((row) => row.querySelector('.order-row__pay'));
    expect(conPago, 'ninguna fila de pedido dice si fue efectivo o transferencia').toBeTruthy();
    expect(conPago.querySelector('.order-row__pay').textContent).toMatch(/Efectivo|Transferencia/);
    expect(conPago.querySelector('.order-row__pay').className).toMatch(/order-row__pay--(cash|transfer)/);
    // Nada de botones dentro de la fila: las acciones viven en la ficha.
    expect(fila.querySelectorAll('button')).toHaveLength(0);
  });

  it('la ficha del pedido dice el cliente, quién lo atendió y quién lo creó', async () => {
    click('#list-pedidos .order-row');
    const ficha = await waitFor(() => $('#sheet-body')?.textContent?.includes('Atendido por'), 'la ficha del pedido');
    const texto = $('#sheet-body').textContent;
    expect(texto).toMatch(/Atendido por/);
    expect(texto).toMatch(/Estado del pedido/);
    expect(texto).toMatch(/Pendiente|En proceso|En camino|Entregado|Cancelado/);
    expect(texto).toMatch(/PE-/);
    /*
     * LA HOJA SE LEE, NO SE LLENA DE BOTONES: las acciones están en el botón
     * flotante, y dentro están todas.
     */
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante de acciones');
    expect($('#sheet-body [data-order-delivery]')).toBe(null);
    expect($('#sheet-body [data-receipt]')).toBe(null);
    click(fab);
    const menu = await waitFor(() => ($('#sheet-body .menu-list') ? $('#sheet-body') : null), 'el menú de acciones');
    for (const accion of ['Ver cliente', 'Ver factura', 'Pasar a un delivery', 'Escribir por WhatsApp', 'Ver el pedido completo']) {
      expect(menu.textContent).toContain(accion);
    }

    // Y «Ver cliente» abre su ficha de verdad (con el id del cliente del pedido).
    const boton = $('[data-customer]');
    expect(boton?.dataset.customer).toBeTruthy();
    click(boton);
    await waitFor(() => $('#customer-profile .profile-head'), 'el perfil del cliente');
    expect(ficha).toBeTruthy();
    // Volver a Pedidos para no dejar la pantalla cambiada.
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-row'), 'la lista otra vez');
  });

  it('la factura del pedido lleva sus acciones en el botón flotante', async () => {
    // La factura es lo que se abre al guardar un pedido: ahí se pasa al reparto.
    click('#list-pedidos .order-row');
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante de la ficha');
    click(fab);
    const verFactura = await waitFor(() => $('[data-receipt]'), 'la acción de ver factura');
    click(verFactura);
    await waitFor(() => ($('#sheet-title')?.textContent?.startsWith('Factura') ? true : null), 'el comprobante');

    const fabFactura = await waitFor(() => $('#sheet-body [data-receipt-actions]'), 'el botón flotante de la factura');
    click(fabFactura);
    const menu = await waitFor(() => ($('#sheet-body .menu-list') ? $('#sheet-body') : null), 'las acciones de la factura');
    for (const accion of [
      'Ver factura',
      'Enviar al cliente',
      'Pasar a un delivery',
      'Ver cliente',
      'Modificar pedido',
    ]) {
      expect(menu.textContent).toContain(accion);
    }
    click('[data-close-sheet]');
  });

  it('desde el pedido se pasa a un delivery de verdad', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-row'), 'la lista de pedidos');

    // La lista AVISA de qué pedidos no tienen repartidor: era el dato que faltaba.
    const sinReparto = $$('#list-pedidos .order-row').filter((fila) =>
      fila.querySelector('.order-row__ref')?.textContent.includes('sin delivery'),
    );
    expect(sinReparto.length).toBeGreaterThan(0);

    click(sinReparto[0]);
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
    click(fab);
    const abrir = await waitFor(() => $('[data-order-delivery]'), 'la acción de pasar a delivery');
    click(abrir);

    // La hoja lista al repartidor (creado en esta suite con rol DELIVERY).
    const repartidor = await waitFor(() => $('[data-order-delivery-user]'), 'la lista de repartidores');
    expect($('#sheet-body').textContent).toContain('Reparto UAT');

    const ordenId = repartidor.dataset.orderId;
    click(repartidor);
    await esperar(async () => {
      const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
      return ordenDe(item)?.delivery?.delivery_user_id ?? null;
    }, 'el pedido pasado a delivery');

    const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
    expect(ordenDe(item).delivery.delivery_user_name_snapshot).toBe('Reparto UAT');
  });

  it('el pedido se le pasa a un AGENTE (el agente es quien entrega)', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-row'), 'la lista de pedidos');
    // Un pedido CON cliente: da igual si ya lo llevaba otro, el menú deja cambiarlo.
    const fila = filaConCliente();
    expect(fila).toBeTruthy();
    click(fila);
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
    click(fab);
    click(await waitFor(() => $('[data-order-delivery]'), 'la acción de pasar a delivery'));

    // La lista ofrece a los AGENTES (y a los repartidores de siempre), con su rol escrito.
    const filaAgente = await waitFor(
      () =>
        $$('#sheet-body [data-order-delivery-user]').find((row) => row.textContent.includes('Agente UAT')) ?? null,
      'el agente en la lista de reparto',
    );
    // El texto habla de AGENTES: el que elige (primera vez) o el que cambia de agente.
    const texto = $('#sheet-body').textContent;
    expect(texto.includes('Elige el agente que va a hacer la entrega') || texto.includes('cambia de agente')).toBe(
      true,
    );
    expect(filaAgente.textContent).toContain('Agente');
    expect(filaAgente.dataset.orderDeliveryUser).toBe(agenteUatId);

    const ordenId = filaAgente.dataset.orderId;
    click(filaAgente);
    await esperar(async () => {
      const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
      return ordenDe(item)?.delivery?.delivery_user_id ?? null;
    }, 'el pedido pasado al agente');

    const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
    expect(ordenDe(item).delivery.delivery_user_id).toBe(agenteUatId);
    expect(ordenDe(item).delivery.delivery_user_name_snapshot).toBe('Agente UAT');
  });

  it('desde el pedido se programa un seguimiento y un mensaje al cliente', async () => {
    const abrirMenu = async (fila) => {
      click(fila);
      const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
      click(fab);
      return waitFor(() => ($('#sheet-body .menu-list') ? $('#sheet-body') : null), 'el menú de acciones');
    };

    click('[data-tab="pedidos"]');
    const filas = await waitFor(() => $$('#list-pedidos .order-row'), 'la lista de pedidos');

    // 1) SEGUIMIENTO: una tarea para el equipo, ligada al pedido.
    const menu = await abrirMenu(filaConCliente());
    for (const opcion of ['Programar seguimiento', 'Programar mensaje al cliente']) {
      expect(menu.textContent).toContain(opcion);
    }
    click($('[data-followup-new]'));
    const guardar = await waitFor(() => $('#fu-save'), 'el formulario de seguimiento');
    setValue('#fu-motivo', 'Seguimiento postventa');
    setValue('#fu-reason', 'Preguntarle si le fue bien');
    click(guardar);
    const seguimiento = await esperar(async () => {
      const data = await datos();
      const todos = [
        ...(data.followups?.overdue ?? []),
        ...(data.followups?.today ?? []),
        ...(data.followups?.upcoming ?? []),
      ];
      return todos.find((row) => String(row.reason ?? '').includes('Preguntarle si le fue bien')) ?? null;
    }, 'el seguimiento guardado');
    // Queda ligado al pedido desde el que se creó y al cliente.
    expect(seguimiento.order_id).toBeTruthy();
    expect(seguimiento.customer_id).toBeTruthy();

    // 2) MENSAJE PROGRAMADO: lo envía el sistema el día y la hora elegidos.
    click(filaConCliente());
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante otra vez');
    click(fab);
    click(await waitFor(() => $('[data-scheduled-new]'), 'la acción de programar mensaje'));
    await waitFor(() => $('#sch-save'), 'el formulario de mensaje programado');
    // Aquí se prueba el texto libre (no la plantilla de seguimiento sugerida).
    await waitFor(() => $('#sch-save')?.dataset?.schLoading === '0', 'la pantalla lista');
    setValue('#sch-tipo', 'libre');
    setValue('#sch-text', 'Hola Ana, ¿cómo te fue con el pedido?');
    click('#sch-save');
    const programado = await esperar(async () => {
      const data = await (await fetch(`${app.url}/api/admin/scheduled`, { headers: { cookie } })).json();
      return (
        (data.scheduled ?? []).find((row) => row.text === 'Hola Ana, ¿cómo te fue con el pedido?') ?? null
      );
    }, 'el mensaje programado');
    expect(programado.status).toBe('SCHEDULED');
    expect(programado.order_id ?? null).not.toBe(undefined);
  });

  it('un pedido sin cliente lo dice en vez de esconder las acciones', async () => {
    click('[data-tab="pedidos"]');
    const fila = await waitFor(
      () =>
        $$('#list-pedidos .order-row').find((row) =>
          row.querySelector('.order-row__name')?.textContent.includes('UAT Sin Cliente'),
        ) ?? null,
      'el pedido sin cliente',
    );
    click(fila);
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
    // La ficha ya NO explica dónde están las acciones: el botón flotante se
    // explica solo y ese párrafo alargaba la hoja sin aportar nada.
    expect($('#sheet-body').textContent).not.toContain('abajo a la derecha');
    click(fab);
    const menu = await waitFor(
      () => ($('#sheet-body .menu-list') ? $('#sheet-body') : null),
      'el menú de acciones',
    );
    for (const label of ['Programar seguimiento', 'Programar mensaje al cliente']) {
      const boton = [...menu.querySelectorAll('.menu-item')].find((row) => row.textContent.includes(label));
      expect(boton).toBeTruthy();
      // Se ve, pero apagado y con el motivo: no hay cliente al que programarle nada.
      expect(boton.disabled).toBe(true);
      expect(boton.textContent).toContain('no hay a quién avisar');
    }
    click('[data-close-sheet]');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');
  });

  it('los filtros de estado se cuentan y filtran de verdad', async () => {
    // Cinco de ESTADO y, en el mismo panel, la FECHA (hoy, ayer, 7 días, mes,
    // intervalo y todas): se elige todo desde el mismo sitio.
    expect($$('#pedidos-filtros [data-order-filter]')).toHaveLength(5);
    expect($$('#pedidos-filtros [data-order-date]')).toHaveLength(5);
    expect($('#pedidos-filtros [data-order-date-custom]')).toBeTruthy();
    expect($('#pedidos-filtros [data-order-date="today"]').textContent).toContain('Hoy');
    const total = (await pedidos()).length;
    expect($('#pedidos-filtros [data-order-filter="todo"]').textContent).toContain(String(total));

    click('[data-order-filter="entregado"]');
    const vacio = await waitFor(
      () => ($('#list-pedidos').textContent.includes('Ningún pedido con ese estado') ? true : null),
      'el vacío del filtro',
    );
    expect(vacio).toBe(true);

    click('[data-order-filter="pendiente"]');
    const pendientes = await waitFor(() => $$('#list-pedidos .order-row'), 'las filas pendientes');
    expect(pendientes.length).toBeGreaterThan(0);
    expect($('#pedidos-count').textContent).toMatch(/\d+ pedido/);
    // Los pedidos que NO están entregados son los que el filtro deja pasar.
    const vivos = (await pedidos()).filter((item) => !['entregado', 'perdido'].includes(item.status));
    expect(pendientes.length).toBeLessThanOrEqual(vivos.length);

    click('[data-order-filter="todo"]');
    await waitFor(() => $$('#list-pedidos .order-row').length >= total, 'la lista completa');
    expect($('#pedidos-count').textContent).toContain(String(total));
  });

  it('el alta vive en el menú de la lista, sin botón flotante de agregar', async () => {
    // La esquina tenía dos botones (acciones y «+»): el alta es una acción más.
    expect($('#compra-nueva-ped')).toBe(null);
    click('#pedidos-acciones');
    const alta = await waitFor(() => $('#side-drawer [data-purchase]'), 'la opción Registrar compra');
    click(alta);
    await waitFor(() => dom.window.document.body.dataset.tab==='catalogo'&&$('[data-pos-add]'),'Facturación');
    click('[data-simple-back]');
  });

  it('avisa del pedido abierto y exige confirmar antes de guardar otro desde POS', async () => {
    const antes=(await pedidos()).length;await abrirPedidoDeAna();
    click('[data-pos-add="capsules_10"]');click('[data-pos-expand]');click('[data-pos-pending]');
    const ack=await waitFor(() => $('.pos-dialog [name=acknowledgeOpen]'),'aviso');
    expect($('.pos-dialog').textContent).toContain('sin cerrar');expect($('.pos-dialog').textContent).toMatch(/PE-/);
    $('.pos-modal-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await sleep(150);
    expect((await pedidos()).length).toBe(antes);
    ack.checked=true;$('.pos-modal-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await esperar(async () => (await pedidos()).length===antes+1,'pedido nuevo');
    click('.pos-dialog [data-pos-close]');
  });

  it('la ubicación que manda el cliente se puede agregar al pedido abierto', async () => {
    await inboundLocation('wamid.UATLOC1', LUGAR);
    click('[data-tab="whatsapp"]');
    const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación en la bandeja');
    click(row);
    const mas = await waitFor(
      () => $$('#thread .loc').find((node) => node.textContent.includes('Casa UAT'))?.querySelector('[data-loc-menu]') ?? null,
      'la ubicación nueva dentro del hilo',
    );
    click(mas);
    await waitFor(() => $('#sheet-body [data-loc-attach]'), 'las acciones de la ubicación');
    click('[data-loc-attach]');

    // Solo se ofrecen los pedidos VIVOS de ESE cliente (ni entregados ni cancelados).
    const cliente = (await datos()).customers.find((candidate) => candidate.phone_e164 === `+${PHONE}`);
    const opcion = await waitFor(() => $('[data-order-attach-loc]'), 'la lista de pedidos abiertos');
    const vivos = (await pedidos()).filter(
      (item) => item.customer_id === cliente.id && !['entregado', 'perdido'].includes(item.status),
    );
    expect($$('[data-order-attach-loc]')).toHaveLength(vivos.length);

    const ordenId = opcion.dataset.orderAttachLoc;
    click(opcion);
    await esperar(async () => {
      const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
      const ubicacion = ordenDe(item)?.delivery?.location ?? null;
      return ubicacion && Number.isFinite(Number(ubicacion.latitude));
    }, 'la ubicación guardada en el pedido');

    const item = (await pedidos()).find((candidate) => candidate.id === ordenId);
    const ubicacion = ordenDe(item).delivery.location;
    expect(ubicacion.latitude).toBeCloseTo(LUGAR.latitude, 3);
    expect(ubicacion.longitude).toBeCloseTo(LUGAR.longitude, 3);
    // Y queda en el historial del cliente para el próximo pedido.
    const guardadas = await (
      await fetch(`${app.url}/api/admin/customers/${cliente.id}/locations`, { headers: { cookie } })
    ).json();
    expect(
      guardadas.locations.some((candidate) => Math.abs(Number(candidate.latitude) - LUGAR.latitude) < 0.001),
    ).toBe(true);
  });

  /*
   * Va al final: deja un pedido ENTREGADO (el test de filtros espera que todavía no haya
   * ninguno). El camino es el real del panel: factura → cambiar estado → motivo.
   */
  it('con el pedido ENTREGADO el menú lo dice y ofrece el seguimiento', async () => {
    dom.window.confirm = () => true;
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-row'), 'la lista de pedidos');

    // 1) Llevar el primer pedido a ENTREGADO desde el propio panel.
    click($$('#list-pedidos .order-row')[0]);
    const fabFicha = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del pedido');
    click(fabFicha);
    click(await waitFor(() => $('[data-receipt]'), 'la acción de ver la factura'));
    const fabFactura = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante de la factura');
    click(fabFactura);
    click(await waitFor(() => $('[data-order-status-change]'), 'la acción de cambiar estado'));
    await waitFor(() => $('#manual-order-confirm'), 'el formulario de cambio de estado');
    setValue('#manual-order-status', 'ENTREGADO');
    setValue('#manual-order-reason', 'Cliente confirmó la entrega por llamada');
    click('#manual-order-confirm');
    await waitFor(
      () => ($('#sheet-body')?.textContent?.includes('Entregado') ? $('#sheet-body') : null),
      'el estado entregado reflejado al instante en la factura',
    );
    const entregado = await esperar(
      async () => (await pedidos()).find((item) => item.status === 'entregado') ?? null,
      'el pedido entregado en el CRM',
    );
    click('[data-close-sheet]');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');

    // 2) La fila ya entregada y su menú: aviso de postventa + las dos acciones.
    const fila = await waitFor(
      () =>
        $$('#list-pedidos .order-row').find((row) =>
          row.querySelector('.order-row__meta')?.textContent.includes(entregado.order_number),
        ) ?? null,
      'la fila del pedido entregado',
    );
    const fechaEntrega = ordenDe(entregado)?.delivered_at;
    expect(fechaEntrega).toBeTruthy();
    expect(fila.querySelector('.order-row__when')?.textContent).toBe(
      new Intl.DateTimeFormat('es-DO', {
        timeZone: 'America/Santo_Domingo', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
      }).format(new Date(fechaEntrega)),
    );
    expect(fila.querySelector('.order-row__when')?.title).toContain('República Dominicana');
    click(fila);
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante del entregado');
    click(fab);
    const menu = await waitFor(
      () => ($('#sheet-body .menu-list') ? $('#sheet-body') : null),
      'el menú del pedido entregado',
    );
    expect(menu.textContent).toContain('Pedido entregado');
    expect(menu.textContent).toContain('Programar seguimiento');
    expect(menu.textContent).toContain('Programar mensaje al cliente');
    click('[data-close-sheet]');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');

    // Estado y fecha se cruzan: el número del chip coincide con las filas visibles.
    click($('#pedidos-filtros [data-order-filter="entregado"]'));
    expect($('#pedidos-filtros [data-order-filter="entregado"]').textContent).toContain('1');
    expect($$('#list-pedidos .order-row')).toHaveLength(1);
    click($('#pedidos-filtros [data-order-date="yesterday"]'));
    expect($$('#list-pedidos .order-row')).toHaveLength(0);
    expect($('#pedidos-filtros [data-order-filter="entregado"]').textContent).not.toContain('1');
    click($('#pedidos-filtros [data-order-date="all"]'));
    expect($('#pedidos-filtros [data-order-filter="entregado"]').textContent).toContain('1');
    expect($$('#list-pedidos .order-row')).toHaveLength(1);
    click($('#pedidos-filtros [data-order-filter="todo"]'));
    click($('#pedidos-filtros [data-order-date="today"]'));
  });

  /*
   * TRABAJAR EL DÍA: la lista abre en HOY, cada pedido lleva su color y sus
   * botones al pie, y varios se resuelven de una vez.
   */
  const abiertos = async () =>
    (await pedidos()).filter((item) => !['entregado', 'cancelado', 'perdido'].includes(item.status ?? 'nuevo'));

  it('la lista de pedidos abre en HOY y el filtro de fecha cambia lo que se ve', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-card'), 'la lista de pedidos con sus tarjetas');
    const chip = $('#pedidos-fecha-chip');
    expect(chip.textContent.trim()).toBe('Hoy');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    // Todos los pedidos de esta suite son de hoy, así que se ven todos… y se dice.
    expect($$('#list-pedidos .order-row').length).toBe((await pedidos()).length);
    expect($('#pedidos-count').textContent).toContain('hoy');

    // El histórico completo está a un toque.
    click('#pedidos-fecha-chip');
    await waitFor(() => $('[data-order-date="all"]'), 'el menú de fechas');
    click('[data-order-date="all"]');
    await waitFor(() => $('#pedidos-fecha-chip').textContent.trim() === 'Fecha', 'el chip sin fecha puesta');
    expect($$('#list-pedidos .order-row').length).toBe((await pedidos()).length);

    /*
     * LA FECHA SE ELIGE TAMBIÉN DESDE EL PROPIO PANEL DE FILTROS, con los mismos
     * rangos: hoy, ayer, una semana, el mes, un intervalo y todas.
     */
    click($('#pedidos-filtros [data-order-date="today"]'));
    await waitFor(() => $('#pedidos-fecha-chip').textContent.trim() === 'Hoy', 'Hoy puesto desde el panel');
    expect($('#pedidos-filtros [data-order-date="today"]').getAttribute('aria-pressed')).toBe('true');
    expect($$('#list-pedidos .order-row').length).toBe((await pedidos()).length);

    // «Ayer» no tiene pedidos en esta suite: la lista lo dice y deja volver.
    click($('#pedidos-filtros [data-order-date="yesterday"]'));
    const ayerVacio = await waitFor(() => $('.empty--order-date'), 'el aviso de que ayer no hay pedidos');
    expect(ayerVacio.textContent).toContain('ayer');
    expect($('#pedidos-filtros [data-order-date="yesterday"]').getAttribute('aria-pressed')).toBe('true');
    click($('#pedidos-filtros [data-order-date="7d"]'));
    await waitFor(() => $$('#list-pedidos .order-row').length > 0, 'los últimos 7 días');

    // El INTERVALO se elige desde el panel y filtra de verdad, día a día.
    click($('#pedidos-filtros [data-order-date-custom]'));
    /*
     * EL DÍA ES EL DEL NEGOCIO, no el de UTC.
     *
     * El panel cuenta los pedidos con la fecha de `America/Santo_Domingo` (UTC-4).
     * Con `toISOString()` el «hoy» del test se adelantaba un día entre las 00:00 y
     * las 04:00 UTC —de noche en el negocio—, el intervalo «hoy→hoy» no casaba con
     * ningún pedido y esta prueba se caía sola (y se llevaba las tres siguientes,
     * que ya no veían filas). Se calcula igual que el panel.
     */
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date());
    setValue('#order-date-from', hoy);
    setValue('#order-date-to', hoy);
    click('#order-date-apply');
    await waitFor(() => $('#pedidos-fecha-chip').textContent.includes('–'), 'el intervalo puesto en el chip');
    expect($$('#list-pedidos .order-row').length).toBe((await pedidos()).length);

    // Un día sin pedidos lo dice claro y ofrece ver todos (nunca una lista vacía sin salida).
    click($('#pedidos-filtros [data-order-date="7d"]'));
    await waitFor(() => $$('#list-pedidos .order-row').length > 0, 'los últimos 7 días otra vez');
    click('#pedidos-fecha-chip');
    await waitFor(() => $('[data-order-date-day]'), 'los días sueltos');
    click($$('[data-order-date-day]')[3]);
    const vacio = await waitFor(() => $('.empty--order-date'), 'el aviso de que ese día no hay pedidos');
    expect(vacio.textContent).toContain('No hay pedidos de');
    click('.empty--order-date [data-order-date="all"]');
    await waitFor(() => $$('#list-pedidos .order-row').length > 0, 'la lista otra vez');
  });

  it('cada pedido lleva el color de su estado y todo lo demás en su «⋯»', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-card'), 'la lista de pedidos');
    const tarjeta = $$('#list-pedidos .order-card')[0];
    expect(tarjeta.querySelector('.order-row')).toBeTruthy();
    //
    // LA LISTA ES FINA: en la tarjeta solo está la fila y el botón «⋯». Los botones
    // que iban al pie (Marcar, Estado, Escribir) viven ahora DENTRO del menú, así
    // que cada pedido ocupa la mitad y se ven el doble en la misma pantalla.
    //
    expect(tarjeta.querySelector('.order-card__actions')).toBeNull();
    expect(tarjeta.querySelector('[data-order-select]')).toBeNull();
    expect(tarjeta.querySelector('[data-order-quick-status]')).toBeNull();
    click(tarjeta.querySelector('[data-order-more]'));
    await waitFor(() => $('#side-drawer [data-order-quick-status]'), 'el menú del pedido');
    expect($('#side-drawer [data-order-quick-status]').textContent).toContain('Cambiar el estado');
    // El menú ya no repite lo que ya está a un toque: el pedido se abre con la fila.
    expect($('#side-drawer [data-open]')).toBe(null);
    expect($('#side-drawer [data-order-delivery]')).toBe(null);
    expect($('#side-drawer [data-order-quick-chat]')).toBeTruthy();
    expect($('#side-drawer [data-order-select-toggle]')).toBeTruthy();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // El color es del estado: lo entregado en verde y lo que falta, no.
    const tonos = $$('#list-pedidos .order-card').map((card) => card.className.match(/order-card--(\w+)/)?.[1] ?? '');
    expect(tonos).toContain('entregado');
    expect(tonos.some((tono) => ['pendiente', 'en_camino', 'incidencia'].includes(tono))).toBe(true);
  });

  it('finalizar desde la lista: el botón Estado cierra el pedido y deja el aviso escrito', async () => {
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-card'), 'la lista de pedidos');
    const objetivo = await esperar(async () => (await abiertos())[0] ?? null, 'un pedido abierto');
    const tarjeta = await waitFor(
      () => $$('#list-pedidos .order-card').find((card) => card.dataset.orderCard === objetivo.id) ?? null,
      'la tarjeta del pedido abierto',
    );
    click(tarjeta.querySelector('[data-order-more]'));
    const cambiar = await waitFor(() => $('#side-drawer [data-order-quick-status]'), 'el menú del pedido');
    click(cambiar);
    await waitFor(() => $('#order-qs-confirm'), 'la hoja de estado');
    expect($('#sheet-body').textContent).toContain('Finalizar');
    // El aviso al cliente viene puesto: al cerrar se le avisa (lo envía la persona).
    expect($('#order-qs-notify')?.checked ?? false).toBe(true);
    click('#order-qs-confirm');
    await esperar(
      async () => ((await pedidos()).find((item) => item.id === objetivo.id)?.status === 'entregado' ? true : null),
      'el pedido finalizado en el CRM',
    );
    // Y el panel abre SU conversación con el mensaje ya escrito (no lo manda solo).
    const texto = await esperar(
      () => ($('#wa-text')?.value?.includes('ENTREGADO') ? $('#wa-text').value : null),
      'el aviso escrito en la conversación',
    );
    expect(texto).toContain('Gracias por tu compra');
  });

  it('varios pedidos a la vez: se marcan y se finalizan de un tirón', async () => {
    dom.window.confirm = () => true;
    click('[data-tab="pedidos"]');
    await waitFor(() => $('#list-pedidos .order-card'), 'la lista de pedidos');
    const lote = (await abiertos()).slice(0, 2);
    expect(lote.length).toBe(2);
    for (const item of lote) {
      const tarjeta = await waitFor(() => $(`[data-order-card="${item.id}"]`), `la tarjeta del pedido ${item.id}`);
      click(tarjeta.querySelector('[data-order-more]'));
      const marcar = await waitFor(() => $('#side-drawer [data-order-select-toggle]'), `la marca del pedido ${item.id}`);
      click(marcar);
    }
    const barra = await waitFor(() => $('#pedidos-bulk:not([hidden]) .order-bulk'), 'la barra de la selección');
    expect(barra.textContent).toContain('2 seleccionados');
    click('[data-order-bulk="entregado"]');
    await esperar(async () => {
      const filas = await pedidos();
      return lote.every((item) => filas.find((fila) => fila.id === item.id)?.status === 'entregado') ? true : null;
    }, 'los dos pedidos finalizados');
    // La selección se limpia sola al terminar: la barra se va.
    await esperar(() => ($('#pedidos-bulk')?.hidden ? true : null), 'la barra de la selección escondida');
  });

  it('finalizar sin ser admin: cualquiera que atienda pedidos puede cerrarlos', async () => {
    const entrada = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'agente@phyto.local', password: 'Agente-12345' }),
    });
    const cookieAgente = entrada.headers.get('set-cookie').split(';')[0];
    // Un pedido propio: no se depende de lo que hayan dejado las pruebas de antes.
    await fetch(`${app.url}/api/crm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `pedido-finish-${Date.now()}`,
        type: 'order_intent',
        name: 'UAT Finalizar',
        source: 'checkout',
        status: 'nuevo',
        // Evidencia del catálogo Phyto para que el pedido de prueba no quede
        // en cuarentena multiempresa como un checkout de origen desconocido.
        variantId: 'capsules_5',
        capsules: 5,
        variantName: '5 cápsulas',
        quantity: 1,
        total: 1250,
        createdAt: new Date().toISOString(),
      }),
    });
    const objetivo = (await abiertos())[0];
    expect(objetivo).toBeTruthy();

    // El cambio de estado COMPLETO (cancelar, revertir…) sigue siendo de ADMIN.
    const general = await fetch(`${app.url}/api/admin/orders/${objetivo.id}/status`, {
      method: 'PATCH',
      headers: { cookie: cookieAgente, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'CANCELADO', reason: 'Prueba de permisos del panel' }),
    });
    expect(general.status).toBe(403);

    // Finalizar, en cambio, sí puede: es el caso del repartidor que no lo marcó.
    const finalizado = await fetch(`${app.url}/api/admin/orders/${objetivo.id}/finish`, {
      method: 'POST',
      headers: { cookie: cookieAgente, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Lo entregó y no lo marcó en la app' }),
    });
    expect(finalizado.status).toBe(200);
    const cuerpo = await finalizado.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.item.status).toBe('entregado');
  });
});
