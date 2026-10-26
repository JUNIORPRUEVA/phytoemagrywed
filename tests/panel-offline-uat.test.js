import {receiptPdfBytes} from '../public/admin/receipt-pdf.js';
// @vitest-environment node
/**
 * UAT DEL PANEL SIN CONEXIÓN — trabajar 24 horas sin internet.
 *
 * Se monta el panel REAL (`public/admin/index.html` + `app.js`) dos veces:
 *
 *   1. EN LÍNEA, contra un CRM de verdad: entra, carga los datos y guarda la copia
 *      en el teléfono (como cuando se usa la app con red).
 *   2. SIN CONEXIÓN, con un arranque EN FRÍO (una página nueva, sin cookies y sin
 *      red) que solo tiene la copia guardada. Aquí se comprueba lo que pidió el
 *      negocio: que la app ABRA, que se vean clientes y pedidos, que se pueda
 *      registrar un pedido, finalizarlo, verificar un pedido y archivar un chat…
 *      y que TODO eso se mande solo al CRM cuando vuelve la conexión.
 *
 * No sustituye a mirar el teléfono en modo avión, pero demuestra que el panel no
 * depende de la red para trabajar y que no pierde ni duplica nada al sincronizar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { calculateSale } from '../public/admin/pos-math.js';
import { offlineReport } from '../public/admin/offline-report.js';
const indexedDB=new IDBFactory(),panels=[],connections=[];

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-offline-123';
const PHONE = '18095559123';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');
const APP_JS = readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8');
const APP_HTML = readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpDir;
let app;

/** Espera a que una condición se cumpla (o falla diciendo qué esperaba). */
async function waitFor(check, label, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout esperando: ${label}`);
    await sleep(30);
  }
}

/**
 * Monta el panel en un DOM. `offline` corta la red de verdad: `fetch` falla como
 * cuando el teléfono no tiene datos, y el navegador dice que no hay conexión.
 */
function montarPanel({ offline = false, snapshot = null, cookie = '' } = {}) {
  const dom = new JSDOM(APP_HTML, {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  }, 30000);
  const win = dom.window;
  const estado = { cookie, offline, peticiones: [] };
  connections.push(estado);

  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.HTMLElement.prototype.scrollIntoView=function(){};
  win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
  Object.assign(win,{indexedDB,structuredClone,Response,Headers,Request,AbortController,Blob,TextDecoder,calculateSale,offlineReport,receiptPdfBytes});
  win.EventSource=class{addEventListener(){}close(){}};panels.push(win);
  Object.defineProperty(win.navigator, 'onLine', { configurable: true, get: () => !estado.offline });
  win.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${app.url}/admin/`).toString();
    if (estado.offline) {
      // Sin red: es lo que hace `fetch` de verdad (TypeError), no un 500.
      throw new TypeError('Failed to fetch');
    }
    const headers = Object.fromEntries(new Headers(init.headers));
    if (estado.cookie) headers.cookie = estado.cookie;
    const response = await fetch(url, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) estado.cookie = setCookie.split(';')[0];
    estado.peticiones.push(`${init.method ?? 'GET'} ${url.replace(app.url, '')}`);
    return response;
  };
  if (snapshot) win.localStorage.setItem('pe_crm_snapshot', snapshot);
  win.eval(readFileSync(path.join(ADMIN_DIR,'offline-storage.js'),'utf8'));
  win.eval(readFileSync(path.join(ADMIN_DIR,'offline.js'),'utf8').replace("await import('./pos-math.js')",'({calculateSale:window.calculateSale})').replace("await import('./offline-report.js')",'({offlineReport:window.offlineReport})').replace("await import('./receipt-pdf.js')",'({receiptPdfBytes:window.receiptPdfBytes})'));
  win.eval(APP_JS);
  win.eval(readFileSync(path.join(ADMIN_DIR,'store.js'),'utf8'));
  win.eval(readFileSync(path.join(ADMIN_DIR,'pos.js'),'utf8').replace(/^import[^\n]+\n/,''));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));

  const $ = (selector) => win.document.querySelector(selector);
  const $$ = (selector) => [...win.document.querySelectorAll(selector)];
  const click = (element) => {
    const target = typeof element === 'string' ? $(element) : element;
    if (!target) throw new Error(`no existe el elemento para pulsar: ${element}`);
    target.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    return true;
  };
  const setValue = (selector, value) => {
    const campo = $(selector);
    if (!campo) throw new Error(`no existe el campo: ${selector}`);
    campo.value = value;
    campo.dispatchEvent(new win.Event('input', { bubbles: true }));
    campo.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const outbox = () => {
    try {
      return JSON.parse(win.localStorage.getItem('pe_crm_outbox') ?? '[]');
    } catch {
      return [];
    }
  };
  return { dom, win, $, $$, click, setValue, outbox, estado };
}

