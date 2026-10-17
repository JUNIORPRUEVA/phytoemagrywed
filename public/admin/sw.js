/*
 * Service worker del panel (PWA).
 *
 *  - El armazón de la app (HTML, CSS, JS, iconos) se guarda en caché: el panel
 *    abre al instante y sigue abriendo sin conexión.
 *  - Los datos privados viven en IndexedDB, separados por cuenta y con acceso
 *    local limitado a 24 horas. La red tiene prioridad cuando está disponible.
 */

if(typeof importScripts==='function')importScripts('/admin/offline-storage.js');
const VERSION = 'crm-v120-chat-escritorio';
const TILE_CACHE = `${VERSION}-tiles`;
const TILE_META = `${VERSION}-tile-meta`;
const MAX_TILE_ENTRIES = 1200;
const TILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const REQUIRED_SHELL = new Set(['/admin/index.html', '/admin/app.js', '/admin/admin.css', '/admin/startup-recovery.js', '/admin/offline-storage.js', '/admin/offline.js', '/admin/offline-ui.js', '/admin/pos.js', '/admin/store.js', '/admin/pos-math.js']);
const SHELL = [
  '/admin/receipt-pdf.js',
  '/admin/receipt-brand.js',
  '/admin/receipt-viewer.html',
  '/admin/receipt-launcher.js',
  '/admin/receipt-viewer.js',
  '/admin/vendor/pdfjs/pdf.mjs',
  '/admin/vendor/pdfjs/pdf.worker.mjs',
  '/admin/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  '/admin/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  '/admin/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  '/admin/',
  '/admin/index.html',
  '/admin/admin.css',
  '/admin/settings.css',
  '/admin/fulltech.css',
  '/admin/navigation.css',
  '/admin/assets/icons/chat-call.png',
  '/admin/assets/icons/chat-search.png',
  '/admin/assets/icons/chat-microphone.png',
  '/admin/assets/icons/chat-send.png',
  '/admin/menus-safe-area.css',
  '/admin/proofreading.css',
  '/admin/proofreading.js',
  '/admin/deepseek-settings.js',
  '/admin/chat-sharing-settings.js',
  '/admin/chat-sharing.css',
  '/admin/vendor/proofreading/worker.js',
  '/admin/vendor/proofreading/es-DO.aff',
  '/admin/vendor/proofreading/es-DO.dic',
  '/admin/shell-v2-tema.css',
  '/admin/wa-lista.css',
  '/admin/wa-desktop.css',
  '/admin/app.js',
  '/admin/offline-storage.js',
  '/admin/offline.js',
  '/admin/offline-report.js',
  '/admin/offline-ui.js',
  '/admin/offline.css',
  '/admin/startup-recovery.js',
  '/admin/calling.js',
  '/admin/store.js',
  '/admin/store.css',
  '/admin/pos.js',
  '/admin/pos-math.js',
  '/admin/quote-document.js',
  '/admin/pos.css',
  '/admin/manifest.json',
  '/admin/vendor/leaflet/leaflet.css',
  '/admin/vendor/leaflet/leaflet.js',
  '/admin/vendor/leaflet/images/layers-2x.png',
  '/admin/vendor/leaflet/images/layers.png',
  '/admin/vendor/leaflet/images/marker-icon-2x.png',
  '/admin/vendor/leaflet/images/marker-icon.png',
  '/admin/vendor/leaflet/images/marker-shadow.png',
  '/admin/assets/sounds/message-notification.wav',
  '/admin/fulltech-logo.png',
  '/admin/fulltech-favicon.png?v=2',
  '/admin/fulltech-icon-192.png?v=2',
  '/admin/fulltech-icon-512.png?v=2',
  '/admin/fulltech-icon-maskable-512.png?v=2',
  '/admin/fulltech-apple-touch-icon.png?v=2',
];
for(const file of ['/admin/receipt-pdf.js','/admin/receipt-brand.js','/admin/receipt-viewer.html','/admin/receipt-launcher.js','/admin/receipt-viewer.js','/admin/vendor/pdfjs/pdf.mjs','/admin/vendor/pdfjs/pdf.worker.mjs','/admin/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf','/admin/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf','/admin/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf'])REQUIRED_SHELL.add(file);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(async (cache) => {
        /*
         * ARCHIVO A ARCHIVO, no con `addAll`: con `addAll` un solo archivo que
         * falte (un icono, un sonido) deja el armazón ENTERO sin guardar y el
         * panel no abre sin conexión. Así, lo que se pueda guardar se guarda.
         */
        const missing=[];
        for (const url of SHELL) {
          try {
            await cache.add(url);
          } catch (error) {
            missing.push(url);
            if (REQUIRED_SHELL.has(url)) throw error;
          }
        }
        await globalThis.FulltechOfflineStore?.put('shell',{version:VERSION,at:Date.now(),missing});
      })
      .then(() => self.skipWaiting()),
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

