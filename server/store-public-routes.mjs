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
    availability: product.availability,
    shortDescription: product.shortDescription,
    description: product.description,
    brand: product.brand,
    imageUrl: product.imageUrl,
    featured: product.featured,
  };
}

export async function handleStorePublicRoute({ req, res, route, url, ctx, json }) {
  const catalog = ctx.storeCatalog;
  const imageMatch = /^\/api\/store\/products\/([a-zA-Z0-9_-]+)\/image$/.exec(route);
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
    const image = await catalog.publicImage(decodeURIComponent(imageMatch[1]));
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
  if (route === '/api/store/home') {
    const all = await catalog.publicProducts();
    const categories = [...new Set(all.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    // Include all eligible published items, including out-of-stock products.
    // Availability is shown to customers; hiding an item here made published
    // CRM records disappear from the homepage without a clear reason.
    const products = all.filter(item => item.kind === 'product');
    const featured = products.filter(item => item.featured);
    const services = all.filter(item => item.kind === 'service');
    const ordered = items => [...items].sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));
    // Keep the homepage bounded while placing featured products first. The
    // paginated catalog endpoint remains the complete source for larger stores.
    const items = ordered(products).slice(0, 8);
    res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, categories, products: items.map(publicProduct), services: ordered(services).slice(0, 4).map(publicProduct), featured: featured.length > 0, total: all.length }));
    return true;
  }
  if (route === '/api/store/categories') {
    const items = await catalog.publicProducts();
    const categories = [...new Set(items.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, categories }));
    return true;
  }

  const page = Math.max(1, Math.min(1000000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const limit = Math.max(1, Math.min(48, Number.parseInt(url.searchParams.get('limit') || '24', 10) || 24));
  const query = normalize(url.searchParams.get('q')).slice(0, 100);
  const category = normalize(url.searchParams.get('category'));
  const kind = url.searchParams.get('kind');
  const featured = url.searchParams.get('featured') === 'true';
  if (kind && !['product', 'service', 'all'].includes(kind)) {
    json(res, 400, { ok: false, error: 'invalid_kind' });
    return true;
  }
  const all = query ? await catalog.searchPublicProducts(query) : await catalog.publicProducts();
  const filtered = all.filter(item => {
    if (category && normalize(item.category) !== category) return false;
    if (kind && kind !== 'all' && item.kind !== kind) return false;
    if (featured && !item.featured) return false;
    return true;
  }).sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'));
  const start = (page - 1) * limit;
  const products = filtered.slice(start, start + limit).map(publicProduct);
  res.writeHead(200, { ...cacheHeaders, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, products, pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) }, query: query || null }));
  return true;
}
