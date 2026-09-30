// @vitest-environment node
/**
 * META — la venta (`Purchase`) y el espejo del `Lead`, con el CRM de verdad.
 *
 * Reglas de negocio que se comprueban aquí:
 *  - `Purchase` SOLO cuando el negocio marca el pedido como ENTREGADO (dinero
 *    cobrado). Ni al guardar, ni al confirmar, ni al abrir WhatsApp.
 *  - Una venta se manda UNA sola vez. Reiniciar el servidor no la reenvía.
 *  - Si Meta se cae, el pedido queda igual (nada de perder ventas por un tercero).
 *  - El token de Meta nunca aparece en una respuesta al navegador.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { createMetaCapi } from '../server/meta-capi.mjs';

const TOKEN = 'clave-del-panel-de-pruebas';
const ACCESS_TOKEN = 'EAAtoken-de-prueba-1234567890abcdefghijkl';
/**
 * Píxel de mentira. El ID real es público (viaja en el HTML) pero no pinta nada
 * en los tests: aquí se prueban los payloads, no la cuenta de nadie.
 */
const PIXEL = '1111222233334444';

/** Servidores y carpetas temporales que hay que limpiar al final. */
const apps = [];
const tmpDirs = [];

/**
 * Arranca un CRM con un "Meta" de mentira: así se prueba el payload real que se
 * enviaría, sin depender de internet ni gastar cuota de la API.
 *
 * @param {object} [options]
 * @param {object} [options.metaAnswer] respuesta que simula dar Meta
 * @param {string} [options.appEnv]
 * @param {string} [options.testEventCode]
 * @param {boolean} [options.withoutCredentials]
 * @param {string} [options.purchaseStatus]
 * @param {string} [options.dataFile] reutilizar el mismo archivo = "reinicio"
 */
async function newApp(options = {}) {
  const dir = options.dataFile ? path.dirname(options.dataFile) : mkdtempSync(path.join(os.tmpdir(), 'phyto-meta-'));
  if (!options.dataFile) tmpDirs.push(dir);
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    const answer = options.metaAnswer ?? { status: 200, body: { events_received: 1, fbtrace_id: 'trace-1' } };
    return { ok: answer.status < 300, status: answer.status, text: async () => JSON.stringify(answer.body) };
  };

  const metaCapi = options.withoutCredentials
    ? createMetaCapi({ pixelId: '', accessToken: '', fetchImpl, log: () => {} })
    : createMetaCapi({
        pixelId: PIXEL,
        accessToken: ACCESS_TOKEN,
        graphVersion: 'v21.0',
        appEnv: options.appEnv ?? 'uat',
        testEventCode: options.testEventCode ?? '',
        fetchImpl,
        log: () => {},
      });

  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: options.dataFile ?? path.join(dir, 'meta.sqlite'),
    token: TOKEN,
    quiet: true,
    metaCapi,
    purchaseStatus: options.purchaseStatus ?? 'entregado',
  });
  app.calls = calls;
  app.file = options.dataFile ?? path.join(dir, 'meta.sqlite');
  // Las rutas del panel piden sesión: se entra como lo haría el negocio.
  const login = await post(app, '/api/admin/login', { token: TOKEN });
  app.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  apps.push(app);
  return app;
}

const post = (app, route, body) =>
  fetch(`${app.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const patch = (app, id, body) =>
  fetch(`${app.url}/api/admin/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(app.cookie ? { cookie: app.cookie } : {}) },
    body: JSON.stringify(body),
  });

