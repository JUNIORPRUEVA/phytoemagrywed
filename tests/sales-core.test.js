// @vitest-environment node
/**
 * S4 — SALES CORE: catálogo (fuente única), pedido desde la conversación y
 * comprobante.
 *
 * El servidor se arranca de verdad porque lo que importa es el recorrido
 * completo: el cliente escribe por WhatsApp → nace la conversación → desde ahí se
 * crea el pedido con el precio del catálogo → queda ligado al cliente y a la
 * conversación → se genera el comprobante.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { CATALOG_CURRENCY, catalogItems, computeOrderTotals, findCatalogItem } from '../src/lib/catalog.js';
import { buildOrder, buildReceipt, maskPhone, orderOf, receiptHtml } from '../server/orders.mjs';

const TOKEN = 'clave-ventas-123';
const APP_SECRET = 'secreto-de-prueba';
const PHONE = '18095550101';

let tmpDir;
let app;
let cookie = '';
let conversationId = '';
let customerId = '';

const call = (route, options = {}) =>
  fetch(`${app.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...(options.headers ?? {}) },
  });

const json = async (response) => JSON.parse(await response.text());
const text = async (response) => response.text();

async function inbound(id, body, from = PHONE) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Ana Ventas' }, wa_id: from }],
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
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

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'phyto-s4-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(tmpDir, 'phytoemagry.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
    schedulerEnabled: false,
  });
  const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  await inbound('wamid.S4-1', 'Hola, quiero comprar 2 frascos de 10 cápsulas');
  const conversations = await json(await call('/api/admin/conversations'));
  const conversation = conversations.conversations.find((row) => row.customer?.phone_e164 === `+${PHONE}`);
  conversationId = conversation.id;
  customerId = conversation.customer_id;
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('catálogo: UNA sola fuente de precios', () => {
  it('sale de product.config y trae los 7 frascos reales', () => {
    const catalog = catalogItems();
    expect(catalog.map((item) => item.capsules)).toEqual([5, 7, 10, 15, 20, 30, 60]);
    expect(findCatalogItem('capsules_10')).toMatchObject({ capsules: 10, price: 2500, currency: CATALOG_CURRENCY });
    expect(findCatalogItem('capsules_60')).toMatchObject({ completeBottle: true, price: 10000 });
    expect(findCatalogItem('no-existe')).toBeNull();
  });

  it('calcula cantidad, subtotal y total con el precio del frasco', () => {
    const totals = computeOrderTotals([{ variantId: 'capsules_10', quantity: 2 }]);
    expect(totals).toMatchObject({ subtotal: 5000, total: 5000, units: 2, totalCapsules: 20 });
    // Varias líneas se suman.
    const mixto = computeOrderTotals([
      { variantId: 'capsules_5', quantity: 1 },
      { variantId: 'capsules_30', quantity: 1 },
    ]);
    expect(mixto.total).toBe(1250 + 6000);
    expect(mixto.itemCount).toBe(2);
  });

  it('un descuento nunca supera el subtotal y un frasco desconocido falla', () => {
    const conDescuento = computeOrderTotals([{ variantId: 'capsules_5', quantity: 1 }], { discount: 99999 });
    expect(conDescuento.discount).toBe(1250);
    expect(conDescuento.total).toBe(0);
    expect(() => computeOrderTotals([{ variantId: 'capsules_999' }])).toThrow(/Frasco desconocido/);
    expect(() => computeOrderTotals([])).toThrow(/no tiene frascos/);
  });

  it('el panel pide el catálogo al servidor (no repite precios)', async () => {
    const response = await call('/api/admin/catalog');
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.catalog).toHaveLength(7);
    expect(body.catalog[2]).toMatchObject({ id: 'capsules_10', price: 2500, label: 'Frasco de 10 cápsulas' });
  });
});

describe('factura de compra (no «factura fiscal»)', () => {
  it('enmascara el teléfono y no afirma nada médico', () => {
    expect(maskPhone('+18095550101')).toBe('+1809••• ••01');
    expect(maskPhone(null)).toBeNull();
    const order = { order_number: 'PE-ABC123', created_at: new Date().toISOString(), items: [], subtotal: 2500, discount: 0, total: 2500, currency: 'DOP', status: 'entregado' };
    const receipt = buildReceipt({ order, customer: { name: 'Ana', phone_e164: '+18095550101' } });
    expect(receipt.document).toBe('Factura de compra');
    expect(receipt.phone_masked).toBe('+1809••• ••01');
    expect(receipt.status_label).toBe('Entregado');
    expect(receipt.thanks).toMatch(/gracias/i);
    // Se presenta como factura de compra, sin afirmar que sea factura fiscal.
    expect(receipt.document).toMatch(/factura de compra/i);
    expect(receipt.document).not.toMatch(/factura fiscal/i);
    expect(receipt.note).not.toMatch(/factura fiscal/i);
  });

  it('el HTML se imprime bien y no filtra el teléfono completo', () => {
    const order = buildOrder({ items: [{ variantId: 'capsules_10', quantity: 1 }], paymentMethod: 'CASH' }).order;
    const html = receiptHtml(buildReceipt({ order, customer: { name: 'Ana', phone_e164: '+18095550101' } }));
    expect(html).toContain('Factura de compra');
    expect(html).toContain('RD$ 2,500');
    expect(html).not.toContain('+18095550101');
    expect(html).toContain('@media print');
  });
});

describe('pedido desde la conversación', () => {
  let orderId = '';

  it('crea el pedido con el cliente y la conversación precargados', async () => {
    const response = await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        conversationId,
        channel: 'whatsapp',
        items: [{ variantId: 'capsules_10', quantity: 2 }],
        paymentMethod: 'TRANSFER',
        notes: 'Confirmó por WhatsApp',
      }),
    });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.order.total).toBe(5000);
    expect(body.order.payment_method).toBe('TRANSFER');
    expect(body.order.order_number).toMatch(/^PE-[0-9A-F]{6}$/);
    expect(body.item.customer_id).toBe(customerId);
    expect(body.item.conversation_id).toBe(conversationId);
    // La primera línea sigue copiada en las columnas de siempre (legacy intacto).
    expect(body.item.variant_id).toBe('capsules_10');
    expect(body.item.quantity).toBe(2);
    expect(body.item.unit_price).toBe(2500);
    expect(body.item.total).toBe(5000);
    expect(body.receipt.phone_masked).toContain('•••');
    orderId = body.item.id;
  });

  it('el pedido se lee con su detalle y su comprobante', async () => {
    const response = await call(`/api/admin/orders/${orderId}`);
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.order.items[0]).toMatchObject({ variantId: 'capsules_10', quantity: 2, subtotal: 5000 });
    expect(body.customer.id).toBe(customerId);
    expect(body.receipt.order_number).toBe(body.order.order_number);
  });

  it('el comprobante se sirve como documento imprimible', async () => {
    const response = await call(`/api/admin/orders/${orderId}/receipt`);
    const html = await text(response);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Factura de compra');
    expect(html).toContain('PE-');
  });

  it('modificar el pedido recalcula el total (y las columnas de siempre)', async () => {
    const response = await call(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: [{ variantId: 'capsules_30', quantity: 2 }], discount: 500 }),
    });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.order.subtotal).toBe(12000);
    expect(body.order.total).toBe(11500);
    expect(body.item.total).toBe(11500);
    expect(body.item.variant_id).toBe('capsules_30');
    expect(body.item.order_json).toContain('"discount":500');
  });

  it('el pedido aparece ligado al cliente en su ficha 360', async () => {
    const response = await call(`/api/admin/customers/${customerId}`);
    const body = await json(response);
    expect(body.purchases.some((row) => row.id === orderId)).toBe(true);
    expect(body.commercial_state).toBe('PEDIDO_CREADO');
  });

  it('rechaza un frasco que no está en el catálogo', async () => {
    const response = await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ customerId, items: [{ variantId: 'capsules_999', quantity: 1 }], paymentMethod: 'CASH' }),
    });
    expect(response.status).toBe(422);
    expect((await json(response)).error).toMatch(/invalid_variant/);
  });

  it('no enlaza la conversación de OTRO cliente', async () => {
    await inbound('wamid.S4-2', 'Hola, soy otro cliente', '18095550202');
    const conversations = await json(await call('/api/admin/conversations'));
    const ajena = conversations.conversations.find((row) => row.customer?.phone_e164 === '+18095550202');
    const response = await call('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ customerId, conversationId: ajena.id, items: [{ variantId: 'capsules_5', quantity: 1 }], paymentMethod: 'CASH' }),
    });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.item.conversation_id).toBeNull();
  });
});

describe('pedidos antiguos (legacy) siguen intactos', () => {
  it('un order_intent sin detalle se reconstruye con UNA línea', async () => {
    const response = await call('/api/crm', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: '1.1',
        type: 'order_intent',
        id: 'legacy-s4-1',
        createdAt: new Date().toISOString(),
        variantId: 'capsules_20',
        variantName: '20 cápsulas',
        capsules: 20,
        quantity: 1,
        unitPrice: 5000,
        total: 5000,
        currency: 'DOP',
        customer: { name: 'Legacy', phone: '+18095550303' },
      }),
    });
    expect(response.status).toBe(202);
    const detail = await call('/api/admin/orders/legacy-s4-1');
    const body = await json(detail);
    expect(detail.status).toBe(200);
    expect(body.order.source).toBe('legacy');
    expect(body.order.items).toHaveLength(1);
    expect(body.order.total).toBe(5000);
    expect(body.order.order_number).toMatch(/^PE-/);
    // Y el CSV de siempre sigue saliendo.
    const csv = await call('/api/crm/export.csv?limit=100');
    expect(csv.status).toBe(200);
    expect((await text(csv)).includes('Legacy')).toBe(true);
  });

  it('orderOf() no rompe con un objeto vacío', () => {
    expect(orderOf(null)).toBeNull();
    expect(orderOf({ type: 'lead' })).toBeNull();
  });
});
