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

/*
 * GUARDA DE ORIGEN PÚBLICO: un canonical, un sitemap o un og:url NUNCA pueden
 * salir con un host que Google no puede alcanzar. Si la configuración falta y la
 * petición llega con el host interno de EasyPanel, se devuelve cadena vacía y el
 * llamador responde en cerrado (noindex / sin sitemap) en vez de publicar basura.
 */
const INTERNAL_HOST = /(^|\.)(localhost|internal|intranet|lan|local)$/i;
const INTERNAL_SUFFIX = /(^|\.)(easypanel\.host|easypanel\.io|railway\.app|vercel\.app)$/i;
const PRIVATE_IPV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6 = /^(::1|fc|fd|fe80)/i;

export function isPublicOrigin(value) {
  const candidate = cleanOrigin(value);
  if (!candidate) return false;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.')) return false;
  if (INTERNAL_HOST.test(host) || INTERNAL_SUFFIX.test(host)) return false;
  if (PRIVATE_IPV4.test(host) || PRIVATE_IPV6.test(host)) return false;
  if (/^[\d.]+$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

/**
 * Origen canónico: la configuración explícita manda; si falta o es inválida se
 * usa el host de la petición SOLO cuando es público. Nunca un host interno.
 */
export function storeOrigin(req, configured = '') {
  const fixed = cleanOrigin(configured);
  if (isPublicOrigin(fixed)) return fixed;
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim() || (req?.socket?.encrypted ? 'https' : 'http');
  const host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? '').split(',')[0].trim();
  /*
   * HTTPS SIEMPRE al derivar el host de la petición: en producción el TLS lo
   * termina Traefik y nginx reenvía `http`, así que un canonical/ sitemap http
   * sería un error. (Pasó de verdad cuando el panel borró la variable.)
   */
  const candidate = host ? `https://${host.replace(/^https?:\/\//, '')}` : '';
  if (isPublicOrigin(candidate)) return candidate;
  const local = host ? `${proto}://${host}` : '';
  return isPublicOrigin(local) ? local : '';
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
 * Portada de la tienda: se sirve el MISMO HTML de la PWA (la experiencia del
 * cliente no cambia) con la cabecera SEO inyectada y enlaces rastreables a los
 * artículos publicados dentro de `<noscript>`.
 *
 * Sin origen público válido: noindex y sin canonical (nunca un host interno).
 */
export function renderStoreShell({ html = '', origin = '', indexable = false, products = [], siteName = 'FULLTECH Store' }) {
  const base = cleanOrigin(origin);
  const publicOrigin = isPublicOrigin(base) ? base : '';
  const canonical = publicOrigin ? `${publicOrigin}/store/` : '';
  const title = `${siteName} · Productos y suministros en República Dominicana`;
  const description =
    'Catálogo FULLTECH Store: productos de tecnología y suministros con entrega a domicilio o recogida coordinada en República Dominicana.';
  const allowIndex = indexable === true && Boolean(publicOrigin);

  const links = products
    .filter((product) => isSitemapEligible(product))
    .slice(0, 60)
    .map((product) => `      <li><a href="${escapeHtml(productCanonical(publicOrigin, product.id))}">${escapeHtml(product.name)}</a></li>`)
    .join('\n');

  const head = [
    `<meta name="robots" content="${allowIndex ? 'index,follow,max-image-preview:large' : 'noindex,nofollow'}">`,
    allowIndex && canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '',
    allowIndex && canonical ? `<meta property="og:type" content="website">` : '',
    allowIndex && canonical ? `<meta property="og:site_name" content="${escapeHtml(siteName)}">` : '',
    allowIndex && canonical ? `<meta property="og:title" content="${escapeHtml(title)}">` : '',
    allowIndex && canonical ? `<meta property="og:description" content="${escapeHtml(description)}">` : '',
    allowIndex && canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : '',
    allowIndex && canonical ? `<meta name="twitter:card" content="summary_large_image">` : '',
  ]
    .filter(Boolean)
    .join('\n    ');

  const noscript = links
    ? `<noscript><nav aria-label="Productos publicados"><h2>Productos disponibles</h2><ul>\n${links}\n    </ul><p><a href="${escapeHtml(`${publicOrigin}/store/catalogo`)}">Ver el catálogo completo</a></p></nav></noscript>`
    : '';

  let output = String(html);
  /* Título descriptivo y único sin duplicarlo si ya existía. */
  output = /<title>[^<]*<\/title>/i.test(output)
    ? output.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`)
    : output.replace(/<\/head>/i, `<title>${escapeHtml(title)}</title>\n  </head>`);
  output = output.replace(/<\/head>/i, `    ${head}\n  </head>`);
  if (noscript) {
    if (/<main id="main"[^>]*><\/main>/i.test(output)) output = output.replace(/(<main id="main"[^>]*>)<\/main>/i, `$1${noscript}</main>`);
    else output = output.replace(/<\/body>/i, `${noscript}\n  </body>`);
  }
  return { html: output, canonical, indexable: allowIndex, title, description };
}

/**
 * Elegibilidad para el sitemap: publicado + activo + no archivado (ya filtrado
 * por el catálogo) + disponibilidad POSITIVA confirmada. Un artículo agotado o
 * «bajo pedido» conserva su página, pero NO entra al sitemap.
 * @param {any} product
 */
export const isSitemapEligible = (product) =>
  Boolean(
    product?.id &&
      product?.name &&
      product.active !== false &&
      product.purchaseable === true &&
      product.availabilityState === 'AVAILABLE_NOW',
  );

/**
 * Catálogo rastreable: HTML plano con enlaces reales a cada artículo vendible.
 * Existe para que Google descubra todo el catálogo sin depender del buscador
 * JavaScript de la PWA, y para que el catálogo pueda crecer sin límite.
 */
export function renderCatalogPage({ origin = '', indexable = false, products = [], siteName = 'FULLTECH Store' }) {
  const base = cleanOrigin(origin);
  const publicOrigin = isPublicOrigin(base) ? base : '';
  const canonical = publicOrigin ? `${publicOrigin}/store/catalogo` : '';
  const allowIndex = indexable === true && Boolean(publicOrigin);
  const eligible = products.filter((product) => isSitemapEligible(product));
  const title = `Catálogo de productos · ${siteName}`;
  const description = 'Todos los productos disponibles para entrega en República Dominicana, con precio en pesos dominicanos (DOP).';
  const items = eligible
    .map((product) => {
      const price = money(product.price, product.currency);
      return `<li><a href="${escapeHtml(productCanonical(publicOrigin, product.id))}">${escapeHtml(product.name)}</a>${price ? ` — <span class="price">${escapeHtml(price)}</span>` : ''}</li>`;
    })
    .join('\n      ');
  const body = `<nav class="crumbs" aria-label="Ruta de navegación"><a href="/store/">Inicio</a> › <span aria-current="page">Catálogo</span></nav>
<main>
<h1>Catálogo de productos</h1>
<p>Productos disponibles para entrega en República Dominicana. Precios en pesos dominicanos (DOP).</p>
${eligible.length ? `<ul class="sitemap-list">\n      ${items}\n</ul>` : '<p>No hay productos disponibles en este momento.</p>'}
</main>`;
  const html = pageShell({ title, description, canonical, indexable: allowIndex, siteName, body });
  return { html, canonical, indexable: allowIndex, count: eligible.length };
}

/**
 * Sitemap: portada, catálogo rastreable y SOLO artículos vendibles.
 * Sin un origen público válido devuelve `xml: null`: NUNCA se publica un sitemap
 * con hosts internos ni con URLs relativas.
 */
export function renderSitemap({ origin, products = [] }) {
  const base = cleanOrigin(origin);
  if (!isPublicOrigin(base)) return { xml: null, urls: [], included: [] };
  const seen = new Set();
  const entries = [
    { loc: `${base}/store/`, changefreq: 'daily', priority: '1.0', lastmod: '' },
    { loc: `${base}/store/catalogo`, changefreq: 'daily', priority: '0.9', lastmod: '' },
  ];
  entries.forEach((entry) => seen.add(entry.loc));
  const included = [];
  const sorted = [...products]
    .filter((product) => isSitemapEligible(product))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  for (const product of sorted) {
    const loc = productCanonical(base, product.id);
    if (seen.has(loc)) continue;
    seen.add(loc);
    /* lastmod solo cuando el catálogo conoce una fecha real de publicación. */
    const stamp = Date.parse(product.updatedAt ?? '');
    const lastmod = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : '';
    entries.push({ loc, changefreq: 'weekly', priority: '0.8', lastmod });
    included.push(String(product.id));
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
    .map((entry) => `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''}\n    <changefreq>${entry.changefreq}</changefreq>\n    <priority>${entry.priority}</priority>\n  </url>`)
    .join('\n')}
</urlset>
`;
  return { xml, urls: entries.map((entry) => entry.loc), included };
}

/** robots.txt de la tienda: índice cerrado salvo autorización explícita. */
export function renderRobots({ origin = '', indexable = false } = {}) {
  const base = cleanOrigin(origin);
  /* Sin origen público no se puede anunciar un sitemap absoluto: se cierra. */
  if (!indexable || !isPublicOrigin(base)) {
    return ['# FULLTECH Store — entorno no indexable (UAT / vista previa).', 'User-agent: *', 'Disallow: /', ''].join('\n');
  }
  return [
    '# FULLTECH Store — público indexable',
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
