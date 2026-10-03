// @vitest-environment jsdom
/**
 * UAT DEL PANEL — MAPAS (servidor de verdad + Leaflet de mentira).
 *
 * Lo que pidió el negocio y se demuestra aquí:
 *   - la ubicación de un cliente se abre EN GRANDE DENTRO de la app (la hoja del
 *     mapa), sin abrir otra pestaña ni salir al navegador;
 *   - la ubicación se puede medir: «¿a qué distancia estoy?» con el GPS del
 *     teléfono y «medir distancia» tocando dos puntos del mapa;
 *   - hay una pantalla «Mapa de pedidos» con TODOS los pedidos y TODAS las
 *     ubicaciones guardadas, con filtros, que se refresca al entrar (y cada 15 s
 *     mientras está abierta, para que una ubicación recién llegada salga sola);
 *   - la factura de un pedido también abre su mapa aquí dentro;
 *   - y NADA de esto abre una pestaña nueva.
 *
 * El mapa real (Leaflet) se sustituye por un doble que apunta lo que el panel le
 * pide: así se comprueba QUÉ se dibuja (coordenadas, marcadores, líneas y
 * distancias) sin depender de la red ni de los tiles de OpenStreetMap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'uat-map-panel';
const APP_SECRET = 'uat-map-secret';
const PHONE_A = '18095550441';
const PHONE_B = '18095550442';
const ADMIN_DIR = path.join(process.cwd(), 'public', 'admin');

/** Coordenadas reales de RD (no son de ninguna persona). */
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' };
const L2 = { latitude: 18.4861, longitude: -69.9312, name: 'Trabajo', address: 'Av. Duarte 45, Santo Domingo' };
/** Un punto cercano a L1 (≈1,1 km) para medir distancias cortas. */
const CERCA = { latitude: 18.6257, longitude: -68.7071 };
/** Dónde está el operador según el GPS de mentira (a un paso de L1). */
const MIO = { latitude: 18.618, longitude: -68.71 };

let tmpDir;
let app;
let dom;
let cookie = '';
let fake;
let ordenId = '';
const ids = {};
const sentLocations = [];
const sentTemplates = [];

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
/** Cierra la hoja como lo hace una persona (el aspa o el fondo). */
const closeSheetForUat = () => {
  const boton = $('[data-close-sheet]');
  if (boton) click(boton);
};
/** Pulsa como un navegador: un botón deshabilitado NO hace nada. */
const click = (element) => {
  const target = typeof element === 'string' ? $(element) : element;
  if (!target) throw new Error(`no existe el elemento: ${element}`);
  if (target.disabled === true) return false;
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return true;
};

/**
 * LEAFLET DE MENTIRA.
 *
 * Devuelve lo mismo que Leaflet API a API (map/marker/polyline/circleMarker/
 * divIcon/latLngBounds) y guarda TODO lo que le piden: qué contenedores, qué
 * coordenadas y qué líneas. Los manejadores de eventos (clic y movimiento) se
 * pueden disparar desde la prueba para simular un dedo sobre el mapa.
 */
function createFakeLeaflet() {
  const calls = { maps: [], instances: [], markers: [], polylines: [], circles: [], fits: [], tiles: [], clicks: [] };
  const node = (extra = {}) => ({
    addTo() {
      return this;
    },
    remove() {},
    on() {
      return this;
    },
    bindPopup() {
      return this;
    },
    setPopupContent() {
      return this;
    },
    setLatLng() {
      return this;
    },
    openPopup() {
      return this;
    },
    ...extra,
  });
  const L = {
    map(container, options) {
      const handlers = {};
      const map = node({
        container,
        options,
        setView(center, zoom) {
          map.center = center;
          map.zoom = zoom;
          return map;
        },
        getContainer: () => container,
        getZoom: () => map.zoom ?? 12,
        getCenter: () => ({ lat: map.center?.[0] ?? 18.6, lng: map.center?.[1] ?? -68.7 }),
        fitBounds(bounds) {
          calls.fits.push(bounds?.points ?? []);
          return map;
        },
        invalidateSize() {},
        on(event, handler) {
          handlers[event] = handler;
          return map;
        },
        handlers,
      });
      calls.maps.push(container);
      calls.instances.push(map);
      return map;
    },
    tileLayer(url, options) {
      calls.tiles.push({ url, options });
      return node();
    },
    marker(coords, options) {
      calls.markers.push({ coords, options });
      return node();
    },
    polyline(coords, options) {
      calls.polylines.push({ coords, options });
      return node();
    },
    circleMarker(coords, options) {
      calls.circles.push({ coords, options });
      return node();
    },
    divIcon(options) {
      return { ...options, fake: true };
    },
    latLngBounds(points) {
      return { points, pad: () => ({ points }) };
    },
  };
  return { L, calls };
}

