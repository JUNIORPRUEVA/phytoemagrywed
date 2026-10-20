/**
 * SEO DE FULLTECH STORE — páginas de producto renderizadas en el servidor.
 *
 * POR QUÉ EXISTE
 * La tienda usa rutas con `#` (`/store/#/product/:id`). Un fragmento NUNCA llega
 * al servidor, así que Google solo ve una página. Aquí se publica una URL real
 * por artículo publicado: `/store/p/<id>`, con HTML semántico completo, título,
 * descripción, canonical, Open Graph y datos estructurados válidos.
 *
 * REGLAS
 *  - Solo se publica lo que está publicado y activo (`catalog.publicProducts()`).
 *  - No se inventan precios, valoraciones, reseñas ni disponibilidad: los datos
 *    estructurados salen del catálogo real o se omiten.
 *  - UAT y vista previa quedan fuera del índice (`noindex` + `robots.txt`).
 */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const escapeXml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

/** JSON dentro de `<script>`: se neutraliza `<` para no cerrar la etiqueta. */
const jsonScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const cleanOrigin = (value) => String(value ?? '').trim().replace(/\/+$/, '');

/** Origen canónico: configuración explícita; si falta, el host de la petición. */
export function storeOrigin(req, configured = '') {
  const fixed = cleanOrigin(configured);
  if (fixed) return fixed;
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req?.socket?.encrypted ? 'https' : 'http');
  const host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export const productPath = (id) => `/store/p/${encodeURIComponent(String(id))}`;
export const productCanonical = (origin, id) => `${cleanOrigin(origin)}${productPath(id)}`;

const AVAILABILITY_SCHEMA = {
  AVAILABLE_NOW: 'https://schema.org/InStock',
  ON_REQUEST: 'https://schema.org/BackOrder',
  UNAVAILABLE: 'https://schema.org/OutOfStock',
};

const AVAILABILITY_TEXT = {
  AVAILABLE_NOW: 'Disponible para entrega',
  ON_REQUEST: 'Disponible bajo pedido',
  UNAVAILABLE: 'No disponible por ahora',
};

const money = (value, currency = 'DOP') => {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('es-DO', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
};

/** Meta descripción útil y sin cortar palabras a la mitad. */
export function metaDescription(product = {}) {
  const source = String(product.shortDescription || product.description || '').replace(/\s+/g, ' ').trim();
  const base = source || `${product.name ?? 'Artículo'} en FULLTECH Store, República Dominicana.`;
  if (base.length <= 155) return base;
  const cut = base.slice(0, 152);
  const space = cut.lastIndexOf(' ');
  return `${(space > 90 ? cut.slice(0, space) : cut).trim()}…`;
}

function productStructuredData({ product, canonical, origin, siteName }) {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    productID: String(product.id),
    url: canonical,
  };
  const description = String(product.description || product.shortDescription || '').trim();
  if (description) node.description = description;
  if (product.brand) node.brand = { '@type': 'Brand', name: product.brand };
  if (product.category) node.category = product.category;
  if (product.imageUrl) node.image = [`${cleanOrigin(origin)}${product.imageUrl}`];
  const rawPrice = product.price;
  const priced = rawPrice !== null && rawPrice !== undefined && rawPrice !== '' && Number.isFinite(Number(rawPrice));
  if (priced) {
    node.offers = {
      '@type': 'Offer',
      url: canonical,
      price: Number(rawPrice).toFixed(2),
      priceCurrency: product.currency || 'DOP',
      availability: AVAILABILITY_SCHEMA[product.availabilityState] ?? AVAILABILITY_SCHEMA.ON_REQUEST,
      seller: { '@type': 'Organization', name: siteName },
    };
  }
  return node;
}

