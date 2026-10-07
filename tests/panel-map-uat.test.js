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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
/**
 * Zonas REALES auditadas el 2026-10-02, con el peso del tile de nivel 19 que
 * devuelve Esri en cada una (el relleno de "sin imagen" pesa 2.521 B, idéntico en
 * todo el país, y la foto real más pequeña encontrada en RD pesa 5.462 B).
 */
const ZONAS_AUDITADAS = {
  higuey: { lat: 18.6157, lng: -68.7071, bytesZ19: 2521, nativo: 18 },
  veron: { lat: 18.6244, lng: -68.4344, bytesZ19: 7394, nativo: 19 },
  bavaro: { lat: 18.6857, lng: -68.4526, bytesZ19: 10195, nativo: 19 },
  puntaCana: { lat: 18.5820, lng: -68.4050, bytesZ19: 5462, nativo: 19 },
  santoDomingo: { lat: 18.4861, lng: -69.9312, bytesZ19: 18684, nativo: 19 },
};
/** El umbral que usa el panel para decir "este tile es imagen de verdad". */
const MINIMO_REAL = Number(
  /const MAP_MIN_REAL_TILE_BYTES = (\d+)/.exec(readFileSync(path.join(ADMIN_DIR, 'app.js'), 'utf8'))?.[1] ?? 0,
);

let tmpDir;
let app;
let dom;
let cookie = '';
let fake;
let ordenId = '';
/*
 * Peso que se le da al tile del nivel 19 en las pruebas: por defecto 2.521 B, que
 * es el relleno de "aquí no hay imagen" (el caso de Higüey). Poniéndolo en 12.000
 * se simula una zona CON imagen real en el nivel 19 (el caso de Bávaro).
 */
