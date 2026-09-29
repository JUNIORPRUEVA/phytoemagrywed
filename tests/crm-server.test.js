// @vitest-environment node
/**
 * API DEL CRM (server/crm-server.mjs) — se arranca de verdad en un puerto libre
 * y se hacen peticiones HTTP reales, porque lo que importa es que los datos
 * queden guardados y se puedan volver a leer (no que una función devuelva algo).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-de-prueba-123';

const sqliteAvailable = await import('node:sqlite')
  .then(() => true)
  .catch(() => false);

let tmpDir;
let app;
let file;

/** Payload real del formulario de contacto (ver docs/CRM-CONTRACT.md). */
const lead = {
  schemaVersion: '1.1',
  type: 'lead',
  id: 'lead-1',
  name: 'Ana Gómez',
  phone: '+18095551234',
  location: 'Higüey, La Altagracia',
  source: 'formulario',
  variantId: null,
  variantName: null,
  capsules: null,
  quantity: null,
  consent: true,
  sessionId: 's_abc',
  createdAt: '2026-09-28T12:03:11.000Z',
};

/** Payload real del modal de compra (solo el nombre). */
const order = {
  schemaVersion: '1.1',
  type: 'order_intent',
  id: 'order-1',
  leadId: 'lead-1',
  product: { id: 'phytoemagry-v1', name: 'Phytoemagry', presentation: '20 cápsulas', currency: 'DOP' },
  variantId: 'capsules_20',
  variantName: '20 cápsulas',
  capsules: 20,
  quantity: 2,
  totalCapsules: 40,
  currency: 'DOP',
  unitPrice: 5000,
  total: 10000,
  source: 'checkout',
  status: 'pending_confirmation',
  customer: { name: 'Junior', phone: null, location: null },
  sessionId: 's_abc',
  createdAt: '2026-09-28T12:05:00.000Z',
};

const post = (body) =>
  fetch(`${app.url}/api/crm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const read = (query = '') => fetch(`${app.url}/api/crm/items?token=${TOKEN}${query}`);

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-crm-'));
  file = path.join(tmpDir, 'phytoemagry.sqlite');
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: file, token: TOKEN, quiet: true });
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('guardar en la base de datos', () => {
  it('acepta un contacto y un pedido y quedan guardados', async () => {
    const first = await post(lead);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, storage: 'sqlite' });

    const second = await post(order);
    expect(second.status).toBe(202);

    const response = await read();
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.count).toBe(2);

    const [pedido, contacto] = body.items;
    expect(pedido.type).toBe('order_intent');
    expect(pedido.name).toBe('Junior');
    expect(pedido.variant_name).toBe('20 cápsulas');
    expect(pedido.quantity).toBe(2);
    expect(pedido.total).toBe(10000);
    expect(contacto.type).toBe('lead');
    expect(contacto.phone).toBe('+18095551234');
    expect(contacto.payload.schemaVersion).toBe('1.1');
  });

  it('el mismo registro dos veces no se duplica (la cola local reintenta)', async () => {
    const again = await post(order);
    const body = await again.json();
    expect(body.saved[0].duplicate).toBe(true);

    const response = await read();
    expect((await response.json()).total).toBe(2);
  });

  it('rechaza cuerpos inválidos sin guardar nada', async () => {
    const badJson = await post('{esto no es json');
    expect(badJson.status).toBe(400);

    const badType = await post({ type: 'otra_cosa', id: 'x' });
    expect(badType.status).toBe(422);

    const after = await read();
    expect((await after.json()).total).toBe(2);
  });

  it('sobrevive al reinicio: los datos están en el archivo, no en memoria', async () => {
    await app.close();
    app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: file, token: TOKEN, quiet: true });

    const response = await read();
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.items[0].name).toBe('Junior');
  });
});

describe('leer los datos (panel y exportación)', () => {
  it('sin clave no se lee nada', async () => {
    const response = await fetch(`${app.url}/api/crm/items?token=clave-equivocada`);
    expect(response.status).toBe(401);
  });

  it('el panel muestra los registros y no se indexa', async () => {
    const response = await fetch(`${app.url}/panel?token=${TOKEN}`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('noindex');
    expect(body).toContain('Junior');
    expect(body).toContain('Ana Gómez');
    expect(body).toContain('Pedido');
    expect(body).toContain('Contacto');
  });

  it('la exportación CSV sale con cabecera y datos', async () => {
    const response = await fetch(`${app.url}/api/crm/export.csv?token=${TOKEN}`);
    const body = await response.text();
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(body).toContain('fecha,tipo,nombre,telefono');
    expect(body).toContain('Junior');
    expect(body.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('se puede filtrar por tipo', async () => {
    const response = await read('&type=order_intent');
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.items[0].type).toBe('order_intent');
  });

  it('el estado es público y no expone datos personales', async () => {
    const response = await fetch(`${app.url}/api/health`);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, storage: 'sqlite', items: 2 });
    expect(JSON.stringify(body)).not.toContain('Junior');
  });

  it('sin PHYTO_CRM_TOKEN leer está desactivado (y dice cómo activarlo)', async () => {
    const sinClave = await startCrmServer({
      port: 0,
      host: '127.0.0.1',
      dataFile: path.join(tmpDir, 'sin-clave.sqlite'),
      token: '',
      quiet: true,
    });
    try {
      const response = await fetch(`${sinClave.url}/api/crm/items`);
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe('read_disabled');

      // Guardar sigue funcionando: la web nunca pierde el dato.
      const saved = await fetch(`${sinClave.url}/api/crm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...lead, id: 'lead-2' }),
      });
      expect(saved.status).toBe(202);
    } finally {
      await sinClave.close();
    }
  });
});

describe('almacén alternativo', () => {
  it('con un archivo .jsonl guarda y lee sin SQLite', async () => {
    const jsonl = await startCrmServer({
      port: 0,
      host: '127.0.0.1',
      dataFile: path.join(tmpDir, 'respaldo.jsonl'),
      token: TOKEN,
      quiet: true,
    });
    try {
      expect(jsonl.storage).toBe('jsonl');
      await fetch(`${jsonl.url}/api/crm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(order),
      });
      const body = await (await fetch(`${jsonl.url}/api/crm/items?token=${TOKEN}`)).json();
      expect(body.total).toBe(1);
      expect(body.items[0].variant_name).toBe('20 cápsulas');
    } finally {
      await jsonl.close();
    }
  });

  it.skipIf(!sqliteAvailable)('en este Node sí hay SQLite (el modo normal)', () => {
    expect(sqliteAvailable).toBe(true);
    expect(app.storage).toBe('sqlite');
  });
});
