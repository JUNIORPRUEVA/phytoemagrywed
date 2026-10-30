// @vitest-environment jsdom
/**
 * UAT DEL FLUJO DE PEDIDOS — CREAR · PEDIR CONFIRMACIÓN · CONFIRMAR (+ DELIVERY).
 *
 * Se carga el panel REAL (`public/admin/index.html` + `app.js` + `pos.js`) sobre
 * un CRM de verdad (SQLite temporal) y se recorre el circuito como lo hace un
 * agente, comprobando en el SERVIDOR lo que queda guardado:
 *
 *   1. «Pedir confirmación» deja el pedido en `nuevo` (pendiente) y escribe el
 *      resumen en el chat SIN enviarlo (ni texto ni plantilla).
 *   2. El acceso de pedidos de la cabecera del chat aparece solo si hay pedidos
 *      abiertos, dice cuántos y abre el pedido correcto.
 *   3. «Confirmar + delivery» confirma y asigna en un solo paso; repetirlo no
 *      duplica ni el pedido ni la asignación.
 *   4. «Solo confirmar» confirma sin mensajero, sin entrega y sin cobro.
 *   5. Un pedido de retiro sin dirección se confirma sin exigir ubicación.
 *   6. Cancelar un pendiente conserva el historial y el carrito se actualiza.
 *   7. Sin permiso no se asignan repartidores del equipo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { calculateSale } from '../public/admin/pos-math.js';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-pedido-panel';
const APP_SECRET = 'uat-pedido-secret';
const PHONE = '18095550333';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const APP_JS = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');
const STORE_SCRIPT = readFileSync(path.join(ADMIN_DIR, 'store.js'), 'utf8');
const POS_SCRIPT = readFileSync(path.join(ADMIN_DIR, 'pos.js'), 'utf8').replace(/^import[^\n]+\n/, '');

let tmpDir;
let app;
let dom;
let cookie = '';
let conversationId = '';
let customerId = '';

/** WhatsApp de mentira: si algo sale solo, queda anotado aquí. */
const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-PEDIDO',
  businessAccountId: 'WABA1',
  sent: [],
  templates: [],
  async sendText(to, body) {
    whatsapp.sent.push({ to, body });
    return { ok: true, status: 200, messageId: `wamid.PEDTXT${whatsapp.sent.length}` };
  },
  async sendTemplate(to, template) {
    whatsapp.templates.push({ to, template });
    return { ok: true, status: 200, messageId: `wamid.PEDTPL${whatsapp.templates.length}` };
  },
  async markAsRead() {
    return { ok: true };
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 8000) {
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
/** El diálogo del POS que está ABIERTO (el anterior conserva su HTML al cerrarse). */
const posDialog = () =>
  $$('dialog').find((dialog) => dialog.open === true && String(dialog.className).includes('pos-')) ?? null;
const posDialogWith = (selector) => (posDialog()?.querySelector(selector) ? posDialog() : null);
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

async function call(route, options = {}) {
  const response = await fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, response };
}

