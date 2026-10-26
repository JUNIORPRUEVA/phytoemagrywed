// @vitest-environment node
/**
 * GOOGLE OAUTH EN PRODUCCIÓN — pruebas de regresión y seguridad.
 *
 * Cubre los cinco fallos reales de la auditoría previa:
 *
 *  1. `www` rompía el `state` de OAuth (dominio canónico).
 *  2. Las cookies de sesión y del `state` salían SIN `Secure` en producción.
 *  3. El límite de intentos era un único cubo para TODO el sitio (127.0.0.1).
 *  4. Se enlazaba Google automáticamente a una cuenta cuyo correo nunca se
 *     verificó (robo de cuenta).
 *  5. El botón decía «muy pronto» para siempre en vez de informar del estado.
 *
 * Nada de esto toca clientes reales: todo corre contra un CRM en memoria con
 * SQLite temporal y un Google simulado (`storeOAuthFetch`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCrmServer } from '../server/crm-server.mjs';
import { createRequestTrust, normalizeIp } from '../server/http-trust.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'oauth-hardening-token';
const PASSWORD = 'Cliente-123';

let app;
let dir;
let adminCookie;
/** Identidad que devolverá el Google simulado en la siguiente entrada. */
let identity;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Google simulado. La identidad es mutable para poder probar varias cuentas en
 * el mismo servidor: solo se llama a los dos endpoints que usa la app.
 */
const googleFetch = async (url) => {
  const target = String(url);
  if (target.includes('oauth2.googleapis.com/token')) return json({ access_token: 'google-token', token_type: 'Bearer' });
  if (target.includes('openidconnect.googleapis.com')) {
    return json({
      sub: identity.sub,
      email: identity.email,
      email_verified: identity.emailVerified !== false,
      name: identity.name ?? 'Cliente Google',
    });
  }
  throw new Error(`unexpected ${target}`);
};

const api = async (route, { method = 'GET', body, cookie, redirect = 'follow', headers = {} } = {}) => {
  const response = await fetch(`${app.url}${route}`, {
    method,
    redirect,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    data: type.includes('json') ? await response.json() : null,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null,
    setCookie: response.headers.get('set-cookie') ?? '',
    location: response.headers.get('location') ?? '',
  };
};

/** Recorre el flujo real: /start (302 a Google) → /callback (302 de vuelta). */
const googleLogin = async (headers = {}) => {
  const start = await api('/api/store/account/auth/google/start', { redirect: 'manual', headers });
  const state = new URL(start.location).searchParams.get('state');
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await api(
    `/api/store/account/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', cookie: stateCookie, headers },
  );
  return { start, callback };
};

const register = (body) => api('/api/store/account/register', { method: 'POST', body });
const login = (body, headers) => api('/api/store/account/login', { method: 'POST', body, headers });

beforeEach(async () => {
  identity = { sub: 'google-sub-default', email: 'default@example.test' };
  dir = mkdtempSync(path.join(tmpdir(), 'fulltech-oauth-'));
  app = await startCrmServer({
    port: 0,
    host: '127.0.0.1',
    dataFile: path.join(dir, 'oauth.sqlite'),
    token: TOKEN,
    quiet: true,
    schedulerEnabled: false,
    storeOAuth: { google: { clientId: 'google-client', clientSecret: 'google-secret', redirectUri: 'http://127.0.0.1/cb' } },
    storeOAuthFetch: googleFetch,
  });
  const session = await fetch(`${app.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  adminCookie = session.headers.get('set-cookie').split(';')[0];
});

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ─────────────────────────────────────── 1. CONFIANZA DE CABECERAS DE PROXY */
describe('confianza de cabeceras de proxy', () => {
  const trust = createRequestTrust({ trustedProxies: ['127.0.0.1', '::1'] });

  it('normaliza IPv4 mapeadas, corchetes y puertos', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('[::1]:443')).toBe('::1');
    expect(normalizeIp('10.0.0.7:5555')).toBe('10.0.0.7');
    expect(normalizeIp('')).toBe('');
  });

  it('solo cree X-Forwarded-* cuando el par es un proxy de confianza', () => {
    const fromProxy = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } };
    const direct = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-proto': 'https' } };
    expect(trust.isSecure(fromProxy)).toBe(true);
    /* Cabecera inventada por el cliente: se ignora, no es HTTPS. */
    expect(trust.isSecure(direct)).toBe(false);
  });

  it('usa el ÚLTIMO salto de x-forwarded-proto (el proxy más cercano)', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'http, https' } };
    expect(trust.isSecure(req)).toBe(true);
  });

  it('`forceSecure` marca Secure aunque no llegue ninguna cabecera', () => {
    const forced = createRequestTrust({ forceSecure: true });
    expect(forced.isSecure({ socket: { remoteAddress: '203.0.113.9' }, headers: {} })).toBe(true);
  });

  it('ignora un X-Forwarded-For inventado si la conexión NO viene del proxy', () => {
    const req = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-for': '1.2.3.4' } };
    expect(trust.clientIp(req)).toBe('203.0.113.9');
  });

  it('con proxy delante, el cliente real es el último salto y no el que escribe el cliente', () => {
    const suplantado = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' },
    };
    /* 1.2.3.4 lo puso el cliente; 198.51.100.7 es lo que vio nginx. */
    expect(trust.clientIp(suplantado)).toBe('198.51.100.7');
  });

  it('sin cabecera de reenvío usa el par de la conexión', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    expect(trust.clientIp(req)).toBe('127.0.0.1');
  });
});

