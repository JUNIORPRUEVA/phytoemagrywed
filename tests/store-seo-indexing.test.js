/**
 * SEO de FULLTECH Store — regresión del dominio canónico, sitemap, robots y
 * política de indexabilidad. Todo con datos simulados: no toca producción.
 */
import { describe, expect, it } from 'vitest';
import {
  isPublicOrigin,
  productCanonical,
  renderProductPage,
  renderRobots,
  renderSitemap,
  renderStoreGone,
  renderStoreNotFound,
  renderStoreShell,
  storeOrigin,
} from '../server/store-seo.mjs';

const ORIGIN = 'https://fulltechrd.com';
const INTERNAL = 'https://ventas-fulltech-tienda-pwa.gcdndd.easypanel.host';

const product = (over = {}) => ({
  id: 'capsules_5',
  kind: 'product',
  name: 'FULLTECH Cápsulas 5',
  category: 'Phytoemagry',
  price: 1250,
  currency: 'DOP',
  availabilityState: 'AVAILABLE_NOW',
  shortDescription: 'Presentación de 5 cápsulas.',
  description: 'Presentación de 5 cápsulas con envío a todo el país.',
  imageUrl: '/api/store/products/capsules_5/image',
  ...over,
});

/* ------------------------------------------------------------------ origen */

describe('Origen canónico', () => {
  it('acepta dominios públicos y rechaza hosts internos o privados', () => {
    expect(isPublicOrigin('https://fulltechrd.com')).toBe(true);
    expect(isPublicOrigin('https://phytoemagryrd.lat')).toBe(true);
    expect(isPublicOrigin(INTERNAL)).toBe(false);
    expect(isPublicOrigin('http://localhost:8790')).toBe(false);
    expect(isPublicOrigin('http://127.0.0.1:8790')).toBe(false);
    expect(isPublicOrigin('http://192.168.1.10')).toBe(false);
    expect(isPublicOrigin('http://10.0.0.5:8787')).toBe(false);
    expect(isPublicOrigin('http://store.internal')).toBe(false);
    expect(isPublicOrigin('')).toBe(false);
    expect(isPublicOrigin('no-es-una-url')).toBe(false);
  });

  it('la configuración válida gana y el host interno nunca se propaga', () => {
    const internalRequest = { headers: { host: 'ventas-fulltech-tienda-pwa.gcdndd.easypanel.host', 'x-forwarded-proto': 'https' } };
    expect(storeOrigin(internalRequest, ORIGIN)).toBe(ORIGIN);
    /* Sin configuración y con host interno: cadena vacía (el llamador cierra). */
    expect(storeOrigin(internalRequest, '')).toBe('');
    /* Sin configuración pero con host público: se usa el de la petición. */
    expect(storeOrigin({ headers: { host: 'fulltechrd.com', 'x-forwarded-proto': 'https' } }, '')).toBe(ORIGIN);
    /* Una configuración con host interno se ignora. */
    expect(storeOrigin({ headers: { host: 'fulltechrd.com', 'x-forwarded-proto': 'https' } }, INTERNAL)).toBe(ORIGIN);
  });
});

/* ----------------------------------------------------------------- sitemap */

describe('Sitemap', () => {
  it('usa solo URLs canónicas públicas y no duplica', () => {
    const { xml, urls, included } = renderSitemap({
      origin: ORIGIN,
      products: [product(), product({ id: 'capsules_10' }), product(), { id: '', name: 'sin id' }, { id: 'x' }],
    });
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(urls[0]).toBe(`${ORIGIN}/store/`);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain(`${ORIGIN}/store/p/capsules_10`);
    expect(urls.some((url) => url.includes('easypanel.host'))).toBe(false);
    expect(urls.some((url) => url.includes('127.0.0.1'))).toBe(false);
    expect(included).toEqual(['capsules_10', 'capsules_5']);
    /* Determinista: mismo resultado con los productos en otro orden. */
    const other = renderSitemap({ origin: ORIGIN, products: [product({ id: 'capsules_10' }), product()] });
    expect(other.urls).toEqual(urls);
  });

  it('no publica un sitemap con host interno ni con lista vacía inválida', () => {
    expect(renderSitemap({ origin: INTERNAL, products: [product()] }).xml).toBeNull();
    expect(renderSitemap({ origin: '', products: [product()] }).xml).toBeNull();
    const empty = renderSitemap({ origin: ORIGIN, products: [] });
    expect(empty.xml).toContain('<loc>https://fulltechrd.com/store/</loc>');
    expect(empty.included).toEqual([]);
  });

  it('escapa XML y usa lastmod solo con fecha real', () => {
    const risky = product({ id: 'p&1<', name: 'A & B <script>' });
    const { xml } = renderSitemap({ origin: ORIGIN, products: [product({ updatedAt: '2026-10-01T10:00:00Z' }), risky] });
    expect(xml).toContain('<lastmod>2026-10-01</lastmod>');
    expect(xml).not.toContain('<script>');
    /* El id se codifica en la ruta: nunca se cuela un `&` o un `<` crudo. */
    expect(xml).toContain('p%261%3C');
    expect(xml).not.toMatch(/<loc>[^<]*&(?!amp;)[^<]*<\/loc>/);
    const withoutDate = renderSitemap({ origin: ORIGIN, products: [product()] });
    expect(withoutDate.xml).not.toContain('<lastmod>');
  });
});