/** Todos los pedidos del servidor (para comprobar lo que de verdad se guardó). */
async function serverOrders() {
  const data = await call('/api/admin/data');
  return (data.body.items ?? []).filter((item) => item.type === 'order_intent');
}

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
              metadata: { phone_number_id: 'PN-UAT-PEDIDO', display_phone_number: '18095550000' },
              contacts: [{ profile: { name: 'Ana Pedido' }, wa_id: PHONE }],
              messages: [
                {
                  from: PHONE,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(typeof body === 'string' ? { type: 'text', text: { body } } : body),
                },
              ],
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-pedido-'));
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

  await inbound('wamid.PEDIDO-1', 'Hola, quiero un pedido');
  // La ubicación que manda el cliente: es la dirección que usará el reparto.
  await inbound('wamid.PEDIDO-LOC', {
    type: 'location',
    location: { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' },
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0];
  const data = await call('/api/admin/data');
  const conversation = data.body.conversations[0];
  conversationId = conversation.id;
  customerId = conversation.customer_id;

  // Un repartidor del equipo para poder asignar.
  await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: `repartidor-${Date.now()}`,
      password: 'clave-segura-1',
      displayName: 'Luis Reparto',
      role: 'DELIVERY',
    }),
  });
  // Y un administrador con NOMBRE: así «quién confirmó» queda registrado de verdad.
  const jefe = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'jefe-uat', password: 'clave-segura-3', displayName: 'Jefe UAT', role: 'ADMIN' }),
  });
  expect(jefe.status).toBe(201);

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  win.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  win.structuredClone = structuredClone;
  win.calculateSale = calculateSale;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  win.cancelAnimationFrame = (timer) => clearTimeout(timer);
  win.confirm = () => true;
  win.alert = () => {};
  win.open = () => null;
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  win.eval(APP_JS);
  win.eval(STORE_SCRIPT);
  win.eval(POS_SCRIPT);
  await waitFor(() => !win.document.querySelector('#login')?.hidden || !win.document.querySelector('#app')?.hidden, 'la pantalla de acceso');
  // Entra el administrador real (usuario + clave), no la clave compartida.
  const usuario = win.document.querySelector('#login-username');
  const clave = win.document.querySelector('#login-password');
  usuario.value = 'jefe-uat';
  clave.value = 'clave-segura-3';
  win.document.querySelector('#login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => win.document.querySelector('[data-conv]'), 'la lista de conversaciones');
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function openChat() {
  if (dom.window.document.body.dataset.tab !== 'whatsapp') {
    click('#menu');
    click('[data-tab="whatsapp"]');
    await waitFor(() => dom.window.document.body.dataset.tab === 'whatsapp', 'la pestaña de WhatsApp');
  }
  click(`[data-conv="${conversationId}"]`);
  await waitFor(() => $$('#thread .bubble').length > 0, 'el hilo del chat');
}

/**
 * Chat → columna de acciones (pestaña del borde derecho) → Crear pedido →
 * producto → Continuar (hoja del pedido).
 */
async function openOrderSheet() {
  await openChat();
  // La columna de acciones pudo quedar abierta de la prueba anterior: no se
  // vuelve a pulsar la pestaña (la cerraría) si la acción ya está a la vista.
  if (!$(`[data-order-new="${customerId}"]`)) click('#wa-edge-right');
  click(await waitFor(() => $(`[data-order-new="${customerId}"]`), 'crear pedido desde el chat'));
  // El cliente del chat llega al POS antes de tocar el catálogo (si no, el
  // carrito se llenaría sin cliente y el POS pediría confirmarlo).
  await waitFor(
    () => ($('#pos-client .pos-client-button strong')?.textContent?.includes('Ana Pedido') ? true : null),
    'el cliente cargado en el POS',
  );
  await waitFor(() => $('[data-pos-add]'), 'el catálogo del POS');
  click($('[data-pos-add]'));
  const pay = await waitFor(() => ($('[data-pos-pay]')?.disabled === false ? $('[data-pos-pay]') : null), 'Continuar');
  click(pay);
  await waitFor(
    () => (posDialogWith(['[data-order-field="deliveryFee"]', '[data-order-field="notes"]'].join(',')) ? true : null),
    'la hoja del pedido',
  );
  // Si el cliente ya tiene pedidos abiertos, el POS pide confirmar que este es uno nuevo.
  const ack = posDialog()?.querySelector('[data-order-open-ack]');
  if (ack && ack.checked !== true) {
    ack.checked = true;
    ack.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
}

describe('crear pedido y pedir confirmación', () => {
  it('deja el pedido PENDIENTE y escribe el mensaje en el chat sin enviarlo', async () => {
    await openOrderSheet();
    const antes = (await serverOrders()).length;
    expect(whatsapp.sent).toHaveLength(0);

    const pedir = posDialog()?.querySelector('[data-order-request]');
    expect(pedir?.disabled).toBe(false);
    expect(click(pedir)).toBe(true);
    const guardado = await waitFor(async () => {
      const pedidos = await serverOrders();
      return pedidos.length > antes ? pedidos : null;
    }, 'el pedido guardado en el servidor');

    expect(guardado).toHaveLength(antes + 1);
    const pedido = guardado.sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0];
    expect(pedido.status).toBe('nuevo');
    const detalle = JSON.parse(pedido.order_json);
    expect(detalle.conversation_id).toBe(conversationId);
    expect(detalle.customer_id).toBe(customerId);
    // Pendiente no es «pagado» ni «entregado».
    expect(detalle.payment_status).toBe('pending');
    expect(detalle.delivered_at ?? null).toBe(null);
    expect(detalle.delivery?.delivery_user_id ?? null).toBe(null);

    // El chat se abre con el resumen escrito y NADA se ha enviado solo.
    await waitFor(() => $('#wa-text')?.value?.includes('este es tu pedido'), 'el resumen en el compositor');
    expect($('#wa-text').value).toContain('Total:');
    expect(whatsapp.sent).toHaveLength(0);
    expect(whatsapp.templates).toHaveLength(0);
  }, 30000);

  it('el acceso del chat muestra el pedido activo y lo abre', async () => {
    const boton = await waitFor(
      () => ($('#wa-chat-orders')?.hidden === false ? $('#wa-chat-orders') : null),
      'el acceso a pedidos del chat',
      20000,
    );
    expect(boton.getAttribute('aria-label')).toMatch(/pedido/i);
    expect($('#wa-chat-orders-count').textContent).toBe('1');

    click(boton);
    await waitFor(() => ($('#sheet-title')?.textContent?.startsWith('Factura') ? true : null), 'la ficha del pedido', 20000);
    expect($('#sheet-body').textContent).toContain('Pendiente');

    // Y desde la MISMA ficha se puede confirmar (con o sin reparto).
    const fab = await waitFor(() => $('#sheet-body [data-sheet-actions]'), 'las acciones del pedido', 20000);
    click(fab);
    try {
      await waitFor(() => $('[data-order-confirm-only]'), 'confirmar desde el carrito', 20000);
    } catch (error) {
      const hechos = $$('#sheet-body .fact')
        .map((nodo) => nodo.textContent.trim())
        .join(' · ');
      throw new Error(
        `${error.message} :: sheet=${$('#sheet-title')?.textContent} :: facts=${hechos} :: menu=${$('#sheet-body .menu-list')?.textContent?.slice(0, 300)} :: delivery=${Boolean($('[data-order-delivery]'))}`,
      );
    }
    expect($('[data-order-confirm-delivery]')).toBeTruthy();
    click('[data-close-sheet]');
  }, 40000);
});

describe('confirmar el pedido', () => {
  it('«Solo confirmar» confirma sin entrega, sin cobro y sin mensajes', async () => {
    await openOrderSheet();
    const idsAntes = new Set((await serverOrders()).map((row) => row.id));
    const boton = posDialog()?.querySelector('[data-order-confirm]');
    expect(boton?.disabled).toBe(false);
    expect(click(boton)).toBe(true);
    let pedido = null;
    try {
      pedido = await waitFor(async () => {
        const rows = await serverOrders();
        return rows.find((row) => !idsAntes.has(row.id) && row.status === 'confirmado') ?? null;
      }, 'el pedido confirmado');
    } catch (error) {
      throw new Error(
        `${error.message} :: error=${posDialog()?.querySelector('#pos-order-error')?.textContent} :: check=${posDialog()?.querySelector('#pos-order-check')?.textContent} :: feedback=${$('.pos-feedback')?.textContent} :: disabled=${posDialog()?.querySelector('[data-order-confirm]')?.disabled}`,
      );
    }
    expect(pedido.status).toBe('confirmado');
    const detalle = JSON.parse(pedido.order_json);
    expect(detalle.status).toBe('confirmado');
    expect(Boolean(detalle.confirmed_at)).toBe(true);
    expect(detalle.confirmed_by_display_name_snapshot).toBeTruthy();
    expect(detalle.delivery?.delivery_user_id ?? null).toBe(null);
    expect(detalle.delivery?.delivery_status ?? null).toBe(null);
    expect(detalle.payment_status).toBe('pending');
    expect(detalle.delivered_at ?? null).toBe(null);
    expect(whatsapp.sent).toHaveLength(0);
    expect(whatsapp.templates).toHaveLength(0);

    // No se creó ninguna entrega (ni sesión de tracking).
    const tracking = await call('/api/admin/delivery-tracking');
    expect((tracking.body.sessions ?? []).filter((session) => session.order?.id === pedido.id)).toHaveLength(0);

    // Queda en el historial del pedido (trazabilidad de quién confirmó).
    expect(detalle.status_history.some((row) => row.status === 'confirmado')).toBe(true);
  }, 30000);

  it('«Confirmar + delivery» confirma y asigna; repetirlo no duplica', async () => {
    await openOrderSheet();
    const idsAntes = new Set((await serverOrders()).map((row) => row.id));
    click(posDialog()?.querySelector('[data-order-confirm-delivery]'));
    const form = await waitFor(() => posDialog()?.querySelector('form [name="assignee"]'), 'el modal de asignación');
    expect(posDialog().textContent).toContain('Quién lo lleva');
    form.value = [...form.options].find((option) => option.value.startsWith('user:'))?.value ?? '';
    expect(form.value).toMatch(/^user:/);
    form.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click(posDialog().querySelector('[type="submit"]'));

    const pedido = await waitFor(async () => {
      const rows = await serverOrders();
      return (
        rows.find((row) => {
          if (idsAntes.has(row.id) || row.status !== 'confirmado') return false;
          return Boolean(JSON.parse(row.order_json).delivery?.delivery_user_id);
        }) ?? null
      );
    }, 'el pedido confirmado y asignado');
    const detalle = JSON.parse(pedido.order_json);
    expect(detalle.status).toBe('confirmado');
    expect(detalle.delivery.delivery_user_name_snapshot).toBe('Luis Reparto');
    expect(detalle.delivery.delivery_assignment_version).toBe(1);
    expect(detalle.payment_status).toBe('pending');
    expect(whatsapp.sent).toHaveLength(0);

    // Repetir la misma operación (doble toque / reintento) NO duplica nada.
    const otra = await call(`/api/admin/orders/${encodeURIComponent(pedido.id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ deliveryUserId: detalle.delivery.delivery_user_id, fulfillment: 'delivery' }),
    });
    expect(otra.status).toBe(200);
    expect(otra.body.duplicate).toBe(true);
    const despues = JSON.parse((await serverOrders()).find((row) => row.id === pedido.id).order_json);
    expect(despues.delivery.delivery_assignment_version).toBe(1);
    expect((await serverOrders()).filter((row) => row.id === pedido.id)).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(0);
  }, 40000);
});

describe('integridad', () => {
  it('un pedido de retiro sin dirección se confirma sin exigir ubicación', async () => {
    const catalogo = await call('/api/admin/store/products');
    const products = catalogo.body.products ?? [];
    expect(products.length).toBeGreaterThan(0);
    const items = [{ variantId: 'capsules_10', quantity: 1, discount: {} }];
    const sale = calculateSale(items, products, {}, 0);
    const creado = await call('/api/admin/pos/checkout', {
      method: 'POST',
      body: JSON.stringify({
        requestId: `uat-retiro-${Date.now()}`,
        mode: 'order',
        customerId,
        conversationId,
        items,
        discount: {},
        deliveryFee: 0,
        deliveryMethod: 'pickup',
        paymentMethod: 'CASH',
        expectedTotal: sale.total_cents,
        guided: true,
        needsDelivery: false,
        acknowledgeOpen: true,
      }),
    });
    expect(creado.status).toBe(201);
    const orderId = creado.body.orderId;
    const confirmado = await call(`/api/admin/orders/${encodeURIComponent(orderId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ fulfillment: 'pickup' }),
    });
    expect(confirmado.status).toBe(200);
    const detalle = JSON.parse((await serverOrders()).find((row) => row.id === orderId).order_json);
    expect(detalle.status).toBe('confirmado');
    expect(detalle.delivery?.location ?? null).toBe(null);
    expect(detalle.delivery?.delivery_user_id ?? null).toBe(null);
  }, 20000);

  it('cancelar un pendiente conserva el historial y el carrito se actualiza', async () => {
    const pendiente = await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        items: [{ variantId: 'capsules_10', quantity: 1, unitPrice: 2500 }],
        paymentMethod: 'CASH',
      }),
    });
    expect(pendiente.status).toBe(201);
    const orderId = pendiente.body.item.id;

    // El panel lo ve tras un refresco (simula el cambio hecho desde otro equipo).
    const activosEnServidor = async () =>
      (await serverOrders()).filter((row) => !['entregado', 'cancelado', 'perdido'].includes(row.status)).length;
    await openChat();
    dom.window.dispatchEvent(new dom.window.Event('fulltech:pos-saved'));
    const activosAntes = await activosEnServidor();
    expect(activosAntes).toBeGreaterThan(0);
    await waitFor(
      () => Number($('#wa-chat-orders-count')?.textContent ?? 0) === activosAntes,
      'el contador del chat igual a los pedidos abiertos',
    );

    const cancelado = await call(`/api/admin/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELADO', reason: 'El cliente ya no lo quiere' }),
    });
    expect(cancelado.status).toBe(200);
    const detalle = JSON.parse((await serverOrders()).find((row) => row.id === orderId).order_json);
    expect(detalle.status).toBe('cancelado');
    expect(detalle.cancel_reason).toBe('El cliente ya no lo quiere');
    expect(detalle.cancelled_at).toBeTruthy();
    // Cancelar no borra: el pedido sigue en la base.
    expect((await serverOrders()).some((row) => row.id === orderId)).toBe(true);

    // El pedido cancelado sale del contador tras refrescar (los demás siguen).
    dom.window.dispatchEvent(new dom.window.Event('fulltech:pos-saved'));
    try {
      await waitFor(
        () => Number($('#wa-chat-orders-count')?.textContent ?? 0) === activosAntes - 1,
        'el contador con un pedido activo menos',
      );
    } catch (error) {
      const estados = (await serverOrders()).map((row) => `${row.id}:${row.status}`).join(' ');
      throw new Error(
        `${error.message} :: antes=${activosAntes} ahora=${$('#wa-chat-orders-count')?.textContent} :: ${estados}`,
      );
    }
  }, 30000);

  it('un agente puede confirmar pero NO asignar repartidores del equipo', async () => {
    const username = `agente-${Date.now()}`;
    const creado = await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'clave-segura-2', displayName: 'Agente UAT', role: 'AGENT' }),
    });
    expect(creado.status).toBe(201);

    const loginAgente = await fetch(`${app.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'clave-segura-2' }),
    });
    const cookieAgente = (loginAgente.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookieAgente).toContain('pe_crm');

    const pedido = await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        items: [{ variantId: 'capsules_10', quantity: 1, unitPrice: 2500 }],
        paymentMethod: 'CASH',
      }),
    });
    const orderId = pedido.body.item.id;

    // Confirmar: permitido (opera pedidos).
    const confirmado = await fetch(`${app.url}/api/admin/orders/${encodeURIComponent(orderId)}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieAgente },
      body: JSON.stringify({ fulfillment: 'delivery' }),
    });
    expect(confirmado.status).toBe(200);

    // Asignar un repartidor del equipo: solo ADMIN.
    const rechazado = await fetch(`${app.url}/api/admin/orders/${encodeURIComponent(orderId)}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieAgente },
      body: JSON.stringify({ deliveryUserId: 'USER-NO-IMPORTA' }),
    });
    expect(rechazado.status).toBe(403);
  }, 30000);
});
