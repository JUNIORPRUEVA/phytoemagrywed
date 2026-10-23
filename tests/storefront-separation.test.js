// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
let app, dir, adminCookie, storeCookie;

async function request(route, { method = 'GET', body, cookie = adminCookie } = {}) {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { response, status: response.status, data: type.includes('json') ? await response.json() : null };
}

async function createProduct(patch = {}) {
  const result = await request('/api/admin/store/products', { method: 'POST', body: {
    kind: 'product', name: `Producto QA ${randomUUID().slice(0, 8)}`, sku: `SEP-${randomUUID().slice(0, 8)}`,
    price: '1250.50', cost: '600.25', quantity: 5, min_stock: 1, image: IMAGE, ...patch,
  } });
  expect(result.status).toBe(201);
  return result.data.product;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-storefront-separation-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'store.sqlite'), token: 'storefront-test-token', quiet: true, schedulerEnabled: false });
  const login = await request('/api/admin/login', { method: 'POST', body: { token: 'storefront-test-token' }, cookie: undefined });
  adminCookie = login.response.headers.get('set-cookie')?.split(';')[0];
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('separación de escaparates públicos', () => {
  it('excluye PHYTOEMAGRY de todo el escaparate FULLTECH', async () => {
    const phyto = await createProduct({ storefront: 'PHYTOEMAGRY_STORE', category: 'Suplementos', daily_offer: true });
    const fulltech = await createProduct({ storefront: 'FULLTECH_STORE', category: 'Tecnología' });

    const publishPhyto = await request(`/api/admin/store/products/${phyto.id}/publication`, { method: 'POST', body: { status: 'published' } });
    expect(publishPhyto.status).toBe(409);
    expect(publishPhyto.data.error).toBe('wrong_storefront');
    expect((await request(`/api/store/products/${phyto.id}/image`, { cookie: undefined })).status).toBe(404);

    const publishFulltech = await request(`/api/admin/store/products/${fulltech.id}/publication`, { method: 'POST', body: { status: 'published' } });
    expect(publishFulltech.status).toBe(200);

    const home = await request('/api/store/home', { cookie: undefined });
    expect(home.data.products.map(row => row.id)).toEqual([fulltech.id]);
    expect(home.data.categories).toEqual(['Tecnología']);
    expect(home.data.dailyOffers).toEqual([]);
    expect((await request(`/api/store/products/${phyto.id}`, { cookie: undefined })).status).toBe(404);
    expect((await request(`/api/store/catalog?q=${encodeURIComponent(phyto.name)}`, { cookie: undefined })).data.products).toEqual([]);
    expect((await request('/api/store/catalog?category=Suplementos', { cookie: undefined })).data.products).toEqual([]);

    const admin = await request('/api/admin/store/products');
    expect(admin.data.products.find(row => row.id === phyto.id)).toMatchObject({ storefront: 'PHYTOEMAGRY_STORE' });
  });

  it('rechaza un producto PHYTO en el carrito aun si el navegador envía su ID', async () => {
    const phyto = await createProduct({ storefront: 'PHYTOEMAGRY_STORE' });
    const register = await request('/api/store/account/register', { method: 'POST', cookie: undefined, body: {
      name: 'Cliente Separación', phone: '8095550199', email: `separacion-${randomUUID().slice(0, 8)}@example.test`, password: 'Segura-12345',
    } });
    expect(register.status).toBe(201);
    storeCookie = register.response.headers.get('set-cookie')?.split(';')[0];
    const order = await request('/api/store/orders', { method: 'POST', cookie: storeCookie, body: {
      requestKey: `sep-${randomUUID()}`, fulfillment: 'pickup', items: [{ id: phyto.id, quantity: 1 }],
    } });
    expect(order.status).toBe(409);
    expect(order.data.error).toBe('product_unavailable');
  });

  it('mantiene las presentaciones legacy de Phytoemagry fuera de FULLTECH', async () => {
    const products = (await request('/api/admin/store/products')).data.products;
    const capsules = products.filter(product => product.legacy);
    expect(capsules).toHaveLength(7);
    expect(capsules.every(product => product.storefront === 'PHYTOEMAGRY_STORE')).toBe(true);
    expect((await request('/api/store/catalog', { cookie: undefined })).data.products).toEqual([]);
  });
});
