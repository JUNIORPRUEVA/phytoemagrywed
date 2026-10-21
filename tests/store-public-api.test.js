// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
let app, dir, cookie;
const request = async (route, { method = 'GET', body, auth = true } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: { ...(auth && cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { response, status: response.status, data: type.includes('json') ? await response.json() : null };
};
const product = async (name, sku, patch = {}) => {
  const result = await request('/api/admin/store/products', { method: 'POST', body: {
    kind: 'product', name, sku, price: '1250.50', cost: '600.25', quantity: 5, min_stock: 1, image: IMAGE, ...patch,
  } });
  expect(result.status).toBe(201);
  return result.data.product;
};
const publish = (id, patch = {}) => request(`/api/admin/store/products/${id}/publication`, { method: 'POST', body: { status: 'published', ...patch } });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-store-public-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'store.sqlite'), token: 'store-test-token', quiet: true, schedulerEnabled: false });
  const login = await fetch(`${app.url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'store-test-token' }) });
  cookie = login.headers.get('set-cookie')?.split(';')[0];
});
afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('FULLTECH Store public catalog API', () => {
  it('keeps every existing product unpublished by default and separates public access from CRM administration', async () => {
    const catalog = await request('/api/store/catalog', { auth: false });
    expect(catalog.status).toBe(200);
    expect(catalog.data.products).toEqual([]);
    expect((await request('/api/store/home', { auth: false })).data).toMatchObject({ categories: [], products: [], services: [], featured: false });
    expect(catalog.response.headers.get('cache-control')).toContain('s-maxage');
    expect((await request('/api/admin/store/products', { auth: false })).status).toBe(401);
  });

  it('builds the homepage from published products only (services stay in the CRM)', async () => {
    const featured = await product('Cámara destacada', `FEA-${randomUUID().slice(0, 8)}`, { category: 'Seguridad' });
    const normal = await product('Router disponible', `NOR-${randomUUID().slice(0, 8)}`);
    const serviceResult = await request('/api/admin/store/products', { method: 'POST', body: {
      kind: 'service', name: 'Instalación de cámaras', sku: `SRV-${randomUUID().slice(0, 8)}`,
      price: '850.00', cost: '200.00', quantity: 0, min_stock: 0, category: 'Instalación',
    } });
    expect(serviceResult.status).toBe(201);
    expect((await request('/api/store/catalog', { auth: false })).data.products).toEqual([]);
    await publish(featured.id, { featured: true });
    await publish(normal.id);
    await publish(serviceResult.data.product.id);
    const home = await request('/api/store/home', { auth: false });
    expect(home.data.featured).toBe(true);
    expect(home.data.products.map(row => row.id)).toEqual([featured.id, normal.id]);
    // FASE 1: los servicios NUNCA aparecen en el escaparate.
    expect(home.data.services).toEqual([]);
    expect(home.data.categories.sort()).toEqual(['Seguridad']);
    expect(home.data.total).toBe(2);
  });

  it('whitelists public fields and never leaks costs or internal CRM values', async () => {
    const p = await product('Cámara Fulltech', `CAM-${randomUUID().slice(0, 8)}`);
    expect((await publish(p.id, { featured: true })).status).toBe(200);
    const result = await request('/api/store/products/' + p.id, { auth: false });
    expect(result.status).toBe(200);
    expect(result.data.product).toMatchObject({ id: p.id, name: 'Cámara Fulltech', kind: 'product', price: 1250.5, currency: 'DOP', availability: 'available', featured: true });
    expect(Object.keys(result.data.product).sort()).toEqual(['availability', 'availabilityState', 'brand', 'category', 'currency', 'description', 'featured', 'id', 'imageUrl', 'images', 'kind', 'name', 'price', 'purchaseable', 'shortDescription', 'warranty'].sort());
    expect(JSON.stringify(result.data)).not.toMatch(/cost|supplier|margin|updated_by|stock_movements/i);
  });

  it('serves images only for active and published products', async () => {
    const hidden = await product('Oculto', `HID-${randomUUID().slice(0, 8)}`);
    expect((await request(`/api/store/products/${hidden.id}/image`, { auth: false })).status).toBe(404);
    await publish(hidden.id);
    const image = await request(`/api/store/products/${hidden.id}/image`, { auth: false });
    expect(image.status).toBe(200);
    expect(image.response.headers.get('content-type')).toBe('image/png');
    const current = (await request('/api/admin/store/products')).data.products.find(row => row.id === hidden.id);
    const deactivated = await request(`/api/admin/store/products/${hidden.id}`, { method: 'PATCH', body: {
      version: current.version, kind: 'product', name: current.name, sku: current.sku,
      price: current.price_cents / 100, cost: current.cost_cents / 100, quantity: current.quantity,
      min_stock: current.min_stock, track_stock: true, active: false, category: current.category,
      image: IMAGE,
    } });
    expect(deactivated.status).toBe(200);
    expect((await request('/api/store/catalog?q=oculto', { auth: false })).data.products).toEqual([]);
    expect((await request(`/api/store/products/${hidden.id}/image`, { auth: false })).status).toBe(404);
  });

  it('keeps published products in sync, hides services and archives without losing history', async () => {
    const created = await product('Producto sincronizado', `SYN-${randomUUID().slice(0, 8)}`);
    const serviceResult = await request('/api/admin/store/products', { method: 'POST', body: {
      kind: 'service', name: 'Servicio sincronizado', sku: `SRV-${randomUUID().slice(0, 8)}`,
      price: '900.00', cost: '300.00', quantity: 0, min_stock: 0, category: 'Soporte',
    } });
    expect(serviceResult.status).toBe(201);
    const service = serviceResult.data.product;
    expect((await request('/api/store/catalog?kind=all&limit=48', { auth: false })).data.products).toEqual([]);
    await publish(created.id);
    await publish(service.id);
    const catalog = await request('/api/store/catalog?kind=all&limit=48', { auth: false });
    expect(catalog.data.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, kind: 'product' }),
    ]));
    expect(catalog.data.products.some(row => row.id === service.id)).toBe(false);
    const archived = await request(`/api/admin/store/products/${created.id}`, { method: 'DELETE' });
    expect(archived.status).toBe(200);
    expect(archived.data.archived).toMatchObject({ id: created.id, archived: true });
    expect((await request('/api/store/catalog?q=sincronizado', { auth: false })).data.products).toEqual([]);
    expect((await request('/api/store/catalog?q=sincronizado', { auth: false })).data.products).toEqual([]);
    expect((await request(`/api/store/products/${created.id}`, { auth: false })).status).toBe(404);
    const admin = await request('/api/admin/store/products');
    expect(admin.data.products.some(row => row.id === created.id)).toBe(false);
    expect(admin.data.movements.some(move => move.product_id === created.id && move.type === 'INITIAL')).toBe(true);
    const restored = await request(`/api/admin/store/products/${created.id}/restore`, { method: 'POST', body: {} });
    expect(restored.status).toBe(200);
    expect(restored.data.product).toMatchObject({ id: created.id, archived: false, active: false });
    expect((await request('/api/store/catalog?q=sincronizado', { auth: false })).data.products).toEqual([]);
    const legacy = admin.data.products.find(row => row.legacy);
    expect((await request(`/api/admin/store/products/${legacy.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('supports bounded pagination, category and normalized search', async () => {
    const a = await product('Cámara Ágil', `CAM-${randomUUID().slice(0, 8)}`);
    const b = await product('Cámara Interior', `CAM-${randomUUID().slice(0, 8)}`);
    const c = await product('Router Casa', `RTR-${randomUUID().slice(0, 8)}`);
    for (const p of [a, b, c]) await publish(p.id);
    const first = await request('/api/store/catalog?limit=1&page=1', { auth: false });
    const second = await request('/api/store/catalog?limit=1&page=2', { auth: false });
    expect(first.data.pagination).toMatchObject({ page: 1, limit: 1, total: 3, pages: 3 });
    expect(first.data.products[0].id).not.toBe(second.data.products[0].id);
    const search = await request('/api/store/catalog?q=camara&limit=48', { auth: false });
    expect(search.data.products.map(item => item.id).sort()).toEqual([a.id, b.id].sort());
    expect((await request('/api/store/catalog?limit=200', { auth: false })).data.pagination.limit).toBe(48);
  });

  it('invalidates the public projection immediately after unpublishing', async () => {
    const p = await product('Retirable', `RET-${randomUUID().slice(0, 8)}`);
    await publish(p.id);
    expect((await request('/api/store/catalog?q=retirable', { auth: false })).data.products).toHaveLength(1);
    const removed = await request(`/api/admin/store/products/${p.id}/publication`, { method: 'POST', body: { status: 'unpublished' } });
    expect(removed.status).toBe(200);
    expect((await request('/api/store/catalog?q=retirable', { auth: false })).data.products).toEqual([]);
  });

  it('reflects CRM edits, stock availability and image access without stale public data', async () => {
    const p = await product('Router inicial', `UPD-${randomUUID().slice(0, 8)}`, { description: 'Nota interna para el equipo.' });
    await publish(p.id);

    const initial = (await request('/api/store/products/' + p.id, { auth: false })).data.product;
    expect(initial).toMatchObject({ name: 'Router inicial', price: 1250.5, availability: 'available' });
    expect((await request('/api/store/catalog?q=router', { auth: false })).data.products).toHaveLength(1);

    const edit = await request(`/api/admin/store/products/${p.id}`, { method: 'PATCH', body: {
      version: p.version, kind: 'product', name: 'Router actualizado', sku: p.sku,
      price: '1499.00', cost: '600.25', quantity: 5, min_stock: 1,
      track_stock: true, active: true, category: 'Redes', description: 'Nota interna actualizada.',
      store_public_name: 'Router doble banda', store_short_description: 'Conexión estable para el hogar.',
      store_public_description: 'Fácil instalación y cobertura confiable.', store_brand: 'Conecta', image: IMAGE,
    } });
    expect(edit.status).toBe(200);

    const updated = (await request('/api/store/products/' + p.id, { auth: false })).data.product;
    expect(updated).toMatchObject({ name: 'Router doble banda', category: 'Redes', price: 1499, brand: 'Conecta', shortDescription: 'Conexión estable para el hogar.', description: 'Fácil instalación y cobertura confiable.' });
    expect(JSON.stringify(updated)).not.toContain('Nota interna');
    expect((await request('/api/store/catalog?q=conecta', { auth: false })).data.products.map(item => item.id)).toEqual([p.id]);

    const stock = await request(`/api/admin/store/products/${p.id}/stock`, { method: 'POST', body: {
      type: 'out', quantity: 4, requestId: `stock_${randomUUID().replaceAll('-', '')}`,
    } });
    expect(stock.status).toBe(200);
    expect((await request('/api/store/products/' + p.id, { auth: false })).data.product.availability).toBe('low_stock');
    expect((await request(`/api/store/products/${p.id}/image`, { auth: false })).status).toBe(200);

    await publish(p.id, { status: 'unpublished' });
    expect((await request(`/api/store/products/${p.id}/image`, { auth: false })).status).toBe(404);
    expect((await request('/api/store/catalog?q=conecta', { auth: false })).data.products).toEqual([]);
  });

  it('validates query filters and leaves publication unavailable to non-admin users', async () => {
    const p = await product('Admin only', `ADM-${randomUUID().slice(0, 8)}`);
    const nonAdmin = await fetch(`${app.url}/api/admin/store/products/${p.id}/publication`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'published' }) });
    expect(nonAdmin.status).toBe(401);
    expect((await request('/api/store/catalog?kind=internal', { auth: false })).status).toBe(400);
    expect((await request('/api/store/catalog?limit=0', { auth: false })).data.pagination.limit).toBe(24);
  });
});
