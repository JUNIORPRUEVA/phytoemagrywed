// @vitest-environment node
/**
 * El puente entre el servidor de desarrollo y el CRM.
 *
 * Por qué se prueba: el fallo original fue abrir el panel en `localhost:5173`
 * (el dev server) y recibir "No se pudo entrar." porque el POST del login
 * acababa en el servidor de ficheros y volvía un 404 en HTML. Aquí se fija que
 * `/api/...` se reenvía de verdad (cuerpo, estado y cookies incluidos) y que,
 * si el CRM no está encendido, la respuesta es un JSON con un mensaje que se
 * pueda leer en pantalla.
 */

import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { crmPortFromEnv, isCrmPath, probeCrm, proxyToCrm } from '../scripts/crm-proxy.mjs';

/** Servidores abiertos por el test (se cierran siempre). */
const open = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))),
  );
});

/**
 * Servidor que se comporta como el CRM: guarda lo que recibe y contesta.
 *
 * @param {(req: import('node:http').IncomingMessage, body: string) => { status?: number, headers?: Record<string, string | string[]>, body?: string }} handler
 * @returns {Promise<{ port: number, seen: Array<{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string }> }>}
 */
async function fakeCrm(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = handler(req, body);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      res.end(answer.body ?? '{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return { port: server.address().port, seen };
}

/**
 * Servidor igual al de desarrollo: `/api/` al CRM, el resto a ficheros.
 *
 * @param {number} port
 * @returns {Promise<number>} puerto escuchando
 */
async function devLikeServer(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/panel') {
      res.writeHead(302, { location: `/admin/${url.search}` });
      res.end();
      return;
    }
    if (isCrmPath(url.pathname)) {
      await proxyToCrm(req, res, url, { port });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><title>landing</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return server.address().port;
}

/** Puerto libre (se abre y se cierra) para simular un CRM apagado. */
async function freePort() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

describe('crm-proxy · rutas del API', () => {
  it('solo considera API a /api y /api/...', () => {
    expect(isCrmPath('/api')).toBe(true);
    expect(isCrmPath('/api/admin/data')).toBe(true);
    expect(isCrmPath('/api/crm')).toBe(true);
    expect(isCrmPath('/api-otro')).toBe(false);
    expect(isCrmPath('/assets/main.js')).toBe(false);
    expect(isCrmPath('/admin/')).toBe(false);
  });

  it('lee el puerto del CRM del entorno y cae al valor por defecto', () => {
    expect(crmPortFromEnv({})).toBe(8787);
    expect(crmPortFromEnv({ PHYTO_CRM_PORT: '9000' })).toBe(9000);
    expect(crmPortFromEnv({ PHYTO_CRM_PORT: 'no-es-un-numero' })).toBe(8787);
    expect(crmPortFromEnv({ PHYTO_CRM_PORT: '0' })).toBe(8787);
  });
});

describe('crm-proxy · reenvío', () => {
  it('manda el cuerpo y la cabecera del navegador al CRM', async () => {
    const { port, seen } = await fakeCrm(() => ({ body: '{"ok":true,"storage":"sqlite"}' }));
    const dev = await devLikeServer(port);

    const response = await fetch(`http://127.0.0.1:${dev}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'pe_crm=vieja' },
      body: JSON.stringify({ token: 'clave-de-prueba' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, storage: 'sqlite' });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/admin/login');
    expect(seen[0].body).toBe('{"token":"clave-de-prueba"}');
    expect(seen[0].headers.cookie).toBe('pe_crm=vieja');
    // El Host se reescribe al del CRM: si no, el CRM vería el puerto del dev server.
    expect(seen[0].headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('devuelve las cookies del CRM tal cual (login y logout)', async () => {
    const { port } = await fakeCrm(() => ({
      headers: {
        'set-cookie': ['pe_crm=9999.firma; Path=/; HttpOnly; SameSite=Strict', 'otra=1; Path=/'],
      },
    }));
    const dev = await devLikeServer(port);

    const response = await fetch(`http://127.0.0.1:${dev}/api/admin/login`, { method: 'POST', body: '{}' });
    const cookies = response.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('pe_crm=9999.firma');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[1]).toContain('otra=1');
  });

  it('conserva el estado 401 y el mensaje del CRM', async () => {
    const { port } = await fakeCrm(() => ({
      status: 401,
      body: '{"ok":false,"error":"invalid_token","message":"La clave no es correcta."}',
    }));
    const dev = await devLikeServer(port);

    const response = await fetch(`http://127.0.0.1:${dev}/api/admin/login`, { method: 'POST', body: '{"token":"x"}' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: 'La clave no es correcta.' });
  });

  it('deja pasar los 422 de validación sin convertirlos en 502', async () => {
    const { port } = await fakeCrm(() => ({ status: 422, body: '{"ok":false,"message":"Estado no válido"}' }));
    const dev = await devLikeServer(port);

    const response = await fetch(`http://127.0.0.1:${dev}/api/admin/items/1`, { method: 'PATCH', body: '{"status":"x"}' });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, message: 'Estado no válido' });
  });

  it('la landing y los assets NO se reenvían al CRM', async () => {
    const { port, seen } = await fakeCrm(() => ({}));
    const dev = await devLikeServer(port);

    const page = await fetch(`http://127.0.0.1:${dev}/`);
    const asset = await fetch(`http://127.0.0.1:${dev}/assets/main.js`);

    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('landing');
    expect(asset.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('/panel redirige a /admin/ conservando el token antiguo', async () => {
    const { port } = await fakeCrm(() => ({}));
    const dev = await devLikeServer(port);

    const response = await fetch(`http://127.0.0.1:${dev}/panel?token=abc`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/?token=abc');
  });
});

describe('crm-proxy · CRM apagado', () => {
  it('responde 502 con un mensaje legible en vez de un error opaco', async () => {
    const dev = await devLikeServer(await freePort());

    const response = await fetch(`http://127.0.0.1:${dev}/api/admin/login`, { method: 'POST', body: '{}' });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.ok).toBe(false);
    expect(body.message).toContain('npm run crm');
    expect(body.message).toContain('no está respondiendo');
  });

  it('probeCrm devuelve el latido cuando hay CRM y null cuando no lo hay', async () => {
    const { port } = await fakeCrm(() => ({ body: '{"ok":true,"storage":"sqlite","items":3}' }));

    await expect(probeCrm({ port })).resolves.toMatchObject({ ok: true, storage: 'sqlite', items: 3 });
    await expect(probeCrm({ port: await freePort(), timeout: 300 })).resolves.toBeNull();
  });
});