/** El CRM, visto desde fuera (la prueba), para comprobar qué llegó de verdad. */
const api = async (ruta, options = {}) => {
  const respuesta = await fetch(`${app.url}${ruta}`, {
    ...options,
    headers: { cookie: cookieAdmin, 'content-type': 'application/json', ...(options.headers ?? {}) },
  }, 30000);
  return { status: respuesta.status, body: await respuesta.json().catch(() => ({})) };
};
let cookieAdmin = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-offline-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    whatsapp: { enabled: false },
  }, 30000);
  const entrada = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  }, 30000);
  cookieAdmin = entrada.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => {
  for(const win of panels)win.dispatchEvent(new win.Event('phyto:calling-logout'));
  await sleep(50);panels.forEach(win=>win.close());
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('el panel trabaja sin conexión y sincroniza al volver', () => {
  it('en línea: entra, carga los datos y deja la copia en el teléfono', async () => {
    await api('/api/admin/inventory/restock',{method:'POST',body:JSON.stringify({quantity:100,unitCost:'10',reason:'Inventario UAT offline'})});
    const panel = montarPanel({cookie:cookieAdmin});
    await waitFor(() => !panel.$('#app').hidden, 'el panel abierto');

    // Un cliente con su conversación (como cuando alguien escribe por WhatsApp).
    const conversacion = await api('/api/admin/conversations/start', {
      method: 'POST',
      body: JSON.stringify({ phone: PHONE, name: 'Ana Offline' }),
    });
    expect(conversacion.body.ok).toBe(true);

    // Un pedido con cliente, creado por la web (como entra en producción).
    const creado = await api('/api/crm', {
      method: 'POST',
      body: JSON.stringify({
        id: 'pedido-offline-base',
        type: 'order_intent',
        name: 'Ana Offline',
        phone: PHONE,
        source: 'checkout',
        status: 'nuevo',
        variantName: '5 cápsulas',
        quantity: 1,
        total: 1250,
        createdAt: new Date().toISOString(),
      }),
    });
    expect(creado.body.ok).toBe(true);

    // El panel trae los datos frescos (como al volver a la app).
    panel.win.dispatchEvent(new panel.win.Event('online'));
    const fila = await waitFor(
      () => panel.$$('#list-pedidos .order-row').find((row) => row.textContent.includes('Ana Offline')) ?? null,
      'el pedido del cliente en la lista',
    );
    expect(fila).toBeTruthy();

    /*
     * LA COPIA DEL TELÉFONO. Se guarda ya (y se vuelve a guardar al final, con el
     * informe) para que un fallo más abajo no deje sin datos a la prueba siguiente.
     */
    capturado.snapshot = panel.win.localStorage.getItem('pe_crm_snapshot');
    expect(capturado.snapshot).toBeTruthy();

    // Ver el comprobante EN LÍNEA deja su copia guardada para poder verlo sin red.
    panel.click(panel.$('[data-tab="pedidos"]'));
    await waitFor(() => panel.$('#list-pedidos .order-card'), 'las tarjetas de pedido');
    panel.click(fila);
    await waitFor(() => panel.$('#sheet-body')?.textContent?.includes('Factura'), 'el comprobante abierto');
    panel.click('#sheet button[aria-label="Cerrar"]');
    await waitFor(() => panel.$('#sheet').hidden, 'la hoja cerrada');

    // El informe de ventas de hoy también queda guardado para verlo sin red.
    panel.click(panel.$('[data-tab="reportes"]'));
    await waitFor(() => {
      try {
        return JSON.parse(panel.win.localStorage.getItem('pe_crm_snapshot') ?? '{}').salesReports?.hoy?.report;
      } catch {
        return null;
      }
    }, 'el informe de ventas guardado en la copia');

    await panel.win.FulltechOffline.warm();
    capturado.snapshot = panel.win.localStorage.getItem('pe_crm_snapshot');
    expect(JSON.parse(capturado.snapshot).customers.length).toBeGreaterThan(0);
    expect(JSON.parse(capturado.snapshot).salesReports?.hoy?.report).toBeTruthy();
  }, 30000);

  it('sin conexión: abre en frío con la copia, sigue viendo todo y registra un pedido', async () => {
    // Cortar la red de TODAS las ventanas del dispositivo simulado.
    for(const connection of connections)connection.offline=true;
    // La MISMA copia que quedó en el teléfono, en una página nueva… y con la
    // sesión que el navegador ya tenía guardada (la cookie no la da la red).
    const { snapshot } = capturado;
    const panel = montarPanel({ offline: true, snapshot, cookie: cookieAdmin });
    sinRed = panel;

    // 1) Abre SIN pedir la clave (no puede: no hay red) y avisa de que está sin conexión.
    await waitFor(() => !panel.$('#app').hidden, 'el panel abierto sin conexión');
    expect(panel.$('#login').hidden).toBe(true);
    await waitFor(() => panel.$('#state-pill')?.dataset.online === 'false', 'indicador discreto sin conexión');
    expect(panel.$('#offline-banner').hidden).toBe(true);

    // 2) Clientes y pedidos: los de la copia.
    expect(panel.$('#stats').textContent).toContain('Pedidos pendientes');
    panel.click(panel.$('[data-tab="pedidos"]'));
    const pedidos = await waitFor(() => {
      const filas = panel.$$('#list-pedidos .order-row');
      return filas.length ? filas : null;
    }, 'los pedidos de la copia');
    expect(pedidos.some((fila) => fila.textContent.includes('Ana Offline'))).toBe(true);

    // 3) VERIFICAR UN PEDIDO sin red: se abre su comprobante desde la copia.
    panel.click(pedidos.find((fila) => fila.textContent.includes('Ana Offline')).querySelector('.order-row__status'));
    const hoja = await waitFor(
      () => (panel.$('#sheet-body')?.textContent ?? '').includes('Ana Offline') ? panel.$('#sheet-body') : null,
      'el comprobante desde la copia guardada',
    );
    expect(hoja.textContent).toContain('Factura');
    expect(hoja.textContent).toMatch(/Ana Offline/);
    panel.click('#sheet button[aria-label="Cerrar"]');
    await waitFor(() => panel.$('#sheet').hidden, 'la hoja cerrada');

    // 4) REGISTRAR UN PEDIDO sin conexión: queda en la lista y en la cola de envíos.
    //    El alta vive en el menú de la lista (el «+» flotante ya no existe).
    panel.click('#pedidos-acciones');
    panel.click(await waitFor(() => panel.$('#side-drawer [data-purchase]'), 'la opción Registrar compra'));
    await waitFor(() => panel.$('[data-pos-client]'), 'Facturación');
    panel.click('[data-pos-client]');
    panel.setValue('.pos-modal-form [name=name]', 'Pedido Sin Red');
    panel.setValue('.pos-modal-form [name=phone]', '8095559999');
    panel.$('.pos-modal-form').dispatchEvent(new panel.win.Event('submit',{bubbles:true,cancelable:true}));
    await waitFor(()=>{const error=panel.$('.pos-modal-error')?.textContent;if(error)throw new Error(error);return panel.$('#pos-client').textContent.includes('Pedido Sin Red');},'cliente local del pedido');
    panel.click('[data-pos-add="capsules_10"]');panel.click('[data-pos-add="capsules_10"]');
    panel.click('[data-pos-expand]');panel.click('[data-pos-pending]');
    await waitFor(()=>panel.$('.pos-dialog').getAttribute('aria-label')==='Guardar pedido','confirmar pedido local');
    panel.$('.pos-modal-form').dispatchEvent(new panel.win.Event('submit',{bubbles:true,cancelable:true}));
    try{await waitFor(()=>{const error=panel.$('.pos-modal-error')?.textContent;if(error)throw new Error(error);return panel.$('.pos-dialog').textContent.includes('Guardado en este dispositivo');},'pedido guardado');}catch(error){throw new Error(error.message+' '+JSON.stringify({queue:await panel.win.FulltechOffline.listQueue(),customers:await(await panel.win.fetch('/api/admin/pos/customers')).json()}));}
    panel.click('[data-pos-close]');panel.click('[data-tab="pedidos"]');
    const nuevo = await waitFor(
      () => panel.$$('#list-pedidos .order-card').find((card) => card.textContent.includes('Sin enviar')) ?? null,
      'el pedido sin conexión en la lista, marcado como «Sin enviar»',
    );
    expect(nuevo.textContent).toMatch(/LOCAL-/);
    expect((await panel.win.FulltechOffline.listQueue()).some(row=>row.path.endsWith('/checkout'))).toBe(true);
    expect(panel.$('#toast').hidden).toBe(true);

    // 5) FINALIZAR ese pedido sin conexión (todo lo del pedido vive en su «⋯»,
    //    que abre la columna lateral de acciones).
    panel.click(nuevo.querySelector('[data-order-more]'));
    const estado = await waitFor(() => panel.$('#side-drawer [data-order-quick-status]'), 'el menú del pedido');
    panel.click(estado);
    await waitFor(() => panel.$('#order-qs-confirm'), 'la hoja de estado');
    panel.click('#order-qs-confirm');
    await waitFor(
      () => panel.$$('#list-pedidos .order-card--entregado').length > 0,
      'el pedido finalizado en pantalla',
    );
    expect((await panel.win.FulltechOffline.listQueue()).some(row=>row.body.status==='entregado'||row.path.endsWith('/finish'))).toBe(true);
  }, 30000);

  it('sin conexión: crear un cliente y archivar un chat también funcionan', async () => {
    const panel = sinRed;
    // Crear un cliente desde «Acciones de clientes».
    panel.click(panel.$('[data-tab="clientes"]'));
    panel.click('#clientes-acciones');
    await waitFor(() => panel.$('[data-new-conversation]'), 'el menú de clientes');
    panel.click('[data-new-conversation]');
    await waitFor(() => panel.$('#wa-start-phone'), 'el formulario de cliente nuevo');
    panel.setValue('#wa-start-phone', '8095558888');
    panel.setValue('#wa-start-name', 'Cliente Sin Red');
    panel.click('#wa-start-open');
    await waitFor(
      () => panel.$$('#list-clientes *').some((nodo) => nodo.textContent?.includes('Cliente Sin Red')) || panel.outbox().some((row) => row.kind === 'customer-start'),
      'el cliente guardado sin conexión',
    );
    expect((await panel.win.FulltechOffline.listQueue()).some(row=>row.path==='/api/admin/pos/customers'&&row.body.name==='Cliente Sin Red')).toBe(true);

    // Archivar un chat desde la lista (el «⋯» de la fila), sin conexión.
    panel.click(panel.$('[data-tab="whatsapp"]'));
    await waitFor(() => panel.$('[data-conv-more]'), 'la lista de conversaciones');
    panel.click('[data-conv-more]');
    await waitFor(() => panel.$('[data-conv-act="archive"]'), 'el menú de la conversación');
    panel.click('[data-conv-act="archive"]');
    await waitFor(() => panel.outbox().some((row) => row.kind === 'conv-archive'), 'el archivo en la cola');
  }, 30000);

  it('al volver la conexión, la cola se manda sola y el CRM queda al día', async () => {
    const panel = sinRed;
    const enCola = panel.outbox().length;
    expect(enCola).toBeGreaterThan(0);

    // Vuelve la red: el panel lo nota y sincroniza por detrás.
    panel.estado.offline = false;
    panel.win.dispatchEvent(new panel.win.Event('online'));

    await panel.win.FulltechOffline.synchronize();
    await waitFor(() => panel.outbox().length === 0, 'la cola vacía', 12000);
    const pending=await panel.win.FulltechOffline.listQueue();if(pending.length)throw new Error(JSON.stringify(pending.map(p=>({path:p.path,state:p.state,error:p.error}))));
    expect(pending).toHaveLength(0);
    await waitFor(() => panel.$('#outbox-banner').hidden, 'el aviso de pendientes fuera');

    // Y ahora de verdad, en el CRM: el pedido, su estado y el cliente.
    const datos = await api('/api/admin/data');
    const pedido = datos.body.items.find((row) => String(row.name).includes('Pedido Sin Red'));
    expect(pedido, 'el pedido registrado sin conexión llegó al CRM').toBeTruthy();
    expect(pedido.status).toBe('entregado');
    expect(datos.body.customers.some((row) => String(row.name ?? '').includes('Cliente Sin Red'))).toBe(true);

    // El chat archivado, archivado de verdad (la bandeja tiene su filtro).
    const archivados = await api('/api/admin/conversations?filter=archivados');
    expect((archivados.body.conversations ?? []).length).toBeGreaterThan(0);
  }, 30000);
});

/** Copia guardada por el primer panel (la que se lleva al arranque sin conexión). */
const capturado = { snapshot: '' };
/** El panel que quedó trabajando sin conexión. */
let sinRed = null;
