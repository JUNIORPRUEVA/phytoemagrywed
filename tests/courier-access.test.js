// @vitest-environment node
/*
 * ACCESO MÓVIL DEL REPARTIDOR — Fase 04 (SOLO LECTURA).
 *
 * Lo que se demuestra aquí, con el servidor real y base temporal:
 *   · un repartidor autorizado entra y lee SOLO lo suyo;
 *   · tener el contacto guardado no da acceso: hace falta autorización explícita;
 *   · inactivo, sin acceso, de otra empresa o con token revocado/caducado no entra;
 *   · el token del móvil no abre nada de administración;
 *   · ninguna ruta del móvil escribe: pedidos, cobros, inventario y WhatsApp quedan igual.
 *
 * Sin WhatsApp real, sin red externa, sin producción.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { startCrmServer } from '../server/crm-server.mjs';
import { createCourierToken } from '../server/courier-app.mjs';

const TOKEN = 'courier-test-token';
const INTERNAL_PHONE = '+18095557000';
const EXTERNAL_PHONE = '+18095557001';
const OTHER_PHONE = '+18095557002';
const INTL_PHONE = '+34955550003';

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

const patch = async (route, body) => {
  const response = await fetch(`${app.url}/api/admin/${route}`, {
    method: 'PATCH',
    headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const courierCall = async (route, { token, method = 'GET', body, companyId } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(companyId ? { 'x-courier-company': companyId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const login = (phone, pin) => courierCall('/api/courier/login', { method: 'POST', body: { phone, pin } });

async function createUser({ username, displayName, role }) {
  const created = await call('users', { username, displayName, role, password: 'Clave-Reparto-1' });
  return created.data.user;
}

async function createOrder({ phone, status = 'nuevo' }) {
  const customer = await call('pos/customers', { name: `Cliente ${phone.slice(-4)}`, phone });
  const created = await call('orders', {
    name: customer.data.customer?.name ?? 'Cliente',
    phone,
    status,
    paymentMethod: 'CASH',
    items: [{ variantId: 'capsules_10', quantity: 1 }],
  });
  return created.data.item?.id ?? created.data.order?.id ?? created.data.id;
}

async function createCourierAccount(input) {
  return call('couriers', input);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'phyto-courier-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'courier.sqlite'),
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
  /* Contactos de reparto guardados: existen, pero por sí solos NO dan acceso a la app. */
  await app.ctx.settings.write('delivery_contacts', [
    { id: 'contact-ext', name: 'Mensajero Externo', phone: EXTERNAL_PHONE, shareOrders: true },
    { id: 'contact-other', name: 'Otro Mensajero', phone: OTHER_PHONE, shareOrders: true },
    { id: 'contact-intl', name: 'Mensajero Ajeno', phone: INTL_PHONE, shareOrders: true },
  ]);
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('identidad del repartidor', () => {
  it('un contacto guardado no entra solo: hace falta autorización explícita', async () => {
    const denied = await login(EXTERNAL_PHONE, '123456');
    expect(denied.status).toBe(401);
    expect(denied.data.error).toBe('invalid_credentials');

    const account = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    expect(account.status).toBe(201);
    expect(account.data.courier.app_access).toBe(true);
    expect(account.data.courier.credential_hash).toBeUndefined();

    const allowed = await login(EXTERNAL_PHONE, '123456');
    expect(allowed.status).toBe(200);
    expect(typeof allowed.data.token).toBe('string');
    expect(allowed.data.courier.credential_hash).toBeUndefined();
    expect(JSON.stringify(allowed.data)).not.toContain('pbkdf2');
  });

  it('no se puede autorizar un teléfono que no es contacto de reparto', async () => {
    const bad = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: '+18095557999',
      displayName: 'Intruso',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    expect(bad.status).toBe(422);
    expect(['contact_not_saved', 'phone_mismatch']).toContain(bad.data.error);
  });

  it('no duplica la misma persona ni el mismo teléfono', async () => {
    const first = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    expect(first.status).toBe(201);

    const twice = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo (otra vez)',
      contactId: 'contact-ext',
      appAccess: true,
      pin: 'abcdef',
    });
    expect(twice.status).toBe(409);
    expect(['duplicate_courier', 'phone_in_use']).toContain(twice.data.error);
  });

  it('un repartidor sin acceso autorizado o inactivo no entra', async () => {
    const manual = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: false,
      pin: '123456',
    });
    expect(manual.status).toBe(201);
    expect((await login(EXTERNAL_PHONE, '123456')).status).toBe(401);

    const withAccess = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: OTHER_PHONE,
      displayName: 'Otro Mensajero',
      contactId: 'contact-other',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(OTHER_PHONE, '123456');
    expect(session.status).toBe(200);

    const off = await patch(`couriers/${withAccess.data.courier.id}`, { active: false });
    expect(off.status).toBe(200);
    expect(off.data.courier.active).toBe(false);

    /* La sesión abierta muere con la desactivación: no basta con no volver a entrar. */
    const me = await courierCall('/api/courier/me', { token: session.data.token });
    expect(me.status).toBe(401);

    /* Y ya no puede volver a entrar. */
    expect((await login(OTHER_PHONE, '123456')).status).toBe(401);
  });

  it('rechaza una identidad empresarial no registrada desde el alta', async () => {
    const foreign = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: INTL_PHONE,
      displayName: 'Mensajero Ajeno',
      contactId: 'contact-intl',
      appAccess: true,
      companyId: 'otra-empresa',
      pin: '123456',
    });
    expect(foreign.status).toBe(422);
    expect(foreign.data.error).toBe('invalid_company');
    const denied = await login(INTL_PHONE, '123456');
    expect(denied.status).toBe(401);
  });

  it('un repartidor multiempresa ve solo la empresa seleccionada y la revocación corta su sesión', async () => {
    const phyto = await createOrder({ phone: '8095557901' });
    const fulltech = await createOrder({ phone: '8095557902' });
    const ambiguous = await createOrder({ phone: '8095557903' });
    for (const id of [phyto, fulltech, ambiguous]) {
      expect((await call(`orders/${id}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);
    }
    const item = await app.ctx.store.getAdmin(fulltech);
    const order = JSON.parse(item.order_json);
    order.origin = 'FULLTECH_STORE';
    order.company_id = 'fulltech';
    await app.ctx.store.update(fulltech, { orderJson: JSON.stringify(order) });
    const unknownItem = await app.ctx.store.getAdmin(ambiguous);
    const unknownOrder = JSON.parse(unknownItem.order_json);
    delete unknownOrder.company_id;
    unknownOrder.items = [{ variantId: 'unclassified-product', quantity: 1 }];
    await app.ctx.store.update(ambiguous, { orderJson: JSON.stringify(unknownOrder) });
    const account = await createCourierAccount({ kind: 'EXTERNAL', phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo', contactId: 'contact-ext', appAccess: true, pin: '123456' });
    expect(account.status).toBe(201);
    const courierId = account.data.courier.id;
    expect((await call(`couriers/${courierId}/companies`, { companyId: 'fulltech', active: true })).status).toBe(200);
    const token = (await login(EXTERNAL_PHONE, '123456')).data.token;
    const me = await courierCall('/api/courier/me', { token });
    expect(me.status).toBe(200);
    expect(me.data.companies.sort()).toEqual(['fulltech', 'phytoemagry']);
    expect((await courierCall('/api/courier/orders', { token })).status).toBe(409);
    const phytoList = await courierCall('/api/courier/orders', { token, companyId: 'phytoemagry' });
    const fulltechList = await courierCall('/api/courier/orders', { token, companyId: 'fulltech' });
    expect(phytoList.data.orders.map((row) => row.id)).toEqual([phyto]);
    expect(fulltechList.data.orders.map((row) => row.id)).toEqual([fulltech]);
    expect((await courierCall(`/api/courier/orders/${ambiguous}`, { token, companyId: 'fulltech' })).status).toBe(404);
    expect((await courierCall(`/api/courier/orders/${fulltech}`, { token, companyId: 'phytoemagry' })).status).toBe(404);
    expect((await courierCall('/api/courier/orders', { token, companyId: 'otra-empresa' })).status).toBe(403);
    expect((await call(`couriers/${courierId}/companies`, { companyId: 'fulltech', active: false })).status).toBe(200);
    expect((await courierCall('/api/courier/orders', { token, companyId: 'fulltech' })).status).toBe(401);
    const newToken = (await login(EXTERNAL_PHONE, '123456')).data.token;
    expect((await courierCall('/api/courier/orders', { token: newToken, companyId: 'fulltech' })).status).toBe(403);
  });

  it('custodia por empresa excluye cargos ajenos y movimientos sin dueño demostrable', async () => {
    const account = await createCourierAccount({ kind: 'EXTERNAL', phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo', contactId: 'contact-ext', appAccess: true, pin: '123456' });
    const id = account.data.courier.id;
    await call(`couriers/${id}/companies`, { companyId: 'fulltech', active: true });
    const phytoOrder = await createOrder({ phone: '8095557911' });
    const fulltechOrder = await createOrder({ phone: '8095557912' });
    const item = await app.ctx.store.getAdmin(fulltechOrder);
    const order = JSON.parse(item.order_json);
    order.origin = 'FULLTECH_STORE'; order.company_id = 'fulltech';
    await app.ctx.store.update(fulltechOrder, { orderJson: JSON.stringify(order) });
    for (const [orderId, amount] of [[phytoOrder, 12000], [fulltechOrder, 30000]]) {
      await app.ctx.db.insert('delivery_cash_ledger', { id: `cash_${orderId}`,
        order_id: orderId, courier_account_id: id, kind: 'charge', amount_cents: amount,
        idempotency_key: `charge:${orderId}`, created_at: new Date().toISOString() });
    }
    await app.ctx.db.insert('delivery_cash_ledger', { id: 'cash_ambiguous',
      order_id: null, courier_account_id: id, kind: 'remittance', amount_cents: 4000,
      idempotency_key: 'legacy:ambiguous', created_at: new Date().toISOString() });
    const token = (await login(EXTERNAL_PHONE, '123456')).data.token;
    const phyto = await courierCall('/api/courier/custody', { token, companyId: 'phytoemagry' });
    const fulltech = await courierCall('/api/courier/custody', { token, companyId: 'fulltech' });
    expect(phyto.data.custody.pending_cents).toBe(12000);
    expect(fulltech.data.custody.pending_cents).toBe(30000);
    const overdraw = await call('delivery-cash/remittance', { courierAccountId: id,
      companyId: 'phytoemagry', amountCents: 13000, idempotencyKey: 'overdraw' });
    expect(overdraw.status).toBe(409);
    expect(overdraw.data.error).toBe('historical_custody_unresolved');
    const paid = await call('delivery-cash/remittance', { courierAccountId: id,
      companyId: 'fulltech', amountCents: 5000, idempotencyKey: 'fulltech:paid' });
    expect(paid.status).toBe(409);
    expect(paid.data.error).toBe('historical_custody_unresolved');
    const phytoAfter = await courierCall('/api/courier/custody', { token, companyId: 'phytoemagry' });
    expect(phytoAfter.data.custody.pending_cents).toBe(12000);
    const fulltechAfter = await courierCall('/api/courier/custody', { token, companyId: 'fulltech' });
    expect(fulltechAfter.data.custody.pending_cents).toBe(30000);
  });

  it('registra una tercera empresa en la misma base sin conceder acceso implícito', async () => {
    const registration = await call('logistics/companies', { id: 'tienda_nueva', name: 'Tienda nueva UAT' });
    expect(registration.status).toBe(201);
    expect((await call('logistics/companies', { id: 'tienda_nueva', name: 'Duplicada' })).status).toBe(409);
    const orderId = await createOrder({ phone: '8095557921' });
    await call(`orders/${orderId}/courier/assign`, { contactPhone: EXTERNAL_PHONE });
    const item = await app.ctx.store.getAdmin(orderId);
    const order = JSON.parse(item.order_json);
    order.company_id = 'tienda_nueva';
    await app.ctx.store.update(orderId, { orderJson: JSON.stringify(order) });
    const account = await createCourierAccount({ kind: 'EXTERNAL', phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo', contactId: 'contact-ext', appAccess: true, pin: '123456' });
    const before = (await login(EXTERNAL_PHONE, '123456')).data.token;
    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: before, companyId: 'tienda_nueva' })).status).toBe(403);
    expect((await call(`couriers/${account.data.courier.id}/companies`, { companyId: 'tienda_nueva', active: true })).status).toBe(200);
    const after = (await login(EXTERNAL_PHONE, '123456')).data.token;
    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: after, companyId: 'tienda_nueva' })).status).toBe(200);
  });

  it('una sesión CRM de Phyto no abre por ID un pedido FULLTECH conocido', async () => {
    const id = await createOrder({ phone: '8095557931' });
    const item = await app.ctx.store.getAdmin(id);
    const order = JSON.parse(item.order_json);
    order.origin = 'FULLTECH_STORE'; order.company_id = 'fulltech';
    await app.ctx.store.update(id, { orderJson: JSON.stringify(order) });
    const agent = await createUser({ username: 'agent-isolation-uat',
      displayName: 'Agente UAT', role: 'AGENT' });
    expect(agent?.id).toBeTruthy();
    const loginResponse = await fetch(`${app.url}/api/admin/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        username: 'agent-isolation-uat', password: 'Clave-Reparto-1' }) });
    expect(loginResponse.status).toBe(200);
    const agentCookie = loginResponse.headers.get('set-cookie').split(';')[0];
    expect((await call(`orders/${id}`, null, agentCookie)).status).toBe(404);
    expect((await call(`orders/${id}/payment/transfer`, { amount: 1 }, agentCookie)).status).toBe(404);
  });

  it('bloquea tras varios PIN incorrectos', async () => {
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    for (let index = 0; index < 5; index += 1) {
      const wrong = await login(EXTERNAL_PHONE, '000000');
      expect(wrong.status).toBe(401);
    }
    const locked = await login(EXTERNAL_PHONE, '123456');
    expect([401, 429]).toContain(locked.status);
    if (locked.status === 401) {
      /* El PIN correcto tampoco entra mientras la cuenta está bloqueada. */
      expect(locked.data.error).toBe('invalid_credentials');
    }
  });
});