/* ───────────────────────────────────────────── 2. COOKIES DE AUTENTICACIÓN */
describe('cookies de autenticación', () => {
  it('la sesión sale Secure, HttpOnly y SameSite=Lax cuando la conexión es HTTPS', async () => {
    const created = await api('/api/store/account/register', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https' },
      body: { name: 'Ana Segura', phone: '8095550901', email: 'ana.segura@example.test', password: PASSWORD },
    });
    expect(created.status).toBe(201);
    expect(created.setCookie).toContain('ft_store_session=');
    expect(created.setCookie).toContain('HttpOnly');
    expect(created.setCookie).toContain('SameSite=Lax');
    expect(created.setCookie).toContain('Secure');
  });

  it('no marca Secure si el proxy dice http ni si la cabecera no es de confianza', async () => {
    const sobreHttp = await api('/api/store/account/register', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'http' },
      body: { name: 'Luis Http', phone: '8095550902', email: 'luis.http@example.test', password: PASSWORD },
    });
    expect(sobreHttp.status).toBe(201);
    expect(sobreHttp.setCookie).not.toContain('Secure');
  });

  it('la cookie del `state` de OAuth lleva los mismos atributos', async () => {
    const start = await api('/api/store/account/auth/google/start', {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(start.status).toBe(302);
    expect(start.setCookie).toContain('ft_oauth_state=');
    expect(start.setCookie).toContain('HttpOnly');
    expect(start.setCookie).toContain('SameSite=Lax');
    expect(start.setCookie).toContain('Secure');
    expect(start.setCookie).toContain('Max-Age=600');
  });

  it('el flujo OAuth usa solo openid, email y profile', async () => {
    const start = await api('/api/store/account/auth/google/start', { redirect: 'manual' });
    const url = new URL(start.location);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1/cb');
  });
});

/* ──────────────────────────────────────────── 3. LÍMITE DE INTENTOS POR IP */
describe('límite de intentos por cliente real', () => {
  it('20 intentos de un cliente no bloquean a otro cliente distinto', async () => {
    const attempt = (ip) =>
      login({ identifier: 'nadie@example.test', password: 'mala-mala' }, { 'x-forwarded-for': ip });

    for (let index = 0; index < 20; index += 1) {
      const response = await attempt('198.51.100.10');
      expect(response.status, `intento ${index + 1} del cliente A`).toBe(401);
    }
    const bloqueado = await attempt('198.51.100.10');
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.data.error).toBe('too_many_attempts');

    /* Otro cliente, mismo segundo: no hereda el bloqueo del primero. */
    const otro = await attempt('198.51.100.20');
    expect(otro.status).toBe(401);
  });

  it('una cabecera X-Forwarded-For falsa no cambia el cubo del atacante', async () => {
    /* El cliente escribe una IP inventada delante; nginx añade la real. */
    const spoof = (fake) =>
      login({ identifier: 'nadie@example.test', password: 'mala-mala' }, { 'x-forwarded-for': `${fake}, 198.51.100.30` });

    for (let index = 0; index < 20; index += 1) await spoof(`10.9.9.${index}`);
    const bloqueado = await spoof('10.9.9.200');
    expect(bloqueado.status).toBe(429);
  });
});

