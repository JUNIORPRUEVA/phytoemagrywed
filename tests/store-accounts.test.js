// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCrmServer } from '../server/crm-server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS7kAAAAASUVORK5CYII=';
const TOKEN = 'accounts-test-token';
let app, dir, adminCookie;

const api = async (route, { method = 'GET', body, cookie, redirect = 'follow' } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    redirect,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    data: type.includes('json') ? await response.json() : null,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null,
  };
};

const register = (body, cookie) => api('/api/store/account/register', { method: 'POST', body, cookie });
const login = (body, cookie) => api('/api/store/account/login', { method: 'POST', body, cookie });
const createOrder = (body) => api('/api/admin/orders', { method: 'POST', cookie: adminCookie, body });
const adminCustomers = (q) => api(`/api/admin/customers?q=${encodeURIComponent(q)}`, { cookie: adminCookie });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-accounts-'));
  app = await startCrmServer({
    port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'accounts.sqlite'),
    token: TOKEN, quiet: true, schedulerEnabled: false,
  });
  const session = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
  });
  adminCookie = session.headers.get('set-cookie').split(';')[0];
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FULLTECH Store customer accounts', () => {
  it('creates an account linked to one CRM customer, keeps sessions separate and refuses duplicates', async () => {
    const created = await register({ name: 'Ana Cliente', phone: '8095550201', email: 'ana@example.test', password: 'Cliente-123' });
    expect(created.status).toBe(201);
    expect(created.data.account).toMatchObject({ phone: '+18095550201', email: 'ana@example.test', name: 'Ana Cliente' });
    expect(created.cookie).toMatch(/^ft_store_session=/);
    expect(created.cookie).not.toMatch(/^pe_crm=/);

    const me = await api('/api/store/account/me', { cookie: created.cookie });
    expect(me.status).toBe(200);
    expect(me.data.account.name).toBe('Ana Cliente');

    expect((await api('/api/store/account/me')).data.account).toBeNull();
    expect((await api('/api/store/account/me', { cookie: adminCookie })).data.account).toBeNull();

    const duplicate = await register({ name: 'Otra', phone: '8095550201', password: 'Cliente-123' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error).toBe('account_exists');

    const customers = await adminCustomers('8095550201');
    expect(customers.data.customers).toHaveLength(1);
    const customerId = customers.data.customers[0].id;
    const profile = await api(`/api/admin/customers/${customerId}`, { cookie: adminCookie });
    expect(profile.data.store_account).toMatchObject({ phone: '+18095550201', name: 'Ana Cliente' });

    const wrong = await login({ identifier: '8095550201', password: 'NoEsLaClave' });
    expect(wrong.status).toBe(401);
    const right = await login({ identifier: '8095550201', password: 'Cliente-123' });
    expect(right.status).toBe(200);
    expect(right.cookie).toMatch(/^ft_store_session=/);

    const updated = await api('/api/store/account/me', {
      method: 'PATCH', cookie: created.cookie,
      body: { name: 'Ana Actualizada', email: 'ana2@example.test', preferences: { contact: 'phone', marketing: true } },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.account).toMatchObject({ name: 'Ana Actualizada', email: 'ana2@example.test' });
    expect(updated.data.account.preferences).toMatchObject({ contact: 'phone', marketing: true });

    const emailTaken = await register({ name: 'Luis', phone: '8095550202', email: 'ana2@example.test', password: 'Cliente-123' });
    expect(emailTaken.status).toBe(409);
    expect(emailTaken.data.error).toBe('email_in_use');
  });

  it('only links an existing CRM customer with proof of ownership (order number)', async () => {
    const order = await createOrder({
      name: 'Cliente Existente', phone: '8095550101', paymentMethod: 'CASH', status: 'nuevo',
      items: [{ variantId: 'capsules_5', quantity: 1 }],
    });
    expect(order.status).toBe(201);
    const orderNumber = order.data.order.order_number;
    expect(orderNumber).toBeTruthy();

    const withoutProof = await register({ name: 'Cliente Existente', phone: '8095550101', password: 'Cliente-123' });
    expect(withoutProof.status).toBe(403);
    expect(withoutProof.data.error).toBe('verification_required');

    const wrongProof = await register({ name: 'Cliente Existente', phone: '8095550101', password: 'Cliente-123', orderNumber: 'PE-NO-EXISTE' });
    expect(wrongProof.status).toBe(403);

    const linked = await register({ name: 'Cliente Existente', phone: '8095550101', password: 'Cliente-123', orderNumber });
    expect(linked.status).toBe(201);

    const customers = await adminCustomers('8095550101');
    expect(customers.data.customers).toHaveLength(1);
    const customerId = customers.data.customers[0].id;
    const profile = await api(`/api/admin/customers/${customerId}`, { cookie: adminCookie });
    expect(profile.data.store_account).toMatchObject({ phone: '+18095550101' });

    const orders = await api('/api/store/account/orders', { cookie: linked.cookie });
    expect(orders.status).toBe(200);
    expect(orders.data.orders.some((row) => row.order_number === orderNumber)).toBe(true);
    expect(JSON.stringify(orders.data)).not.toMatch(/cost_cents|product_cost_snapshot|gross_profit/i);
  });

  it('creates real requests with idempotency, ownership, quotes and customer decisions', async () => {
    const owner = await register({ name: 'Dueña', phone: '8095550301', password: 'Cliente-123' });
    const other = await register({ name: 'Otra Persona', phone: '8095550302', password: 'Cliente-123' });
    expect(owner.status).toBe(201);
    expect(other.status).toBe(201);

    const key = `sreq_${randomUUID().replaceAll('-', '')}`;
    const body = {
      kind: 'product', title: 'Busco un router de doble banda', details: 'Para una casa de dos plantas.',
      referenceUrl: 'https://example.test/router', requestKey: key, images: [IMAGE],
    };
    const created = await api('/api/store/requests', { method: 'POST', cookie: owner.cookie, body });
    expect(created.status).toBe(201);
    expect(created.data.request).toMatchObject({ status: 'nuevo', kind: 'product', images: 1 });
    const requestId = created.data.request.id;

    const repeated = await api('/api/store/requests', { method: 'POST', cookie: owner.cookie, body });
    expect(repeated.status).toBe(200);
    expect(repeated.data.duplicate).toBe(true);
    expect(repeated.data.request.id).toBe(requestId);

    const similar = await api('/api/store/requests', {
      method: 'POST', cookie: owner.cookie,
      body: { ...body, requestKey: `sreq_${randomUUID().replaceAll('-', '')}`, images: [] },
    });
    expect(similar.status).toBe(200);
    expect(similar.data.duplicate).toBe(true);

    const mine = await api('/api/store/account/requests', { cookie: owner.cookie });
    expect(mine.data.requests).toHaveLength(1);
    expect((await api('/api/store/account/requests', { cookie: other.cookie })).data.requests).toHaveLength(0);

    const ownImage = await fetch(`${app.url}/api/store/requests/${requestId}/image/0`, { headers: { cookie: owner.cookie } });
    expect(ownImage.status).toBe(200);
    expect(ownImage.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${app.url}/api/store/requests/${requestId}/image/0`)).status).toBe(401);
    expect((await fetch(`${app.url}/api/store/requests/${requestId}/image/0`, { headers: { cookie: other.cookie } })).status).toBe(404);

    const adminList = await api('/api/admin/store/requests', { cookie: adminCookie });
    expect(adminList.status).toBe(200);
    expect(adminList.data.requests.find((row) => row.id === requestId)?.customer?.name).toBe('Dueña');

    const agentUser = await api('/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { username: 'requests-agent', displayName: 'Agente solicitudes', role: 'AGENT', password: 'Agente-12345' },
    });
    expect(agentUser.status).toBe(201);
    const agentLogin = await fetch(`${app.url}/api/admin/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'requests-agent', password: 'Agente-12345' }),
    });
    const agentCookie = agentLogin.headers.get('set-cookie').split(';')[0];
    expect((await api('/api/admin/store/requests', { cookie: agentCookie })).data.canManage).toBe(false);
    expect((await api(`/api/admin/store/requests/${requestId}`, { method: 'PATCH', cookie: agentCookie, body: { status: 'en_revision' } })).status).toBe(403);

    const reviewing = await api(`/api/admin/store/requests/${requestId}`, {
      method: 'PATCH', cookie: adminCookie, body: { status: 'en_revision', admin_notes: 'Revisando proveedor.' },
    });
    expect(reviewing.status).toBe(200);
    expect(reviewing.data.request.status).toBe('en_revision');

    const quoted = await api(`/api/admin/store/requests/${requestId}`, {
      method: 'PATCH', cookie: adminCookie, body: { quote: { amount: '3500.00', notes: 'Incluye instalación.' } },
    });
    expect(quoted.status).toBe(200);
    expect(quoted.data.request).toMatchObject({ status: 'cotizado', quote: { amount: 3500, currency: 'DOP' } });

    const customerView = await api(`/api/store/requests/${requestId}`, { cookie: owner.cookie });
    expect(customerView.data.request.status).toBe('cotizado');
    expect(customerView.data.request.admin_notes).toBeUndefined();
    expect((await api(`/api/store/requests/${requestId}`, { cookie: other.cookie })).status).toBe(404);

    const accepted = await api(`/api/store/requests/${requestId}/decision`, {
      method: 'POST', cookie: owner.cookie, body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.data.request.status).toBe('aprobado');
    expect((await api(`/api/store/requests/${requestId}/decision`, { method: 'POST', cookie: owner.cookie, body: { decision: 'accept' } })).status).toBe(409);

    const filtered = await api('/api/admin/store/requests?status=aprobado', { cookie: adminCookie });
    expect(filtered.data.requests.some((row) => row.id === requestId)).toBe(true);
  });

  it('requires a session for requests and rejects cross-origin writes', async () => {
    expect((await api('/api/store/requests', {
      method: 'POST', body: { title: 'Sin sesión', kind: 'product', requestKey: 'abcdefgh' },
    })).status).toBe(401);

    const owner = await register({ name: 'Cliente CSRF', phone: '8095550401', password: 'Cliente-123' });
    const proxied = await fetch(`${app.url}/api/store/account/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173', 'x-forwarded-host': '127.0.0.1:4173' },
      body: JSON.stringify({ identifier: '8095550401', password: 'Cliente-123' }),
    });
    expect(proxied.status).toBe(200);
    const response = await fetch(`${app.url}/api/store/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'Intento externo', kind: 'product', requestKey: 'csrf_12345678' }),
    });
    expect(response.status).toBe(403);
  });

  it('completes a Google login without duplicating customers and keeps the store session separate', async () => {
    await app.close();
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'google-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('openidconnect.googleapis.com')) {
        return new Response(JSON.stringify({ sub: 'google-sub-1', email: 'oauth@example.test', email_verified: true, name: 'OAuth Cliente' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    app = await startCrmServer({
      port: 0, host: '127.0.0.1', dataFile: path.join(dir, 'accounts.sqlite'), token: TOKEN,
      quiet: true, schedulerEnabled: false,
      storeOAuth: { google: { clientId: 'google-client', clientSecret: 'google-secret', redirectUri: 'http://127.0.0.1/cb' } },
      storeOAuthFetch: fakeFetch,
    });

    const providers = await api('/api/store/account/providers');
    expect(providers.data.providers).toMatchObject({ password: true, google: true, apple: false });

    const start = await api('/api/store/account/auth/google/start', { redirect: 'manual' });
    expect(start.status).toBe(302);
    const location = start.headers.get('location');
    expect(location).toContain('accounts.google.com');
    const state = new URL(location).searchParams.get('state');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    expect(stateCookie).toMatch(/^ft_oauth_state=/);

    const callback = await api(`/api/store/account/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`, { cookie: stateCookie, redirect: 'manual' });
    expect(callback.status).toBe(302);
    const completeLocation = callback.headers.get('location');
    expect(completeLocation).toContain('/store/#/account/complete?token=');
    const setupToken = new URLSearchParams(completeLocation.split('?')[1] ?? '').get('token');
    expect(setupToken).toBeTruthy();
    expect(callback.cookie ?? '').not.toMatch(/^ft_store_session=/);

    const completed = await api('/api/store/account/complete', {
      method: 'POST', body: { token: setupToken, name: 'OAuth Cliente', phone: '8095550501' },
    });
    expect(completed.status).toBe(200);
    expect(completed.data.account).toMatchObject({ name: 'OAuth Cliente', phone: '+18095550501', providers: { google: true, password: false } });
    expect(completed.cookie).toMatch(/^ft_store_session=/);

    const me = await api('/api/store/account/me', { cookie: completed.cookie });
    expect(me.status).toBe(200);
    expect(me.data.account.name).toBe('OAuth Cliente');

    const customers = await adminCustomers('8095550501');
    expect(customers.data.customers).toHaveLength(1);

    const again = await api('/api/store/account/auth/google/start', { redirect: 'manual' });
    const state2 = new URL(again.headers.get('location')).searchParams.get('state');
    const secondCallback = await api(`/api/store/account/auth/google/callback?code=ok&state=${encodeURIComponent(state2)}`, {
      cookie: again.headers.get('set-cookie').split(';')[0], redirect: 'manual',
    });
    expect(secondCallback.headers.get('location')).toBe('/store/#/account');
    expect(calls.filter((url) => url.includes('/token')).length).toBe(2);
  });
});
