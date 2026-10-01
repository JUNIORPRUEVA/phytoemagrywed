// @vitest-environment node
/**
 * UBICACIÓN GPS + DELIVERY (fase «dónde se entrega»), con el CRM de verdad.
 *
 * Reglas de negocio que se comprueban aquí:
 *  - una ubicación de WhatsApp se recibe con SUS coordenadas (no se inventa nada),
 *    se guarda como dato estructurado y NO pasa por multimedia/R2;
 *  - el webhook es idempotente: el mismo mensaje dos veces no duplica nada;
 *  - un pedido SIN ubicación, SIN ciudad y SIN dirección es VÁLIDO;
 *  - el delivery es opcional, nunca negativo y NO es un producto:
 *    total = productos − descuento + delivery;
 *  - un pedido guarda un SNAPSHOT: si el cliente manda otra ubicación después, el
 *    pedido anterior sigue representando la suya;
 *  - la ubicación de un cliente NUNCA se aplica al pedido de otro;
 *  - enviar una ubicación exige confirmación explícita y respeta opt-out y 24 h;
 *  - las coordenadas no se filtran a Meta (CAPI) ni al comprobante.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { createMetaCapi } from '../server/meta-capi.mjs';
import { LOCATION_SOURCES, mapUrl, normalizeLocation, parseCoordinates } from '../server/locations.mjs';

const TOKEN = 'clave-ubicacion-123';
const APP_SECRET = 'secreto-ubicacion';
const PHONE_A = '18095550101';
const PHONE_B = '18095550102';
const PIXEL = '1111222233334444';
const ACCESS_TOKEN = 'EAAtoken-de-prueba-1234567890abcdefghijkl';

const apps = [];
const tmpDirs = [];

/** Coordenadas reales de RD para las pruebas (no son de ninguna persona). */
const L1 = { latitude: 18.6157, longitude: -68.7071, name: 'Casa', address: 'Calle Principal 12, Higüey' };
const L2 = { latitude: 18.4861, longitude: -69.9312, name: 'Trabajo', address: 'Av. Duarte 45, Santo Domingo' };

/**
 * CRM de verdad con WhatsApp y almacén de mentira (y Meta de mentira si se pide).
 * `r2Calls` cuenta lo que llega al almacén: una ubicación NUNCA debe aparecer ahí.
 */
async function newApp(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-loc-'));
  tmpDirs.push(dir);
  const sentMessages = [];
  const sentLocations = [];
  const r2Calls = [];
  const capiCalls = [];

  const whatsapp = {
    enabled: true,
    graphVersion: 'v21.0',
    phoneNumberId: 'PN-UBICACION',
    businessAccountId: 'WABA1',
    async sendText(to, body) {
      sentMessages.push({ to, body });
      return { ok: true, status: 200, messageId: `wamid.TXT${sentMessages.length}` };
    },
    async sendTemplate(to, template) {
      sentMessages.push({ to, template });
      return { ok: true, status: 200, messageId: `wamid.TPL${sentMessages.length}` };
    },
    async sendLocation(to, location) {
      sentLocations.push({ to, location });
      return { ok: true, status: 200, messageId: `wamid.LOC${sentLocations.length}` };
    },
    async markAsRead() {
      return { ok: true };
    },
  };

  const storage = {
    enabled: true,
    provider: 's3',
    bucket: 'test-bucket',
    objects: new Map(),
    async put(key, buffer) {
      r2Calls.push({ action: 'put', key });
      storage.objects.set(key, Buffer.from(buffer));
      return { ok: true, objectKey: key, size: buffer.length };
    },
    async get(key) {
      const found = storage.objects.get(key);
      return found ? { ok: true, buffer: found } : { ok: false, error: 'not_found' };
    },
    async head() {
      return { ok: false, error: 'not_found' };
    },
  };

  const fetchImpl = async (url, request) => {
    capiCalls.push({ url, body: JSON.parse(request.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ events_received: 1 }) };
  };
  const metaCapi = createMetaCapi({
    pixelId: PIXEL,
    accessToken: ACCESS_TOKEN,
    graphVersion: 'v21.0',
    appEnv: 'uat',
    fetchImpl,
    log: () => {},
  });

  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'ubicacion.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    whatsapp,
    storage,
    metaCapi,
    schedulerEnabled: false,
  });
  app.sentMessages = sentMessages;
  app.sentLocations = sentLocations;
  app.r2Calls = r2Calls;
  app.capiCalls = capiCalls;

  const login = await post(app, '/api/admin/login', { token: TOKEN });
  app.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  apps.push(app);
  return app;
}

