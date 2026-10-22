const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();

function publicProduct(product) {
  // Construct the public object field by field; never spread the CRM record.
  return {
    id: product.id,
    kind: product.kind,
    name: product.name,
    category: product.category,
    price: product.price,
    currency: product.currency,
    compareAtPrice: product.compareAtPrice ?? null,
    discountPercent: product.discountPercent ?? null,
    createdAt: product.createdAt ?? null,
    publishedAt: product.publishedAt ?? null,
    availability: product.availability,
    availabilityState: product.availabilityState,
    purchaseable: product.purchaseable === true,
    shortDescription: product.shortDescription,
    description: product.description,
    brand: product.brand,
    warranty: product.warranty ?? null,
    imageUrl: product.imageUrl,
    images: product.images,
    featured: product.featured,
  };
}

export async function handleStorePublicRoute({ req, res, route, url, ctx, json }) {
  const catalog = ctx.storeCatalog;
  const imageMatch = /^\/api\/store\/products\/([a-zA-Z0-9_-]+)\/(?:image|images\/([a-zA-Z0-9_-]+))$/.exec(route);
  const productMatch = /^\/api\/store\/products\/([a-zA-Z0-9_-]+)$/.exec(route);
  if (route !== '/api/store/catalog' && route !== '/api/store/categories' && route !== '/api/store/home' && !imageMatch && !productMatch) return false;
  if (!catalog) {
    res.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '30' });
    res.end(JSON.stringify({ ok: false, error: 'catalog_unavailable' }));
    return true;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  if (imageMatch) {
    const image = await catalog.publicImage(decodeURIComponent(imageMatch[1]),imageMatch[2]);
    if (!image) {
      res.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end();
      return true;
    }
    res.writeHead(200, {
      'content-type': image.mime,
      'cache-control': 'public, max-age=0, s-maxage=5, must-revalidate',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.end(Buffer.from(image.data, 'base64'));
    return true;
  }

  const cacheHeaders = {
    'cache-control': 'public, max-age=0, s-maxage=5, must-revalidate',
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
  };
  if (productMatch) {
    const id = decodeURIComponent(productMatch[1]);
    const item = (await catalog.publicProducts()).find(product => product.id === id);
    if (!item) {
      res.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end();
      return true;
    }
    res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, product: publicProduct(item) }));
    return true;
  }
  if (route === '/api/store/home' || route === '/api/store/categories') {
    const all = await catalog.publicProducts();
    const categories = [...new Set(all.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const products = all.filter(item => item.kind === 'product');
    /*
     * FICHAS DE CATEGORÍA (carrusel horizontal): nombre, número REAL de productos
     * publicados y una imagen representativa tomada del propio catálogo. Si la
     * categoría no tiene imagen propia se usa la del primer producto con foto:
     * nunca un recurso inventado.
     */
    const tiles = new Map();
    for (const item of products) {
      if (!item.category) continue;
      const tile = tiles.get(item.category) || { name: item.category, count: 0, imageUrl: null };
      tile.count += 1;
      if (!tile.imageUrl && item.imageUrl) tile.imageUrl = item.imageUrl;
      tiles.set(item.category, tile);
    }
    const categoryCards = [...tiles.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
    if (route === '/api/store/categories') {
      res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, categories, categoryCards }));
      return true;
    }
    // Include all eligible published items, including out-of-stock products.
    // Availability is shown to customers; hiding an item here made published
    // CRM records disappear from the homepage without a clear reason.
    const featured = products.filter(item => item.featured);
    const services = all.filter(item => item.kind === 'service');
    const ordered = items => [...items].sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));
    /*
     * SECCIONES SIN REPETICIONES: cada bloque toma productos aún no mostrados, de
     * modo que la portada no repita la misma tarjeta en secciones consecutivas.
     *   · destacados → marcados como destacados en el CRM.
     *   · ofertas    → SOLO con precio anterior configurado (descuento real).
     *   · recientes  → por fecha REAL de publicación (la más nueva primero).
     *   · descubrir  → el resto del catálogo publicado.
     */
    const shown = new Set();
    const take = (list, max) => {
      const out = [];
      for (const item of list) {
        if (out.length >= max) break;
        if (shown.has(item.id)) continue;
        shown.add(item.id);
        out.push(publicProduct(item));
      }
      return out;
    };
    const sections = {
      featured: take(ordered(featured), 6),
      offers: take(products.filter(item => Number(item.discountPercent) > 0).sort((a, b) => Number(b.discountPercent) - Number(a.discountPercent) || Number(a.price) - Number(b.price)), 6),
      newArrivals: take(products.filter(p => { const time = Date.parse(p.publishedAt); return time <= Date.now() && time >= Date.now() - 30 * 86400000; }).sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || a.name.localeCompare(b.name, 'es')), 6),
      discover: take(ordered(products), 8),
    };
    // Keep the homepage bounded while placing featured products first. The
    // paginated catalog endpoint remains the complete source for larger stores.
    const items = ordered(products).slice(0, 8);
    res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, categories, categoryCards, products: items.map(publicProduct), sections,
      services: ordered(services).slice(0, 4).map(publicProduct), featured: featured.length > 0, total: products.length,
    }));
    return true;
  }

  const page = Math.max(1, Math.min(1000000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const limit = Math.max(1, Math.min(48, Number.parseInt(url.searchParams.get('limit') || '24', 10) || 24));
  const query = normalize(url.searchParams.get('q')).slice(0, 100);
  const category = normalize(url.searchParams.get('category'));
  const kind = url.searchParams.get('kind');
  const featured = url.searchParams.get('featured') === 'true';
  const offersOnly = ['true', '1'].includes(url.searchParams.get('offers'));
  /*
   * ORDENAMIENTO: la relevancia es el orden actual del catálogo (destacados y
   * luego el orden editorial). «recent» usa la fecha real de publicación. No hay
   * orden por «más vendido»: sin historial de ventas verificado no se ofrece ese
   * criterio (nunca se presenta una semilla como si fueran ventas).
   */
  const SORTS = {
    relevance: (a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'),
    recent: (a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || a.name.localeCompare(b.name, 'es'),
    'price-asc': (a, b) => Number(a.price) - Number(b.price) || a.name.localeCompare(b.name, 'es'),
    'price-desc': (a, b) => Number(b.price) - Number(a.price) || a.name.localeCompare(b.name, 'es'),
    name: (a, b) => a.name.localeCompare(b.name, 'es'),
  };
  const sortKey = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'relevance';
  if (kind && !['product', 'service', 'all'].includes(kind)) {
    json(res, 400, { ok: false, error: 'invalid_kind' });
    return true;
  }
  const all = query ? await catalog.searchPublicProducts(query) : await catalog.publicProducts();
  const filtered = all.filter(item => {
    if (category && normalize(item.category) !== category) return false;
    if (kind && kind !== 'all' && item.kind !== kind) return false;
    if (featured && !item.featured) return false;
    if (offersOnly && !(Number(item.discountPercent) > 0)) return false;
    return true;
  }).sort(SORTS[sortKey]);
  const start = (page - 1) * limit;
  const products = filtered.slice(start, start + limit).map(publicProduct);
  res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, products, pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) }, query: query || null, sort: sortKey }));
  return true;
}
