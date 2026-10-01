// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-inventario-123';

const apps = [];
const dirs = [];

async function newApp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-inv-'));
  dirs.push(dir);
  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'inventory.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });
  const login = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  app.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  apps.push(app);
  return app;
}

const call = (app, route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: app.cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());

async function restock(app, quantity, unitCost = '126.66', reason = 'Inventario inicial') {
  return call(app, '/api/admin/inventory/restock', {
    method: 'POST',
    body: JSON.stringify({ quantity, unitCost, reason }),
  });
}

async function deliveredOrder(app, overrides = {}) {
  return json(
    await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cliente Inventario',
        phone: '8095550101',
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        paymentMethod: 'CASH',
        status: 'entregado',
        ...overrides,
      }),
    }),
  );
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('inventario, costo y reportes', () => {
  it('expone las 7 presentaciones con costo por capsula y stock derivado del ledger', async () => {
    const app = await newApp();
    const body = await json(await call(app, '/api/admin/inventory'));

    expect(body.presentations.map((item) => item.capsule_quantity)).toEqual([5, 7, 10, 15, 20, 30, 60]);
    expect(body.product.current_unit_cost_cents).toBe(12666);
    expect(body.stock).toBe(0);
    expect(body.initialized).toBe(false);
  });

  it('registra venta entregada, separa delivery y reporta utilidad bruta historica', async () => {
    const app = await newApp();
    await restock(app, 100);

    const created = await deliveredOrder(app, { name: 'Ana Inventario', deliveryFee: 250 });

    expect(created.ok).toBe(true);
    expect(created.order.delivery_fee).toBe(250);
    expect(created.order.items[0].product_cost_snapshot_cents).toBe(126660);
    expect(created.order.items[0].gross_profit_snapshot_cents).toBe(123340);

    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(90);

    const report = await json(await call(app, '/api/admin/reports/sales?period=hoy'));
    expect(report.report.summary).toMatchObject({
      orders: 1,
      capsules_sold: 10,
      product_revenue_cents: 250000,
      delivery_revenue_cents: 25000,
      total_collected_cents: 275000,
      product_cost_cents: 126660,
      gross_product_profit_cents: 123340,
    });
    expect(report.report.byPresentation[0]).toMatchObject({
      variant_id: 'capsules_10',
      capsules: 10,
      product_cost_cents: 126660,
    });
  });

  it('conserva el costo historico aunque cambie el costo vigente despues de vender', async () => {
    const app = await newApp();
    await restock(app, 100);
    await deliveredOrder(app, { name: 'Luis Historico', phone: '8095550202' });
    await call(app, '/api/admin/inventory/cost', { method: 'POST', body: JSON.stringify({ unitCost: '200.00' }) });

    const report = await json(await call(app, '/api/admin/reports/sales?period=hoy'));
    expect(report.report.summary.product_cost_cents).toBe(126660);
    expect(report.report.summary.gross_product_profit_cents).toBe(123340);
  });

  it('bloquea una venta entregada si no hay capsulas suficientes', async () => {
    const app = await newApp();
    await restock(app, 8);

    const response = await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Marta Stock',
        phone: '8095550303',
        items: [{ variantId: 'capsules_10', quantity: 1 }],
        paymentMethod: 'TRANSFER',
        status: 'entregado',
      }),
    });
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body.error).toBe('insufficient_stock');
    expect(body.available).toBe(8);
    expect(body.required).toBe(10);
  });

  it('revierte stock una sola vez al cancelar una venta entregada', async () => {
    const app = await newApp();
    await restock(app, 20);
    const created = await deliveredOrder(app, { name: 'Rosa Reversa', phone: '8095550404' });

    const first = await call(app, `/api/admin/orders/${created.item.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cliente anuló la compra' }),
    });
    const second = await call(app, `/api/admin/orders/${created.item.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Intento duplicado' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(20);
    expect(inventory.movements.filter((row) => row.type === 'SALE_REVERSAL')).toHaveLength(1);
  });

  it('exige metodo de pago al registrar ventas', async () => {
    const app = await newApp();
    const response = await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Pago Requerido',
        phone: '8095550102',
        items: [{ variantId: 'capsules_5', quantity: 1 }],
      }),
    });
    const data = await json(response);

    expect(response.status).toBe(422);
    expect(data.error).toBe('payment_method_required');
    expect(data.methods).toEqual(['CASH', 'TRANSFER']);
  });

  it('acepta efectivo y transferencia y los reporta sin mezclar caja con inventario', async () => {
    const app = await newApp();
    await restock(app, 30);

    const cash = await deliveredOrder(app, { phone: '8095550445', paymentMethod: 'CASH' });
    const transfer = await deliveredOrder(app, { phone: '8095550446', paymentMethod: 'TRANSFER' });

    expect(cash.order.payment_method).toBe('CASH');
    expect(transfer.order.payment_method).toBe('TRANSFER');
    const report = await json(await call(app, '/api/admin/reports/sales?period=hoy'));
    expect(report.report.sales.map((row) => row.payment_method).sort()).toEqual(['CASH', 'TRANSFER']);
  });

  it('serializa cancelaciones concurrentes y restaura inventario una sola vez', async () => {
    const app = await newApp();
    await restock(app, 20);
    const created = await deliveredOrder(app, { name: 'Doble Click', phone: '8095550447' });

    const attempts = await Promise.all(
      ['Primer clic', 'Segundo clic'].map(async (reason) => {
        const response = await call(app, `/api/admin/orders/${created.item.id}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        return { status: response.status, data: await json(response) };
      }),
    );

    expect(attempts.map((row) => row.status).sort()).toEqual([200, 409]);
    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(20);
    expect(inventory.movements.filter((row) => row.order_id === created.item.id && row.type === 'SALE_REVERSAL')).toHaveLength(1);
  });

  it('calcula costo y utilidad de 30 y 60 capsulas con centavos exactos', async () => {
    const app = await newApp();
    await restock(app, 100);

    await deliveredOrder(app, {
      phone: '8095550505',
      items: [
        { variantId: 'capsules_30', quantity: 1 },
        { variantId: 'capsules_60', quantity: 1 },
      ],
    });

    const report = await json(await call(app, '/api/admin/reports/sales?period=hoy'));
    expect(report.report.summary).toMatchObject({
      capsules_sold: 90,
      product_revenue_cents: 1600000,
      product_cost_cents: 1139940,
      gross_product_profit_cents: 460060,
    });
    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(10);
  });

  it('editar una venta entregada 10→15 descuenta solo 5 adicionales y 15→7 devuelve 8', async () => {
    const app = await newApp();
    await restock(app, 100);
    const created = await deliveredOrder(app, { phone: '8095550606' });
    expect((await json(await call(app, '/api/admin/inventory'))).stock).toBe(90);

    const up = await json(
      await call(app, `/api/admin/orders/${created.item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ variantId: 'capsules_15', quantity: 1 }] }),
      }),
    );
    expect(up.ok).toBe(true);
    expect((await json(await call(app, '/api/admin/inventory'))).stock).toBe(85);

    const down = await json(
      await call(app, `/api/admin/orders/${created.item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ items: [{ variantId: 'capsules_7', quantity: 1 }] }),
      }),
    );
    expect(down.ok).toBe(true);
    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(93);
    expect(inventory.movements.filter((row) => row.order_id === created.item.id && row.type === 'SALE')).toHaveLength(2);
    expect(inventory.movements.filter((row) => row.order_id === created.item.id && row.type === 'SALE_REVERSAL')).toHaveLength(1);
  });

  it('ajustes y ledger reconcilian con el stock mostrado', async () => {
    const app = await newApp();
    await restock(app, 100);
    await call(app, '/api/admin/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify({ direction: 'in', quantity: 50, reason: 'Conteo inicial ampliado' }),
    });
    await deliveredOrder(app, { phone: '8095550707', items: [{ variantId: 'capsules_30', quantity: 1 }] });
    await call(app, '/api/admin/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify({ direction: 'out', quantity: 5, reason: 'Muestras' }),
    });

    const inventory = await json(await call(app, '/api/admin/inventory'));
    const ledgerStock = inventory.movements.reduce((sum, row) => sum + Number(row.quantity_delta), 0);
    expect(inventory.stock).toBe(115);
    expect(ledgerStock).toBe(inventory.stock);
  });

  it('dos ventas concurrentes no pueden vender el mismo stock', async () => {
    const app = await newApp();
    await restock(app, 10);

    const bodies = await Promise.all(
      ['8095550801', '8095550802'].map(async (phone) => {
        const response = await call(app, '/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Concurrente',
            phone,
            items: [{ variantId: 'capsules_7', quantity: 1 }],
            paymentMethod: 'CASH',
            status: 'entregado',
          }),
        });
        return { status: response.status, body: await json(response) };
      }),
    );

    expect(bodies.filter((row) => row.status === 201)).toHaveLength(1);
    expect(bodies.filter((row) => row.status === 409)).toHaveLength(1);
    const inventory = await json(await call(app, '/api/admin/inventory'));
    expect(inventory.stock).toBe(3);
    expect(inventory.movements.filter((row) => row.type === 'SALE')).toHaveLength(1);
  });
});