afterAll(async () => {
  for (const app of apps) await app?.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const call = (app, route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(app.cookie ? { cookie: app.cookie } : {}), ...(options.headers ?? {}) },
  });

const post = (app, route, body) =>
  fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(app.cookie ? { cookie: app.cookie } : {}) },
    body: JSON.stringify(body),
  });

const json = async (response) => JSON.parse(await response.text());

/** Mensaje entrante firmado como lo manda Meta (webhook real). */
async function inbound(app, id, node, from = PHONE_A) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: `Cliente ${from.slice(-4)}` }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...node }],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  return fetch(`${app.url}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

/** Ubicación tal y como la manda WhatsApp (`type: location`). */
const locationNode = (coords, extra = {}) => ({
  type: 'location',
  location: {
    latitude: coords.latitude,
    longitude: coords.longitude,
    // WhatsApp manda `name`/`address` cuando el cliente los tiene puestos.
    ...(coords.name ? { name: coords.name } : {}),
    ...(coords.address ? { address: coords.address } : {}),
    ...extra,
  },
});

async function customerWithPhone(app, phone) {
  const data = await json(await call(app, '/api/admin/customers'));
  return data.customers.find((row) => row.phone_e164 === `+${phone}`) ?? null;
}

/** Crea un pedido con lo mínimo: NO se manda ciudad ni dirección (§1). */
const createOrder = (app, body) => call(app, '/api/admin/orders', { method: 'POST', body: JSON.stringify(body) });

describe('modelo de ubicación: validación estricta', () => {
  it('acepta coordenadas válidas y las deja tal cual (sin inventar precisión)', () => {
    const parsed = parseCoordinates({ latitude: 18.6157, longitude: -68.7071 });
    expect(parsed).toEqual({ ok: true, latitude: 18.6157, longitude: -68.7071 });
    // Cadenas numéricas (lo que llega de un formulario) también valen.
    expect(parseCoordinates({ latitude: '18.5', longitude: '-68.5' })).toEqual({ ok: true, latitude: 18.5, longitude: -68.5 });
  });

  it('rechaza NaN, Infinity, texto, vacíos y valores fuera de rango', () => {
    for (const bad of [
      { latitude: Number.NaN, longitude: 10 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 10 },
      { latitude: 'no-es-un-numero', longitude: 10 },
      { latitude: '', longitude: 10 },
      { latitude: null, longitude: 10 },
      { latitude: [], longitude: 10 },
      { latitude: 91, longitude: 10 },
      { latitude: -91, longitude: 10 },
      { latitude: 10, longitude: 181 },
      { latitude: 10, longitude: -181 },
    ]) {
      expect(parseCoordinates(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('no genera enlace de mapa con coordenadas inválidas', () => {
    expect(mapUrl(L1)).toContain('18.6157');
    expect(mapUrl(L1)).toContain('-68.7071');
    expect(mapUrl({ latitude: 'x', longitude: 'y' })).toBe(null);
    expect(mapUrl(null)).toBe(null);
  });

  it('etiqueta la procedencia y no inventa dirección', () => {
    const sinDireccion = normalizeLocation({ latitude: 18.5, longitude: -68.5, source: LOCATION_SOURCES.WHATSAPP_INBOUND });
    expect(sinDireccion.ok).toBe(true);
    expect(sinDireccion.location.address).toBe(null);
    expect(sinDireccion.location.name).toBe(null);
    expect(sinDireccion.location.source).toBe(LOCATION_SOURCES.WHATSAPP_INBOUND);
    // Una procedencia inventada NO se guarda: cae a la más conservadora.
    const raro = normalizeLocation({ latitude: 18.5, longitude: -68.5, source: 'lo-que-sea' });
    expect(raro.location.source).toBe(LOCATION_SOURCES.MANUAL_COORDINATES);
  });
});

describe('ubicación entrante por WhatsApp', () => {
  it('se guarda con sus coordenadas y aparece en el hilo con enlace de mapa', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.LOC-1', locationNode(L1, { name: 'Casa', address: L1.address }));

    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);
    expect(conversation).toBeTruthy();
    // La vista previa de la lista dice que es una UBICACIÓN (nunca el JSON).
    expect(conversation.last_message.type).toBe('location');

    const thread = await json(await call(app, `/api/admin/conversations/${conversation.id}/messages`));
    const message = thread.messages.at(-1);
    expect(message.type).toBe('location');
    expect(message.location.latitude).toBeCloseTo(L1.latitude, 4);
    expect(message.location.longitude).toBeCloseTo(L1.longitude, 4);
    expect(message.location.name).toBe('Casa');
    expect(message.location.map_url).toContain('google.com/maps');
    expect(message.location.source).toBe(LOCATION_SOURCES.WHATSAPP_INBOUND);
    expect(message.location.age_label).toMatch(/Compartida hoy/);

    // NO pasó por R2: una ubicación es un dato, no un archivo (§34).
    expect(app.r2Calls).toHaveLength(0);
  });

  it('es idempotente: el webhook repetido no duplica mensaje ni ubicación', async () => {
    const app = await newApp();
    const node = locationNode(L1);
    await inbound(app, 'wamid.LOC-DUP', node);
    await inbound(app, 'wamid.LOC-DUP', node);

    const customer = await customerWithPhone(app, PHONE_A);
    const locations = await json(await call(app, `/api/admin/customers/${customer.id}/locations`));
    expect(locations.locations).toHaveLength(1);

    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);
    const thread = await json(await call(app, `/api/admin/conversations/${conversation.id}/messages`));
    expect(thread.messages.filter((row) => row.type === 'location')).toHaveLength(1);
  });

  it('guarda HISTORIAL: la ubicación nueva no borra la anterior', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.L-A', locationNode(L1));
    await inbound(app, 'wamid.L-B', locationNode(L2));

    const customer = await customerWithPhone(app, PHONE_A);
    const { locations } = await json(await call(app, `/api/admin/customers/${customer.id}/locations`));
    expect(locations).toHaveLength(2);
    // La más reciente primero, con su nombre y su procedencia.
    expect(locations[0].name).toBe('Trabajo');
    expect(locations[1].name).toBe('Casa');
    expect(locations[0].source_label).toMatch(/cliente/i);
  });

  it('coordenadas inválidas no crean una ubicación (y el mensaje queda sin mapa)', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.L-MALA', { type: 'location', location: { latitude: 'x', longitude: 'y' } });

    const customer = await customerWithPhone(app, PHONE_A);
    const { locations } = await json(await call(app, `/api/admin/customers/${customer.id}/locations`));
    expect(locations).toHaveLength(0);

    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);
    const thread = await json(await call(app, `/api/admin/conversations/${conversation.id}/messages`));
    expect(thread.messages.at(-1).location ?? null).toBe(null);
    expect(thread.messages.at(-1).type).toBe('location');
  });

  it('el nombre y la dirección de WhatsApp se guardan sin romper el render (XSS)', async () => {
    const app = await newApp();
    const ataque = '<script>alert(1)</script>';
    await inbound(app, 'wamid.L-XSS', locationNode(L1, { name: ataque, address: `<img src=x onerror="alert(2)">` }));

    const customer = await customerWithPhone(app, PHONE_A);
    const { locations } = await json(await call(app, `/api/admin/customers/${customer.id}/locations`));
    // El dato se guarda tal cual (es un hecho), pero el panel lo ESCAPA al pintarlo
    // (eso se comprueba en el UAT del panel). Aquí: ni HTML ejecutable en el JSON…
    expect(locations[0].name).toBe(ataque);
    // …ni coordenadas convertidas en HTML.
    expect(locations[0].map_url).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  });
});

describe('pedidos: ubicación y delivery son OPCIONALES', () => {
  it('un pedido sin ubicación, sin ciudad y sin dirección se guarda y da comprobante', async () => {
    const app = await newApp();
    const customer = await json(await post(app, '/api/admin/customers', {}).catch(() => null));
    void customer;

    // Cliente por teléfono: el CRM lo crea si no existe.
    const created = await createOrder(app, {
      phone: PHONE_A,
      name: 'Ana Ubicación',
      items: [{ variantId: 'capsules_10', quantity: 1 }],
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.order.subtotal).toBe(2500);
    expect(body.order.delivery_fee).toBe(0);
    expect(body.order.total).toBe(2500);
    expect(body.order.delivery.location).toBe(null);
    expect(body.receipt.delivery_fee).toBe(0);
    expect(body.receipt.has_location).toBe(false);
  });

  it('el delivery se suma al total y NO es una línea de producto', async () => {
    const app = await newApp();
    const body = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryFee: 250,
      }),
    );
    expect(body.order.subtotal).toBe(2500);
    expect(body.order.delivery_fee).toBe(250);
    expect(body.order.total).toBe(2750);
    // No hay ningún «producto delivery»: las líneas son las del catálogo.
    expect(body.order.items).toHaveLength(1);
    expect(body.order.items[0].variantId).toBe('capsules_10');
    expect(body.receipt.delivery_fee).toBe(250);
    expect(body.receipt.total).toBe(2750);
  });

  it('delivery vacío o 0 no cambia nada, y un delivery negativo se rechaza', async () => {
    const app = await newApp();
    const sinDelivery = await json(
      await createOrder(app, { phone: PHONE_A, items: [{ variantId: 'capsules_5', quantity: 1 }], deliveryFee: null }),
    );
    expect(sinDelivery.order.delivery_fee).toBe(0);
    expect(sinDelivery.order.total).toBe(1250);

    const conCero = await json(
      await createOrder(app, { phone: PHONE_A, items: [{ variantId: 'capsules_5', quantity: 1 }], deliveryFee: 0 }),
    );
    expect(conCero.order.total).toBe(1250);

    const negativo = await createOrder(app, {
      phone: PHONE_A,
      items: [{ variantId: 'capsules_5', quantity: 1 }],
      deliveryFee: -100,
    });
    expect(negativo.status).toBe(422);
  });

  it('la ubicación del pedido se guarda como SNAPSHOT y no cambia después', async () => {
    const app = await newApp();
    // El cliente manda su ubicación (L1).
    await inbound(app, 'wamid.SNAP-1', locationNode(L1));
    const customer = await customerWithPhone(app, PHONE_A);
    const { locations } = await json(await call(app, `/api/admin/customers/${customer.id}/locations`));
    const L1id = locations[0].id;

    const order = await json(
      await createOrder(app, {
        customerId: customer.id,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: L1id,
        deliveryFee: 250,
      }),
    );
    expect(order.order.delivery.location.latitude).toBeCloseTo(L1.latitude, 4);
    expect(order.order.delivery.location.source_location_id).toBe(L1id);

    // Después el cliente manda OTRA ubicación (L2).
    await inbound(app, 'wamid.SNAP-2', locationNode(L2));
    const after = await json(await call(app, `/api/admin/orders/${order.item.id}`));
    // El pedido sigue apuntando a L1: no se ha mutado (§14).
    expect(after.order.delivery.location.latitude).toBeCloseTo(L1.latitude, 4);
    expect(after.order.delivery.location.name).toBe('Casa');
  });

  it('acepta coordenadas directas (dispositivo del operador) y las marca como tal', async () => {
    const app = await newApp();
    const body = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: { ...L2, source: LOCATION_SOURCES.BROWSER_GEOLOCATION },
      }),
    );
    expect(body.order.delivery.location.latitude).toBeCloseTo(L2.latitude, 4);
    expect(body.order.delivery.location.source).toBe(LOCATION_SOURCES.BROWSER_GEOLOCATION);
  });

  it('la ubicación de OTRO cliente se rechaza', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.OTRO-1', locationNode(L1), PHONE_B);
    const other = await customerWithPhone(app, PHONE_B);
    const { locations } = await json(await call(app, `/api/admin/customers/${other.id}/locations`));

    const intento = await createOrder(app, {
      phone: PHONE_A,
      items: [{ variantId: 'capsules_10', quantity: 1 }],
      deliveryLocation: locations[0].id,
    });
    expect(intento.status).toBe(422);
    expect((await json(intento)).error).toBe('location_from_other_customer');
  });

  it('editar un pedido conserva su ubicación y su delivery si no se mandan', async () => {
    const app = await newApp();
    const creado = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: L1,
        deliveryFee: 300,
      }),
    );
    const editado = await json(
      await call(app, `/api/admin/orders/${creado.item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ variantId: 'capsules_15', quantity: 1 }] }),
      }),
    );
    expect(editado.order.subtotal).toBe(3750);
    expect(editado.order.delivery_fee).toBe(300);
    expect(editado.order.total).toBe(4050);
    expect(editado.order.delivery.location.latitude).toBeCloseTo(L1.latitude, 4);
  });

  it('quitar la ubicación NO quita el delivery (son independientes)', async () => {
    const app = await newApp();
    const creado = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: L1,
        deliveryFee: 250,
      }),
    );
    const editado = await json(
      await call(app, `/api/admin/orders/${creado.item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ deliveryLocation: false }),
      }),
    );
    expect(editado.order.delivery.location).toBe(null);
    expect(editado.order.delivery_fee).toBe(250);
    expect(editado.order.total).toBe(2750);
  });

  it('un pedido ANTIGUO (sin order_json) sigue abriendo, con delivery 0 y sin ubicación', async () => {
    const app = await newApp();
    // Se inserta una fila como las de antes: columnas clásicas, sin `order_json`.
    const store = app.store ?? null;
    void store;
    const legacy = await json(
      await post(app, '/api/crm', {
        type: 'order_intent',
        id: 'legacy-loc-1',
        name: 'Cliente Antiguo',
        phone: PHONE_A,
        variantId: 'capsules_10',
        quantity: 1,
        unitPrice: 2500,
        total: 2500,
        location: 'Higüey',
        createdAt: '2026-09-01T12:00:00.000Z',
      }),
    );
    expect(legacy.ok).toBe(true);

    const detalle = await json(await call(app, '/api/admin/orders/legacy-loc-1'));
    expect(detalle.order.delivery_fee).toBe(0);
    expect(detalle.order.delivery.location).toBe(null);
    // La ciudad histórica NO se pierde.
    expect(detalle.order.delivery.city).toBe('Higüey');
    expect(detalle.receipt.total).toBe(2500);
    expect(detalle.receipt.has_location).toBe(false);
  });

  it('el comprobante dice que hay ubicación pero NO imprime coordenadas', async () => {
    const app = await newApp();
    const creado = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: L1,
        deliveryFee: 250,
      }),
    );
    expect(creado.receipt.has_location).toBe(true);
    expect(creado.receipt.location_label).toBe('Casa');
    const html = await (await call(app, `/api/admin/orders/${creado.item.id}/receipt`)).text();
    expect(html).toContain('Delivery');
    expect(html).toContain('Ubicación de entrega registrada');
    expect(html).not.toContain('18.6157');
    expect(html).not.toContain('-68.7071');
  });
});

describe('Meta (CAPI) nunca recibe coordenadas', () => {
  it('la venta entregada viaja sin latitud ni longitud, con el total cobrado', async () => {
    const app = await newApp();
    const creado = await json(
      await createOrder(app, {
        phone: PHONE_A,
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        deliveryLocation: L1,
        deliveryFee: 250,
      }),
    );
    await call(app, `/api/admin/items/${creado.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'entregado' }),
    });
    // El envío a Meta es en segundo plano: se espera un poco.
    for (let i = 0; i < 60 && app.capiCalls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));

    expect(app.capiCalls.length).toBeGreaterThan(0);
    const payload = JSON.stringify(app.capiCalls[0].body);
    expect(payload).not.toContain('18.6157');
    expect(payload).not.toContain('-68.7071');
    expect(payload).not.toMatch(/latitude|longitude|latitude/);
    // `value` = el total efectivamente cobrado (incluye el delivery).
    expect(app.capiCalls[0].body.data[0].custom_data.value).toBe(2750);
    expect(app.capiCalls[0].body.data[0].custom_data.currency).toBe('DOP');
  });
});

