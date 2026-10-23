// @vitest-environment node
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';
import { businessDate, offerPricing } from '../server/store-catalog.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
let app, dir, cookie;

async function request(route, { method = 'GET', body, auth = cookie } = {}) {
  const response = await fetch(app.url + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { cookie: auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

async function create(patch = {}) {
  return request('/api/admin/store/products', { method: 'POST', body: {
    kind: 'product', name: `Oferta UAT ${randomUUID().slice(0, 6)}`, sku: `OFR-${randomUUID().slice(0, 8)}`,
    price: '800.00', cost: '400.00', quantity: 5, min_stock: 0, image: IMAGE,
    compare_at_price: '1000.00', offer_price: '800.00', offer_active: true, daily_offer: true, ...patch,
  } });
}

async function publish(id, patch = {}) {
  return request(`/api/admin/store/products/${id}/publication`, { method: 'POST', body: { status: 'published', ...patch } });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-daily-offers-'));
  app = await startCrmServer({ port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'catalog.sqlite'), token: 'daily-offers-test-token', quiet: true, schedulerEnabled: false });
  const login = await fetch(app.url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'daily-offers-test-token' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

it('expone ofertas activas con precio de oferta y mantiene la selección diaria estable', async () => {
  const first = await create({ name: 'Taladro diario', sku: 'DAILY-001', compare_at_price: '4500', offer_price: '3250', price: '4500' });
  const second = await create({ name: 'Router diario', sku: 'DAILY-002', compare_at_price: '2400', offer_price: '1800', price: '2400' });
  const regular = await create({ name: 'Producto normal', sku: 'DAILY-003', compare_at_price: '', offer_price: '', offer_active: false, daily_offer: false });
  await publish(first.data.product.id); await publish(second.data.product.id); await publish(regular.data.product.id);

  const detail = await request(`/api/store/products/${first.data.product.id}`, { auth: '' });
  expect(detail.data.product).toMatchObject({ price: 3250, compareAtPrice: 4500, discountPercent: 28 });
  const home = await request('/api/store/home', { auth: '' });
  expect(home.data.dailyOffers.map(item => item.id)).toEqual([first.data.product.id, second.data.product.id]);
  const again = await request('/api/store/home', { auth: '' });
  expect(again.data.dailyOffers.map(item => item.id)).toEqual(home.data.dailyOffers.map(item => item.id));
  expect(home.data.dailyOffers.every(item => item.imageUrl && item.price < item.compareAtPrice)).toBe(true);

  const order = await request('/api/admin/orders', { method: 'POST', body: { name: 'Cliente UAT', phone: '8095550101', paymentMethod: 'CASH', status: 'entregado', items: [{ variantId: first.data.product.id, quantity: 1 }] } });
  expect(order.data.order.total).toBe(3250);
});

it('elige una sola oferta válida y excluye ofertas futuras, vencidas o sin disponibilidad', async () => {
  const valid = await create({ name: 'Oferta única', sku: 'DAILY-010' });
  const future = await create({ name: 'Oferta futura', sku: 'DAILY-011', offer_start_at: '2099-01-01T00:00:00Z' });
  const expired = await create({ name: 'Oferta vencida', sku: 'DAILY-012', offer_end_at: '2020-01-01T00:00:00Z' });
  const empty = await create({ name: 'Oferta sin existencia', sku: 'DAILY-013', quantity: 0 });
  await publish(valid.data.product.id); await publish(future.data.product.id); await publish(expired.data.product.id); await publish(empty.data.product.id);
  const home = await request('/api/store/home', { auth: '' });
  expect(home.data.dailyOffers.map(item => item.id)).toEqual([valid.data.product.id]);
  expect(home.data.dailyOffers.map(item => item.id)).not.toEqual(expect.arrayContaining([future.data.product.id, expired.data.product.id, empty.data.product.id]));
});

it('valida las fechas y precios de la oferta en el backend', async () => {
  const invalidPrice = await create({ name: 'Oferta inválida', sku: 'DAILY-020', compare_at_price: '900', offer_price: '950' });
  expect(invalidPrice.status).toBe(422);
  expect(invalidPrice.data.error).toBe('invalid_compare_at');
  const invalidDates = await create({ name: 'Fechas inválidas', sku: 'DAILY-021', offer_start_at: '2026-10-23T00:00:00Z', offer_end_at: '2026-10-22T00:00:00Z' });
  expect(invalidDates.status).toBe(422);
  expect(invalidDates.data.error).toBe('invalid_offer_dates');
  const unauthenticated = await request('/api/admin/store/products', { method: 'POST', auth: '', body: { kind: 'product', name: 'No autorizado', sku: 'DAILY-022', price: '10', cost: '5', offer_active: true, daily_offer: true } });
  expect(unauthenticated.status).toBe(401);
});

it('usa la zona horaria dominicana para la fecha comercial y el cálculo es determinista', () => {
  expect(businessDate(new Date('2026-10-22T03:30:00Z'))).toBe('2026-10-21');
  expect(businessDate(new Date('2026-10-22T05:30:00Z'))).toBe('2026-10-22');
  const product = { price_cents: 325000, compare_at_cents: 450000, offer_price_cents: 325000, offer_active: true };
  expect(offerPricing(product, new Date('2026-10-22T12:00:00Z'))).toMatchObject({ active: true, priceCents: 325000, compareAtCents: 450000, discountPercent: 28 });
});