/*
 * El panel avisa por aquí cuando alguien pulsa «Actualizar»: si por lo que sea
 * quedó una versión esperando, se activa ya. Normalmente el propio `install`
 * hace skipWaiting y ni hace falta, pero así «Actualizar» nunca se queda mudo.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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

  // Datos privados: red primero; copia particionada por cuenta y con acceso de 24 h.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async()=>{
      async function local(){
        const store=globalThis.FulltechOfflineStore;if(!store)return null;
        const identity=await store.get('identity');
        if(!identity||Date.now()-identity.verifiedAt>86400000)return null;
        const saved=await store.get('response:'+identity.key+':'+url.href);
        if(!saved||saved.owner!==identity.key)return null;
        return new Response(saved.body,{status:saved.status,headers:[...saved.headers,['x-fulltech-offline','1']]});
      }
      try{
        const response=await fetch(request);
        if(response.status===401){await globalThis.FulltechOfflineStore?.remove('identity');return response;}
        if([502,503,504].includes(response.status)||url.pathname.startsWith('/api/admin/pos/local/'))return (await local())||response;
        if(response.status===404&&/\/(receipt|pdf)$/.test(url.pathname)){
          const store=globalThis.FulltechOfflineStore,identity=await store?.get('identity');
          const queue=identity?await store.get('queue:'+identity.key)||[]:[];
          if(queue.some(p=>url.pathname.includes(p.localId)))return (await local())||response;
        }
        return response;
      }catch{return (await local())||new Response(JSON.stringify({ok:false,error:'offline'}),{status:503,headers:{'content-type':'application/json'}});}
    })());
    return;
  }

  if (!url.pathname.startsWith('/admin/')) return;

  // Una página solo puede ser respaldo de otra navegación, nunca de JS/CSS.
  const navigation = request.mode === 'navigate' || request.destination === 'document' || /\/(?:index\.html)?$/.test(url.pathname);
  const resource = /\.(?:js|mjs|css|json)$/.test(url.pathname);
  const usable = (response) => response && !(resource && /text\/html/i.test(response.headers.get('content-type') || ''));
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (!response.ok || !usable(response)) throw new Error('shell_resource_unavailable');
      const cache = await caches.open(VERSION);
      await cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch {
      // El HTML usa ?v=…; install guarda las rutas base. Son el mismo recurso.
      const exact = await caches.match(request);
      if (usable(exact)) return exact;
      const base = await caches.match(url.origin + url.pathname);
      if (usable(base)) return base;
      if (navigation) {
        const shell = await caches.match('/admin/index.html');
        if (shell) return shell;
      }
      return new Response('Recurso no disponible sin conexión', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
  })());
});

// Nunca bloquear la presentación por una petición de diagnóstico.
async function reportPushReceipt(receipt, status, error = null) {
  if (!receipt?.jobId || !receipt?.token) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch('/api/push/receipts', {
      method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: receipt.jobId, token: receipt.token, status, error: error?.name || null, workerVersion: VERSION }),
    });
  } catch { /* Sin red: la falta de confirmación no prueba falta de recepción. */ }
  finally { clearTimeout(timeout); }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  // Incluso un payload vacío o inválido debe producir un aviso visible en Safari.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  const title = payload.title || 'FullTECH, SRL';
  const deepLink =
    payload.deepLink ||
    (payload.conversationId
      ? `/admin/?v=whatsapp&conversation=${encodeURIComponent(payload.conversationId)}`
      : payload.orderId
        ? `/admin/?v=delivery&order=${encodeURIComponent(payload.orderId)}`
        : '/admin/');
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, {
        body: payload.body || 'Tienes una actualización en el CRM.',
        tag: payload.notificationId || payload.conversationId || payload.orderId || 'phyto-crm',
        data: {
          deepLink,
          orderId: payload.orderId || null,
          conversationId: payload.conversationId || null,
          notificationId: payload.notificationId || null,
        },
        icon: '/admin/fulltech-icon-192.png?v=2',
        badge: '/admin/fulltech-icon-192.png?v=2',
        vibrate: Array.isArray(payload.vibrate) ? payload.vibrate : undefined,
      });
    } catch (error) {
      await reportPushReceipt(payload.receipt, 'display_failed', error);
      throw error;
    }
    await reportPushReceipt(payload.receipt, 'displayed');
  })());
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
