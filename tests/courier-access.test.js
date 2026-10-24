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

const courierCall = async (route, { token, method = 'GET', body } = {}) => {
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

  it('una cuenta de otra empresa no entra en esta instalación', async () => {
    const foreign = await createCourierAccount({
      kind: 'EXTERNAL',
      phone: INTL_PHONE,
      displayName: 'Mensajero Ajeno',
      contactId: 'contact-intl',
      appAccess: true,
      companyId: 'otra-empresa',
      pin: '123456',
    });
    expect(foreign.status).toBe(201);
    const denied = await login(INTL_PHONE, '123456');
    expect(denied.status).toBe(401);
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

describe('solo lectura: nada escribe', () => {
  it('ninguna ruta del móvil acepta cambios y los datos quedan intactos', async () => {
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

    const before = JSON.stringify((await app.ctx.store.getAdmin(orderId)).orderJson);
    for (const route of ['deliver', 'accept', 'pickup', 'payments', 'cancel', 'status']) {
      const attempt = await courierCall(`/api/courier/orders/${orderId}/${route}`, { token, method: 'POST', body: {} });
      expect(attempt.status).toBe(405);
      expect(attempt.data.error).toBe('read_only');
    }
    const after = JSON.stringify((await app.ctx.store.getAdmin(orderId)).orderJson);
    expect(after).toBe(before);
  });
});