const whatsapp = {
  enabled: true,
  graphVersion: 'v21.0',
  phoneNumberId: 'PN-UAT-MAP',
  businessAccountId: 'WABA1',
  async sendText() {
    return { ok: true, status: 200, messageId: 'wamid.TXT1' };
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

let inboundSeq = 0;
/** Mensaje entrante firmado (el webhook de verdad del CRM). */
async function inbound(phone, name, id, node) {
  inboundSeq += 1;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name }, wa_id: phone }],
              messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000) + inboundSeq), ...node }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const locationNode = (coords) => ({
  type: 'location',
  location: { latitude: coords.latitude, longitude: coords.longitude, name: coords.name, address: coords.address },
});

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-uat-map-'));
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

  // Dos clientes con su ubicación compartida por WhatsApp (el camino real).
  await inbound(PHONE_A, 'Ana Mapa', 'wamid.MAP-A0', { type: 'text', text: { body: 'Hola, quiero 5' } });
  await inbound(PHONE_A, 'Ana Mapa', 'wamid.MAP-A1', locationNode(L1));
  await inbound(PHONE_B, 'Beto Mapa', 'wamid.MAP-B0', { type: 'text', text: { body: 'Buenas' } });
  await inbound(PHONE_B, 'Beto Mapa', 'wamid.MAP-B1', locationNode(L2));

  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const adminHeaders = { 'content-type': 'application/json', cookie };

  const data = await (await fetch(`${app.url}/api/admin/data`, { headers: { cookie } })).json();
  const clienteDe = (phone) =>
    data.customers.find((row) => String(row.phone_e164 ?? '').replace(/\D/g, '') === phone) ?? null;
  const conversacionDe = (phone) =>
    data.conversations.find((row) => String(row.customer?.phone_e164 ?? '').replace(/\D/g, '') === phone) ?? null;
  ids.ana = clienteDe(PHONE_A).id;
  ids.beto = clienteDe(PHONE_B).id;
  ids.convAna = conversacionDe(PHONE_A).id;
  ids.convBeto = conversacionDe(PHONE_B).id;

  // Un pedido de Ana que se entrega en LA MISMA ubicación que compartió.
  const ubicaciones = await (
    await fetch(`${app.url}/api/admin/customers/${ids.ana}/locations`, { headers: { cookie } })
  ).json();
  const pedido = await fetch(`${app.url}/api/admin/orders`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      customerId: ids.ana,
      conversationId: ids.convAna,
      variantId: 'capsules_10',
      quantity: 2,
      paymentMethod: 'CASH',
      status: 'confirmado',
      deliveryLocation: ubicaciones.locations[0].id,
      confirmed: true,
    }),
  });
  const pedidoBody = await pedido.json();
  ordenId = pedidoBody.item?.id ?? pedidoBody.order?.id ?? '';

  dom = new JSDOM(readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8'), {
    url: `${app.url}/admin/`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.alert = () => {};
  win.open = () => {
    win.__abrioPestana = true;
    return null;
  };
  win.navigator.geolocation = {
    getCurrentPosition(success) {
      success({ coords: { latitude: MIO.latitude, longitude: MIO.longitude, accuracy: 12 } });
    },
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
  fake = createFakeLeaflet();
  win.L = fake.L;

  win.eval(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'));
  await waitFor(() => $('[data-conv]'), 'la lista de conversaciones');
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Abre el chat de Ana y espera al hilo con la ubicación. */
async function abrirChatAna() {
  click('.drawer__item[data-tab="whatsapp"]');
  const fila = await waitFor(() => $(`[data-conv="${ids.convAna}"]`), 'la fila de Ana');
  click(fila);
  await waitFor(() => $('#wa-chat-name')?.textContent.includes('Ana'), 'el chat de Ana');
  return waitFor(() => $$('#thread .loc').length > 0, 'la ubicación en el hilo');
}

describe('el mapa se abre DENTRO de la app', () => {
  it('la hoja de ubicación lleva a LA pantalla del mapa (sin pestaña nueva)', async () => {
    await abrirChatAna();
    const chip = $$('#thread .loc').find((node) => node.textContent.includes('Casa'));
    click(chip.querySelector('[data-loc-menu]'));
    await waitFor(() => $('#loc-map'), 'la hoja de la ubicación');

    // La opción principal es el mapa de la app: el enlace externo queda detrás.
    expect($('#sheet-body').textContent).toContain('Ver el mapa');
    expect($('#sheet-body').textContent).toContain('Abrir en Google Maps');

    const mapasAntes = fake.calls.maps.length;
    const marcadoresAntes = fake.calls.markers.length;
    click('#loc-map');

    // UNA pantalla de mapa: el punto queda centrado y con su ficha encima.
    await waitFor(() => !$('#view-mapa').hidden && $('#orders-map'), 'la pantalla del mapa');
    const marcador = await waitFor(() => {
      const creados = fake.calls.markers.slice(marcadoresAntes);
      return creados.find((m) => Math.abs(m.coords[0] - L1.latitude) < 0.001) ?? null;
    }, 'el marcador de la ubicación');

    expect(dom.window.__abrioPestana).toBeUndefined();
    // Un solo mapa en toda la app: el contenedor es siempre el mismo.
    expect(fake.calls.maps.map((el) => el.id ?? '')).toEqual(
      fake.calls.maps.map(() => 'orders-map'),
    );
    expect(fake.calls.maps.length).toBeGreaterThanOrEqual(mapasAntes);
    expect(marcador.coords[0]).toBeCloseTo(L1.latitude, 4);
    expect(marcador.coords[1]).toBeCloseTo(L1.longitude, 4);
    expect(fake.calls.tiles.at(-1).url).toContain('tile.openstreetmap.org');
    // La ficha del punto, con la medición desde el GPS a un toque.
    expect($('#sheet-title').textContent).toBe('Ubicación');
    expect($('#sheet-body').textContent).toContain('El mapa está centrado en este punto');
    expect($('#sheet-body').textContent).toContain('¿A qué distancia estoy?');
  }, 30000);

  it('«¿A qué distancia estoy?» fija el GPS y deja las distancias en la lista', async () => {
    const boton = await waitFor(() => $('#sheet-body [data-map-action="aqui"]'), 'el botón de medir desde el GPS');
    const marcadoresAntes = fake.calls.markers.length;
    click(boton);

    // Mi punto de referencia se dibuja en el mapa, en las coordenadas del GPS.
    const yo = await waitFor(() => {
      const creados = fake.calls.markers.slice(marcadoresAntes);
      return creados.find((m) => String(m.options?.icon?.className ?? '').includes('--me')) ?? null;
    }, 'el marcador de mi ubicación');
    expect(yo.coords[0]).toBeCloseTo(MIO.latitude, 4);
    expect(yo.coords[1]).toBeCloseTo(MIO.longitude, 4);

    // Y la lista dice A CUÁNTO está la Casa de Ana: unos 400 m (no un decimal crudo).
    const fila = await waitFor(() => {
      const items = $$('#mapa-lista .map-item');
      return items.find((item) => item.textContent.includes('Ana Mapa') && /\d{3} m/.test(item.textContent)) ?? null;
    }, 'la distancia medida en la lista');
    expect(fila).toBeTruthy();
    expect($('#mapa-estado').textContent).toContain('distancias desde tu punto');
    // La hoja se cierra sola: el mapa se queda a la vista, con su lista debajo.
    expect($('#sheet').hidden).toBe(true);
  }, 30000);

  it('la factura del pedido abre su ubicación en el mapa de la app', async () => {
    closeSheetForUat();
    click('.drawer__item[data-tab="pedidos"]');
    const boton = await waitFor(() => $(`[data-receipt="${ordenId}"]`), 'la factura del pedido');
    click(boton);
    // El botón de la ubicación de entrega de la factura (hay más ubicaciones en la
    // hoja: se elige el de la fila del pedido, que es el que se está probando).
    const abrir = await waitFor(() => $('#sheet-body .loc-row [data-open-map]'), 'el mapa del pedido en la factura');
    expect(abrir.textContent).toContain('Ver en el mapa');
    const antes = fake.calls.maps.length;
    click(abrir);
    await waitFor(() => !$('#view-mapa').hidden && $('#orders-map'), 'la pantalla del mapa del pedido');
    expect(fake.calls.maps.length).toBe(antes + 1);
    expect(fake.calls.maps.at(-1).id).toBe('orders-map');
    expect($('#sheet-title').textContent).toContain('Ubicación del pedido');
  }, 30000);
});

describe('pantalla «Mapa de pedidos»', () => {
  it('enseña todos los puntos (pedidos y ubicaciones) con filtros', async () => {
    closeSheetForUat();
    click('.drawer__item[data-tab="mapa"]');
    /*
     * La pantalla pinta AL INSTANTE lo que ya sabe (el pedido está en los datos
     * del panel) y completa cuando llegan las ubicaciones guardadas: se espera a
     * que termine la carga, no al primer pintado.
     */
    const filas = await waitFor(() => {
      const lista = $$('#mapa-lista .map-item');
      return lista.length >= 2 && !$('#mapa-estado').textContent.includes('actualizando') ? lista : null;
    }, 'la lista del mapa de pedidos');

    // El pedido de Ana (con su ubicación de entrega) y la ubicación de Beto. La
    // ubicación de Ana NO se repite: el pedido ya la representa.
    const textos = filas.map((fila) => fila.textContent).join(' | ');
    expect(textos).toContain('Ana Mapa');
    expect(textos).toContain('Beto Mapa');
    expect(filas.filter((fila) => fila.textContent.includes('Ana Mapa'))).toHaveLength(1);
    expect($('#mapa-estado').textContent).toContain('1 pedido');
    expect($('#mapa-estado').textContent).toContain('1 ubicación');
    // Y el mapa tiene un marcador por punto, dibujado aquí dentro.
    expect(fake.calls.markers.length).toBeGreaterThanOrEqual(2);
    expect(dom.window.__abrioPestana).toBeUndefined();

    // Filtro «Pedidos»: solo lo que hay que entregar.
    click('[data-map-filter="pedidos"]');
    await waitFor(() => {
      const items = $$('#mapa-lista .map-item');
      return items.length === 1 && items[0].classList.contains('map-item--order') ? items : null;
    }, 'el filtro de pedidos');
    expect($$('#mapa-lista .map-item')).toHaveLength(1);
    expect($$('#mapa-lista .map-item')[0].textContent).toContain('Ana Mapa');

    // Filtro «Ubicaciones»: solo los puntos que mandaron los clientes.
    click('[data-map-filter="ubicaciones"]');
    const soloUbicaciones = await waitFor(() => {
      const items = $$('#mapa-lista .map-item');
      return items.length === 1 && !items[0].classList.contains('map-item--order') ? items : null;
    }, 'el filtro de ubicaciones');
    expect(soloUbicaciones[0].textContent).toContain('Ubicación del cliente');

    // «De hoy»: los dos puntos son de hoy (recién llegados).
    click('[data-map-filter="hoy"]');
    await waitFor(() => $$('#mapa-lista .map-item').length >= 1, 'el filtro de hoy');
    // Y «Ver todo» encuadra los puntos visibles (ahora vive en el botón flotante).
    const encuadresAntes = fake.calls.fits.length;
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="ajustar"]'), 'la acción de encuadrar'));
    expect(fake.calls.fits.length).toBeGreaterThan(encuadresAntes);
    click('[data-map-filter="todo"]');
  }, 30000);

  it('mide la distancia entre dos puntos que se tocan en el mapa', async () => {
    // Medir es una acción del botón flotante, no una barra de botones fija.
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de medir'));
    expect($('#mapa-acciones').getAttribute('aria-pressed')).toBe('true');
    expect($('#orders-map-notice').textContent).toContain('Toca dos puntos');

    /*
     * Los dos toques los hace la prueba con el manejador que el panel registró en
     * el mapa (`map.on('click', …)`), que es lo mismo que un dedo sobre la pantalla.
     */
    const mapa = fake.calls.instances.find((inst) => inst.container?.id === 'orders-map' && inst.handlers?.click);
    expect(mapa).toBeTruthy();
    mapa.handlers.click({ latlng: { lat: L1.latitude, lng: L1.longitude } });
    expect($('#orders-map-notice').textContent).toContain('segundo punto');
    mapa.handlers.click({ latlng: { lat: CERCA.latitude, lng: CERCA.longitude } });

    const aviso = await waitFor(
      () => (/Distancia: [\d.,]+ (m|km)/.test($('#orders-map-notice').textContent) ? $('#orders-map-notice') : null),
      'la distancia medida en el mapa',
    );
    // L1 y CERCA están a ~1,11 km en línea recta (0.01° de latitud).
    expect(aviso.textContent).toMatch(/Distancia: 1,1 km en línea recta/);
    expect(fake.calls.polylines.length).toBeGreaterThan(0);
    const linea = fake.calls.polylines.at(-1);
    expect(linea.coords[0][0]).toBeCloseTo(L1.latitude, 4);
    expect(linea.coords[1][0]).toBeCloseTo(CERCA.latitude, 4);
    // Se apaga desde el mismo botón flotante.
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de terminar de medir'));
    expect($('#mapa-acciones').getAttribute('aria-pressed')).toBe('false');
  }, 30000);

  it('con «Mi ubicación» las distancias salen ordenadas de la más cercana', async () => {
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="aqui"]'), 'la acción de mi ubicación'));
    const lista = await waitFor(() => {
      const items = $$('#mapa-lista .map-item');
      return items.length && items.every((fila) => /·\s*[\d.,]+ (m|km)/.test(fila.textContent)) ? items : null;
    }, 'las distancias en la lista');
    expect($('#mapa-estado').textContent).toContain('distancias desde tu punto');
    // Ana (Casa, junto al GPS de mentira) va antes que Beto (Santo Domingo).
    expect(lista[0].textContent).toContain('Ana Mapa');
    expect(lista.at(-1).textContent).toContain('Beto Mapa');
    expect(lista[0].textContent).toMatch(/[\d.,]+ m/);
    expect(lista.at(-1).textContent).toMatch(/\d+ km/);
  }, 30000);
});