/* ─────────────────────────────────── 4. ENLACE DE CUENTAS (robo de cuenta) */
describe('enlace de Google con una cuenta existente', () => {
  const ana = { name: 'Ana Titular', phone: '8095550701', email: 'ana.titular@example.test', password: PASSWORD };

  it('NO enlaza automáticamente: pide la contraseña de la cuenta', async () => {
    const created = await register(ana);
    expect(created.status).toBe(201);

    identity = { sub: 'google-ana', email: ana.email };
    const { callback } = await googleLogin();

    expect(callback.status).toBe(302);
    expect(callback.location).toContain('/store/#/account/complete?token=');
    expect(callback.location).toContain('modo=clave');
    /* Ni sesión ni enlace: la cuenta sigue exactamente igual. */
    expect(callback.setCookie ?? '').not.toContain('ft_store_session=');

    const me = await api('/api/store/account/me', { cookie: created.cookie });
    expect(me.data.account.providers).toMatchObject({ password: true, google: false });
  });

  it('rechaza la vinculación con una contraseña incorrecta', async () => {
    await register({ name: 'Luis Titular', phone: '8095550702', email: 'luis.titular@example.test', password: PASSWORD });
    identity = { sub: 'google-luis', email: 'luis.titular@example.test' };
    const { callback } = await googleLogin();
    const token = new URLSearchParams(callback.location.split('?')[1] ?? '').get('token');

    const wrong = await api('/api/store/account/complete', { method: 'POST', body: { token, password: 'no-es-la-clave' } });
    expect(wrong.status).toBe(401);
    expect(wrong.data.error).toBe('invalid_credentials');
  });

  it('con la contraseña correcta enlaza, conserva la cuenta y sus pedidos', async () => {
    const created = await register(ana);
    const order = await api('/api/admin/orders', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: ana.name, phone: ana.phone, paymentMethod: 'CASH', status: 'nuevo', items: [{ variantId: 'capsules_5', quantity: 1 }] },
    });
    expect(order.status).toBe(201);
    const orderNumber = order.data.order.order_number;
    const stored = await app.ctx.store.getAdmin(order.data.item.id);
    const fulltechOrder = JSON.parse(stored.order_json);
    fulltechOrder.origin = 'FULLTECH_STORE'; fulltechOrder.company_id = 'fulltech';
    await app.ctx.store.update(stored.id, { orderJson: JSON.stringify(fulltechOrder) });
    const before = await api('/api/store/account/orders', { cookie: created.cookie });
    expect(before.data.orders.some((row) => row.order_number === orderNumber)).toBe(true);

    identity = { sub: 'google-ana', email: ana.email };
    const { callback } = await googleLogin();
    const token = new URLSearchParams(callback.location.split('?')[1] ?? '').get('token');
    const linked = await api('/api/store/account/complete', { method: 'POST', body: { token, password: PASSWORD } });
    expect(linked.status).toBe(200);
    expect(linked.data.account.id).toBe(created.data.account.id);
    expect(linked.data.account.providers).toMatchObject({ password: true, google: true });

    /* Los pedidos siguen ahí tras el enlace. */
    const after = await api('/api/store/account/orders', { cookie: linked.cookie });
    expect(after.status).toBe(200);
    expect(after.data.orders.some((row) => row.order_number === orderNumber)).toBe(true);

    /* Y la siguiente vez entra directo, sin volver a pedir la contraseña. */
    const again = await googleLogin();
    expect(again.callback.location).toBe('/store/#/account');
    expect(again.callback.setCookie).toContain('ft_store_session=');
  });

  it('no hereda el historial de un cliente del CRM solo por coincidir el correo', async () => {
    const order = await api('/api/admin/orders', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: 'Cliente CRM', phone: '8095550801', paymentMethod: 'CASH', status: 'nuevo', items: [{ variantId: 'capsules_5', quantity: 1 }] },
    });
    const orderNumber = order.data.order.order_number;
    const found = await api('/api/admin/customers?q=8095550801', { cookie: adminCookie });
    const customerId = found.data.customers[0].id;
    const patched = await api(`/api/admin/customers/${customerId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { email: 'crm.solo@example.test' },
    });
    expect(patched.status).toBe(200);

    /* Google creates an active account with optional onboarding, never the CRM history. */
    identity = { sub: 'google-crm', email: 'crm.solo@example.test' };
    const { callback } = await googleLogin();
    expect(callback.location).toBe('/store/#/account');
    const cookie=callback.headers.getSetCookie().find(v=>v.startsWith('ft_store_session=')).split(';')[0];
    expect((await api('/api/store/account/orders',{cookie})).data.orders).toEqual([]);

    /* Su teléfono ya tiene historial: sin número de pedido NO se vincula. */
    const sinPrueba = await api('/api/store/account/phone', {
      method: 'POST',
      cookie, body: { phone: '8095550801' },
    });
    expect(sinPrueba.status).toBe(200);
    expect(sinPrueba.data.needs_proof).toBe(true);
    expect((await api('/api/store/account/orders',{cookie})).data.orders).toEqual([]);

    /* Con la prueba sí, y entonces ve su pedido. */
    const conPrueba = await api('/api/store/account/phone', {
      method: 'POST',
      cookie,body: { phone: '8095550801', orderNumber },
    });
    expect(conPrueba.status).toBe(200);
    expect(conPrueba.data.needs_proof).toBe(true);
    expect((await api('/api/store/account/orders', { cookie })).data.orders).toEqual([]);
    const stored = await app.ctx.store.getAdmin(order.data.item.id);
    const fulltechOrder = JSON.parse(stored.order_json);
    fulltechOrder.origin = 'FULLTECH_STORE'; fulltechOrder.company_id = 'fulltech';
    await app.ctx.store.update(stored.id, { orderJson: JSON.stringify(fulltechOrder) });
    const pruebaFulltech = await api('/api/store/account/phone', {
      method: 'POST', cookie, body: { phone: '8095550801', orderNumber },
    });
    expect(pruebaFulltech.status).toBe(200);
    expect(pruebaFulltech.data.needs_proof).toBe(false);
    const orders = await api('/api/store/account/orders', { cookie });
    expect(orders.data.orders.some((row) => row.order_number === orderNumber)).toBe(true);
  });
});

/* ────────────────────────────── 5. DESPLIEGUE: DOMINIO CANÓNICO Y ESQUEMA */
describe('despliegue: un solo dominio y esquema real detrás del proxy', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const nginxConf = readFileSync(path.join(ROOT, 'nginx', 'phytoemagry.conf'), 'utf8');

  it('ambos nginx redirigen www al dominio raíz conservando ruta y query', () => {
    for (const [name, config] of [['Dockerfile', dockerfile], ['nginx/phytoemagry.conf', nginxConf]]) {
      expect(config, `${name}: falta la condición del host`).toContain("if ($host = 'www.fulltechrd.com')");
      expect(config, `${name}: la redirección debe conservar la ruta`).toContain('return 308 https://fulltechrd.com$request_uri;');
    }
  });

  it('ambos nginx reenvían el esquema real (map) y no lo pisan con $scheme', () => {
    for (const [name, config] of [['Dockerfile', dockerfile], ['nginx/phytoemagry.conf', nginxConf]]) {
      expect(config, `${name}: falta el map del esquema`).toContain('map $http_x_forwarded_proto $phyto_forwarded_proto');
      expect(config, `${name}: quedan cabeceras con $scheme`).not.toContain('X-Forwarded-Proto $scheme;');
      expect(config, `${name}: no se usa el esquema del proxy`).toContain('proxy_set_header X-Forwarded-Proto $phyto_forwarded_proto;');
    }
  });
});
