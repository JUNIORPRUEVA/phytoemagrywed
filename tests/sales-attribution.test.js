// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'clave-attribution-123';
const APP_SECRET = 'app-secret-attribution';

const apps = [];
const tmpDirs = [];

async function newApp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phyto-attribution-'));
  tmpDirs.push(dir);
  const app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'crm.sqlite'),
    token: TOKEN,
    quiet: true,
    metaAppSecret: APP_SECRET,
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

afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const json = async (response) => JSON.parse(await response.text());

async function call(app, route, options = {}) {
  return fetch(`${app.url}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(app.cookie ? { cookie: app.cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function signed(body) {
  const raw = JSON.stringify(body);
  return `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
}

function inbound(id, body, referral = null) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '18095550000', phone_number_id: 'PN123' },
              contacts: [{ profile: { name: 'Cliente Meta' }, wa_id: '18095550123' }],
              messages: [
                {
                  from: '18095550123',
                  id,
                  timestamp: '1760000000',
                  type: 'text',
                  text: { body },
                  ...(referral ? { referral } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function waitFor(check) {
  for (let i = 0; i < 80; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timeout');
}

describe('sales attribution', () => {
  it('chat con referral Meta marca conversación AUTO y copia snapshot al pedido', async () => {
    const app = await newApp();
    const body = inbound('wamid.ATTR1', 'Hola, quiero comprar', {
      source_type: 'ad',
      source_url: 'https://fb.me/xyz',
      headline: 'Phytoemagry promo',
      body: 'Compra por WhatsApp',
      ctwa_clid: 'ctwa-123',
    });
    const response = await fetch(`${app.url}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signed(body) },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);

    const conversation = await waitFor(async () => {
      const data = await json(await call(app, '/api/admin/conversations'));
      return data.conversations.find((row) => row.customer?.phone_e164 === '+18095550123') ?? null;
    });
    expect(conversation.source).toBe('META_ADS');
    expect(conversation.source_origin).toBe('AUTO');
    expect(conversation.meta_attribution.ctwa_clid).toBe('ctwa-123');

    const created = await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: conversation.id,
        customerId: conversation.customer.id,
        variantId: 'capsules_5',
        quantity: 1,
        paymentMethod: 'CASH',
      }),
    });
    expect(created.status).toBe(201);
    const order = (await json(created)).order;
    expect(order.source).toBe('META_ADS');
    expect(order.source_origin).toBe('AUTO');
    expect(order.meta_attribution_snapshot.ctwa_clid).toBe('ctwa-123');
  });

  it('chat normal no se atribuye a Meta Ads solo por venir de WhatsApp', async () => {
    const app = await newApp();
    const body = inbound('wamid.ATTR2', 'Hola normal');
    await fetch(`${app.url}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signed(body) },
      body: JSON.stringify(body),
    });
    const conversation = await waitFor(async () => {
      const data = await json(await call(app, '/api/admin/conversations'));
      return data.conversations[0] ?? null;
    });
    expect(conversation.source).not.toBe('META_ADS');
  });

  it('pedido manual Meta queda MANUAL y el reporte separa ingresos por origen', async () => {
    const app = await newApp();
    const meta = await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ana Admin',
        phone: '8095557799',
        variantId: 'capsules_5',
        quantity: 1,
        paymentMethod: 'CASH',
        status: 'entregado',
        source: 'META_ADS',
        utm_campaign: 'campana-test',
        source_note: 'Cliente lo indicó por teléfono',
      }),
    });
    expect(meta.status).toBe(201);
    expect((await json(meta)).order).toMatchObject({ source: 'META_ADS', source_origin: 'MANUAL' });

    const organic = await call(app, '/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cliente Orgánico',
        phone: '8095557788',
        variantId: 'capsules_5',
        quantity: 1,
        paymentMethod: 'CASH',
        status: 'entregado',
        source: 'ORGANIC',
      }),
    });
    expect(organic.status).toBe(201);

    const report = (await json(await call(app, '/api/admin/reports/sales-by-source'))).report;
    const bySource = new Map(report.sources.map((row) => [row.source, row]));
    expect(bySource.get('META_ADS')).toMatchObject({ completed_sales: 1, manually_marked_meta: 1 });
    expect(bySource.get('ORGANIC')).toMatchObject({ completed_sales: 1 });
    expect(report.meta.roas_status).toBe('WAITING_FOR_AD_SPEND');
    expect(report.meta.breakdown[0]).toMatchObject({ kind: 'campaign', id: 'campana-test', sales: 1 });
  });
});