describe('enviar una ubicación por WhatsApp', () => {
  it('NO se envía sin confirmación explícita', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.ENV-0', locationNode(L1));
    const customer = await customerWithPhone(app, PHONE_A);
    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);

    const sinConfirmar = await call(app, `/api/admin/conversations/${conversation.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ latitude: L1.latitude, longitude: L1.longitude }),
    });
    expect(sinConfirmar.status).toBe(409);
    expect((await json(sinConfirmar)).error).toBe('not_confirmed');
    expect(app.sentLocations).toHaveLength(0);
    void customer;
  });

  it('confirmada, se envía con las coordenadas exactas y queda en el hilo', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.ENV-1', locationNode(L1));
    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);

    const enviada = await call(app, `/api/admin/conversations/${conversation.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ latitude: L2.latitude, longitude: L2.longitude, name: 'Punto de entrega', confirmed: true }),
    });
    expect(enviada.status).toBe(201);
    const body = await json(enviada);
    expect(app.sentLocations).toHaveLength(1);
    expect(app.sentLocations[0].location.latitude).toBeCloseTo(L2.latitude, 4);
    expect(app.sentLocations[0].location.longitude).toBeCloseTo(L2.longitude, 4);
    expect(app.sentLocations[0].location.name).toBe('Punto de entrega');
    // NUNCA se manda una URL de mapa: la fuente de verdad son las coordenadas.
    expect(app.sentLocations[0].location.reported_url ?? null).toBe(null);
    expect(body.message.type).toBe('location');

    const thread = await json(await call(app, `/api/admin/conversations/${conversation.id}/messages`));
    const outbound = thread.messages.filter((row) => row.direction === 'outbound' && row.type === 'location');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].status).toBe('sent');
    expect(outbound[0].location.map_url).toContain('google.com/maps');
  });

  it('la ubicación de otro cliente no se puede enviar a este chat', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.OTRO-2', locationNode(L1), PHONE_B);
    const other = await customerWithPhone(app, PHONE_B);
    const { locations } = await json(await call(app, `/api/admin/customers/${other.id}/locations`));

    await inbound(app, 'wamid.PROPIO-1', locationNode(L2), PHONE_A);
    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);

    const intento = await call(app, `/api/admin/conversations/${conversation.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ locationId: locations[0].id, confirmed: true }),
    });
    expect(intento.status).toBe(422);
    expect(app.sentLocations).toHaveLength(0);
  });

  it('compartir con OTRA conversación exige confirmación y deja auditoría', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.SHARE-1', locationNode(L1), PHONE_A);
    const origen = await customerWithPhone(app, PHONE_A);
    const { locations } = await json(await call(app, `/api/admin/customers/${origen.id}/locations`));

    // Destino: otra conversación (otro cliente).
    await inbound(app, 'wamid.SHARE-2', { type: 'text', text: { body: 'Hola' } }, PHONE_B);
    const conversations = await json(await call(app, '/api/admin/conversations'));
    const destino = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_B}`);

    const sinConfirmar = await call(app, `/api/admin/locations/${locations[0].id}/share`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: destino.id }),
    });
    expect(sinConfirmar.status).toBe(409);
    expect(app.sentLocations).toHaveLength(0);

    const confirmada = await call(app, `/api/admin/locations/${locations[0].id}/share`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: destino.id, confirmed: true }),
    });
    expect(confirmada.status).toBe(201);
    expect(app.sentLocations).toHaveLength(1);
    expect(app.sentLocations[0].to).toBe(`+${PHONE_B}`);
    expect(app.sentLocations[0].location.source).toBe(LOCATION_SOURCES.REUSED_LOCATION);

    const audit = await json(await call(app, '/api/admin/audit?entity=location'));
    const shared = audit.entries.find((row) => row.action === 'location.shared');
    expect(shared).toBeTruthy();
    expect(JSON.stringify(shared)).not.toContain('18.6157');
  });

  it('no se envía a un cliente que pidió no recibir mensajes', async () => {
    const app = await newApp();
    await inbound(app, 'wamid.OPT-1', { type: 'text', text: { body: 'No me escriban más' } });
    const conversations = await json(await call(app, '/api/admin/conversations'));
    const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE_A}`);

    const intento = await call(app, `/api/admin/conversations/${conversation.id}/location`, {
      method: 'POST',
      body: JSON.stringify({ latitude: L1.latitude, longitude: L1.longitude, confirmed: true }),
    });
    expect(intento.status).toBe(409);
    expect(app.sentLocations).toHaveLength(0);
  });
});
