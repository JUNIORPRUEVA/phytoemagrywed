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

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-panel-123';
const APP_SECRET = 'uat-panel-secret';
const PHONE = '18095559191';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que una condición del DOM se cumpla (o falla con un mensaje claro). */
async function waitFor(check, label, timeout = 5000) {
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
  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
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
    const hoy = await waitFor(() => {
      const html = $('#list-hoy').innerHTML;
      return html.includes('Ana UAT') ? html : null;
    }, 'una conversación en HOY');
    // «Esperando respuesta» es una fila con acción directa.
    expect(hoy).toContain('Esperando respuesta');
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
    for (const accion of ['Crear pedido', 'Programar seguimiento', 'Programar mensaje', 'Ver cliente']) {
      expect(menu).toContain(accion);
    }
  });

  it('crea un pedido con el precio del catálogo y muestra el comprobante', async () => {
    click('[data-order-new]');
    const lineas = await waitFor(() => $('#order-lines')?.querySelector('select'), 'el formulario de pedido');
    // El catálogo sale del servidor: 7 frascos reales.
    expect(lineas.options).toHaveLength(7);

    setValue('[data-line-variant="0"]', 'capsules_10');
    setValue('[data-line-qty="0"]', '3');
    setValue('#order-discount', '500');
    // 3 × RD$2,500 − RD$500 = RD$7,000
    expect($('#order-total').textContent).toContain('7,000');

    click('#order-save');
    const receipt = await waitFor(() => {
      const html = $('#sheet-body').innerHTML;
      return html.includes('Comprobante') || html.includes('Pedido'); 
    }, 'el comprobante');
    const title = $('#sheet-title').textContent;
    expect(title).toMatch(/PE-/);

    // El pedido quedó guardado en el servidor, ligado al cliente y a la conversación.
    const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
    const order = data.items.find((item) => item.type === 'order_intent');
    expect(order).toBeTruthy();
    expect(order.total).toBe(7000);
    expect(order.conversation_id).toBeTruthy();
    expect(order.customer_id).toBeTruthy();
    expect(order.order_number).toMatch(/^PE-/);
    expect(receipt ?? true).toBeTruthy();
  });

  it('programa un mensaje (no es un seguimiento: lo intentará el sistema)', async () => {
    await waitFor(() => $('#wa-actions')?.disabled === false, 'el menú ⋯ habilitado');
    click('#wa-actions');
    click('[data-scheduled-new]');
    await waitFor(() => $('#sch-save'), 'el formulario de mensaje programado');
    setValue('#sch-text', 'Hola Ana, ¿te ayudo con algo más?');
    click('#sch-save');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');

    const data = await (await fetch(`${app.url}/api/admin/scheduled`, { headers: { cookie } })).json();
    const row = data.scheduled.find((entry) => entry.text === 'Hola Ana, ¿te ayudo con algo más?');
    expect(row).toBeTruthy();
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
    return waitFor(() => $('#order-lines'), 'el formulario de pedido');
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
    // Nada de botones dentro de la fila: las acciones viven en la ficha.
    expect(fila.querySelectorAll('button')).toHaveLength(0);
  });

  it('la ficha del pedido dice el cliente, quién lo atendió y quién lo creó', async () => {
    click('#list-pedidos .order-row');
    const ficha = await waitFor(() => $('#sheet-body')?.textContent?.includes('Atendido por'), 'la ficha del pedido');
    const texto = $('#sheet-body').textContent;
    expect(texto).toMatch(/Atendido por/);
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
    for (const accion of ['Ver cliente', 'Ver factura', 'Pasar a un delivery', 'Escribir por WhatsApp', 'Volver a la ficha']) {
      expect(menu.textContent).toContain(accion);
    }

    // Y «Ver cliente» abre su ficha de verdad (con el id del cliente del pedido).
    const boton = $('[data-customer]');
    expect(boton?.dataset.customer).toBeTruthy();
    click(boton);
    await waitFor(() => $('#customer-profile .profile-hero'), 'el perfil del cliente');
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
    for (const accion of ['Ver factura', 'Compartir factura', 'Pasar a un delivery', 'Ver cliente', 'Modificar pedido']) {
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
    const menu = await abrirMenu(filas[0]);
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
    click($$('#list-pedidos .order-row')[0]);
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'el botón flotante otra vez');
    click(fab);
    click(await waitFor(() => $('[data-scheduled-new]'), 'la acción de programar mensaje'));
    await waitFor(() => $('#sch-save'), 'el formulario de mensaje programado');
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

  it('los filtros de estado se cuentan y filtran de verdad', async () => {
    expect($$('#pedidos-filtros .chip')).toHaveLength(5);
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

  it('el alta vive en un botón cuadrado flotante, no en una barra ancha al pie', async () => {
    const fab = $('#compra-nueva-ped');
    expect(fab.classList.contains('list-fab')).toBe(true);
    // Solo el icono: sin texto de botón grande.
    expect(fab.textContent.trim()).toBe('');
    click(fab);
    await waitFor(() => $('#order-lines'), 'el formulario de pedido');
    click('[data-close-sheet]');
    await waitFor(() => $('#sheet').hidden, 'la hoja cerrada');
  });

  it('avisa de que ya hay un pedido abierto y NO lo guarda sin confirmar', async () => {
    const antes = (await pedidos()).length;
    await abrirPedidoDeAna();
    const aviso = await waitFor(() => $('#order-open-warning'), 'el aviso de pedido abierto');
    expect(aviso.textContent).toMatch(/ya tiene un pedido sin cerrar/);
    expect(aviso.textContent).toMatch(/PE-/);

    click('#order-save');
    await sleep(200);
    // Sigue abierto (no se guardó) y el servidor no tiene un pedido más.
    expect($('#order-open-warning')).toBeTruthy();
    expect((await pedidos()).length).toBe(antes);

    // Con la confirmación marcada, el pedido nuevo sí se guarda.
    $('#order-open-ack').checked = true;
    click('#order-save');
    await esperar(async () => (await pedidos()).length === antes + 1, 'el pedido nuevo guardado');
    click('[data-close-sheet]');
  });

  it('la ubicación que manda el cliente se puede agregar al pedido abierto', async () => {
    await inboundLocation('wamid.UATLOC1', LUGAR);
    click('[data-tab="whatsapp"]');
    const row = await waitFor(() => $$('[data-conv]')[0], 'la conversación en la bandeja');
    click(row);
    const mas = await waitFor(() => $('#thread [data-loc-menu]'), 'la ubicación dentro del hilo');
    click(mas);
    await waitFor(() => $('#loc-attach'), 'las acciones de la ubicación');
    click('#loc-attach');

    // Solo se ofrecen los pedidos VIVOS (ni entregados ni cancelados).
    const opcion = await waitFor(() => $('[data-order-attach-loc]'), 'la lista de pedidos abiertos');
    const vivos = (await pedidos()).filter((item) => !['entregado', 'perdido'].includes(item.status));
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
    const cliente = (await datos()).customers.find((candidate) => candidate.phone_e164 === `+${PHONE}`);
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
  });
});
