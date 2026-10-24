// @vitest-environment node
/*
 * CUSTODIA DEL EFECTIVO (módulo financiero).
 *
 * Se prueba contra el servidor real y base temporal:
 *   · el cobro contra entrega crea un CARGO en custodia (no una ganancia);
 *   · rendir reduce el saldo solo cuando lo registra administración;
 *   · no se puede rendir más de lo pendiente, ni cero, ni duplicar;
 *   · la tarifa es configurable y sin tarifa NO se inventan ganancias;
 *   · el repartidor ve su propio saldo y no el de otro.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';
import { custodySummary, earningsFor, validateRemittance } from '../server/delivery-cash.mjs';

const TOKEN = 'cash-test-token';
const PHONE = '+18095550101';
const OTHER_PHONE = '+18095550102';

let app;
let dir;
let admin;
let courierId;

const call = async (route, body, auth = admin) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie: auth, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const courier = async (route, { token, method = 'GET', body } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

async function prepareCourier(phone, pin) {
  const account = await call('couriers', {
    kind: 'EXTERNAL',
    phone,
    displayName: `Mensajero ${phone.slice(-4)}`,
    contactId: phone === PHONE ? 'contact-1' : 'contact-2',
    appAccess: true,
    pin,
  });
  return account.data?.courier?.id ?? null;
}

async function cashOrderAssigned(phone) {
  const customer = await call('pos/customers', { name: 'Cliente Custodia', phone: '8095558001' });
  const created = await call('orders', {
    name: customer.data?.customer?.name ?? 'Cliente Custodia',
    phone: '8095558001',
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  });
  const orderId = created.data?.item?.id ?? created.data?.order?.id ?? created.data?.id;
  await call(`orders/${orderId}/courier/assign`, { contactPhone: phone });
  return orderId;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'phyto-cash-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'cash.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
  });
  const session = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  admin = session.headers.get('set-cookie').split(';')[0];
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-1', name: 'Mensajero Uno', phone: PHONE, shareOrders: true },
    { id: 'contact-2', name: 'Mensajero Dos', phone: OTHER_PHONE, shareOrders: true },
  ]);
  courierId = await prepareCourier(PHONE, '111222');
  await prepareCourier(OTHER_PHONE, '333444');
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reglas financieras (puras)', () => {
  it('el saldo pendiente es cobrado menos rendido, y no se puede rendir de más', () => {
    const rows = [
      { kind: 'charge', amount_cents: 170000, order_id: 'o1' },
      { kind: 'remittance', amount_cents: 100000 },
    ];
    const summary = custodySummary(rows, null);
    expect(summary.charged_cents).toBe(170000);
    expect(summary.remitted_cents).toBe(100000);
    expect(summary.pending_cents).toBe(70000);

    expect(validateRemittance(summary, 80000).error).toBe('amount_exceeds_pending');
    expect(validateRemittance(summary, 0).error).toBe('invalid_amount');
    expect(validateRemittance(summary, 70000).ok).toBe(true);
  });

  it('sin tarifa configurada no se inventan ganancias', () => {
    expect(earningsFor({ deliveredCount: 3, rateCents: null })).toMatchObject({
      configured: false,
      earned_cents: null,
    });
    expect(earningsFor({ deliveredCount: 3, rateCents: 5000 })).toMatchObject({
      configured: true,
      earned_cents: 15000,
    });
  });
});

describe('custodia sobre entregas reales', () => {
  it('la entrega contra efectivo crea un cargo en custodia, no una ganancia', async () => {
    const orderId = await cashOrderAssigned(PHONE);
    const session = await courier('/api/courier/login', {
      method: 'POST',
      body: { phone: PHONE, pin: '111222' },
    });
    const token = session.data.token;

    await courier(`/api/courier/orders/${orderId}/start`, { token, method: 'POST', body: {} });
    const codeResponse = await call(`orders/${orderId}/delivery-code`, {});
    const code = codeResponse.data.code;
    /* Primero sin importe: el servidor debe exigirlo (no cobra el saldo por su cuenta). */
    const probe = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code },
    });
    expect(probe.status).toBe(422);
    expect(probe.data.error).toBe('cash_amount_required');
    const expected = probe.data.expected_cents;

    const delivered = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code, cashReceivedCents: expected },
    });
    expect(delivered.status).toBe(200);
    expect(delivered.data.state).toBe('DELIVERED');

    const custody = await courier('/api/courier/custody', { token });
    expect(custody.status).toBe(200);
    expect(custody.data.custody.charged_cents).toBeGreaterThan(0);
    expect(custody.data.custody.remitted_cents).toBe(0);
    expect(custody.data.earnings.configured).toBe(false);
    expect(custody.data.note).toBe('Tarifa pendiente de configurar');
  });

  it('la rendición la registra administración y el saldo baja exactamente', async () => {
    const orderId = await cashOrderAssigned(PHONE);
    const session = await courier('/api/courier/login', {
      method: 'POST',
      body: { phone: PHONE, pin: '111222' },
    });
    const token = session.data.token;
    await courier(`/api/courier/orders/${orderId}/start`, { token, method: 'POST', body: {} });
    const code = (await call(`orders/${orderId}/delivery-code`, {})).data.code;
    const probe = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code },
    });
    await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code, cashReceivedCents: probe.data.expected_cents },
    });

    const before = await call('delivery-cash');
    const own = before.data.couriers.find((row) => row.courier_id === courierId);
    expect(own.pending_cents).toBeGreaterThan(0);

    const partial = await call('delivery-cash/remittance', {
      courierAccountId: courierId,
      amountCents: 50000,
      idempotencyKey: 'rend-1',
    });
    expect(partial.status).toBe(201);
    expect(partial.data.summary.pending_cents).toBe(own.pending_cents - 50000);

    /* Reintento con la misma clave: no duplica dinero. */
    const repeat = await call('delivery-cash/remittance', {
      courierAccountId: courierId,
      amountCents: 50000,
      idempotencyKey: 'rend-1',
    });
    expect(repeat.status).toBe(201);
    expect(repeat.data.duplicate).toBe(true);

    const after = await call('delivery-cash');
    const final = after.data.couriers.find((row) => row.courier_id === courierId);
    expect(final.pending_cents).toBe(own.pending_cents - 50000);
  });

  it('no se puede rendir más de lo pendiente', async () => {
    const attempt = await call('delivery-cash/remittance', {
      courierAccountId: courierId,
      amountCents: 1000,
    });
    expect(attempt.status).toBe(422);
    expect(attempt.data.error).toBe('amount_exceeds_pending');
  });

  it('un repartidor solo ve su propia custodia', async () => {
    const other = await courier('/api/courier/login', {
      method: 'POST',
      body: { phone: OTHER_PHONE, pin: '333444' },
    });
    const custody = await courier('/api/courier/custody', { token: other.data.token });
    expect(custody.status).toBe(200);
    expect(custody.data.custody.charged_cents).toBe(0);
    expect(custody.data.custody.pending_cents).toBe(0);
  });

  it('la tarifa se configura desde administración', async () => {
    const invalid = await call('delivery-rate', { rateCents: -5 });
    expect(invalid.status).toBe(422);
    const saved = await call('delivery-rate', { rateCents: 7500 });
    expect(saved.status).toBe(200);
    expect(saved.data.rate_cents).toBe(7500);
  });
});
