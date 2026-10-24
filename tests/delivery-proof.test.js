// @vitest-environment node
/*
 * CÓDIGO DE ENTREGA — ENDURECIMIENTO.
 *
 * Se comprueba que el código:
 *   · se valida SOLO en el servidor y nunca se devuelve al repartidor;
 *   · caduca,
 *   · se bloquea tras varios intentos fallidos,
 *   · no se puede reutilizar tras confirmar,
 *   · se invalida al reasignar,
 *   · deja rastro en auditoría sin guardar el código.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startCrmServer } from '../server/crm-server.mjs';

const TOKEN = 'proof-test-token';
const PHONE = '+18095550101';

let app;
let dir;
let admin;

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

async function readyOrder() {
  const customer = await call('pos/customers', { name: 'Cliente Código', phone: '8095559001' });
  const created = await call('orders', {
    name: customer.data?.customer?.name ?? 'Cliente Código',
    phone: '8095559001',
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  });
  const orderId = created.data?.item?.id ?? created.data?.order?.id ?? created.data?.id;
  await call(`orders/${orderId}/courier/assign`, { contactPhone: PHONE });
  const session = await courier('/api/courier/login', {
    method: 'POST',
    body: { phone: PHONE, pin: '123456' },
  });
  const token = session.data.token;
  await courier(`/api/courier/orders/${orderId}/start`, { token, method: 'POST', body: {} });
  return { orderId, token };
}

async function storedProof(orderId) {
  const rows = await app.ctx.store.listAdmin({ limit: 5000 });
  const row = rows.find((item) => item.id === orderId);
  const order = JSON.parse(row.orderJson ?? row.order_json);
  return order.delivery?.proof ?? null;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'phyto-proof-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'proof.sqlite'),
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
  ]);
  await call('couriers', {
    kind: 'EXTERNAL',
    phone: PHONE,
    displayName: 'Mensajero Uno',
    contactId: 'contact-1',
    appAccess: true,
    pin: '123456',
  });
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('código de entrega', () => {
  it('se genera con caducidad y no se expone al repartidor', async () => {
    const { orderId, token } = await readyOrder();
    const created = await call(`orders/${orderId}/delivery-code`, {});
    expect(created.status).toBe(200);
    expect(created.data.code).toMatch(/^\d{4}$/);

    const proof = await storedProof(orderId);
    expect(proof.hash).toBeTruthy();
    expect(proof.hash).not.toBe(created.data.code);
    expect(Date.parse(proof.expires_at)).toBeGreaterThan(Date.now());

    /* El detalle que ve el repartidor no incluye el código ni su hash. */
    const detail = await courier(`/api/courier/orders/${orderId}`, { token });
    const raw = JSON.stringify(detail.data);
    expect(raw).not.toContain(created.data.code);
    expect(raw).not.toContain(proof.hash);
  });

  it('un código incorrecto suma intentos y bloquea tras el máximo', async () => {
    const { orderId, token } = await readyOrder();
    await call(`orders/${orderId}/delivery-code`, {});
    let last = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last = await courier(`/api/courier/orders/${orderId}/deliver`, {
        token,
        method: 'POST',
        body: { proofCode: '0000', cashReceivedCents: 1 },
      });
    }
    expect(last.status).toBe(429);
    expect(last.data.error).toBe('proof_locked');

    const proof = await storedProof(orderId);
    expect(proof.attempts).toBeGreaterThanOrEqual(5);
  });

  it('un código vencido no se acepta', async () => {
    const { orderId, token } = await readyOrder();
    await call(`orders/${orderId}/delivery-code`, {});
    const rows = await app.ctx.store.listAdmin({ limit: 5000 });
    const row = rows.find((item) => item.id === orderId);
    const order = JSON.parse(row.orderJson ?? row.order_json);
    order.delivery.proof.expires_at = new Date(Date.now() - 60_000).toISOString();
    await app.ctx.store.update(orderId, { orderJson: JSON.stringify(order) });

    const attempt = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: '1234', cashReceivedCents: 1 },
    });
    expect(attempt.status).toBe(409);
    expect(attempt.data.error).toBe('proof_expired');
  });

  it('el código válido se usa una sola vez', async () => {
    const { orderId, token } = await readyOrder();
    const code = (await call(`orders/${orderId}/delivery-code`, {})).data.code;
    const probe = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code },
    });
    const delivered = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code, cashReceivedCents: probe.data.expected_cents },
    });
    expect(delivered.status).toBe(200);
    expect((await storedProof(orderId)).used_at).toBeTruthy();

    const again = await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: code, cashReceivedCents: 1 },
    });
    expect(again.status).toBe(409);
  });

  it('reasignar invalida el código anterior', async () => {
    const { orderId } = await readyOrder();
    await call(`orders/${orderId}/delivery-code`, {});
    expect(await storedProof(orderId)).toBeTruthy();

    await app.ctx.settings.write('delivery_contacts', [
      { id: 'contact-1', name: 'Mensajero Uno', phone: PHONE, shareOrders: true },
      { id: 'contact-2', name: 'Mensajero Dos', phone: '+18095550102', shareOrders: true },
    ]);
    const reassigned = await call(`orders/${orderId}/courier/assign`, { contactPhone: '+18095550102' });
    expect(reassigned.status).toBe(200);
    expect(await storedProof(orderId)).toBeNull();
  });

  it('el código intentado no se guarda en ningún sitio del pedido', async () => {
    const { orderId, token } = await readyOrder();
    await call(`orders/${orderId}/delivery-code`, {});
    await courier(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: { proofCode: '9999', cashReceivedCents: 1 },
    });
    const rows = await app.ctx.store.listAdmin({ limit: 5000 });
    const row = rows.find((item) => item.id === orderId);
    const stored = String(row.orderJson ?? row.order_json);
    expect(stored).not.toContain('9999');
    expect((await storedProof(orderId)).attempts).toBe(1);
  });
});