let tileZ19Bytes = 2521;
const tileRequests = [];
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
  const node = (extra = {}) => {
    /*
     * Cada nodo (capa, marcador, línea) guarda sus manejadores y se pueden
     * DISPARAR desde la prueba con `fire()`. Hace falta de verdad: la distancia
     * medida se borraba cuando la capa de teselas avisaba de que estaba cargando.
     */
    const listeners = {};
    return {
      addTo() {
        return this;
      },
      remove() {},
      on(event, handler) {
        for (const nombre of String(event).split(' ')) (listeners[nombre] ??= []).push(handler);
        return this;
      },
      fire(nombre, evento = {}) {
        return (listeners[nombre] ?? []).map((fn) => fn(evento));
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
      listeners,
      ...extra,
    };
  };
  const L = {
    map(container, options) {
      const handlers = {};
      /*
       * Leaflet admite VARIOS manejadores por evento ('moveend' lo usan la vista
       * guardada y la comprobación del techo de imagen). El doble guarda el
       * último en `handlers` (para las pruebas antiguas) y TODOS en `listeners`,
       * que es lo que dispara `fire()`.
       */
      const listeners = {};
      const map = node({
        container,
        options,
        setView(center, zoom) {
          map.center = center;
          map.zoom = zoom;
          return map;
        },
        getContainer: () => container,
        /*
         * Como el Leaflet de verdad: sin vista fijada, preguntar por el centro o el
         * zoom LANZA («Set map center and zoom first»). Si el doble fuera benévolo,
         * un error real de orden al montar el mapa pasaría desapercibido.
         */
        getZoom() {
          if (map.zoom === undefined) throw new Error('Set map center and zoom first.');
          return map.zoom;
        },
        getCenter() {
          if (map.center === undefined) throw new Error('Set map center and zoom first.');
          return { lat: map.center[0], lng: map.center[1] };
        },
        fitBounds(bounds) {
          calls.fits.push(bounds?.points ?? []);
          return map;
        },
        invalidateSize() {},
        on(event, handler) {
          handlers[event] = handler;
          for (const nombre of String(event).split(' ')) (listeners[nombre] ??= []).push(handler);
          return map;
        },
        fire(nombre, evento = {}) {
          return (listeners[nombre] ?? []).map((fn) => fn(evento));
        },
        handlers,
        listeners,
      });
      calls.maps.push(container);
      calls.instances.push(map);
      return map;
    },
    tileLayer(url, options) {
      const layer = node();
      // La capa se guarda TAMBIÉN en el registro: así la prueba puede disparar
      // 'loading'/'load' como hace el navegador de verdad.
      calls.tiles.push({ url, options, layer });
      return layer;
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
    /*
     * Los tiles del mapa NO salen a la red en las pruebas: se simula el PESO del
     * archivo, que es lo que distingue la foto real del relleno de "sin imagen".
     * (Medido de verdad: el relleno de Esri pesa 2.521 B en todo el país; la foto
     * real más pequeña que existe en RD pesa 5.462 B.)
     */
    if (/\/tile\/\d+\/\d+\/\d+$/.test(url)) {
      const z = Number(url.match(/\/tile\/(\d+)\//)?.[1] ?? 0);
      const bytes = z >= 19 ? tileZ19Bytes : 20000;
      tileRequests.push({ url, z, bytes });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(bytes),
        blob: async () => ({ size: bytes }),
        text: async () => '',
      };
    }
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

/** El mapa real que montó el panel (el último que se creó sobre su contenedor). */
const mapaUat = () => fake.calls.instances.filter((inst) => inst.container?.id === 'orders-map').at(-1);

/** La capa de imagen que está puesta ahora mismo. */
const capaSatelite = () => fake.calls.tiles.filter((capa) => capa.url.includes('World_Imagery')).at(-1);

/** Limpia lo que el panel recuerda de zonas anteriores: cada prueba parte de cero. */
function olvidarZonas() {
  dom.window.localStorage.removeItem('pe_map_native_zoom');
}

/**
 * Apaga el modo «medir» si quedó encendido. El aviso del mapa es UNO y tiene
 * prioridad (medición > ampliado > teselas): para leer el aviso del zoom hay que
 * estar midiendo, no. Deja la prueba independiente de las anteriores.
 */
function dejarDeMedir() {
  if ($('#mapa-acciones')?.getAttribute('aria-pressed') !== 'true') return;
  click('#mapa-acciones');
  const boton = $('[data-map-action="medir"]');
  if (boton) click(boton);
}

/**
 * Coloca el mapa en una zona (como si el operador la mirara) y espera a que el
 * panel compruebe el techo de imagen de esa zona (deja 600 ms de respiro antes).
 */
async function irAZona(zona, zoom = 18) {
  dejarDeMedir();
  const mapa = mapaUat();
  mapa.setView([zona.lat, zona.lng], zoom);
  mapa.fire('moveend');
  await sleep(1000);
}

/** Abre la pantalla del mapa desde el menú lateral. */
async function abrirMapa() {
  click('.drawer__item[data-tab="mapa"]');
  await waitFor(() => $('#orders-map') && mapaUat(), 'el mapa');
}

/** Abre el chat de Ana y espera al hilo con la ubicación. */
async function abrirChatAna() {
  click('.tabs [data-tab="whatsapp"]');
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
    // Esta acción debe abrir el mapa principal de pedidos; delivery tiene su
    // propio mapa de detalle y no debe confundirse con este flujo.
    expect(fake.calls.maps.slice(mapasAntes).map((el) => el.id ?? '')).toEqual(
      fake.calls.maps.slice(mapasAntes).map(() => 'orders-map'),
    );
    expect(fake.calls.maps.length).toBeGreaterThanOrEqual(mapasAntes);
    expect(marcador.coords[0]).toBeCloseTo(L1.latitude, 4);
    expect(marcador.coords[1]).toBeCloseTo(L1.longitude, 4);
    // La capa base es la imagen de satélite (lo que pide el negocio: ver la tierra)
    // y encima van las calles y los nombres.
    const capas = fake.calls.tiles.map((capa) => capa.url);
    expect(capas.some((url) => url.includes('World_Imagery'))).toBe(true);
    expect(capas.some((url) => url.includes('World_Transportation'))).toBe(true);
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
    click('.tabs [data-tab="pedidos"]');
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
    const verPedido = await waitFor(() => $('#sheet-body [data-map-order]'), 'volver al pedido desde el mapa');
    expect(verPedido.textContent).toContain('Ver pedido');
    click(verPedido);
    await waitFor(() => $('#sheet-title')?.textContent?.includes('Factura'), 'la factura desde el mapa');
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
      () => (/Distancia [\d.,]+ (m|km) en línea recta/.test($('#orders-map-notice').textContent) ? $('#orders-map-notice') : null),
      'la distancia medida en el mapa',
    );
    // L1 y CERCA están a ~1,11 km en línea recta (0.01° de latitud).
    expect(aviso.textContent).toMatch(/Distancia 1,1 km en línea recta/);
    // Además de la distancia, el TIEMPO estimado con la velocidad a la vista
    // (1,1 km a 25 km/h ≈ 3 min). Se dice de dónde sale el número, no se promete.
    expect(aviso.textContent).toMatch(/unos 3 min a 25 km\/h/);
    expect(fake.calls.polylines.length).toBeGreaterThan(0);
    const linea = fake.calls.polylines.at(-1);
    expect(linea.coords[0][0]).toBeCloseTo(L1.latitude, 4);
    expect(linea.coords[1][0]).toBeCloseTo(CERCA.latitude, 4);
    // Se apaga desde el mismo botón flotante.
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de terminar de medir'));
    expect($('#mapa-acciones').getAttribute('aria-pressed')).toBe('false');
  }, 30000);

  it('la distancia medida NO se borra cuando el mapa carga teselas (fallo real)', async () => {
    /*
     * Lo que pasaba: se tocaban los dos puntos, la distancia se calculaba… y la
     * capa de satélite avisaba de que estaba cargando TESELAS, que escribe en el
     * mismo aviso. El número desaparecía y parecía que «medir» no medía nada.
     */
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de medir'));
    const mapa = mapaUat();
    mapa.handlers.click({ latlng: { lat: L1.latitude, lng: L1.longitude } });
    mapa.handlers.click({ latlng: { lat: CERCA.latitude, lng: CERCA.longitude } });
    expect($('#orders-map-notice').textContent).toMatch(/Distancia 1,1 km/);

    const capa = capaSatelite();
    capa.layer.fire('loading');
    expect($('#orders-map-notice').textContent).toMatch(/Distancia 1,1 km/);
    capa.layer.fire('load');
    expect($('#orders-map-notice').textContent).toMatch(/Distancia 1,1 km/);

    // Y al terminar de medir, el aviso vuelve a ser el del mapa (aquí, sin ampliar).
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de terminar de medir'));
    expect($('#orders-map-notice').textContent).not.toMatch(/Distancia/);
  }, 30000);

  it('también se mide DESDE un punto conocido (el pin no deja pasar el toque)', async () => {
    /*
     * El gesto que de verdad se usa es «¿a cuánto está este cliente?». Tocar el pin
     * para medir NO siempre cuenta como toque del mapa (Leaflet no deja pasar el
     * clic del marcador), así que el punto trae su propia acción: se abre el punto
     * desde la lista, como cuando se abre su globo, y se mide desde él.
     */
    const fila = await waitFor(() => $('#mapa-lista [data-map-open]'), 'un punto de la lista');
    click(fila);
    const boton = await waitFor(() => $('#map-point-measure'), 'la acción de medir desde el punto');
    click(boton);

    // El punto entra en la medición y el mapa pide el segundo.
    expect($('#mapa-acciones').getAttribute('aria-pressed')).toBe('true');
    expect($('#orders-map-notice').textContent).toContain('segundo punto');

    // El segundo toque, sobre el mapa: distancia y tiempo estimado.
    const mapa = mapaUat();
    mapa.handlers.click({ latlng: { lat: L1.latitude + 0.02, lng: L1.longitude } });
    const aviso = await waitFor(
      () =>
        /Distancia [\d.,]+ km en línea recta/.test($('#orders-map-notice').textContent)
          ? $('#orders-map-notice')
          : null,
      'la distancia medida desde el punto',
    );
    expect(aviso.textContent).toMatch(/unos (?:\d+ min|\d+ h(?: \d+ min)?) a 25 km\/h/);
    dejarDeMedir();
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

  it('deja elegir cómo se ve el terreno: satélite (foto real) o mapa de calles', async () => {
    click('#mapa-acciones');
    const satelite = await waitFor(() => $('[data-map-base="satelite"]'), 'la opción de satélite');
    // Por defecto: imagen real del terreno, que es lo que se pidió para ver las casas.
    expect(satelite.getAttribute('aria-pressed')).toBe('true');
    expect(satelite.textContent).toContain('Satélite');
    expect(fake.calls.tiles.some((capa) => capa.url.includes('World_Imagery'))).toBe(true);
    // Las calles y los nombres van encima de la foto y se pueden apagar.
    expect($('[data-map-layer="labels"]')).toBeTruthy();

    // Cambiar al mapa dibujado: se cambia la capa SIN rehacer el mapa.
    const mapasAntes = fake.calls.maps.length;
    const capasAntes = fake.calls.tiles.length;
    click($('[data-map-base="calles"]'));
    await waitFor(() => fake.calls.tiles.length > capasAntes, 'la capa de calles');
    expect(fake.calls.tiles.at(-1).url).toContain('tile.openstreetmap.org');
    expect(fake.calls.maps.length).toBe(mapasAntes);
    expect(dom.window.localStorage.getItem('pe_orders_map_base')).toBe('calles');
    expect($('[data-map-base="calles"]').getAttribute('aria-pressed')).toBe('true');
    expect($('#mapa-estado').textContent).toContain('mapa (calles)');

    // Y volver al satélite, que es lo que se recuerda para la próxima vez.
    click($('[data-map-base="satelite"]'));
    await waitFor(() => dom.window.localStorage.getItem('pe_orders_map_base') === 'satelite', 'volver al satélite');
    // La foto primero y las calles y nombres encima (ese es el orden de las capas).
    const ultimas = fake.calls.tiles.slice(-2).map((capa) => capa.url);
    expect(ultimas[0]).toContain('World_Imagery');
    expect(ultimas[1]).toContain('World_Transportation');
    expect(fake.calls.maps.length).toBe(mapasAntes);

    // Y se puede apagar: la foto se queda sola (y el gusto se recuerda).
    click($('[data-map-layer="labels"]'));
    await waitFor(() => dom.window.localStorage.getItem('pe_orders_map_labels') === '0', 'apagar las etiquetas');
    await waitFor(() => $('[data-map-layer="labels"]')?.textContent.includes('Poner calles'), 'la fila al revés');
    click($('[data-map-layer="labels"]'));
    await waitFor(() => dom.window.localStorage.getItem('pe_orders_map_labels') === '1', 'volver a encenderlas');
  }, 30000);
});

/**
 * TECHO DE IMAGEN REAL, ZONA POR ZONA.
 *
 * Esri sirve el nivel 19 en unas zonas y en otras no, y donde no lo tiene devuelve
 * un PNG gris de 2.521 B con HTTP 200 (no da error: Leaflet no se enteraría y el
 * mapa saldría gris). Estas pruebas fijan el comportamiento con los pesos REALES
 * medidos en la auditoría del 2026-10-02, y comprueban que nunca se toma un tile
 * de relleno (ni una simple ampliación) por resolución real.
 */
describe('techo de imagen real por zona', () => {
  beforeEach(() => {
    // El registro de peticiones de tiles es de la prueba que empieza, no de antes.
    tileRequests.length = 0;
  });

  it('el umbral de «imagen real» está por encima del relleno y por debajo de la foto más pequeña', () => {
    // Medido: el relleno de Esri pesa 2.521 B (el mismo archivo en todo el país y
    // también en z20) y la foto real más pequeña encontrada en RD pesa 5.462 B.
    expect(MINIMO_REAL).toBeGreaterThan(2521);
    expect(MINIMO_REAL).toBeLessThan(5462);
    // Y el techo comprobable es el 19: el nivel 20 no existe en ninguna zona medida.
    expect(ZONAS_AUDITADAS.higuey.nativo).toBe(18);
    expect(ZONAS_AUDITADAS.bavaro.nativo).toBe(19);
  });

  it('Higüey: aquí la imagen real llega al nivel 18 y NO se finge el 19', async () => {
    tileZ19Bytes = ZONAS_AUDITADAS.higuey.bytesZ19; // el relleno medido en Higüey
    olvidarZonas();
    await abrirMapa();
    tileRequests.length = 0;

    await irAZona(ZONAS_AUDITADAS.higuey);

    // Se comprobó la zona pidiendo UN tile del 19, ni uno más.
    const pedidos = tileRequests.filter((t) => t.z === 19);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].bytes).toBe(2521);

    // Y el techo se queda donde toca: 18 (nada de z19 gris).
    expect(capaSatelite().options.maxNativeZoom).toBe(18);
    expect($('#mapa-estado').textContent).toContain('imagen z18');

    // Acercarse más se puede, pero se DICE que ya no hay más detalle real.
    mapaUat().setView([ZONAS_AUDITADAS.higuey.lat, ZONAS_AUDITADAS.higuey.lng], 20);
    mapaUat().fire('zoomend');
    expect($('#orders-map-notice').hidden).toBe(false);
    expect($('#orders-map-notice').textContent).toContain('ampliado');
    expect($('#orders-map-notice').textContent).toContain('nivel 18');
    expect($('#orders-map-notice').textContent).toContain('no gana detalle');
    // Y la capa sigue sin pedir el nivel 20 (que no existe): máximo 18 nativo.
    expect(capaSatelite().options.maxNativeZoom).toBe(18);
  }, 30000);

  it('Bávaro y Santo Domingo: donde SÍ hay nivel 19 real, el mapa lo aprovecha solo', async () => {
    for (const zona of [ZONAS_AUDITADAS.bavaro, ZONAS_AUDITADAS.santoDomingo]) {
      tileZ19Bytes = zona.bytesZ19; // el peso real medido en esa zona
      olvidarZonas();
      await irAZona(zona);

      expect(capaSatelite().options.maxNativeZoom).toBe(19);
      expect(capaSatelite().options.maxZoom).toBe(22);
      expect(capaSatelite().options.maxZoom).toBeGreaterThan(19);
      expect($('#mapa-estado').textContent).toContain('imagen z19');

      // En z19 no hay aviso: es detalle de verdad, no ampliación.
      mapaUat().setView([zona.lat, zona.lng], 19);
      mapaUat().fire('zoomend');
      expect($('#orders-map-notice').hidden).toBe(true);
      expect($('#orders-map-notice').textContent).not.toContain('ampliado');

      // En z20 sí se avisa (el 20 no existe en RD): ahí ya se amplía.
      mapaUat().setView([zona.lat, zona.lng], 20);
      mapaUat().fire('zoomend');
      expect($('#orders-map-notice').textContent).toContain('nivel 19');
    }
  }, 30000);

  it('en una zona SIN comprobar no se hereda el techo de la anterior (nada de gris)', async () => {
    // Bávaro: comprobado con 19 real (y el mapa queda con ese techo puesto).
    tileZ19Bytes = ZONAS_AUDITADAS.bavaro.bytesZ19;
    olvidarZonas();
    await irAZona(ZONAS_AUDITADAS.bavaro);
    expect(capaSatelite().options.maxNativeZoom).toBe(19);

    // Zona nueva sin comprobar: mientras no se sepa, el techo es el SEGURO (18), que
    // tiene imagen real en todo el país. Heredar el 19 de la zona anterior haría que
    // el mapa pidiera tiles del 19 donde no hay: el mosaico gris que se veía.
    olvidarZonas();
    mapaUat().setView([ZONAS_AUDITADAS.veron.lat, ZONAS_AUDITADAS.veron.lng], 19);
    mapaUat().fire('zoomend');
    expect($('#orders-map-notice').textContent).toContain('nivel 18');
    expect($('#orders-map-notice').textContent).not.toContain('nivel 19');
    expect(capaSatelite().options.maxNativeZoom).toBe(18);

    // Y cuando la comprobación responde (Verón sí tiene 19), sube sola.
    await sleep(1400);
    expect(capaSatelite().options.maxNativeZoom).toBe(19);
    expect($('#orders-map-notice').hidden).toBe(true);
  }, 30000);

  it('Verón (foto real pequeña, 7,4 KB) sube a z19; 3 KB de duda se quedan en z18', async () => {
    // Verón tiene imagen real de nivel 19 y es la más pequeña medida: entra por poco.
    tileZ19Bytes = ZONAS_AUDITADAS.veron.bytesZ19;
    olvidarZonas();
    await irAZona(ZONAS_AUDITADAS.veron);
    expect(capaSatelite().options.maxNativeZoom).toBe(19);

    // Ante la duda (3 KB, entre el relleno y la foto) NO se sube el techo: prefiero
    // ver la imagen buena del 18 que un mosaico gris.
    tileZ19Bytes = 3000;
    olvidarZonas();
    await irAZona(ZONAS_AUDITADAS.puntaCana);
    expect(capaSatelite().options.maxNativeZoom).toBe(18);
    expect($('#mapa-estado').textContent).toContain('imagen z18');
  }, 30000);

  it('no vuelve a comprobar la misma zona ni pide nunca el nivel 20', async () => {    tileZ19Bytes = ZONAS_AUDITADAS.higuey.bytesZ19;
    olvidarZonas();
    await irAZona(ZONAS_AUDITADAS.higuey);
    expect(tileRequests.filter((t) => t.z === 19)).toHaveLength(1);

    // La segunda vez ya está recordada: ni un tile más.
    tileRequests.length = 0;
    await irAZona(ZONAS_AUDITADAS.higuey);
    expect(tileRequests).toHaveLength(0);
    // Y en ningún momento se pide el 20 (no existe en RD).
    expect(tileRequests.filter((t) => t.z >= 20)).toHaveLength(0);
    // La zona queda RECORDADA como lo que se midió (18), nunca como 19.
    const guardado = JSON.parse(dom.window.localStorage.getItem('pe_map_native_zoom') ?? '{}');
    const niveles = Object.values(guardado).map((entrada) => entrada.z);
    expect(niveles).toContain(18);
    expect(niveles).not.toContain(19);
  }, 30000);

  it('cambiar de zoom o medir no altera el techo ni rompe nada del mapa', async () => {
    tileZ19Bytes = ZONAS_AUDITADAS.bavaro.bytesZ19;
    olvidarZonas();
    await irAZona(ZONAS_AUDITADAS.bavaro);
    const marcadoresAntes = fake.calls.markers.length;
    const mapaAntes = fake.calls.maps.length;

    // Zoom, medir y volver a mirar: el mapa es el mismo y los pines siguen ahí.
    mapaUat().setView([ZONAS_AUDITADAS.bavaro.lat, ZONAS_AUDITADAS.bavaro.lng], 19);
    mapaUat().fire('zoomend');
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'la acción de medir'));
    mapaUat().fire('click', { latlng: { lat: ZONAS_AUDITADAS.bavaro.lat, lng: ZONAS_AUDITADAS.bavaro.lng } });
    click('#mapa-acciones');
    click(await waitFor(() => $('[data-map-action="medir"]'), 'terminar de medir'));

    expect(fake.calls.maps.length).toBe(mapaAntes);
    expect(fake.calls.markers.length).toBeGreaterThanOrEqual(marcadoresAntes);
    expect(capaSatelite().options.maxNativeZoom).toBe(19);
    expect($$('#mapa-lista .map-item').length).toBeGreaterThan(0);
  }, 30000);
});
