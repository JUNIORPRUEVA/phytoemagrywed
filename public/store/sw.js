const VERSION = 'fulltech-store-v66';
const SHELL = [
  '/store/discovery.css?v=21',
  '/store/assets/icons/custom/search-large.png',
  '/store/assets/icons/custom/find-for-you.png',
  '/store/floating-cart.css?v=3',
  '/store/presentation.css?v=2',
  '/store/',
  '/store/index.html',
  '/store/store.css?v=7',
  '/store/premium.css?v=5',
  '/store/design-system.css?v=10',
  '/store/storefront.css?v=3',
  '/store/store.js?v=48',
  '/store/product-gallery.js?v=4',
  '/store/product-gallery.css?v=5',
  '/store/icons.js',
  '/store/custom-icons.js?v=1',
  '/store/custom-icons.css?v=1',
  '/store/assets/icons/custom/home.png',
  '/store/assets/icons/custom/categories.png',
  '/store/assets/icons/custom/filter.png',
  '/store/assets/icons/custom/back.png',
  '/store/assets/icons/custom/share.png',
  '/store/assets/icons/custom/estrella.png',
  '/store/assets/icons/custom/instalar-en-pc.png',
  '/store/assets/icons/custom/truck.png',
  '/store/assets/icons/custom/cart.png',
  '/store/assets/icons/custom/whatsapp.png',
  '/store/assets/icons/custom/account.png',
  '/store/assets/icons/custom/down.png',
  '/store/assets/icons/custom/up.png',
  '/store/assets/icons/custom/plus.png',
  '/store/assets/icons/custom/close.png',
  '/store/assets/icons/custom/menu.png',
  '/store/assets/icons/custom/delete.png',
  '/store/assets/icons/custom/search.png',

  '/store/assets/branding/fulltech-store-header-transparent-144.webp',
  '/store/assets/branding/fulltech-store-header-transparent-144.png',
  '/store/assets/branding/fulltech-store-header-transparent-288.webp',
  '/store/assets/branding/fulltech-store-header-transparent-288.png',
  '/store/assets/branding/fulltech-store-header-transparent-432.webp',
  '/store/assets/branding/fulltech-store-header-transparent-432.png',
  '/store/assets/branding/fulltech-store-horizontal-240.webp',
  '/store/assets/branding/fulltech-store-horizontal-240.png',
  '/store/assets/branding/fulltech-store-horizontal-480.webp',
  '/store/assets/branding/fulltech-store-horizontal-480.png',
  '/store/assets/branding/fulltech-store-horizontal-720.webp',
  '/store/assets/branding/fulltech-store-horizontal-720.png',

  '/store/manifest.webmanifest',
  '/store/icon.svg',
  '/store/icon-192.png',
  '/store/icon-512.png',
];
const PUBLIC_CATALOG = /^\/api\/store\/(?:catalog|categories|home)(?:\?.*)?$/;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fulltech-store-') && key !== VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) return;
  if (PUBLIC_CATALOG.test(`${url.pathname}${url.search}`)) {
    event.respondWith((async () => {
      const cache = await caches.open(`${VERSION}-public`);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request);
        return cached || new Response(JSON.stringify({ ok: false, offline: true, products: [], categories: [] }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } });
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/store/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && response.type === 'basic') caches.open(VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
