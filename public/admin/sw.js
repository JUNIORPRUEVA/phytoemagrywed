/*
 * Service worker del panel (PWA).
 *
 *  - El armazón de la app (HTML, CSS, JS, iconos) se guarda en caché: el panel
 *    abre al instante y sigue abriendo sin conexión.
 *  - Los datos (/api/…) NUNCA se cachean: el negocio necesita ver el último
 *    pedido, no una copia vieja. Los datos offline los guarda la propia app.
 */

const VERSION = 'crm-v23-satelite';
const TILE_CACHE = `${VERSION}-tiles`;
const TILE_META = `${VERSION}-tile-meta`;
const MAX_TILE_ENTRIES = 1200;
const TILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SHELL = [
  '/admin/',
  '/admin/index.html',
  '/admin/admin.css',
  '/admin/app.js',
  '/admin/manifest.json',
  '/admin/vendor/leaflet/leaflet.css',
  '/admin/vendor/leaflet/leaflet.js',
  '/admin/vendor/leaflet/images/layers-2x.png',
  '/admin/vendor/leaflet/images/layers.png',
  '/admin/vendor/leaflet/images/marker-icon-2x.png',
  '/admin/vendor/leaflet/images/marker-icon.png',
  '/admin/vendor/leaflet/images/marker-shadow.png',
  '/admin/assets/sounds/message-notification.wav',
  '/admin/logo-phytoemagry.png',
  '/admin/icon-192.png',
  '/admin/icon-512.png',
  '/admin/icon-maskable-512.png',
  '/admin/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => ![VERSION, TILE_CACHE, TILE_META].includes(key)).map((key) => caches.delete(key)));
      await Promise.all(keys.filter((key) => key.endsWith('-tiles') && key !== TILE_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Tiles del mapa que SÍ se cachean (los "visitados", para que el mapa vuelva a
 * pintarse sin datos). Solo estos proveedores, y siempre pidiendo la imagen real:
 *   - OpenStreetMap (el mapa dibujado),
 *   - Esri World Imagery / World Transportation (la foto de satélite y sus calles).
 * Cualquier otro dominio pasa de largo: no se cachea lo que no se conoce.
 */
function isMapTile(url) {
  if (/^https:\/\/[abc]\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url.href)) return true;
  return (
    url.origin === 'https://server.arcgisonline.com' &&
    /^\/ArcGIS\/rest\/services\/(World_Imagery|Reference\/World_Transportation)\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(url.pathname)
  );
}

async function tileMeta() {
  const cache = await caches.open(TILE_META);
  const response = await cache.match('/__tile_meta__');
  if (!response) return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function saveTileMeta(meta) {
  const cache = await caches.open(TILE_META);
  await cache.put('/__tile_meta__', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
}

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const meta = await tileMeta();
  const now = Date.now();
  const keys = await cache.keys();
  const entries = keys
    .map((request) => ({ request, url: request.url, at: Number(meta[request.url] ?? 0) || 0 }))
    .sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    if (now - entry.at > TILE_MAX_AGE_MS || entries.length > MAX_TILE_ENTRIES) {
      await cache.delete(entry.request);
      delete meta[entry.url];
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    }
  }
  await saveTileMeta(meta);
}

async function refreshTile(request, cached) {
  const cache = await caches.open(TILE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      const meta = await tileMeta();
      meta[request.url] = Date.now();
      await saveTileMeta(meta);
      trimTileCache().catch(() => {});
    }
    return response;
  } catch {
    return cached || new Response('', { status: 504, statusText: 'tile offline' });
  }
}

async function tileResponse(request, event) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    event?.waitUntil?.(refreshTile(request, cached));
    return cached;
  }
  return refreshTile(request, null);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isMapTile(url)) {
    event.respondWith(tileResponse(request, event));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Datos: siempre a la red (y si falla, la app usa su copia local).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ ok: false, error: 'offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    return;
  }

  if (!url.pathname.startsWith('/admin/')) return;

  // Armazón: red primero (para recibir mejoras), caché como red de seguridad.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(VERSION);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        const shell = await caches.match('/admin/index.html');
        if (shell) return shell;
        return new Response('Sin conexión', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'Phytoemagry';
  const deepLink =
    payload.deepLink ||
    (payload.conversationId
      ? `/admin/?v=whatsapp&conversation=${encodeURIComponent(payload.conversationId)}`
      : payload.orderId
        ? `/admin/?v=delivery&order=${encodeURIComponent(payload.orderId)}`
        : '/admin/');
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'Tienes una actualización en el CRM.',
      tag: payload.notificationId || payload.conversationId || payload.orderId || 'phyto-crm',
      data: {
        deepLink,
        orderId: payload.orderId || null,
        conversationId: payload.conversationId || null,
        notificationId: payload.notificationId || null,
      },
      icon: '/admin/icon-192.png',
      badge: '/admin/icon-192.png',
      vibrate: Array.isArray(payload.vibrate) ? payload.vibrate : undefined,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.deepLink || '/admin/?v=delivery', self.location.origin);
  if (data.notificationId && !target.searchParams.get('notification')) target.searchParams.set('notification', data.notificationId);
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const admin = list.find((client) => new URL(client.url).pathname.startsWith('/admin/'));
      if (admin) {
        await admin.focus();
        if ('navigate' in admin) return admin.navigate(target.href);
        return null;
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
