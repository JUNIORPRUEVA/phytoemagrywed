// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startCrmServer } from '../server/crm-server.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
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
  it('does not require onboarding for an existing account without a welcome marker', async () => {
    const created=await register({name:'Cliente Anterior',phone:'8095551266',email:'existing-welcome@example.test',password:'Cliente-123'});
    const db=new DatabaseSync(path.join(dir,'accounts.sqlite'));
    db.prepare('UPDATE fulltech_customer_accounts_v1 SET profile=? WHERE id=?').run(JSON.stringify({name:'Cliente Anterior',email:'existing-welcome@example.test'}),created.data.account.id);db.close();
    const returned=await login({identifier:'existing-welcome@example.test',password:'Cliente-123'});
    expect(returned.status).toBe(200);expect(returned.data.account.onboarding).toBeNull();
  });
  it('persists optional welcome data, rejects invalid phones without completing, and keeps email-only accounts isolated', async () => {
    const created=await register({name:'Lina Nueva',email:'welcome@example.test',password:'Cliente-123'});
    expect(created.status).toBe(201);
    expect(created.data.account).toMatchObject({onboarding:'pending',phone:null});
    const patch=body=>api('/api/store/account/me',{method:'PATCH',cookie:created.cookie,body});
    expect((await patch({phone:'80912',city:'Higüey',onboarding:'completed'})).status).toBe(422);
    expect((await api('/api/store/account/me',{cookie:created.cookie})).data.account.onboarding).toBe('pending');
    const saved=await patch({phone:'809 555 1287',city:'Higüey',onboarding:'completed'});
    expect(saved.status).toBe(200);
    expect(saved.data.account).toMatchObject({phone:'+18095551287',city:'Higüey',onboarding:'completed'});
    await api('/api/store/account/logout',{method:'POST',cookie:created.cookie,body:{}});
    const logged=await login({identifier:'welcome@example.test',password:'Cliente-123'});
    expect(logged.data.account).toMatchObject({city:'Higüey',onboarding:'completed'});
    const second=await register({name:'Otra Nueva',email:'other-welcome@example.test',password:'Cliente-123'});
    expect((await api('/api/store/account/orders',{cookie:second.cookie})).data.orders).toEqual([]);
    expect((await api('/api/store/account/me',{cookie:second.cookie})).data.account.city).toBe('');
    expect((await api('/api/store/account/me',{method:'PATCH',cookie:second.cookie,body:{onboarding:'skipped'}})).status).toBe(200);
    expect((await api('/api/store/account/me',{cookie:second.cookie})).data.account.onboarding).toBe('skipped');
    expect((await api('/api/store/account/me',{method:'PATCH',cookie:logged.cookie,body:{phone:'8295551287',city:'Santo Domingo'}})).status).toBe(200);
    expect((await api('/api/store/account/me',{cookie:logged.cookie})).data.account.phone).toBe('+18295551287');
  });
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

  it('retires sourcing endpoints and preserves historical requests and payments as read-only', async () => {
    await expect(app.ctx.storeAccounts.createRequest({},{})).rejects.toMatchObject({code:'sourcing_retired',status:410});
    const owner=await register({name:'Titular archivo',phone:'8095550301',password:'Cliente-123'});
    const db=new DatabaseSync(path.join(dir,'accounts.sqlite'));
    const customerId=db.prepare('SELECT customer_id FROM fulltech_customer_accounts_v1 WHERE id=?').get(owner.data.account.id).customer_id;
    const doc={id:'req_historical',customer_id:customerId,account_id:owner.data.account.id,title:'Solicitud histórica',status:'cotizado',kind:'product',created_at:'2026-01-01T00:00:00Z',quote:{amount:1000,currency:'DOP'},payment:{amount:300,status:'confirmed'},timeline:[{status:'nuevo',at:'2026-01-01T00:00:00Z'}]};
    const raw=JSON.stringify(doc);
    db.prepare('INSERT INTO fulltech_store_requests_v1(id,customer_id,account_id,request_key,status,kind,title_key,doc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(doc.id,customerId,owner.data.account.id,'legacy-key','cotizado','product','solicitud historica',raw,doc.created_at,doc.created_at);
    for(const route of ['/api/store/requests','/api/store/account/requests','/api/store/requests/req_historical','/api/store/requests/req_historical/decision','/api/store/requests/req_historical/transfer'])for(const method of ['GET','POST'])expect((await api(route,{method,cookie:owner.cookie,...(method==='POST'?{body:{title:'No crear'}}:{})})).status).toBe(410);
    const archive=await api('/api/admin/store/requests',{cookie:adminCookie});expect(archive.status).toBe(200);expect(archive.data.canManage).toBe(false);expect(archive.data.requests.some(r=>r.id===doc.id)).toBe(true);
    expect((await api('/api/admin/store/requests/req_historical',{method:'PATCH',cookie:adminCookie,body:{status:'cancelado'}})).status).toBe(410);
    expect((await api('/api/admin/store/requests',{method:'POST',cookie:adminCookie,body:{title:'No crear'}})).status).toBe(410);
    expect(db.prepare('SELECT doc FROM fulltech_store_requests_v1 WHERE id=?').get(doc.id).doc).toBe(raw);
    expect(db.prepare('SELECT count(*) AS n FROM fulltech_store_requests_v1').get().n).toBe(1);db.close();
  });

  it('requires a session for requests and rejects cross-origin writes', async () => {
    expect((await api('/api/store/requests', {
      method: 'POST', body: { title: 'Sin sesión', kind: 'product', requestKey: 'abcdefgh' },
    })).status).toBe(410);

    const owner = await register({ name: 'Cliente CSRF', phone: '8095550401', password: 'Cliente-123' });
    const proxied = await fetch(`${app.url}/api/store/account/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173', 'x-forwarded-host': '127.0.0.1:4173' },
      body: JSON.stringify({ identifier: '8095550401', password: 'Cliente-123' }),
    });
    expect(proxied.status).toBe(200);
    const response = await fetch(`${app.url}/api/store/account/me`, {
      method: 'PATCH',
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
    expect(completeLocation).toBe('/store/#/account');
    const sessionCookie=callback.headers.getSetCookie().find(v=>v.startsWith('ft_store_session=')).split(';')[0];
    const completed = await api('/api/store/account/me', {
      method: 'PATCH',cookie:sessionCookie,body:{phone:'8095550501',city:'Santo Domingo',onboarding:'completed'},
    });
    expect(completed.status).toBe(200);
    expect(completed.data.account).toMatchObject({ name: 'OAuth Cliente', phone: '+18095550501', providers: { google: true, password: false } });
    const me = await api('/api/store/account/me', { cookie: sessionCookie });
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
    const secondCookie=secondCallback.headers.getSetCookie().find(v=>v.startsWith('ft_store_session=')).split(';')[0];
    const returned=await api('/api/store/account/me',{cookie:secondCookie});
    expect(returned.data.account.id).toBe(me.data.account.id);
    expect(returned.data.account.onboarding).toBe('completed');
    expect(calls.filter((url) => url.includes('/token')).length).toBe(2);
  });
});