function breadcrumbStructuredData({ product, canonical, origin }) {
  const items = [
    { '@type': 'ListItem', position: 1, name: 'Inicio', item: `${cleanOrigin(origin)}/store/` },
    { '@type': 'ListItem', position: 2, name: 'Catálogo', item: `${cleanOrigin(origin)}/store/#/catalog` },
  ];
  if (product.category) {
    items.push({
      '@type': 'ListItem',
      position: 3,
      name: product.category,
      item: `${cleanOrigin(origin)}/store/#/catalog?category=${encodeURIComponent(product.category)}`,
    });
  }
  items.push({ '@type': 'ListItem', position: items.length + 1, name: product.name, item: canonical });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f7f8fa;--fg:#111318;--muted:#5b6270;--card:#fff;--line:#e4e7ee;--accent:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#0d1016;--fg:#f2f4f8;--muted:#9aa3b2;--card:#151a22;--line:#232a35;--accent:#5b9cff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:920px;margin:0 auto;padding:20px 18px 48px}
header.site{display:flex;align-items:center;gap:12px;padding:14px 0}
.brand{font-weight:800;letter-spacing:.08em;text-decoration:none;color:var(--fg)}
.brand span{color:var(--accent)}
nav.crumbs{font-size:13px;color:var(--muted);margin:8px 0 18px}
nav.crumbs a{color:var(--muted);text-decoration:none}
main{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
.media{width:100%;height:auto;max-height:360px;object-fit:contain;border-radius:14px;background:var(--bg);margin-bottom:18px}
h1{font-size:clamp(22px,4vw,30px);line-height:1.2;margin:0 0 8px}
.cat{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0 0 6px}
.price{font-size:24px;font-weight:700;margin:12px 0}
.avail{display:inline-block;font-size:14px;color:var(--muted);margin-bottom:12px}
.desc{color:var(--fg);white-space:pre-line;margin:0 0 18px}
.cta{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:600}
.alt{display:inline-block;margin-left:10px;font-size:14px}
footer.site{color:var(--muted);font-size:13px;padding:22px 0 0}
`.trim();

function pageShell({ title, description, canonical, indexable, siteName, body, image = '' }) {
  return `<!doctype html>
<html lang="es-DO">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f7f8fa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1016" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="${indexable ? 'index,follow,max-image-preview:large' : 'noindex,nofollow'}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(siteName)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">\n<meta property="og:image:alt" content="${escapeHtml(title)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/store/icon.svg" type="image/svg+xml">
<style>${BASE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="site"><a class="brand" href="/store/">FULL<span>TECH</span> STORE</a></header>
${body}
<footer class="site">FULLTECH Store · República Dominicana</footer>
</div>
</body>
</html>
`;
}

/**
 * Página pública de un artículo publicado.
 * @param {{product:any, origin:string, indexable:boolean, siteName?:string}} input
 */
export function renderProductPage({ product, origin, indexable = false, siteName = 'FULLTECH Store' }) {
  const canonical = productCanonical(origin, product.id);
  const title = `${product.name} · ${siteName}`;
  const description = metaDescription(product);
  const image = product.imageUrl ? `${cleanOrigin(origin)}${product.imageUrl}` : '';
  const availabilityLabel = AVAILABILITY_TEXT[product.availabilityState] ?? 'Consultar disponibilidad';
  const price = product.kind === 'service' ? '' : money(product.price, product.currency);
  const isProduct = product.kind === 'product';
  const ogImage = image;

  const structured = isProduct
    ? [productStructuredData({ product, canonical, origin, siteName }), breadcrumbStructuredData({ product, canonical, origin })]
    : [breadcrumbStructuredData({ product, canonical, origin })];

  const body = `<nav class="crumbs" aria-label="Ruta de navegación"><a href="/store/">Inicio</a> › <a href="/store/#/catalog">Catálogo</a>${product.category ? ` › <a href="/store/#/catalog?category=${encodeURIComponent(product.category)}">${escapeHtml(product.category)}</a>` : ''} › <span aria-current="page">${escapeHtml(product.name)}</span></nav>
<main>
${image ? `<img class="media" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" decoding="async">` : ''}
${product.category ? `<p class="cat">${escapeHtml(product.category)}${product.brand ? ` · ${escapeHtml(product.brand)}` : ''}</p>` : ''}
<h1>${escapeHtml(product.name)}</h1>
${price ? `<p class="price">${escapeHtml(price)}</p>` : ''}
<p class="avail">${escapeHtml(availabilityLabel)}</p>
${product.description || product.shortDescription ? `<p class="desc">${escapeHtml(product.description || product.shortDescription)}</p>` : ''}
<p><a class="cta" href="/store/#/product/${encodeURIComponent(product.id)}">${isProduct ? 'Ver en la tienda' : 'Consultar este servicio'}</a><a class="alt" href="/store/#/catalog">Ver todo el catálogo</a></p>
<noscript><p>Activa JavaScript para comprar o solicitar este artículo. También puedes escribirnos desde la tienda.</p></noscript>
</main>
<script type="application/ld+json">${structured.map(jsonScript).join('</script>\n<script type="application/ld+json">')}</script>
<script type="application/ld+json">${jsonScript({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: canonical,
    name: title,
    inLanguage: 'es-DO',
  })}</script>`;

  const html = pageShell({ title, description, canonical, indexable, siteName, body, image: ogImage });
  return { html, canonical, title, description, image, notFound: false, indexable };
}

/** 404 para artículos que nunca existieron o no están publicados. */
export function renderStoreNotFound({ origin = '', indexable = false, siteName = 'FULLTECH Store' } = {}) {
  const canonical = `${cleanOrigin(origin)}/store/`;
  const body = `<main>
<h1>Ese artículo no está disponible</h1>
<p class="desc">Puede que ya no esté publicado o que el enlace haya cambiado. En el catálogo encontrarás lo que sí tenemos hoy.</p>
<p><a class="cta" href="/store/#/catalog">Ver el catálogo</a></p>
</main>`;
  return {
    html: pageShell({ title: `Artículo no disponible · ${siteName}`, description: 'El artículo solicitado no está publicado en FULLTECH Store.', canonical, indexable: false, siteName, body }),
    canonical,
    notFound: true,
  };
}

/** 410 para artículos retirados del catálogo público (existieron y ya no). */
export function renderStoreGone({ origin = '', siteName = 'FULLTECH Store', name = '' } = {}) {
  const canonical = `${cleanOrigin(origin)}/store/`;
  const body = `<main>
<h1>${escapeHtml(name || 'Este artículo')} ya no está en la tienda</h1>
<p class="desc">Lo retiramos del catálogo público. Escríbenos si necesitas conseguirlo: podemos buscarlo por ti.</p>
<p><a class="cta" href="/store/#/request">Lo conseguimos por ti</a><a class="alt" href="/store/#/catalog">Ver catálogo</a></p>
</main>`;
  return {
    html: pageShell({ title: 'Artículo retirado · FULLTECH Store', description: 'Este artículo fue retirado del catálogo público.', canonical, indexable: false, siteName, body }),
    canonical,
    notFound: true,
  };
}

/**
 * Sitemap con SOLO artículos publicados y activos.
 * Devuelve la lista de URLs incluidas (para poder comprobarla en UAT).
 */
export function renderSitemap({ origin, products = [] }) {
  const base = cleanOrigin(origin);
  const entries = [{ loc: `${base}/store/`, changefreq: 'daily', priority: '1.0' }];
  const included = [];
  for (const product of products) {
    if (!product?.id || !product?.name) continue;
    entries.push({ loc: productCanonical(base, product.id), changefreq: 'weekly', priority: '0.8' });
    included.push(String(product.id));
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
    .map((entry) => `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`)
    .join('\n')}
</urlset>
`;
  return { xml, urls: entries.map((entry) => entry.loc), included };
}

/** robots.txt: índice cerrado salvo autorización explícita. */
export function renderRobots({ origin = '', indexable = false } = {}) {
  if (!indexable) {
    return ['# FULLTECH Store — entorno no indexable (UAT / vista previa).', 'User-agent: *', 'Disallow: /', ''].join('\n');
  }
  const base = cleanOrigin(origin);
  return [
    'User-agent: *',
    'Allow: /store/',
    'Disallow: /admin/',
    'Disallow: /api/',
    'Disallow: /store/verify/',
    '',
    `Sitemap: ${base}/store/sitemap.xml`,
    '',
  ].join('\n');
}
