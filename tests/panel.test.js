// @vitest-environment node
/**
 * PANEL (mini-CRM) — se arranca el servidor de verdad y se entra como lo haría
 * el negocio desde el móvil: clave → cookie de sesión → gestionar clientes.
 *
 * También se comprueba que el panel se sirve como app instalable (PWA), porque
 * eso es justo lo que pidió el negocio: tenerla en su teléfono.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-del-panel-para-pruebas';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_DIR = path.join(ROOT, 'public', 'admin');

let tmpDir;
let app;

/** Petición con cookie de sesión (fetch no guarda cookies solo). */
const call = (route, options = {}, cookie = '') =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });

/** Entra al panel y devuelve la cookie (o null si la clave es incorrecta). */
async function login(token = TOKEN) {
  const response = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token }) });
  if (!response.ok) return { cookie: null, status: response.status };
  const header = response.headers.get('set-cookie') ?? '';
  return { cookie: header.split(';')[0], status: response.status, header };
}

const json = async (response) => response.json();

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-panel-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'panel.sqlite'),
    token: TOKEN,
    adminDir: ADMIN_DIR,
    quiet: true,
  });

  // Dos registros como los que envía la web
  await call('/api/crm', {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: '1.1',
      type: 'lead',
      id: 'lead-panel',
      name: 'Ana Gómez',
      phone: '+18095551234',
      location: 'Higüey',
      source: 'formulario',
      createdAt: '2026-09-28T12:00:00.000Z',
    }),
  });
  await call('/api/crm', {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: '1.1',
      type: 'order_intent',
      id: 'order-panel',
      variantId: 'capsules_20',
      variantName: '20 cápsulas',
      quantity: 2,
      unitPrice: 5000,
      total: 10000,
      currency: 'DOP',
      source: 'checkout',
      customer: { name: 'Junior' },
      createdAt: '2026-09-28T12:05:00.000Z',
    }),
  });
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('panel: entrar', () => {
  it('la clave incorrecta no deja entrar', async () => {
    const { status, cookie } = await login('no-es-la-clave');
    expect(status).toBe(401);
    expect(cookie).toBeNull();
  });

  it('sin clave no se puede administrar nada', async () => {
    for (const route of ['/api/admin/data', '/api/admin/messages']) {
      const response = await call(route);
      expect([401, 404]).toContain(response.status);
    }
  });

  it('con la clave correcta devuelve una cookie de sesión protegida', async () => {
    const { status, header, cookie } = await login();
    expect(status).toBe(200);
    expect(cookie).toContain('pe_crm=');
    // La cookie del panel no puede leerla el JavaScript de la página.
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');

    const session = await call('/api/admin/session', {}, cookie);
    expect(await json(session)).toMatchObject({ ok: true, storage: 'sqlite' });
  });

  it('una cookie inventada no vale', async () => {
    const response = await call('/api/admin/data', {}, 'pe_crm=9999999999.firma-falsa');
    expect(response.status).toBe(401);
  });

  it('al salir, la cookie se borra', async () => {
    const { cookie } = await login();
    const logout = await call('/api/admin/logout', { method: 'POST' }, cookie);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('el enlace antiguo /panel?token= entra y manda al panel', async () => {
    const response = await call(`/panel?token=${TOKEN}`, { redirect: 'manual' });
    expect([301, 302]).toContain(response.status);
    expect(response.headers.get('location')).toBe('/admin/');
    expect(response.headers.get('set-cookie')).toContain('pe_crm=');
  });
});

describe('panel: app instalable (PWA)', () => {
  it('sirve el panel sin indexar', async () => {
    const response = await call('/admin/');
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(body).toContain('rel="manifest"');
    expect(body).toContain('apple-touch-icon');
  });

  it('el manifest y el service worker están listos para instalar', async () => {
    const manifest = await json(await call('/admin/manifest.json'));
    expect(manifest).toMatchObject({ name: 'CRM Phytoemagry', start_url: '/admin/', display: 'standalone' });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

    const sw = await call('/admin/sw.js');
    const body = await sw.text();
    expect(sw.status).toBe(200);
    // Los datos NUNCA se cachean: el panel tiene que ver el último pedido.
    expect(body).toContain("url.pathname.startsWith('/api/')");
    expect(body).toContain('caches.open');
  });

  it('los iconos existen de verdad (404 sería una app rota al instalar)', () => {
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
      const file = path.join(ADMIN_DIR, icon);
      expect(existsSync(file), `falta ${icon}`).toBe(true);
      expect(readFileSync(file).length).toBeGreaterThan(500);
    }
  });

  it('no se puede salir de la carpeta del panel (path traversal)', async () => {
    const response = await call('/admin/../../server/crm-server.mjs');
    expect(response.status).toBe(404);
  });
});

describe('panel: gestionar clientes y pedidos', () => {
  let cookie;

  beforeAll(async () => {
    cookie = (await login()).cookie;
  });

  it('trae registros, estados, cuentas y plantillas en una sola petición', async () => {
    const data = await json(await call('/api/admin/data', {}, cookie));
    expect(data.items).toHaveLength(2);
    expect(data.statuses.map((status) => status.value)).toEqual([
      'nuevo',
      'contactado',
      'interesado',
      'confirmado',
      'en_preparacion',
      'enviado',
      'entregado',
      'cancelado',
      'perdido',
    ]);
    expect(data.stats).toMatchObject({ total: 2, nuevos: 2, pedidos: 1, valorAbierto: 10000 });
    expect(data.messages.length).toBeGreaterThanOrEqual(5);
    expect(data.timeZone).toBe('America/Santo_Domingo');
  });

  it('guarda estado, notas y recordatorio', async () => {
    const response = await call(
      '/api/admin/items/lead-panel',
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'interesado', notes: 'Quiere el de 20', nextActionAt: '2026-09-29' }),
      },
      cookie,
    );
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      status: 'interesado',
      notes: 'Quiere el de 20',
      next_action_at: '2026-09-29',
    });

    const data = await json(await call('/api/admin/data', {}, cookie));
    const item = data.items.find((entry) => entry.id === 'lead-panel');
    expect(item.status).toBe('interesado');
    // El recordatorio de hoy cuenta como pendiente.
    expect(data.stats.hoy).toBeGreaterThanOrEqual(1);
  });

  it('escribir por WhatsApp queda registrado como contacto', async () => {
    const response = await call(
      '/api/admin/items/order-panel',
      { method: 'PATCH', body: JSON.stringify({ contacted: true }) },
      cookie,
    );
    const body = await json(response);
    expect(body.item.status).toBe('contactado');
    expect(body.item.last_contact_at).toBeTruthy();
  });

  it('quit el recordatorio con una fecha vacía', async () => {
    const response = await call(
      '/api/admin/items/lead-panel',
      { method: 'PATCH', body: JSON.stringify({ nextActionAt: '' }) },
      cookie,
    );
    expect((await json(response)).item.next_action_at).toBeNull();
  });

  it('rechaza un estado que no existe', async () => {
    const response = await call(
      '/api/admin/items/lead-panel',
      { method: 'PATCH', body: JSON.stringify({ status: 'vendido-a-un-amigo' }) },
      cookie,
    );
    expect(response.status).toBe(422);
  });

  it('un registro que no existe da 404 (y no crea nada)', async () => {
    const response = await call(
      '/api/admin/items/no-existe',
      { method: 'PATCH', body: JSON.stringify({ status: 'contactado' }) },
      cookie,
    );
    expect(response.status).toBe(404);
  });

  it('las plantillas se crean, se editan y se borran', async () => {
    const created = await json(
      await call(
        '/api/admin/messages',
        { method: 'POST', body: JSON.stringify({ name: 'Entrega hoy', body: 'Hola {nombre}, sale hoy.' }) },
        cookie,
      ),
    );
    expect(created.message.id).toBe('msg-entrega-hoy');
    const before = created.messages.length;

    const edited = await json(
      await call(
        '/api/admin/messages',
        { method: 'POST', body: JSON.stringify({ id: 'msg-entrega-hoy', name: 'Entrega hoy', body: 'Cambiado' }) },
        cookie,
      ),
    );
    expect(edited.messages.length).toBe(before);
    expect(edited.messages.find((message) => message.id === 'msg-entrega-hoy').body).toBe('Cambiado');

    const removed = await json(await call('/api/admin/messages/msg-entrega-hoy', { method: 'DELETE' }, cookie));
    expect(removed.messages.find((message) => message.id === 'msg-entrega-hoy')).toBeUndefined();

    const invalid = await call('/api/admin/messages', { method: 'POST', body: JSON.stringify({ name: 'Sin texto' }) }, cookie);
    expect(invalid.status).toBe(422);
  });
});

describe('panel: exportar', () => {
  it('el CSV incluye los campos de gestión y sale con la sesión', async () => {
    const { cookie } = await login();
    const response = await call('/api/crm/export.csv?limit=100', {}, cookie);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const [header, ...rows] = body.split('\r\n').filter(Boolean);
    expect(header).toContain('estado');
    expect(header).toContain('recordatorio');
    expect(header).toContain('notas');
    expect(rows.join('\n')).toContain('Ana Gómez');
    expect(rows.join('\n')).toContain('Interesado');
  });
});
