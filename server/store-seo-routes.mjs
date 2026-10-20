/**
 * RUTAS SEO DE LA TIENDA (`/store/p/:id`, `/store/sitemap.xml`, `/store/robots.txt`).
 *
 * En producción nginx sirve `public/` de forma estática; estas tres rutas las
 * resuelve el servidor del CRM porque dependen del catálogo vivo. En UAT se
 * prueban directamente contra el mismo servidor.
 *
 * Si el entorno no está autorizado a indexar (`PHYTO_STORE_INDEXABLE`), todo
 * sale con `noindex` y `robots.txt` cierra el rastreo entero.
 */
import {
  renderProductPage,
  renderRobots,
  renderSitemap,
  renderStoreGone,
  renderStoreNotFound,
  renderStoreShell,
  storeOrigin,
} from './store-seo.mjs';

const PRODUCT_PATH = /^\/store\/p\/([A-Za-z0-9_-]{1,80})$/;
/** Portada de la tienda: se sirve la PWA con la cabecera SEO inyectada. */
const STORE_HOME = '/store/';
let shellCache = { html: '', at: 0 };

function send(res, req, status, body, headers) {
  res.writeHead(status, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

export async function handleStoreSeoRoute({ req, res, route, ctx }) {
  const isProduct = PRODUCT_PATH.test(route);
  /*
   * El router del CRM elimina la barra final, así que `/store/` llega como
   * `/store`. La barra original se recupera de `req.url` para redirigir solo la
   * variante sin barra y no provocar un bucle 301.
   */
  const rawPath = String(req.url ?? '').split('?')[0];
  const isHome = route === '/store';
  if (route !== '/store/robots.txt' && route !== '/store/sitemap.xml' && !isProduct && !isHome) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    send(res, req, 405, 'Método no permitido', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return true;
  }

  /* `/store` sin barra: una sola URL canónica, con redirección permanente. */
  if (isHome && !rawPath.startsWith(STORE_HOME)) {
    res.writeHead(301, { location: STORE_HOME, 'cache-control': 'public, max-age=300' });
    res.end();
    return true;
  }

  const seo = ctx.storeSeo ?? {};
  const indexable = seo.indexable === true;
  const origin = storeOrigin(req, seo.publicUrl);
  const catalog = ctx.storeCatalog;

  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'cache-control': indexable ? 'public, max-age=0, s-maxage=60, must-revalidate' : 'no-store',
    ...(indexable && origin ? {} : { 'x-robots-tag': 'noindex, nofollow' }),
  };

  if (route === '/store/robots.txt') {
    return send(res, req, 200, renderRobots({ origin, indexable }), {
      ...baseHeaders,
      'content-type': 'text/plain; charset=utf-8',
    });
  }

  if (!catalog) {
    return send(res, req, 503, 'La tienda no está disponible.', {
      ...baseHeaders,
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '30',
    });
  }

  let products = [];
  try {
    products = await catalog.publicProducts();
  } catch (error) {
    console.error('[store-seo] catalog failed', { code: error?.code });
    return send(res, req, 503, 'La tienda no está disponible.', {
      ...baseHeaders,
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '30',
    });
  }

  if (isHome) {
    let shell = '';
    try {
      shell = await readStoreShell();
    } catch {
      shell = '';
    }
    if (!shell) {
      /*
       * Sin HTML base se responde 503 a propósito: nginx tiene un `error_page`
       * que sirve el índice estático de la PWA. Devolver 404 aquí rompería la
       * portada (pasó en el primer intento de este release).
       */
      return send(res, req, 503, 'Portada no disponible en este momento.', {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '30',
      });
    }
    const page = renderStoreShell({ html: shell, origin, indexable, products, siteName: seo.siteName });
    return send(res, req, 200, page.html, { ...baseHeaders, 'content-type': 'text/html; charset=utf-8' });
  }

  if (route === '/store/sitemap.xml') {
    const { xml } = renderSitemap({ origin, products });
    /* Sin origen público válido no se publica un sitemap con hosts internos. */
    if (!xml) {
      return send(res, req, 503, 'Sitemap no disponible: falta configurar el dominio público de la tienda.', {
        ...baseHeaders,
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '60',
      });
    }
    return send(res, req, 200, xml, { ...baseHeaders, 'content-type': 'application/xml; charset=utf-8' });
  }

  const id = decodeURIComponent(PRODUCT_PATH.exec(route)[1]);
  const product = products.find((item) => String(item.id) === id);
  const htmlHeaders = { ...baseHeaders, 'content-type': 'text/html; charset=utf-8' };

  if (!product) {
    /*
     * 404 o 410: si el artículo EXISTE en el catálogo pero está inactivo o sin
     * publicar, la respuesta correcta es 410 (existió y ya no está). Solo se
     * responde 404 cuando nunca existió o no hay forma de saberlo.
     */
    let everExisted = false;
    try {
      const all = typeof catalog.list === 'function' ? await catalog.list({ includeInactive: true }) : [];
      everExisted = all.some((item) => String(item.id) === id);
    } catch {
      everExisted = false;
    }
    if (everExisted) {
      const gone = renderStoreGone({ origin, siteName: seo.siteName });
      return send(res, req, 410, gone.html, htmlHeaders);
    }
    const missing = renderStoreNotFound({ origin, indexable: false, siteName: seo.siteName });
    return send(res, req, 404, missing.html, htmlHeaders);
  }

  const page = renderProductPage({ product, origin, indexable: indexable && Boolean(origin), siteName: seo.siteName });
  return send(res, req, 200, page.html, htmlHeaders);
}

/**
 * HTML base de la PWA. En el repositorio está en `public/store/index.html`; en
 * la imagen de producción nginx lo sirve desde `/usr/share/nginx/html/store/`.
 * Se prueban las dos rutas y se cachea 60 s.
 */
async function readStoreShell() {
  if (shellCache.html && Date.now() - shellCache.at < 60000) return shellCache.html;
  const { readFile } = await import('node:fs/promises');
  const candidates = [
    new URL('../public/store/index.html', import.meta.url),
    new URL('file:///usr/share/nginx/html/store/index.html'),
  ];
  for (const candidate of candidates) {
    try {
      const html = await readFile(candidate, 'utf8');
      if (html.includes('<html')) {
        shellCache = { html, at: Date.now() };
        return html;
      }
    } catch {
      /* se prueba la siguiente ruta */
    }
  }
  return '';
}
