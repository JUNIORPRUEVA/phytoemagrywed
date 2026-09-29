/*
 * Service worker del panel (PWA).
 *
 *  - El armazón de la app (HTML, CSS, JS, iconos) se guarda en caché: el panel
 *    abre al instante y sigue abriendo sin conexión.
 *  - Los datos (/api/…) NUNCA se cachean: el negocio necesita ver el último
 *    pedido, no una copia vieja. Los datos offline los guarda la propia app.
 */

const VERSION = 'crm-v1';
const SHELL = [
  '/admin/',
  '/admin/index.html',
  '/admin/admin.css',
  '/admin/app.js',
  '/admin/manifest.json',
  '/admin/icon-192.png',
  '/admin/icon-512.png',
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
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
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