/** Espera a que se cumpla una condición (los envíos van en segundo plano). */
async function waitFor(check, { attempts = 60, delay = 20 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return check();
}

/** Pedido como el que envía la web (con atribución y los ids del píxel). */
function orderPayload(id, overrides = {}) {
  return {
    schemaVersion: '1.1',
    type: 'order_intent',
    id,
    variantId: 'capsules_20',
    variantName: '20 cápsulas',
    capsules: 20,
    quantity: 1,
    unitPrice: 5000,
    total: 5000,
    currency: 'DOP',
    source: 'checkout',
    sessionId: 'sesion-meta-1',
    attribution: { fbclid: 'IwAR-prueba', fbc: null, fbp: 'fb.1.1700000000000.123', clickIds: { fbclid: 'IwAR-prueba' } },
    meta: { events: { lead: 'lead_abc', initiateCheckout: 'ic_xyz' }, sourceUrl: 'https://phytoemagryrd.lat/#frascos' },
    customer: { name: 'Maria Prueba', phone: '8091234567', location: 'Santo Domingo' },
    ...overrides,
  };
}

afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('meta · cuándo se envía una venta', () => {
  it('NO se envía al guardar el pedido, ni al confirmarlo: solo al entregarlo', async () => {
    const app = await newApp();
    await post(app, '/api/crm', orderPayload('pedido-1'));
    const saved = await app.store.listAdmin({ limit: 10 });
    expect(saved).toHaveLength(1);
    expect(app.calls).toHaveLength(0);

    await patch(app, 'pedido-1', { status: 'contactado' });
    await patch(app, 'pedido-1', { status: 'interesado' });
    await patch(app, 'pedido-1', { status: 'confirmado' });
    expect(app.calls).toHaveLength(0);

    const response = await patch(app, 'pedido-1', { status: 'entregado' });
    expect(response.status).toBe(200);
    await waitFor(() => app.calls.length === 1);

    expect(app.calls).toHaveLength(1);
    const event = app.calls[0].body.data[0];
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe('purchase_pedido-1');
    expect(event.action_source).toBe('website');
    expect(event.event_source_url).toBe('https://phytoemagryrd.lat/#frascos');
    expect(event.custom_data).toMatchObject({ currency: 'DOP', value: 5000, content_ids: ['capsules_20'] });
    // Atribución del anuncio: el fbclid que llegó en la URL, reconstruido como _fbc.
    expect(event.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR-prueba$/);
    expect(event.user_data.fbp).toBe('fb.1.1700000000000.123');
    // El teléfono va hasheado (nunca en claro).
    expect(JSON.stringify(event)).not.toContain('8091234567');
    expect(event.user_data.ph).toHaveLength(1);
  });

  it('un cambio de notas o recordatorio NO reenvía la venta', async () => {
    const app = await newApp();
    await post(app, '/api/crm', orderPayload('pedido-2', { total: 1250, unitPrice: 1250, variantId: 'capsules_5' }));
    await patch(app, 'pedido-2', { status: 'entregado' });
    await waitFor(() => app.calls.length === 1);

    await patch(app, 'pedido-2', { status: 'entregado', notes: 'pagado en efectivo' });
    await patch(app, 'pedido-2', { nextActionAt: '2026-10-05' });
    await patch(app, 'pedido-2', { status: 'entregado' });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(app.calls).toHaveLength(1);
    const item = (await app.store.listAdmin({ limit: 10 })).find((entry) => entry.id === 'pedido-2');
    expect(item.status).toBe('entregado');
    expect(item.meta_purchase_status).toBe('sent');
    expect(item.meta_purchase_sent_at).toBeTruthy();
    expect(item.meta_purchase_event_id).toBe('purchase_pedido-2');
  });

  it('reiniciar el servidor NO reenvía una venta ya enviada', async () => {
    const first = await newApp();
    await post(first, '/api/crm', orderPayload('pedido-3'));
    await patch(first, 'pedido-3', { status: 'entregado' });
    await waitFor(() => first.calls.length === 1);
    const file = first.file;
    await first.close();

    // "Reinicio": mismo archivo, servidor nuevo.
    const second = await newApp({ dataFile: file });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second.calls).toHaveLength(0);
  });

  it('un fallo de Meta deja el pedido entregado y el envío marcado para reintentar', async () => {
    const app = await newApp({ metaAnswer: { status: 500, body: { error: { code: 1, type: 'Server', message: 'inténtalo luego' } } } });
    await post(app, '/api/crm', orderPayload('pedido-4'));
    const response = await patch(app, 'pedido-4', { status: 'entregado' });
    expect(response.status).toBe(200);
    await waitFor(() => app.calls.length === 1);

    const item = (await app.store.listAdmin({ limit: 10 })).find((entry) => entry.id === 'pedido-4');
    expect(item.status).toBe('entregado');
    expect(item.meta_purchase_status).toBe('failed');
    expect(item.meta_purchase_sent_at).toBeNull();
    expect(item.meta_purchase_attempts).toBe(1);
    expect(item.meta_purchase_error).toContain('HTTP 500');
    expect(item.meta_purchase_error).not.toContain(ACCESS_TOKEN);
  });

  it('al reiniciar, reintenta lo que quedó pendiente (una vez, sin duplicar)', async () => {
    const failing = await newApp({ metaAnswer: { status: 503, body: { error: { code: 2, type: 'Server', message: 'caído' } } } });
    await post(failing, '/api/crm', orderPayload('pedido-5'));
    await patch(failing, 'pedido-5', { status: 'entregado' });
    await waitFor(() => failing.calls.length === 1);
    const file = failing.file;
    await failing.close();

    const healthy = await newApp({ dataFile: file });
    await waitFor(() => healthy.calls.length === 1);
    expect(healthy.calls).toHaveLength(1);
    expect(healthy.calls[0].body.data[0].event_id).toBe('purchase_pedido-5');

    const item = (await healthy.store.listAdmin({ limit: 10 })).find((entry) => entry.id === 'pedido-5');
    expect(item.meta_purchase_status).toBe('sent');
    expect(item.meta_purchase_attempts).toBe(2);
    expect(item.meta_purchase_error).toBeNull();
  });

  it('sin credenciales de Meta el CRM funciona igual (no manda nada)', async () => {
    const app = await newApp({ withoutCredentials: true });
    await post(app, '/api/crm', orderPayload('pedido-6'));
    await patch(app, 'pedido-6', { status: 'entregado' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(app.calls).toHaveLength(0);
    const item = (await app.store.listAdmin({ limit: 10 })).find((entry) => entry.id === 'pedido-6');
    expect(item.status).toBe('entregado');
  });

  it('solo se envía la venta de un pedido, nunca de un contacto', async () => {
    const app = await newApp();
    await post(app, '/api/crm', { ...orderPayload('lead-9'), type: 'lead' });
    await patch(app, 'lead-9', { status: 'entregado' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(app.calls.filter((call) => call.body.data[0].event_name === 'Purchase')).toHaveLength(0);
  });
});

describe('meta · espejo del Lead (browser + servidor con el mismo event_id)', () => {
  it('reenvía el Lead con el MISMO event_id que usó el píxel', async () => {
    const app = await newApp();
    await post(app, '/api/crm', {
      schemaVersion: '1.1',
      type: 'lead',
      id: 'lead-meta-1',
      name: 'Ana Prueba',
      phone: '8291234567',
      source: 'checkout',
      sessionId: 'sesion-meta-2',
      attribution: { fbclid: 'IwAR-lead', clickIds: { fbclid: 'IwAR-lead' } },
      meta: { events: { lead: 'lead_abc123' }, sourceUrl: 'https://phytoemagryrd.lat/' },
    });

    await waitFor(() => app.calls.length === 1);
    const event = app.calls[0].body.data[0];
    expect(event.event_name).toBe('Lead');
    expect(event.event_id).toBe('lead_abc123');
    expect(event.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR-lead$/);
    expect(event.user_data.client_user_agent).toBeDefined();
    // El teléfono del formulario va hasheado.
    expect(event.user_data.ph).toBeDefined();
  });

  it('sin event_id del navegador usa uno estable del propio registro', async () => {
    const app = await newApp();
    await post(app, '/api/crm', { type: 'lead', id: 'lead-meta-2', name: 'Luis' });
    await waitFor(() => app.calls.length === 1);
    expect(app.calls[0].body.data[0].event_id).toBe('lead_lead-meta-2');
  });
});

describe('meta · configuración y secretos', () => {
  it('test_event_code se manda en UAT y se ignora en producción', async () => {
    const uat = await newApp({ appEnv: 'uat', testEventCode: 'TEST12345' });
    await post(uat, '/api/crm', orderPayload('pedido-uat'));
    await patch(uat, 'pedido-uat', { status: 'entregado' });
    await waitFor(() => uat.calls.length === 1);
    expect(uat.calls[0].body.test_event_code).toBe('TEST12345');

    const prod = await newApp({ appEnv: 'production', testEventCode: 'TEST12345' });
    await post(prod, '/api/crm', orderPayload('pedido-prod'));
    await patch(prod, 'pedido-prod', { status: 'entregado' });
    await waitFor(() => prod.calls.length === 1);
    expect(prod.calls[0].body.test_event_code).toBeUndefined();
  });

  it('el token de Meta jamás aparece en una respuesta al navegador', async () => {
    const app = await newApp({ testEventCode: 'TEST12345' });
    await post(app, '/api/crm', orderPayload('pedido-7'));
    await patch(app, 'pedido-7', { status: 'entregado' });
    await waitFor(() => app.calls.length === 1);

    const login = await post(app, '/api/admin/login', { token: TOKEN });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const bodies = [];    for (const route of ['/api/health', '/api/admin/data', '/api/crm/export.csv']) {
      const response = await fetch(`${app.url}${route}`, { headers: cookie ? { cookie } : {} });
      bodies.push(await response.text());
    }
    bodies.push(await (await fetch(`${app.url}/api/admin/items/pedido-7`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'entregado' }),
    })).text());

    for (const body of bodies) {
      expect(body).not.toContain(ACCESS_TOKEN);
      expect(body).not.toContain('EAAtoken');
      expect(body).not.toContain('TEST12345');
    }
    // Pero sí se informa de que Meta está configurada (sin valores).
    const data = JSON.parse(bodies[1]);
    expect(data.meta).toMatchObject({ configured: true, purchaseStatus: 'entregado', graphVersion: 'v21.0' });
  });

  it('el reenvío manual repara un envío fallido y no duplica uno ya enviado', async () => {
    const app = await newApp({ metaAnswer: { status: 500, body: { error: { code: 9, type: 'Server', message: 'temporal' } } } });
    await post(app, '/api/crm', orderPayload('pedido-8'));
    await patch(app, 'pedido-8', { status: 'entregado' });
    await waitFor(() => app.calls.length === 1);

    const retry = () =>
      fetch(`${app.url}/api/admin/items/pedido-8/meta-purchase`, {
        method: 'POST',
        headers: { cookie: app.cookie },
      });

    const failedAgain = await retry();
    expect(failedAgain.status).toBe(502);
    expect((await failedAgain.json()).error.code).toBe(9);
    expect(app.calls).toHaveLength(2);
  });

  it('el reenvío manual no repite una venta ya enviada', async () => {
    const app = await newApp();
    await post(app, '/api/crm', orderPayload('pedido-9'));
    await patch(app, 'pedido-9', { status: 'entregado' });
    await waitFor(() => app.calls.length === 1);

    const response = await fetch(`${app.url}/api/admin/items/pedido-9/meta-purchase`, {
      method: 'POST',
      headers: { cookie: app.cookie },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe('already_sent');
    expect(app.calls).toHaveLength(1);
  });

  it('el reenvío manual pide sesión (no es un endpoint público)', async () => {
    const app = await newApp();
    const response = await fetch(`${app.url}/api/admin/items/lo-que-sea/meta-purchase`, { method: 'POST' });
    expect(response.status).toBe(401);
  });
});