/* ------------------------------------------------------------------ robots */

describe('robots.txt de la tienda', () => {
  it('cierra todo cuando el entorno no es indexable', () => {
    const robots = renderRobots({ origin: ORIGIN, indexable: false });
    expect(robots).toContain('Disallow: /');
    expect(robots).not.toContain('Sitemap:');
  });

  it('permite solo lo público y anuncia el sitemap cuando sí lo es', () => {
    const robots = renderRobots({ origin: ORIGIN, indexable: true });
    expect(robots).toContain('Allow: /store/');
    expect(robots).toContain('Disallow: /admin/');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Disallow: /store/verify/');
    expect(robots).toContain(`Sitemap: ${ORIGIN}/store/sitemap.xml`);
  });

  it('no anuncia sitemap si el origen no es público', () => {
    const robots = renderRobots({ origin: INTERNAL, indexable: true });
    expect(robots).toContain('Disallow: /');
    expect(robots).not.toContain('Sitemap:');
  });
});

/* ----------------------------------------------------------- página producto */

describe('Página de producto', () => {
  it('declara canonical absoluto, og:url y Product con Offer disponibles', () => {
    const { html } = renderProductPage({ product: product(), origin: ORIGIN, indexable: true });
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/store/p/capsules_5">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/store/p/capsules_5">`);
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"availability":"https://schema.org/InStock"');
    expect(html).not.toContain('easypanel.host');
  });

  it('marca noindex cuando el entorno no es indexable', () => {
    const { html } = renderProductPage({ product: product(), origin: ORIGIN, indexable: false });
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  it('mapea disponibilidad bajo pedido y sin stock sin inventar datos', () => {
    const request = renderProductPage({ product: product({ availabilityState: 'ON_REQUEST', purchaseable: false }), origin: ORIGIN, indexable: true }).html;
    expect(request).toContain('https://schema.org/BackOrder');
    const out = renderProductPage({ product: product({ availabilityState: 'UNAVAILABLE' }), origin: ORIGIN, indexable: true }).html;
    expect(out).toContain('https://schema.org/OutOfStock');
    /* Sin precio no se inventa una oferta. */
    const noPrice = renderProductPage({ product: product({ price: null }), origin: ORIGIN, indexable: true }).html;
    expect(noPrice).not.toContain('"price"');
  });
});

/* --------------------------------------------------------------- portada */

describe('Portada de la tienda', () => {
  const shell = `<!doctype html><html lang="es-DO"><head><meta charset="utf-8"><title>FULLTECH Store</title></head><body><main id="main" tabindex="-1"></main><script type="module" src="/store/store.js?v=16"></script></body></html>`;

  it('inyecta canonical, og y enlaces rastreables sin tocar la app', () => {
    const page = renderStoreShell({ html: shell, origin: ORIGIN, indexable: true, products: [product(), product({ id: 'capsules_10', name: 'FULLTECH 10' })] });
    expect(page.canonical).toBe(`${ORIGIN}/store/`);
    expect(page.html).toContain(`<link rel="canonical" href="${ORIGIN}/store/">`);
    expect(page.html).toContain('<meta property="og:url" content="https://fulltechrd.com/store/">');
    expect(page.html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(page.html).toContain(`<a href="${ORIGIN}/store/p/capsules_5">FULLTECH Cápsulas 5</a>`);
    expect(page.html).toContain('<noscript>');
    /* El script de la PWA sigue intacto. */
    expect(page.html).toContain('/store/store.js?v=16');
    expect((page.html.match(/<title>/g) ?? []).length).toBe(1);
  });

  it('sin indexación no publica canonical ni enlaces', () => {
    const page = renderStoreShell({ html: shell, origin: ORIGIN, indexable: false, products: [product()] });
    expect(page.html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(page.html).not.toContain('rel="canonical"');
    expect(page.canonical).toBe(`${ORIGIN}/store/`);
  });

  it('con host interno no genera canonical alguno', () => {
    const page = renderStoreShell({ html: shell, origin: INTERNAL, indexable: true, products: [product()] });
    expect(page.canonical).toBe('');
    expect(page.html).not.toContain('canonical');
    expect(page.html).toContain('noindex');
  });
});

/* ------------------------------------------------------------ ciclo de vida */

describe('Ciclo de vida de un artículo', () => {
  it('404, 410 y canonical se mantienen en el dominio público', () => {
    expect(productCanonical(ORIGIN, 'a b')).toBe(`${ORIGIN}/store/p/a%20b`);
    const missing = renderStoreNotFound({ origin: ORIGIN, indexable: false });
    expect(missing.html).toContain('noindex');
    const gone = renderStoreGone({ origin: ORIGIN, name: 'FULLTECH Cápsulas 5' });
    expect(gone.html).toContain('noindex');
    expect(gone.html).not.toContain('easypanel.host');
  });
});