describe('lectura de pedidos asignados', () => {
  it('el repartidor externo solo ve los pedidos que tiene asignados', async () => {
    const own = await createOrder({ phone: '8095557101' });
    const other = await createOrder({ phone: '8095557102' });
    const loose = await createOrder({ phone: '8095557103' });
    expect(own && other && loose).toBeTruthy();

    expect((await call(`orders/${own}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);
    expect((await call(`orders/${other}/courier/assign`, { contactPhone: OTHER_PHONE })).status).toBe(200);

    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(EXTERNAL_PHONE, '123456');
    const token = session.data.token;

    const list = await courierCall('/api/courier/orders', { token });
    expect(list.status).toBe(200);
    expect(list.data.count).toBe(1);
    expect(list.data.orders.map((row) => row.id)).toEqual([own]);

    const detail = await courierCall(`/api/courier/orders/${own}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.data.order.id).toBe(own);
    /* El teléfono sale normalizado (E.164), que es como lo guarda el CRM. */
    expect(detail.data.order.customer.phone).toBe('+18095557101');
    /* La compensación no existe en el CRM todavía: se dice, no se inventa. */
    expect(detail.data.order.courier_compensation).toBeNull();
    expect(detail.data.order.courier_compensation_unavailable).toBe(true);
    /* Nada de márgenes ni de costos. */
    expect(JSON.stringify(detail.data)).not.toMatch(/cost|profit|margin/i);

    const foreign = await courierCall(`/api/courier/orders/${other}`, { token });
    expect(foreign.status).toBe(404);
  });

  it('el repartidor interno ve los pedidos asignados a su usuario del CRM', async () => {
    const user = await createUser({ username: 'repartidor-uno', displayName: 'Repartidor Uno', role: 'DELIVERY' });
    const own = await createOrder({ phone: '8095557201' });
    expect((await call(`orders/${own}/delivery/assign`, { deliveryUserId: user.id })).status).toBe(200);

    const account = await createCourierAccount({
      kind: 'INTERNAL',
      phone: INTERNAL_PHONE,
      displayName: 'Repartidor Uno',
      userId: user.id,
      appAccess: true,
      pin: '123456',
    });
    expect(account.status).toBe(201);

    const session = await login(INTERNAL_PHONE, '123456');
    const list = await courierCall('/api/courier/orders', { token: session.data.token });
    expect(list.status).toBe(200);
    expect(list.data.orders.map((row) => row.id)).toEqual([own]);
  });

  /*
   * REGRESIÓN (Fase 04B): un pedido tiene UN repartidor vigente. Antes, al reasignar de
   * externo a interno el bloque `delivery.external` seguía en el pedido y el mensajero
   * anterior seguía viéndolo en la app. Detectado en el UAT por HTTP real.
   */
  it('al reasignar de externo a interno, el externo deja de ver el pedido', async () => {
    const user = await createUser({ username: 'repartidor-dos', displayName: 'Repartidor Dos', role: 'DELIVERY' });
    const orderId = await createOrder({ phone: '8095557401' });
    expect((await call(`orders/${orderId}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const externo = (await login(EXTERNAL_PHONE, '123456')).data.token;
    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: externo })).status).toBe(200);

    expect((await call(`orders/${orderId}/delivery/assign`, { deliveryUserId: user.id })).status).toBe(200);

    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: externo })).status).toBe(404);
    const list = await courierCall('/api/courier/orders', { token: externo });
    expect(list.data.count).toBe(0);
  });

  it('al reasignar de interno a externo, el interno deja de ver el pedido', async () => {
    const user = await createUser({ username: 'repartidor-tres', displayName: 'Repartidor Tres', role: 'DELIVERY' });
    const orderId = await createOrder({ phone: '8095557402' });
    expect((await call(`orders/${orderId}/delivery/assign`, { deliveryUserId: user.id })).status).toBe(200);

    await createCourierAccount({
      kind: 'INTERNAL',
      phone: INTERNAL_PHONE,
      displayName: 'Repartidor Tres',
      userId: user.id,
      appAccess: true,
      pin: '123456',
    });
    const interno = (await login(INTERNAL_PHONE, '123456')).data.token;
    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: interno })).status).toBe(200);

    expect((await call(`orders/${orderId}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);

    expect((await courierCall(`/api/courier/orders/${orderId}`, { token: interno })).status).toBe(404);
  });

  it('un repartidor sin pedidos recibe una lista vacía, no un error', async () => {    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(EXTERNAL_PHONE, '123456');
    const list = await courierCall('/api/courier/orders', { token: session.data.token });
    expect(list.status).toBe(200);
    expect(list.data.orders).toEqual([]);
    expect(list.data.count).toBe(0);
  });
});

describe('sesión y límites', () => {
  it('sin token no se lee nada', async () => {
    expect((await courierCall('/api/courier/me')).status).toBe(401);
    expect((await courierCall('/api/courier/orders')).status).toBe(401);
  });

  it('cerrar sesión revoca el token emitido', async () => {
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(EXTERNAL_PHONE, '123456');
    const token = session.data.token;
    expect((await courierCall('/api/courier/me', { token })).status).toBe(200);

    const out = await courierCall('/api/courier/logout', { token, method: 'POST' });
    expect(out.status).toBe(200);

    const after = await courierCall('/api/courier/me', { token });
    expect(after.status).toBe(401);
    expect(after.data.error).toBe('session_revoked');
  });

  it('un token caducado o falsificado se rechaza', async () => {
    const account = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const expired = createCourierToken(account.data.courier, TOKEN, { ttlSeconds: -10 });
    const expiredCall = await courierCall('/api/courier/me', { token: expired.token });
    expect(expiredCall.status).toBe(401);
    expect(expiredCall.data.error).toBe('session_expired');

    const forged = `${account.data.courier.id}.0.9999999999.firma-falsa`.replace(/^/, 'cv1.');
    expect((await courierCall('/api/courier/me', { token: forged })).status).toBe(401);
  });

  it('el token del móvil no abre el panel de administración', async () => {
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(EXTERNAL_PHONE, '123456');
    const response = await fetch(`${app.url}/api/admin/orders`, {
      headers: { authorization: `Bearer ${session.data.token}` },
    });
    expect([401, 403]).toContain(response.status);
  });
});

describe('solo lectura: lo que no es una transición sigue cerrado', () => {
  it('las rutas del móvil que no son transiciones responden 405 read_only', async () => {
    const orderId = await createOrder({ phone: '8095557301' });
    expect((await call(`orders/${orderId}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const session = await login(EXTERNAL_PHONE, '123456');
    const token = session.data.token;

    for (const route of ['payments', 'cancel', 'status', 'refund', 'total']) {
      const attempt = await courierCall(`/api/courier/orders/${orderId}/${route}`, { token, method: 'POST', body: {} });
      /* Acción desconocida (404) o ruta cerrada (405): nunca se ejecuta nada. */
      expect([404, 405]).toContain(attempt.status);
      expect(['unknown_action', 'read_only']).toContain(attempt.data.error);
    }
  });

  /* Fase 05: entregar sin haber aceptado no puede mover el pedido ni un byte. */
  it('una transición inválida no muta el pedido', async () => {
    const orderId = await createOrder({ phone: '8095557311' });
    expect((await call(`orders/${orderId}/courier/assign`, { contactPhone: EXTERNAL_PHONE })).status).toBe(200);
    await createCourierAccount({
      kind: 'EXTERNAL',
      phone: EXTERNAL_PHONE,
      displayName: 'Mensajero Externo',
      contactId: 'contact-ext',
      appAccess: true,
      pin: '123456',
    });
    const token = (await login(EXTERNAL_PHONE, '123456')).data.token;

    const before = JSON.stringify((await app.ctx.store.listAdmin({ limit: 5000 })).find((row) => row.id === orderId));
    const attempt = await courierCall(`/api/courier/orders/${orderId}/deliver`, {
      token,
      method: 'POST',
      body: {},
    });
    expect(attempt.status).toBe(409);
    expect(attempt.data.error).toBe('invalid_transition');
    const after = JSON.stringify((await app.ctx.store.listAdmin({ limit: 5000 })).find((row) => row.id === orderId));
    expect(after).toBe(before);
  });
});
