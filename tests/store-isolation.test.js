// @vitest-environment node
/*
 * AISLAMIENTO DE CATÁLOGOS: FULLTECH STORE ↔ PHYTOEMAGRY
 *
 * Regresión del defecto real: el catálogo administrativo es uno solo y los
 * artículos PHYTO-* (legacy) se publicaban dentro de la tienda Fulltech. Aquí se
 * comprueba que el servidor filtra por dueño y que la tienda NO puede cambiar de
 * contexto desde la URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
const TOKEN = 'store-isolation-token';

let dir = '';
let apps = [];

/** Arranca el CRM con un contexto de tienda CONCRETO y devuelve su cookie admin. */
async function boot(storeKey, dataFile = path.join(dir, 'store.sqlite')) {
  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile,
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    ...(storeKey ? { storeKey } : {}),
  });
  apps.push(app);
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  return { app, cookie };
}

const call = async (app, route, { method = 'GET', body, cookie, auth = false } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: { ...(auth && cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, data: type.includes('json') ? await response.json() : null };
};

/** Crea y publica un artículo en la tienda indicada (mismo nombre de categoría en ambas). */
async function seedProduct(app, cookie, { name, sku, store, category = 'Cámaras', featured = false }) {
  const created = await call(app, '/api/admin/store/products', {
    method: 'POST',
    cookie,
    auth: true,
    body: {
      kind: 'product',
      name,
      sku,
      store,
      category,
      price: '1500.00',
      cost: '700.00',
      quantity: 5,
      min_stock: 1,
      image: IMAGE,
      store_public_name: name,
      store_short_description: `${name} de prueba`,
    },
  });
  expect(created.status).toBe(201);
  const product = created.data.product;
  expect(product.store).toBe(store ?? 'fulltech');
  const published = await call(app, `/api/admin/store/products/${product.id}/publication`, {
    method: 'POST',
    cookie,
    auth: true,
    body: { status: 'published', featured, sort_order: 10 },
  });
  expect(published.status).toBe(200);
  return product;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-store-isolation-'));
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('FULLTECH Store · aislamiento del catálogo', () => {
  it('solo muestra los artículos de su tienda en portada, catálogo, categorías y buscador', async () => {
    const { app, cookie } = await boot('fulltech');
    const fulltech = await seedProduct(app, cookie, { name: 'Cámara Fulltech', sku: 'ISO-FT-1', store: 'fulltech', featured: true });
    const phyto = await seedProduct(app, cookie, { name: 'Phytoemagry · 5 cápsulas', sku: 'ISO-PH-1', store: 'phytoemagry' });

    const catalog = await call(app, '/api/store/catalog');
    expect(catalog.data.products.map((row) => row.id)).toEqual([fulltech.id]);

    /*
     * El contexto de tienda NO se puede cambiar desde la URL: pedir el catálogo
     * «como Phytoemagry» desde la tienda Fulltech devuelve exactamente lo mismo.
     */
    const spoofed = await call(app, '/api/store/catalog?store=phytoemagry');
    expect(spoofed.data.products.map((row) => row.id)).toEqual([fulltech.id]);

    const home = await call(app, '/api/store/home');
    expect(home.data.total).toBe(1);
    expect(home.data.sections.featured.map((row) => row.id)).toEqual([fulltech.id]);
    expect(JSON.stringify(home.data)).not.toContain(phyto.id);

    const categories = await call(app, '/api/store/categories');
    expect(categories.data.categories).toEqual(['Cámaras']);
    expect(categories.data.categoryCards).toEqual([expect.objectContaining({ name: 'Cámaras', count: 1 })]);

    const search = await call(app, '/api/store/catalog?q=camara');
    expect(search.data.products.map((row) => row.id)).toEqual([fulltech.id]);

    /* Acceso directo al artículo ajeno: ni ficha ni imagen. */
    expect((await call(app, `/api/store/products/${phyto.id}`)).status).toBe(404);
    expect((await call(app, `/api/store/products/${phyto.id}/image`)).status).toBe(404);
    expect((await call(app, `/api/store/products/${fulltech.id}`)).status).toBe(200);
  });

  it('etiqueta el dueño en el panel y permite la MISMA categoría en las dos tiendas', async () => {
    const { app, cookie } = await boot('fulltech');
    const fulltech = await seedProduct(app, cookie, { name: 'Router Fulltech', sku: 'ISO-FT-2', store: 'fulltech', category: 'Redes' });
    const phyto = await seedProduct(app, cookie, { name: 'Frasco Phyto', sku: 'ISO-PH-2', store: 'phytoemagry', category: 'Redes' });

    const admin = await call(app, '/api/admin/store/products', { cookie, auth: true });
    const bySku = new Map(admin.data.products.map((row) => [row.sku, row]));
    expect(bySku.get('ISO-FT-2').store).toBe('fulltech');
    expect(bySku.get('ISO-PH-2').store).toBe('phytoemagry');
    expect(admin.data.storeKey).toBe('fulltech');

    /* Dos categorías con el mismo nombre, una por tienda. */
    const redes = admin.data.categories.filter((row) => row.name === 'Redes');
    expect(redes).toHaveLength(2);
    expect(redes.map((row) => row.store).sort()).toEqual(['fulltech', 'phytoemagry']);

    /* Un artículo no puede colgarse de la categoría de la otra tienda. */
    const foreignCategory = redes.find((row) => row.store === 'phytoemagry');
    const mismatch = await call(app, `/api/admin/store/products/${fulltech.id}`, {
      method: 'PATCH',
      cookie,
      auth: true,
      body: {
        version: fulltech.version,
        kind: 'product',
        name: fulltech.name,
        sku: fulltech.sku,
        price: '1500.00',
        cost: '700.00',
        quantity: 5,
        min_stock: 1,
        category_id: foreignCategory.id,
        track_stock: true,
        store: 'fulltech',
      },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.data.error).toBe('category_store_mismatch');
    expect(phyto.id).not.toBe(fulltech.id);
  });

  it('el mismo catálogo, servido como Phytoemagry, solo devuelve los artículos de Phytoemagry', async () => {
    const dataFile = path.join(dir, 'shared.sqlite');
    const first = await boot('fulltech', dataFile);
    const fulltech = await seedProduct(first.app, first.cookie, { name: 'Cámara Fulltech', sku: 'ISO-FT-3', store: 'fulltech', featured: true });
    const phyto = await seedProduct(first.app, first.cookie, { name: 'Phytoemagry · 7 cápsulas', sku: 'ISO-PH-3', store: 'phytoemagry', featured: true });
    await first.app.close();

    /* Misma base, OTRO contexto de tienda: el resultado se invierte. */
    const second = await boot('phytoemagry', dataFile);
    const catalog = await call(second.app, '/api/store/catalog');
    expect(catalog.data.products.map((row) => row.id)).toEqual([phyto.id]);

    const home = await call(second.app, '/api/store/home');
    expect(home.data.total).toBe(1);
    expect(home.data.sections.featured.map((row) => row.id)).toEqual([phyto.id]);

    const categories = await call(second.app, '/api/store/categories');
    expect(categories.data.categories).toEqual(['Cámaras']);
    expect(categories.data.categoryCards[0].count).toBe(1);

    /* «camara» también indexa la CATEGORÍA, así que se busca una marca propia. */
    const search = await call(second.app, '/api/store/catalog?q=fulltech');
    expect(search.data.products).toEqual([]);
    expect((await call(second.app, `/api/store/products/${fulltech.id}`)).status).toBe(404);
    expect((await call(second.app, `/api/store/products/${fulltech.id}/image`)).status).toBe(404);
    expect((await call(second.app, `/api/store/products/${phyto.id}`)).status).toBe(200);
  });

  it('un despliegue sin PHYTO_STORE_KEY se comporta como FULLTECH y nunca incluye Phytoemagry', async () => {
    const { app, cookie } = await boot(null);
    await seedProduct(app, cookie, { name: 'Producto sin tienda explícita', sku: 'ISO-DEF-1', store: undefined });
    const phyto = await seedProduct(app, cookie, { name: 'Frasco Phyto', sku: 'ISO-DEF-2', store: 'phytoemagry' });
    const catalog = await call(app, '/api/store/catalog');
    expect(catalog.data.products).toHaveLength(1);
    expect(catalog.data.products[0].name).toBe('Producto sin tienda explícita');
    expect(JSON.stringify(catalog.data)).not.toContain(phyto.id);
  });

  it('el carrito de una tienda no puede comprar un producto de la otra', async () => {
    const { app, cookie } = await boot('fulltech');
    const phyto = await seedProduct(app, cookie, { name: 'Frasco ajeno', sku: 'ISO-CART-1', store: 'phytoemagry' });
    /* Sin sesión de cliente la ruta responde 401/403 antes de mirar el carrito. */
    const order = await call(app, '/api/store/orders', { method: 'POST', body: { items: [{ id: phyto.id, quantity: 1 }] } });
    expect([401, 403]).toContain(order.status);
    /* Y el artículo ajeno tampoco se puede resolver desde el catálogo público. */
    expect((await call(app, `/api/store/products/${phyto.id}`)).status).toBe(404);
  });
});
