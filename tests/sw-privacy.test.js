// @vitest-environment node
/**
 * EL SERVICE WORKER NO PUEDE GUARDAR NADA PRIVADO.
 *
 * El panel es una PWA: guarda el armazón (HTML, CSS, JS, iconos) para abrir sin
 * conexión. Lo que NO puede guardar —nunca— son los datos del negocio:
 *
 *   · `/api/*` (pedidos, conversaciones, clientes…) porque el vendedor tiene que
 *     ver el último mensaje, no una copia vieja;
 *   · los archivos privados (`/api/admin/media/…`), que se piden con la sesión y
 *     el almacén guarda privados a propósito;
 *   · cualquier respuesta autenticada, esté donde esté.
 *
 * Este test ejecuta el `sw.js` REAL en un entorno con cachés de mentira y
 * comprueba qué se cachea y qué no al recibir peticiones de verdad.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SW_PATH = path.join(process.cwd(), 'public', 'admin', 'sw.js');
const ORIGIN = 'https://crm.example';

let handlers;
let cachePuts;
let cacheMatches;
let networkCalls;

/** Caché de mentira que apunta TODO lo que se guarda o se busca. */
function fakeCaches() {
  return {
    async open() {
      return {
        async addAll(list) {
          for (const item of list) cachePuts.push(new URL(item, ORIGIN).href);
        },
        async put(request, response) {
          cachePuts.push(typeof request === 'string' ? request : request.url);
          return response;
        },
      };
    },
    async keys() {
      return ['crm-v1', 'crm-v2'];
    },
    async match(request) {
      cacheMatches.push(typeof request === 'string' ? request : request.url);
      return undefined;
    },
    async delete() {
      return true;
    },
  };
}

/** Lanza una petición contra el service worker y devuelve si la interceptó. */
async function request({ url, method = 'GET', ok = true, body = 'x' }) {
  const full = new URL(url, ORIGIN).href;
  const captured = [];
  let responsePromise = null;
  const event = {
    request: new Request(full, { method, headers: { cookie: 'phyto=secreta' } }),
    respondWith(value) {
      responsePromise = value;
    },
  };
  const handler = handlers.get('fetch');
  handler(event);
  if (responsePromise) {
    const response = await responsePromise;
    captured.push(response);
  }
  return { intercepted: Boolean(responsePromise), response: captured[0] ?? null };
}

beforeEach(() => {
  handlers = new Map();
  cachePuts = [];
  cacheMatches = [];
  networkCalls = [];

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };

  const sandbox = {
    self,
    caches: fakeCaches(),
    URL,
    Request,
    Response,
    Headers,
    console,
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      networkCalls.push(url);
      return new Response('contenido', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('service worker: nunca guarda datos privados', () => {
  it('está instalado y escucha install/activate/fetch', () => {
    for (const type of ['install', 'activate', 'fetch']) {
      expect(typeof handlers.get(type)).toBe('function');
    }
  });

  it('el armazón que precarga no incluye NINGUNA ruta /api/', () => {
    const fuente = readFileSync(SW_PATH, 'utf8');
    const shell = fuente.slice(fuente.indexOf('const SHELL'), fuente.indexOf('];', fuente.indexOf('const SHELL')));
    expect(shell).not.toMatch(/\/api\//);
    expect(shell).toContain('/admin/app.js');
  });

  it('una respuesta de datos (/api/…) va a la red y NO se guarda en caché', async () => {
    const { intercepted } = await request({ url: '/api/admin/data' });
    expect(intercepted).toBe(true);
    expect(networkCalls).toEqual([`${ORIGIN}/api/admin/data`]);
    expect(cachePuts).toEqual([]);
    expect(cacheMatches).toEqual([]);
  });

  it('un archivo privado (/api/admin/media/…) tampoco se guarda ni se sirve de caché', async () => {
    const { intercepted } = await request({
      url: '/api/admin/media/3b1f?download=1',
      ok: false,
    });
    expect(intercepted).toBe(true);
    expect(cachePuts).toEqual([]);
    expect(cacheMatches).toEqual([]);
    expect(networkCalls).toEqual([`${ORIGIN}/api/admin/media/3b1f?download=1`]);
  });

  it('ni la auditoría, ni las conversaciones, ni los pedidos (nada autenticado bajo /api/)', async () => {
    for (const ruta of ['/api/admin/audit?entity=message', '/api/admin/conversations', '/api/admin/orders', '/api/admin/me']) {
      await request({ url: ruta });
    }
    expect(cachePuts).toEqual([]);
    expect(cacheMatches).toEqual([]);
    expect(networkCalls).toHaveLength(4);
  });

  it('si la red falla en /api/, contesta 503 y NO inventa una respuesta guardada', async () => {
    const original = globalThis.fetch;
    // El sandbox sustituye `fetch`; aquí se prueba el camino de error del SW.
    const sandbox = {
      self: {
        location: { origin: ORIGIN },
        addEventListener: (type, fn) => handlers.set(type, fn),
        skipWaiting: () => {},
        clients: { claim: async () => {} },
      },
      caches: fakeCaches(),
      URL,
      Request,
      Response,
      Headers,
      console,
      fetch: async () => {
        throw new Error('sin conexión');
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });
    void original;

    const { intercepted, response } = await request({ url: '/api/admin/data' });
    expect(intercepted).toBe(true);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(cachePuts).toEqual([]);
    expect(cacheMatches).toEqual([]);
  });

  it('el armazón sí se puede guardar, pero solo bajo /admin/', async () => {
    const { intercepted, response } = await request({ url: '/admin/app.js' });
    expect(intercepted).toBe(true);
    expect(response.status).toBe(200);
    expect(cachePuts).toEqual([`${ORIGIN}/admin/app.js`]);
  });

  it('no intercepta lo que no es del panel: ni otros orígenes ni métodos que escriben', async () => {
    const externo = await request({ url: 'https://ajeno.example/api/admin/data' });
    expect(externo.intercepted).toBe(false);

    const publico = await request({ url: '/gracias.html' });
    expect(publico.intercepted).toBe(false);

    const escritura = await request({ url: '/api/admin/conversations/1/messages', method: 'POST' });
    expect(escritura.intercepted).toBe(false);

    const enviarArchivo = await request({ url: '/api/admin/conversations/1/media?kind=image', method: 'POST' });
    expect(enviarArchivo.intercepted).toBe(false);

    expect(networkCalls).toEqual([]);
    expect(cachePuts).toEqual([]);
  });

  it('la sesión (cookie) no acaba guardada en ninguna caché', async () => {
    await request({ url: '/admin/' });
    await request({ url: '/admin/app.js' });
    for (const guardado of cachePuts) {
      expect(String(guardado)).not.toMatch(/cookie|phyto=|session|token=/i);
    }
  });
});
