// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SW_PATH = path.join(process.cwd(), 'public', 'admin', 'sw.js');
const ORIGIN = 'https://crm.example';
/**
 * Nombre REAL de la caché de tiles. Se deriva de la VERSION del propio service
 * worker: subirla (obligatorio al tocar el armazón del panel) dejaba antes este
 * test en rojo por una cadena escrita a mano.
 */
const TILE_CACHE = `${/const VERSION = '([^']+)'/.exec(readFileSync(SW_PATH, 'utf8'))?.[1] ?? 'sin-version'}-tiles`;

let handlers;
let stores;
let networkCalls;
let networkCount;
let networkMode;
let backgroundTasks;

function cacheApi(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const store = stores.get(name);
  return {
    async addAll(list) {
      for (const item of list) store.set(new URL(item, ORIGIN).href, new Response('shell'));
    },
    async put(request, response) {
      store.set(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url, response.clone());
    },
    async match(request) {
      return store.get(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);
    },
    async delete(request) {
      return store.delete(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);
    },
    async keys() {
      return [...store.keys()].map((url) => new Request(url));
    },
  };
}

async function tileRequest(url) {
  let responsePromise = null;
  handlers.get('fetch')({
    request: new Request(url),
    waitUntil(value) {
      backgroundTasks.push(value);
    },
    respondWith(value) {
      responsePromise = value;
    },
  });
  return responsePromise ? responsePromise : null;
}

beforeEach(() => {
  handlers = new Map();
  stores = new Map();
  networkCalls = [];
  networkCount = 0;
  networkMode = 'ok';
  backgroundTasks = [];
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => handlers.set(type, fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name) => cacheApi(name),
      keys: async () => [...stores.keys()],
      match: async (request) => {
        for (const name of stores.keys()) {
          const found = await cacheApi(name).match(request);
          if (found) return found;
        }
        return undefined;
      },
      delete: async (name) => stores.delete(name),
    },
    URL,
    Request,
    Response,
    Headers,
    console,
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      networkCalls.push(url);
      networkCount += 1;
      if (networkMode === 'offline') throw new Error('offline');
      return new Response(`tile-${networkCount}`, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });
});

describe('delivery map service worker cache', () => {
  it('precarga Leaflet local dentro del app shell', () => {
    const sw = readFileSync(SW_PATH, 'utf8');
    expect(sw).toContain('/admin/vendor/leaflet/leaflet.css');
    expect(sw).toContain('/admin/vendor/leaflet/leaflet.js');
    expect(sw).toContain('/admin/vendor/leaflet/images/marker-icon.png');
  });

  it('cachea tiles visitados y en segunda carga responde desde cache', async () => {
    const url = 'https://a.tile.openstreetmap.org/16/19164/28882.png';
    const first = await tileRequest(url);
    expect(await (await first).text()).toBe('tile-1');
    expect(networkCalls).toEqual([url]);

    const second = await tileRequest(url);
    expect(await (await second).text()).toBe('tile-1');
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    expect(networkCalls).toEqual([url, url]);
  });

  it('con cache hit no espera red lenta para pintar el tile', async () => {
    const url = 'https://b.tile.openstreetmap.org/16/19165/28882.png';
    await (await tileRequest(url)).text();
    stores.get(TILE_CACHE).set(url, new Response('cached-now'));
    networkMode = 'offline';

    const second = await tileRequest(url);
    expect(await (await second).text()).toBe('cached-now');
    expect(backgroundTasks).toHaveLength(1);
    await Promise.all(backgroundTasks);
    expect(networkCalls).toEqual([url, url]);
  });

  it('si red cae sin cache devuelve fallo de tile sin romper el fetch handler', async () => {
    networkMode = 'offline';
    const response = await tileRequest('https://c.tile.openstreetmap.org/16/19166/28882.png');
    expect((await response).status).toBe(504);
  });

  it('declara límite y vencimiento de cache de tiles', () => {
    const sw = readFileSync(SW_PATH, 'utf8');
    // El límite existe y es razonable para un teléfono (ni 100 ni 100.000).
    const limite = Number(/const MAX_TILE_ENTRIES = (\d+)/.exec(sw)?.[1] ?? 0);
    expect(limite).toBeGreaterThan(400);
    expect(limite).toBeLessThan(4000);
    expect(sw).toContain('const TILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000');
    expect(sw).toContain('trimTileCache');
    expect(sw).toContain('now - entry.at > TILE_MAX_AGE_MS');
  });

  it('cachea también la imagen de satélite (Esri) y sus calles', async () => {
    const imagen = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/61047/49112';
    const calles =
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/17/61047/49112';
    const primera = await tileRequest(imagen);
    expect(await (await primera).text()).toBe('tile-1');
    const segunda = await tileRequest(calles);
    expect(await (await segunda).text()).toBe('tile-2');
    // Y en la segunda vuelta, sin cobertura, la foto sale de la caché igual.
    networkCalls = [];
    networkMode = 'offline';
    const repetida = await tileRequest(imagen);
    expect(await (await repetida).text()).toBe('tile-1');
    await Promise.all(backgroundTasks);
    // La foto se pintó desde la caché: lo único que se intenta es refrescarla por detrás.
    expect(networkCalls).toEqual([imagen]);
  });

  it('no intercepta proveedores desconocidos como tile cache', async () => {
    const response = await tileRequest('https://tiles.example/16/1/1.png');
    expect(response).toBeNull();
    expect(networkCalls).toEqual([]);
    // Y tampoco otros servicios de Esri que no son tiles de mapa.
    expect(await tileRequest('https://server.arcgisonline.com/ArcGIS/rest/services/Other/MapServer/tile/17/1/1')).toBeNull();
  });
});
