import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSqlQuery } from './sql-query.mjs';
import { productConfig } from '../src/config/product.config.js';
import { moneyToCents } from './inventory.mjs';
import sharp from 'sharp';

const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const clean = (v, n = 160) => String(v ?? '').trim().slice(0, n);

/*
 * DISPONIBILIDAD COMERCIAL (independiente de la publicación).
 *
 *   AVAILABLE_NOW → se puede comprar ya (si el stock lo permite).
 *   ON_REQUEST    → se consigue bajo pedido: no se compra directo.
 *   UNAVAILABLE   → no se puede comprar (se puede pedir por «Lo conseguimos por ti»).
 *
 * REGLA QUE NO SE ROMPE: un producto con control de existencias y 0 unidades
 * NO se puede comprar aunque alguien lo haya marcado AVAILABLE_NOW.
 */
const AVAILABILITY_STATES = new Set(['AVAILABLE_NOW', 'ON_REQUEST', 'UNAVAILABLE']);
const STORE_TIME_ZONE = 'America/Santo_Domingo';

export function businessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseOfferDate(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00-04:00` :
    /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00-04:00` : raw;
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime())) throw fail('invalid_offer_date', `La fecha de ${field} no es válida.`);
  return parsed.toISOString();
}

function booleanInput(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || ['true', '1', 'on', 'yes', 'si'].includes(String(value).trim().toLowerCase());
}

export function offerPricing(product, now = new Date()) {
  const referenceCents = Number(product?.compare_at_cents);
  const baseCents = Number(product?.price_cents);
  const offerCents = product?.offer_price_cents == null ? baseCents : Number(product.offer_price_cents);
  const legacyOffer = product?.offer_active === undefined && referenceCents > baseCents;
  const configured = product?.offer_active === true || legacyOffer;
  const starts = product?.offer_start_at ? Date.parse(product.offer_start_at) : -Infinity;
  const ends = product?.offer_end_at ? Date.parse(product.offer_end_at) : Infinity;
  const nowMs = new Date(now).getTime();
  const active = configured && Number.isFinite(nowMs) && referenceCents > offerCents && offerCents > 0 && nowMs >= starts && nowMs < ends;
  return {
    active,
    priceCents: active ? offerCents : baseCents,
    compareAtCents: active ? referenceCents : null,
    discountPercent: active ? Math.max(1, Math.round((1 - offerCents / referenceCents) * 100)) : null,
  };
}

export function effectiveAvailability(product) {
  if (!product) return 'UNAVAILABLE';
  if (product.kind === 'service') return 'UNAVAILABLE';
  const declared = AVAILABILITY_STATES.has(product.store_availability)
    ? product.store_availability
    : product.track_stock === false || product.product_type === 'third_party'
      ? 'ON_REQUEST'
      : 'AVAILABLE_NOW';
  if (declared !== 'AVAILABLE_NOW') return declared;
  if (product.track_stock !== false) {
    if (product.quantity === null || product.quantity === undefined) return 'ON_REQUEST';
    if (Number(product.quantity) <= 0) return 'UNAVAILABLE';
  }
  return 'AVAILABLE_NOW';
}

/** Garantía PÚBLICA: nunca incluye las notas internas. */
export function publicWarranty(product) {
  const p = product ?? {};
  const available = p.warranty_available === true;
  const months = Math.max(0, Math.min(120, Number(p.warranty_months) || 0));
  const provider = ['FULLTECH', 'manufacturer', 'other'].includes(p.warranty_provider) ? p.warranty_provider : '';
  const label = available
    ? months > 0
      ? `Garantía de ${months} ${months === 1 ? 'mes' : 'meses'}`
      : provider === 'manufacturer'
        ? 'Garantía del fabricante'
        : 'Garantía disponible'
    : 'Sin garantía comercial adicional';
  const conditions = clean(p.warranty_conditions, 2000);
  return {
    available, months, provider, label,
    coverage: clean(p.warranty_coverage, 1000),
    exclusions: clean(p.warranty_exclusions, 1000),
    conditions,
    claim: clean(p.warranty_claim, 1000),
    notes: clean(p.warranty_public_notes, 500),
    hasDetails: Boolean(conditions || p.warranty_coverage || p.warranty_exclusions || p.warranty_claim),
  };
}
const integer = (v) => v !== '' && v !== null && Number.isSafeInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000000;
const money = (v) => { const n = moneyToCents(v); if (n === null || n > 10000000000) throw fail('invalid_money', 'Escribe un importe válido, con hasta dos decimales.'); return n; };

export function parseProductImage(value) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(value ?? ''));
  if (!match) throw fail('invalid_image', 'Selecciona una imagen JPG, PNG o WebP.');
  const bytes = Buffer.from(match[2], 'base64');
  const mime = `image/${match[1]}`;
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length < 16 || bytes.length > 1024 * 1024) throw fail('invalid_image', 'La imagen debe ser JPG, PNG o WebP y pesar como máximo 1 MB.');
  return { mime, data: bytes.toString('base64') };
}

// Decode pixels, not only the file signature. Bound decompression and honor EXIF.
async function usableImage(image, optimize = false) {
  try {
    const decoder = sharp(Buffer.from(image.data, 'base64'), {limitInputPixels: 40000000, failOn: 'error'});
    if (optimize) {
      const bytes = await decoder.rotate().resize({width:1200,height:1200,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
      if(bytes.length>1024*1024)throw new Error('image_too_large');
      return {mime:'image/webp',data:bytes.toString('base64')};
    }
    await decoder.raw().toBuffer();
    return image;
  } catch { throw fail('invalid_image', 'La imagen está dañada o no se puede abrir. Usa JPG, PNG o WebP de hasta 1 MB.'); }
}

/** Catálogo POS persistente. No modifica las tablas ni las unidades históricas de Phytoemagry. */
export async function createStoreCatalog({ backend, handle, legacyInventory, clock = () => new Date() }) {
  const sql = createSqlQuery({ backend, handle });
  if (!sql.enabled) return null;
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_catalog_v1 (
    id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, quantity BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulltech_product_images_v1 (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulltech_stock_movements_v1 (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, order_id TEXT,
      created_at TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, doc TEXT NOT NULL)`);
  await sql.query('CREATE TABLE IF NOT EXISTS fulltech_categories_v1 (id TEXT PRIMARY KEY, category_key TEXT NOT NULL UNIQUE, doc TEXT NOT NULL)');
  // La publicación es un acto deliberado: un artículo nuevo nace oculto y solo
  // aparece en la tienda cuando una persona autorizada lo publica. Esta tabla
  // guarda además los ajustes editoriales (destacado y orden).
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_store_publication_v1 (
    product_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unpublished',
    featured INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL)`);
  await sql.query('CREATE TABLE IF NOT EXISTS fulltech_store_first_publication_v1 (product_id TEXT PRIMARY KEY, published_at TEXT NOT NULL)');
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_store_daily_offers_v1 (
    offer_date TEXT PRIMARY KEY, product_ids TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await sql.query('CREATE INDEX IF NOT EXISTS fulltech_store_publication_status_order_idx ON fulltech_store_publication_v1(status, sort_order, product_id)');
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_store_search_terms_v2 (
    product_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(product_id,token))`);
  await sql.query('CREATE INDEX IF NOT EXISTS fulltech_store_search_token_product_v2_idx ON fulltech_store_search_terms_v2(token,product_id)');
  for (const p of productConfig.variants) {
    const doc = { id: p.id, sku: `PHYTO-${p.capsules}`, kind: 'product', name: `Phytoemagry · ${p.capsules} cápsulas`,
      category: 'Phytoemagry', description: '', price_cents: p.price * 100, cost_cents: 0,
      image_url: `/api/admin/store/products/${p.id}/image?v=1`, active: true, track_stock: true, min_stock: 0,
      capsules: p.capsules, legacy: true, completeBottle: !!p.completeBottle, unit: 'unidad', created_at: clock().toISOString() };
    await sql.query('INSERT INTO fulltech_catalog_v1(id,sku,doc) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [p.id, doc.sku, JSON.stringify(doc)]);
  }
  for (const row of (await sql.query('SELECT id FROM fulltech_catalog_v1')).rows) {
    await sql.query("INSERT INTO fulltech_store_publication_v1(product_id,status,featured,sort_order,updated_at) VALUES($1,'unpublished',0,0,$2) ON CONFLICT(product_id) DO NOTHING", [row.id, clock().toISOString()]);
  }
  let tail = Promise.resolve();
  const listeners = new Set();
  let publicCache = null;
  function changed() { publicCache = null; for (const listener of listeners) { try { listener(); } catch {} } }
  async function setPublication(id, input) {
    const status = input?.status;
    if (!['published', 'unpublished'].includes(status)) throw fail('invalid_publication_status', 'Elige si el artículo se publica o se mantiene oculto.');
    return transaction(async q => {
    const current = await one(id, q, true);
    if (!current) throw fail('not_found', 'El artículo ya no existe.', 404);
    if (status === 'published' && !current.active) throw fail('inactive_product', 'Activa el artículo en el catálogo antes de publicarlo.', 409);
    if (status === 'published') await requireGallery(current, q);
    const prior = (await q('SELECT status FROM fulltech_store_publication_v1 WHERE product_id=$1', [id])).rows[0];
    if (status === 'published' && prior?.status !== 'published') await q('INSERT INTO fulltech_store_first_publication_v1(product_id,published_at) VALUES($1,$2) ON CONFLICT(product_id) DO NOTHING', [id, clock().toISOString()]);
    const featured = input?.featured === true;
    const rawOrder = input?.sort_order ?? 0;
    if (!Number.isSafeInteger(Number(rawOrder)) || Number(rawOrder) < 0 || Number(rawOrder) > 1000000) throw fail('invalid_sort_order', 'El orden debe ser un número válido.');
    await q('INSERT INTO fulltech_store_publication_v1(product_id,status,featured,sort_order,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_id) DO UPDATE SET status=excluded.status,featured=excluded.featured,sort_order=excluded.sort_order,updated_at=excluded.updated_at', [id, status, featured ? 1 : 0, Number(rawOrder), clock().toISOString()]);
    changed();
    return { product_id: id, status, featured, sort_order: Number(rawOrder) };
    });
  }
  async function publicationStates() {
    return Object.fromEntries((await sql.query('SELECT product_id,status,featured,sort_order,updated_at FROM fulltech_store_publication_v1')).rows.map(row => [row.product_id, { status: row.status, featured: Boolean(Number(row.featured)), sort_order: Number(row.sort_order), updated_at: row.updated_at }]));
  }
  async function publicProducts() {
    if (publicCache && publicCache.expiresAt > Date.now()) return publicCache.items;
    const now = clock();
    const pubs = (await sql.query("SELECT p.product_id,p.featured,p.sort_order,p.updated_at,f.published_at FROM fulltech_store_publication_v1 p LEFT JOIN fulltech_store_first_publication_v1 f ON f.product_id=p.product_id WHERE p.status='published' ORDER BY p.sort_order,p.product_id")).rows;
    if (!pubs.length) { publicCache = { items: [], expiresAt: Date.now() + 5000 }; return []; }
    /*
     * El contenido público se deriva SIEMPRE del registro vivo del catálogo:
     * precio, nombre público, imagen y disponibilidad se actualizan solos. La
     * publicación solo decide si el artículo se muestra.
     */
    const all = await list({ includeInactive: false });
    const byId = new Map(all.map(p => [p.id, p]));
    const items = pubs.flatMap(pub => {
      const p = byId.get(pub.product_id);
      if (!p?.active) return [];
      /*
       * FASE 1: la tienda SOLO vende productos. Los servicios siguen existiendo
       * en el CRM, pero no se listan, no se buscan y no se pueden pedir.
       */
      if (p.kind === 'service') return [];
      let availability;
      if (p.kind === 'service') availability = 'consult';
      else if (p.track_stock === false || p.product_type === 'third_party') availability = 'by_order';
      else if (p.quantity == null) availability = 'check';
      else if (p.quantity <= 0) availability = 'out_of_stock';
      else if (p.quantity <= 2) availability = 'low_stock';
      else availability = 'available';
      const pricing = offerPricing(p, now);
      const availabilityState = effectiveAvailability(p);
      return [{
        id: p.id, kind: p.kind === 'service' ? 'service' : 'product', name: p.store_public_name || p.name,
        category: p.category || null, price: pricing.priceCents / 100, currency: 'DOP',
        /*
         * OFERTA: solo existe si una persona configuró un precio anterior MÁS
         * ALTO que el de venta. El descuento se calcula aquí (servidor), nunca en
         * el navegador, para que nadie pueda inventar un porcentaje.
         */
        compareAtPrice: pricing.compareAtCents === null ? null : pricing.compareAtCents / 100,
        discountPercent: pricing.discountPercent,
        /* Fechas reales: creación del registro y publicación en la tienda. */
        createdAt: p.created_at ?? null,
        publishedAt: pub.published_at ?? null,
        availability, availabilityState,
        purchaseable: availabilityState === 'AVAILABLE_NOW',
        shortDescription: p.store_short_description || '', description: p.store_public_description || '',
        brand: p.store_brand || null,
        warranty: publicWarranty(p),
        imageUrl: p.images[0] ? publicGallery(p)[0].url : null,
        images: publicGallery(p),
        featured: Boolean(Number(pub.featured)), sortOrder: Number(pub.sort_order),
        /* Fecha real de publicación: única fuente válida para <lastmod>. */
        updatedAt: pub.updated_at ?? null,
        _dailyOfferEligible: pricing.active && p.daily_offer === true && availabilityState === 'AVAILABLE_NOW',
        _offerSavingsCents: pricing.active ? pricing.compareAtCents - pricing.priceCents : 0,
      }];
    });
    publicCache = { items, expiresAt: Date.now() + 5000 };
    return items;
  }
  function dailyOfferHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
  async function dailyOffers(now = clock()) {
    const date = businessDate(now);
    return exclusive(async () => {
      const items = await publicProducts();
      const eligible = items.filter(item => item._dailyOfferEligible);
      if (!eligible.length) return [];
      const byId = new Map(eligible.map(item => [item.id, item]));
      const current = (await sql.query('SELECT product_ids FROM fulltech_store_daily_offers_v1 WHERE offer_date=$1', [date])).rows[0];
      let currentIds = [];
      try { currentIds = Array.isArray(JSON.parse(current?.product_ids || '[]')) ? JSON.parse(current.product_ids) : []; } catch {}
      const desired = Math.min(2, eligible.length);
      const stillValid = [...new Set(currentIds)].filter(id => byId.has(id)).slice(0, desired);
      if (stillValid.length === desired) return stillValid.map(id => byId.get(id));
      const historyRows = (await sql.query('SELECT product_ids FROM fulltech_store_daily_offers_v1 WHERE offer_date<>$1 ORDER BY offer_date DESC LIMIT 14', [date])).rows;
      const seen = new Map();
      for (const row of historyRows) {
        let ids = []; try { ids = JSON.parse(row.product_ids); } catch {}
        for (const id of Array.isArray(ids) ? ids : []) seen.set(id, (seen.get(id) || 0) + 1);
      }
      const selected = [...stillValid];
      const ranked = eligible.filter(item => !selected.includes(item.id)).sort((a, b) =>
        (seen.get(a.id) || 0) - (seen.get(b.id) || 0) ||
        Number(b.discountPercent) - Number(a.discountPercent) ||
        Number(b._offerSavingsCents) - Number(a._offerSavingsCents) ||
        Number(a.price) - Number(b.price) ||
        dailyOfferHash(`${date}:${a.id}`) - dailyOfferHash(`${date}:${b.id}`));
      selected.push(...ranked.slice(0, desired - selected.length).map(item => item.id));
      const timestamp = new Date(now).toISOString();
      await sql.query(`INSERT INTO fulltech_store_daily_offers_v1(offer_date,product_ids,created_at,updated_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(offer_date) DO UPDATE SET product_ids=excluded.product_ids,updated_at=excluded.updated_at`, [date, JSON.stringify(selected), timestamp, timestamp]);
      return selected.map(id => byId.get(id)).filter(Boolean);
    });
  }
  async function searchPublicProducts(value) {
    const terms = [...new Set(normalizeSearch(value).split(/[^a-z0-9]+/).filter(Boolean))].slice(0, 8);
    if (!terms.length) return publicProducts();
    let matches = null;
    for (const term of terms) {
      const rows = (await sql.query('SELECT product_id FROM fulltech_store_search_terms_v2 WHERE token LIKE $1', [`${term}%`])).rows;
      const ids = new Set(rows.map(row => row.product_id));
      matches = matches === null ? ids : new Set([...matches].filter(id => ids.has(id)));
      if (!matches.size) return [];
    }
    return (await publicProducts()).filter(product => matches.has(product.id));
  }
  const galleryRefs = p => Array.isArray(p?.gallery) ? p.gallery : p?.image_url ? [{id:p.id,created_at:p.created_at}] : [];
  const galleryView = p => galleryRefs(p).map((entry,order)=>({...entry,order,primary:order===0,url:`/api/admin/store/products/${encodeURIComponent(p.id)}/images/${encodeURIComponent(entry.id)}?v=${p.version}`}));
  const publicGallery = p => p.images.map(({id,order,primary})=>({id,order,primary,url:`/api/store/products/${encodeURIComponent(p.id)}/images/${encodeURIComponent(id)}?v=${p.version}`}));
  async function storedImage(id, q=sql.query) {
    const stored=(await q('SELECT mime,data FROM fulltech_product_images_v1 WHERE id=$1',[id])).rows[0];
    if(stored)return stored;
    const seed=productConfig.variants.find(p=>p.id===id);
    if(!seed)return null;
    try {const data=await readFile(new URL(`../public${seed.image}-320.webp`,import.meta.url));return {mime:'image/webp',data:data.toString('base64')};}catch{return null;}
  }
  async function image(id, imageId=null) {
    if(id.startsWith('category_')&&!imageId)return storedImage(id);
    const p=await one(id);if(!p)return null;
    const refs=galleryRefs(p), entry=imageId?refs.find(e=>e.id===imageId):refs[0];
    return entry?storedImage(entry.id):null;
  }
  async function requireGallery(p,q) {
    const refs=galleryRefs(p);
    if(!refs.length)throw fail('image_required','Agrega al menos una imagen válida antes de publicar. Para quitar la última imagen, retira primero el artículo de la tienda.',409);
    for(const entry of refs){const data=await storedImage(entry.id,q);if(!data)throw fail('invalid_image','Una imagen no está disponible. Reemplázala antes de publicar.',409);await usableImage(data);}
  }
  async function galleryAudit() {
    const result=[];
    for(const [id,pub] of Object.entries(await publicationStates()))if(pub.status==='published'){
      const p=await one(id);try{if(!p)throw new Error('not_found');await requireGallery(p,sql.query);}catch(e){result.push({id,sku:p?.sku,error:e.code||'not_found'});}
    }
    const referenced=new Set();
    for(const row of (await sql.query('SELECT doc FROM fulltech_catalog_v1')).rows)for(const entry of galleryRefs(JSON.parse(row.doc)))referenced.add(entry.id);
    for(const row of (await sql.query('SELECT id FROM fulltech_categories_v1')).rows)referenced.add(row.id);
    const retained=(await sql.query('SELECT id FROM fulltech_product_images_v1')).rows.filter(row=>!referenced.has(row.id)).length;
    return {invalidPublished:result,retainedUnreferencedImages:retained};
  }
  async function publicImage(id, imageId=null) {
    const pub = (await sql.query('SELECT status FROM fulltech_store_publication_v1 WHERE product_id=$1', [id])).rows[0];
    if (pub?.status !== 'published') return null;
    const p = await one(id);
    if (!p?.active) return null;
    return image(id,imageId);
  }
  let ordersTail = Promise.resolve();
  async function orderLock(fn) {
    const before=ordersTail;let release;ordersTail=new Promise(r=>{release=r;});await before;
    try{return await fn();}finally{release();}
  }
  async function exclusive(fn) {
    const before = tail; let release; tail = new Promise(r => { release = r; }); await before;
    try { return await fn(); } finally { release(); }
  }
  async function transaction(fn) {
    return exclusive(async () => {
      const client = backend === 'postgres' ? await handle.connect() : null;
      const q = client ? (text, args) => client.query(text, args) : (text, args) => sql.query(text, args);
      let started = false;
      try { await q(backend === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE'); started = true;
        const result = await fn(q); await q('COMMIT'); changed(); return result; }
      catch (e) { if (started) await q('ROLLBACK'); throw e; }
      finally { client?.release(); }
    });
  }
  const decode = r => {if(!r)return null;const p={...JSON.parse(r.doc),quantity:Number(r.quantity),version:Number(r.version)};return {...p,images:galleryView(p)};};
  const normalizeSearch = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  async function indexProductSearch(q, product) {
    const tokens = [...new Set(normalizeSearch(`${product.name} ${product.store_public_name || ''} ${product.sku} ${product.category || ''} ${product.store_short_description || ''} ${product.store_public_description || ''} ${product.store_brand || ''}`).split(/[^a-z0-9]+/).filter(token => token.length > 0 && token.length <= 80))];
    await q('DELETE FROM fulltech_store_search_terms_v2 WHERE product_id=$1', [product.id]);
    for (const token of tokens) await q('INSERT INTO fulltech_store_search_terms_v2(product_id,token) VALUES($1,$2) ON CONFLICT(product_id,token) DO NOTHING', [product.id, token]);
  }
  if (Number((await sql.query('SELECT COUNT(*) AS count FROM fulltech_store_search_terms_v2')).rows[0]?.count || 0) === 0) {
    for (const row of (await sql.query('SELECT id,doc FROM fulltech_catalog_v1')).rows) await indexProductSearch(sql.query, { ...JSON.parse(row.doc), id: row.id });
  }
  const one = async (id, q = sql.query, lock = false) => decode((await q('SELECT * FROM fulltech_catalog_v1 WHERE id=$1'+(lock&&backend==='postgres'?' FOR UPDATE':''), [id])).rows[0]);
  const categoryKey=name=>name.trim().replace(/\s+/g,' ').toLocaleLowerCase('es');
  async function ensureCategory(q,name,imageUrl=null) {
    name=clean(name,100).replace(/\s+/g,' ');if(!name)return null;
    const id=`category_${randomUUID()}`,key=categoryKey(name);
    const doc={id,name,image_url:imageUrl,created_at:clock().toISOString()};
    await q('INSERT INTO fulltech_categories_v1(id,category_key,doc) VALUES($1,$2,$3) ON CONFLICT(category_key) DO NOTHING',[id,key,JSON.stringify(doc)]);
    return JSON.parse((await q('SELECT doc FROM fulltech_categories_v1 WHERE category_key=$1',[key])).rows[0].doc);
  }
  // Importación aditiva de las categorías de las fichas existentes.
  for(const row of (await sql.query('SELECT id,doc FROM fulltech_catalog_v1')).rows){
    const p=JSON.parse(row.doc);if(!p.category||p.category_id)continue;
    const c=await ensureCategory(sql.query,p.category,p.image_url?.startsWith('/assets/')?`/api/admin/store/products/${p.id}/image?v=1`:p.image_url);
    if(c)await sql.query('UPDATE fulltech_catalog_v1 SET doc=$1 WHERE id=$2 AND doc=$3',[JSON.stringify({...p,category:c.name,category_id:c.id}),row.id,row.doc]);
  }
  async function categories(){return (await sql.query('SELECT doc FROM fulltech_categories_v1')).rows.map(r=>{
    const c=JSON.parse(r.doc),seed=productConfig.variants.find(p=>c.image_url===`${p.image}-320.webp`);
    return seed?{...c,image_url:`/api/admin/store/products/${seed.id}/image?v=1`}:c;
  }).sort((a,b)=>a.name.localeCompare(b.name,'es'));}
  async function createCategory(input,actor){
    const name=clean(input.name,100).replace(/\s+/g,' ');if(!name)throw fail('category_name_required','Escribe el nombre de la categoría.');
    const image=input.image?parseProductImage(input.image):null;
    return transaction(async q=>{
      const existing=(await q('SELECT id FROM fulltech_categories_v1 WHERE category_key=$1',[categoryKey(name)])).rows[0];
      if(existing)throw fail('duplicate_category','Ya existe una categoría con ese nombre.',409);
      const c={id:`category_${randomUUID()}`,name,image_url:null,created_at:clock().toISOString(),created_by:actor?.display_name||'Administración'};
      if(image){await q('INSERT INTO fulltech_product_images_v1(id,mime,data) VALUES($1,$2,$3)',[c.id,image.mime,image.data]);c.image_url=`/api/admin/store/categories/${c.id}/image?v=1`;}
      await q('INSERT INTO fulltech_categories_v1(id,category_key,doc) VALUES($1,$2,$3)',[c.id,categoryKey(name),JSON.stringify(c)]);
      return c;
    });
  }
  async function list({ includeInactive = true, includeArchived = false } = {}) {
    const [rows, legacy] = await Promise.all([sql.query('SELECT * FROM fulltech_catalog_v1 ORDER BY sku'), legacyInventory.catalog()]);
    return rows.rows.map(decode).filter(p => (includeArchived || !p.archived) && (includeInactive || p.active)).sort((a,b)=>a.legacy&&b.legacy?a.capsules-b.capsules:a.legacy?-1:b.legacy?1:a.name.localeCompare(b.name)).map(p => p.legacy ? { ...p,
      quantity: legacy.initialized ? Math.floor(legacy.stock / p.capsules) : null,
      stock_initialized: legacy.initialized, base_quantity: legacy.stock, base_unit: 'cápsulas',
      cost_cents: legacy.product.current_unit_cost_cents * p.capsules,
      image_url: p.image_url?.startsWith('/assets/') ? `/api/admin/store/products/${p.id}/image?v=${p.version}` : p.image_url,
    } : { ...p, stock_initialized: true });
  }
  function saleItem(p) {
    const pricing = offerPricing(p, clock());
    return { id: p.id, name: p.name, label: p.name, kind: p.kind, product_type: p.product_type ?? null, product_id: p.id,
      price: pricing.priceCents / 100, currency: 'DOP', available: p.active, active: p.active,
      capsules: p.capsules || 0, capsule_quantity: p.capsules || 0, completeBottle: !!p.completeBottle,
      general: !p.legacy, track_stock: p.track_stock, stock: p.quantity,
      image_url: p.image_url, sale_price_cents: pricing.priceCents, regular_price_cents: p.price_cents, compare_at_cents: pricing.compareAtCents };
  }
  async function save(input, actor, id = null) {
    if(input.images!==undefined&&(!Array.isArray(input.images)||input.images.length>3))throw fail('image_limit','Puedes guardar un máximo de 3 imágenes.');
    if(input.images!==undefined&&input.image)throw fail('invalid_image','Envía una sola lista de imágenes.');
    const image = input.image ? await usableImage(parseProductImage(input.image)) : null;
    const incoming = input.images===undefined ? null : await Promise.all(input.images.map(async entry=>{
      if(!entry||typeof entry!=='object'||Boolean(entry.id)===Boolean(entry.data))throw fail('invalid_image','Cada imagen debe ser nueva o pertenecer a este producto.');
      return entry.data?{content:await usableImage(parseProductImage(entry.data),true)}:{id:String(entry.id)};
    }));
    return transaction(async q => {
      const previous = id ? await one(id, q, true) : null;
      if (id && !previous) throw fail('not_found', 'El producto ya no existe.', 404);
      if (previous && Number(input.version) !== previous.version) throw fail('stale_product', 'Otro usuario modificó este producto. Actualiza antes de guardar.', 409);
      const kind = previous?.legacy ? 'product' : input.kind;
      if (!['product','service'].includes(kind)) throw fail('invalid_kind', 'Elige producto o servicio.');
      if (previous && kind !== previous.kind) throw fail('kind_locked', 'No se puede cambiar el tipo de un artículo ya creado.');
      /*
       * POLÍTICA DE INVENTARIO.
       *
       * Un artículo puede llevar existencias (`track_stock: true`) o venderse sin
       * control de inventario (`false`, para lo que se compra al proveedor cuando
       * lo piden). Cambiarla es un proceso CONTROLADO: si el artículo tiene
       * existencias, primero hay que dejarlas en cero con un ajuste, porque si no
       * el saldo quedaría sin significado y el historial de movimientos mentiría.
       */
      const requested = typeof input.track_stock === 'boolean'
        ? input.track_stock
        : input.track_stock === undefined || input.track_stock === null
          ? null
          : !['false', '0', ''].includes(String(input.track_stock).toLowerCase());
      if (kind === 'service' && requested === true) throw fail('invalid_kind', 'Un servicio no lleva existencias.');
      if (previous && requested !== null && Boolean(previous.track_stock) !== requested && Number(previous.quantity) !== 0) {
        throw fail('policy_locked', 'Para cambiar el control de inventario, deja antes las existencias en cero con un ajuste de inventario.', 409);
      }
      const trackStock = kind === 'product'
        ? requested === null
          ? previous ? previous.track_stock !== false : true
          : requested
        : false;
      /*
       * TIPO COMERCIAL (no confundir con `kind`: producto o servicio).
       *   own         → está en nuestro almacén y descuenta existencias.
       *   third_party → se compra en una tienda; NUNCA descuenta stock propio.
       * Los PHYTOEMAGRY de siempre quedan como `own` sin cambiar nada más. Si no
       * se dice nada en un producto nuevo, se deduce de la política de stock.
       */
      const requestedType = ['own', 'third_party'].includes(input.product_type) ? input.product_type : null;
      const productType = previous?.legacy
        ? 'own'
        : requestedType ??
          previous?.product_type ??
          (kind === 'service' ? 'own' : trackStock ? 'own' : 'third_party');
      if (kind === 'service' && productType === 'third_party') {
        throw fail('invalid_product_type', 'Un servicio no se compra en una tienda: elige «Propio».');
      }
      if (productType === 'third_party' && trackStock && Number(previous?.quantity ?? 0) > 0) {
        throw fail('policy_locked', 'Un producto de terceros no lleva existencias propias: deja antes el stock en cero con un ajuste.', 409);
      }
      const name = clean(input.name), sku = clean(input.sku, 60).toUpperCase();
      if (!name || !/^[A-Z0-9][A-Z0-9._-]{0,59}$/.test(sku)) throw fail('invalid_product', 'Escribe un nombre y un código válido sin espacios.');
      /*
       * PRECIO ANTERIOR (ofertas): opcional. Se guarda SOLO si es mayor que el
       * precio de venta; si no, se rechaza. En un PATCH sin el campo se conserva
       * el valor que ya tuviera el artículo.
       */
      const priceCents = money(input.price);
      let compareCents = previous?.compare_at_cents ?? null;
      if (input.compare_at_price !== undefined) {
        compareCents = input.compare_at_price === '' || input.compare_at_price === null
          ? null
          : money(input.compare_at_price);
      }
      if (compareCents !== null && compareCents <= priceCents) {
        throw fail('invalid_compare_at', 'El precio anterior debe ser mayor que el precio de venta.');
      }
      let offerPriceCents = previous?.offer_price_cents ?? null;
      if (input.offer_price !== undefined) offerPriceCents = input.offer_price === '' || input.offer_price === null ? null : money(input.offer_price);
      if (offerPriceCents !== null && offerPriceCents <= 0) throw fail('invalid_offer_price', 'El precio de oferta debe ser mayor que cero.');
      if (offerPriceCents !== null && compareCents !== null && compareCents <= offerPriceCents) throw fail('invalid_compare_at', 'El precio anterior debe ser mayor que el precio de oferta.');
      const offerActive = booleanInput(input.offer_active, previous?.offer_active === undefined ? compareCents !== null : previous.offer_active === true);
      if (offerActive && offerPriceCents === null) offerPriceCents = priceCents;
      if (offerActive && (compareCents === null || compareCents <= offerPriceCents)) throw fail('invalid_offer', 'Activa la oferta solo con precio anterior y precio de oferta válidos.');
      const offerStartAt = input.offer_start_at === undefined ? previous?.offer_start_at ?? null : parseOfferDate(input.offer_start_at, 'inicio de la oferta');
      const offerEndAt = input.offer_end_at === undefined ? previous?.offer_end_at ?? null : parseOfferDate(input.offer_end_at, 'final de la oferta');
      if (offerStartAt && offerEndAt && Date.parse(offerEndAt) <= Date.parse(offerStartAt)) throw fail('invalid_offer_dates', 'La fecha final debe ser posterior a la fecha inicial.');
      const dailyOffer = booleanInput(input.daily_offer, previous?.daily_offer === true);
      if (!integer(input.min_stock ?? 0)) throw fail('invalid_quantity', 'El stock mínimo debe ser un número entero mayor o igual a cero.');
      let category=null;
      if(input.category_id){const row=(await q('SELECT doc FROM fulltech_categories_v1 WHERE id=$1',[String(input.category_id)])).rows[0];if(!row)throw fail('category_not_found','Selecciona una categoría existente.');category=JSON.parse(row.doc);}
      else if(input.category_id===undefined)category=await ensureCategory(q,input.category||'');
      const p = { ...previous, id: id || `product_${randomUUID()}`, sku, name, kind, product_type: productType,
        description: clean(input.description, 2000), category: category?.name||'',category_id:category?.id||null,unit: 'unidad',
        store_public_name: clean(input.store_public_name ?? previous?.store_public_name ?? '', 160),
        store_short_description: clean(input.store_short_description ?? previous?.store_short_description ?? '', 240),
        store_public_description: clean(input.store_public_description ?? previous?.store_public_description ?? '', 2000),
        store_brand: clean(input.store_brand ?? previous?.store_brand ?? '', 100),
        store_availability: AVAILABILITY_STATES.has(input.store_availability)
          ? input.store_availability
          : previous?.store_availability ?? (trackStock && productType === 'own' ? 'AVAILABLE_NOW' : 'ON_REQUEST'),
        warranty_available: input.warranty_available === undefined
          ? Boolean(previous?.warranty_available)
          : input.warranty_available === true || String(input.warranty_available) === 'true' || String(input.warranty_available) === 'on',
        warranty_months: Math.max(0, Math.min(120, Number(input.warranty_months ?? previous?.warranty_months ?? 0) || 0)),
        warranty_provider: ['FULLTECH', 'manufacturer', 'other'].includes(input.warranty_provider)
          ? input.warranty_provider
          : previous?.warranty_provider ?? '',
        warranty_coverage: clean(input.warranty_coverage ?? previous?.warranty_coverage ?? '', 1000),
        warranty_exclusions: clean(input.warranty_exclusions ?? previous?.warranty_exclusions ?? '', 1000),
        warranty_conditions: clean(input.warranty_conditions ?? previous?.warranty_conditions ?? '', 2000),
        warranty_claim: clean(input.warranty_claim ?? previous?.warranty_claim ?? '', 1000),
        warranty_public_notes: clean(input.warranty_public_notes ?? previous?.warranty_public_notes ?? '', 500),
        warranty_private_notes: clean(input.warranty_private_notes ?? previous?.warranty_private_notes ?? '', 1000),
        price_cents: priceCents, compare_at_cents: compareCents, offer_active: offerActive, offer_price_cents: offerPriceCents,
        offer_start_at: offerStartAt, offer_end_at: offerEndAt, daily_offer: dailyOffer,
        cost_cents: previous?.legacy ? 0 : money(input.cost),
        track_stock: trackStock, active: input.active !== false, min_stock: Number(input.min_stock ?? 0),
        legacy: !!previous?.legacy, created_at: previous?.created_at || clock().toISOString(),
        updated_at: clock().toISOString(), updated_by: actor?.display_name || 'Administración' };
      const previousRefs=galleryRefs(previous);
      const entries=incoming??(image?[{content:image},...previousRefs.slice(1)]:null);
      if(entries){
        const seen=new Set();p.gallery=[];
        for(const entry of entries){
          if(entry.content){const key=`image_${randomUUID()}`;await q('INSERT INTO fulltech_product_images_v1(id,mime,data) VALUES($1,$2,$3)',[key,entry.content.mime,entry.content.data]);p.gallery.push({id:key,created_at:clock().toISOString()});}
          else{const known=previousRefs.find(e=>e.id===entry.id);if(!known||seen.has(entry.id))throw fail('invalid_image','La imagen no pertenece a este producto o está repetida.');const bytes=await storedImage(entry.id,q);if(!bytes)throw fail('invalid_image','La imagen ya no está disponible. Reemplázala.');await usableImage(bytes);seen.add(entry.id);p.gallery.push(known);}
        }
        // Immutable image rows preserve historical references and permit rollback.
        p.image_url=p.gallery.length?`/api/admin/store/products/${encodeURIComponent(p.id)}/image?v=${(previous?.version||0)+1}`:null;
      }
      delete p.images;
      const publication=(await q('SELECT status FROM fulltech_store_publication_v1 WHERE product_id=$1',[p.id])).rows[0];
      if(publication?.status==='published')await requireGallery(p,q);
      const initial = kind === 'product' && !previous ? Number(input.quantity ?? 0) : 0;
      if (!integer(initial)) throw fail('invalid_quantity', 'La cantidad inicial debe ser un número entero mayor o igual a cero.');
      if (previous) await q('UPDATE fulltech_catalog_v1 SET sku=$1,doc=$2,version=version+1 WHERE id=$3', [sku,JSON.stringify(p),p.id]);
      else {
        await q('INSERT INTO fulltech_catalog_v1(id,sku,quantity,doc) VALUES($1,$2,$3,$4)', [p.id,sku,initial,JSON.stringify(p)]);
        if (initial) await movement(q,p,initial,0,initial,'INITIAL','Inventario inicial',actor,`initial:${p.id}`);
      }
      // Seguridad de publicación: el artículo nace oculto. Se publica de forma
      // explícita desde la ficha. Las ediciones posteriores no alteran el estado.
      await q("INSERT INTO fulltech_store_publication_v1(product_id,status,featured,sort_order,updated_at) VALUES($1,'unpublished',0,0,$2) ON CONFLICT(product_id) DO NOTHING", [p.id, clock().toISOString()]);
      await indexProductSearch(q, p);
      return one(p.id, q);
    });
  }
  async function movement(q,p,delta,before,after,type,reason,actor,key,orderId=null) {
    const doc = { id: `movement_${randomUUID()}`, product_id:p.id, product_name:p.name, quantity_delta:delta,
      quantity_before:before, quantity_after:after, type, reason, actor:actor?.display_name || 'Sistema',
      order_id:orderId, unit_cost_cents:p.cost_cents, created_at:clock().toISOString() };
    await q('INSERT INTO fulltech_stock_movements_v1(id,product_id,order_id,created_at,operation_key,doc) VALUES($1,$2,$3,$4,$5,$6)',
      [doc.id,p.id,orderId,doc.created_at,key,JSON.stringify(doc)]);
    return doc;
  }
  async function adjust(id, input, actor) {
    /*
     * El motivo es OPCIONAL: quien ajusta muchas veces al día no tiene que
     * inventar una frase. Si no lo escribe, se guarda uno que diga de dónde
     * viene el movimiento, para que el historial siga siendo legible.
     */
    const reason = clean(input.reason,300) || (input.type==='count'?'Recuento físico':input.type==='in'?'Entrada manual':'Salida manual');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId || '')) throw fail('invalid_request_id','Actualiza la página y vuelve a intentarlo.');
    const current = await one(id);
    if (!current) throw fail('not_found','Producto no encontrado.',404);
    if (current.kind === 'service') throw fail('service_has_no_stock','Los servicios no llevan existencias.');
    if (current.legacy) throw fail('legacy_stock','Phytoemagry comparte un inventario por cápsulas. Usa su control de cápsulas.');
    return transaction(async q => {
      const key = `manual:${input.requestId}`;
      const p = await one(id,q,true);
      const old = (await q('SELECT product_id,doc FROM fulltech_stock_movements_v1 WHERE operation_key=$1',[key])).rows[0];
      if (old) { if(old.product_id !== id) throw fail('invalid_request_id','La operación corresponde a otro producto.',409); return { duplicate:true,movement:JSON.parse(old.doc) }; }
      const count = input.type === 'count';
      if (!['in','out','count'].includes(input.type) || !integer(input.quantity) || (!count && Number(input.quantity) === 0)) throw fail('invalid_quantity','Escribe una cantidad válida.');
      if (count && Number(input.expected) !== p.quantity) throw fail('stale_count','El stock cambió durante el recuento. Actualiza y vuelve a contar.',409);
      const delta = count ? Number(input.quantity)-p.quantity : Number(input.quantity)*(input.type === 'out'?-1:1);
      const after = p.quantity+delta;
      if(after < 0) throw fail('insufficient_stock',`Stock insuficiente de ${p.name}: hay ${p.quantity} unidades.`,409);
      await q('UPDATE fulltech_catalog_v1 SET quantity=quantity+$1,version=version+1 WHERE id=$2',[delta,id]);
      return { movement:await movement(q,p,delta,p.quantity,after,count?'COUNT':input.type==='in'?'RESTOCK':'ADJUSTMENT_OUT',reason,actor,key) };
    });
  }
  async function history() { return (await sql.query('SELECT doc FROM fulltech_stock_movements_v1 ORDER BY created_at DESC LIMIT 200')).rows.map(r=>JSON.parse(r.doc)); }
  async function checkOrder(order, previous = false) {
    const products = new Map((await list()).map(p=>[p.id,p]));
    const required = new Map();
    for(const line of order.items || []) { const p=products.get(line.variantId); if(p && !p.legacy && p.track_stock) required.set(p.id,(required.get(p.id)||0)+Number(line.quantity)); }
    for(const [id,n] of required) {
      const p=products.get(id);
      const net = previous ? await sold(order.id,id) : 0;
      if(p.quantity < n-net) return {ok:false,status:409,error:'insufficient_stock',message:`Stock insuficiente de ${p.name}: hay ${p.quantity} unidades.`,available:p.quantity,required:n-net};
    }
    return {ok:true};
  }
  async function sold(orderId,id,q=sql.query) {
    const rows=await q('SELECT doc FROM fulltech_stock_movements_v1 WHERE order_id=$1 AND product_id=$2',[orderId,id]);
    return -rows.rows.reduce((s,r)=>s+Number(JSON.parse(r.doc).quantity_delta),0);
  }
  async function syncSale(item, order, previous, legacyWork) {
    return transaction(async q=>{
      const rows=(await q('SELECT * FROM fulltech_catalog_v1 ORDER BY id'+(backend==='postgres'?' FOR UPDATE':''))).rows.map(decode);
      const next = {...order,items:[...(order.items||[])]};
      const allMoves=[];
      for(const p of rows.filter(p=>!p.legacy)) {
        const lines=next.items.filter(l=>l.variantId===p.id);
        const target=p.track_stock?lines.reduce((s,l)=>s+Number(l.quantity),0):0;
        const old=await sold(item.id,p.id,q), delta=old-target;
        if(p.quantity+delta<0) throw fail('insufficient_stock',`Stock insuficiente de ${p.name}.`,409);
        if(delta) {
          await q('UPDATE fulltech_catalog_v1 SET quantity=quantity+$1,version=version+1 WHERE id=$2',[delta,p.id]);
          allMoves.push(await movement(q,p,delta,p.quantity,p.quantity+delta,delta<0?'SALE':'SALE_REVERSAL',`Pedido ${order.order_number||item.id}`,null,`sale:${randomUUID()}`,item.id));
        }
        next.items=next.items.map(l=>{
          if(l.variantId!==p.id)return l;
          const oldLine=previous?.items?.find(x=>x.variantId===p.id);
          const cost=oldLine?.unit_cost_snapshot_cents ?? p.cost_cents;
          const revenue=Math.round(Number(l.subtotal)*100),totalCost=cost*Number(l.quantity);
          return {...l,unit_cost_snapshot_cents:cost,product_cost_snapshot_cents:totalCost,
            unit_price_snapshot_cents:Math.round(Number(l.unitPrice)*100),subtotal_snapshot_cents:revenue,gross_profit_snapshot_cents:revenue-totalCost};
        });
      }
      const r=await legacyWork(next);
      if(!r.ok)throw Object.assign(fail(r.error,r.message||'No se pudo actualizar el inventario.',409),{inventory:r});
      return {...r,movements:allMoves};
    });
  }
  async function integrity(order) {
    const issues=[];
    for(const p of (await list()).filter(p=>!p.legacy&&p.track_stock)) {
      const expected=(order.items||[]).filter(l=>l.variantId===p.id).reduce((s,l)=>s+Number(l.quantity),0);
      if(await sold(order.id,p.id)!==expected)issues.push('delivered_store_stock_mismatch');
    }
    return [...new Set(issues)];
  }
  /**
   * CAMBIO DE TIPO COMERCIAL, aislado del resto de la ficha.
   *
   * Editar un producto exige reenviar precio, categoría e imagen; para marcar
   * «esto se compra en una tienda» eso es demasiado y se presta a pisar datos.
   * Aquí solo se toca `product_type`, con las mismas garantías: no se cambia el
   * tipo de un PHYTOEMAGRY y no se marca de terceros algo con existencias.
   */
  async function setProductType(id, productType, actor) {
    if (!['own', 'third_party'].includes(productType)) {
      throw fail('invalid_product_type', 'Elige «Propio» o «De terceros».');
    }
    return transaction(async (q) => {
      const previous = await one(id, q, true);
      if (!previous) throw fail('not_found', 'El producto ya no existe.', 404);
      if (previous.legacy) throw fail('product_type_locked', 'Los productos Phytoemagry son propios por su inventario.', 409);
      if (productType === 'third_party' && previous.track_stock && Number(previous.quantity) > 0) {
        throw fail(
          'policy_locked',
          'Un producto de terceros no lleva existencias propias: deja antes el stock en cero con un ajuste.',
          409,
        );
      }
      const doc = {
        ...previous,
        product_type: productType,
        // De terceros nunca descuenta stock propio.
        track_stock: productType === 'third_party' ? false : previous.track_stock,
        updated_at: clock().toISOString(),
        updated_by: actor?.display_name || 'Administración',
      };
      await q('UPDATE fulltech_catalog_v1 SET doc=$1,version=version+1 WHERE id=$2', [JSON.stringify(doc), id]);
      return one(id, q);
    });
  }
  /**
   * Archivar es la baja segura de un artículo: deja de venderse y desaparece de
   * la tienda, pero conserva su registro, su imagen, su historial de inventario
   * y las referencias de pedidos y facturas ya emitidos. No se borran filas
   * físicamente para no romper la integridad histórica.
   */
  async function archive(id, actor) {
    return transaction(async (q) => {
      const current = await one(id, q, true);
      if (!current) throw fail('not_found', 'El artículo ya no existe.', 404);
      if (current.legacy) throw fail('legacy_locked', 'Las presentaciones Phytoemagry no se archivan: desactívalas para retirarlas.', 409);
      if (current.archived) return { id, name: current.name, archived: true, duplicate: true };
      const { quantity, version, ...stored } = current;
      const now = clock().toISOString();
      const doc = {
        ...stored, archived: true, active: false,
        archived_at: now, archived_by: actor?.display_name || 'Administración',
        updated_at: now, updated_by: actor?.display_name || 'Administración',
      };
      await q('UPDATE fulltech_catalog_v1 SET doc=$1, version=version+1 WHERE id=$2', [JSON.stringify(doc), id]);
      await q("UPDATE fulltech_store_publication_v1 SET status='unpublished', featured=0, updated_at=$2 WHERE product_id=$1", [id, now]);
      return { id, name: current.name, archived: true };
    });
  }
  /**
   * Restaurar devuelve el artículo al catálogo conservando su identidad: mismo
   * id, SKU, imagen, movimientos y referencias históricas. Queda inactivo y sin
   * publicar hasta que administración lo active y apruebe explícitamente.
   */
  async function restore(id, actor) {
    return transaction(async (q) => {
      const current = await one(id, q, true);
      if (!current) throw fail('not_found', 'El artículo ya no existe.', 404);
      if (!current.archived) throw fail('not_archived', 'El artículo no está archivado.', 409);
      const { quantity, version, ...stored } = current;
      const now = clock().toISOString();
      const doc = {
        ...stored, archived: false, active: false,
        restored_at: now, restored_by: actor?.display_name || 'Administración',
        updated_at: now, updated_by: actor?.display_name || 'Administración',
      };
      await q('UPDATE fulltech_catalog_v1 SET doc=$1, version=version+1 WHERE id=$2', [JSON.stringify(doc), id]);
      await q("INSERT INTO fulltech_store_publication_v1(product_id,status,featured,sort_order,updated_at) VALUES($1,'unpublished',0,0,$2) ON CONFLICT(product_id) DO UPDATE SET status='unpublished', featured=0, updated_at=excluded.updated_at", [id, now]);
      return one(id, q);
    });
  }
  /**
   * Valida el carrito de la tienda contra el catálogo vivo y devuelve las
   * líneas con PRECIO y GARANTÍA del servidor (nunca se confía en el navegador).
   */
  async function publicOrderItems(input) {
    if (Array.isArray(input) && (input.length > 30 || new Set(input.map(row => row?.id)).size !== input.length)) {
      throw fail('invalid_cart', 'El carrito admite hasta 30 productos distintos, sin líneas repetidas.', 422);
    }
    const rows = Array.isArray(input) ? input : [];
    if (!rows.length) throw fail('empty_cart', 'El carrito está vacío.', 422);
    const pubs = await publicProducts();
    const byId = new Map(pubs.map(p => [p.id, p]));
    const lines = [];
    for (const raw of rows) {
      const id = clean(raw?.id, 80);
      const quantity = Number(raw?.quantity);
      const p = byId.get(id);
      if (!p) throw fail('product_unavailable', 'Uno de los productos ya no está disponible.', 409);
      /* Doble puerta: aunque llegue un id de servicio, aquí no pasa. */
      if (p.kind !== 'product') throw fail('service_not_sellable', 'Los servicios no se venden por la tienda.', 422);
      if (!p.purchaseable) throw fail('not_purchaseable', `${p.name} no se puede comprar ahora mismo.`, 409);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw fail('invalid_quantity', `Revisa la cantidad de ${p.name}.`, 422);
      }
      lines.push({ id: p.id, quantity, name: p.name, price: p.price, warranty: p.warranty });
    }
    return lines;
  }

  return {list,save,setProductType,adjust,history,checkOrder,syncSale,exclusive,integrity,orderLock,changed,categories,createCategory,setPublication,publicationStates,galleryAudit,publicProducts,dailyOffers,publicOrderItems,searchPublicProducts,publicImage,archive,restore,
    subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},
    product:(options={})=>list({includeInactive:options.includeInactive===true}).then(rows=>({variants:rows.map(p=>({...saleItem(p),general:!p.legacy}))})),
    saleItems:()=>list({includeInactive:false}).then(rows=>rows.map(saleItem)),
    image,
  };
}

export function storeInventoryFacade(legacy, catalog) {
  if(!catalog)return legacy;
  const safely = promise => promise.catch(e=>({ok:false,error:e.code||'inventory_error',message:e.message,status:e.status||409}));
  const legacyChange=fn=>catalog.exclusive(async()=>{const result=await fn();catalog.changed();return result;});
  return {...legacy,
    addStock:input=>legacyChange(()=>legacy.addStock(input)),
    adjust:input=>legacyChange(()=>legacy.adjust(input)),
    countStock:input=>legacyChange(()=>legacy.countStock(input)),
    updateCost:(value,actor)=>legacyChange(()=>legacy.updateCost(value,actor)),
    catalog:async()=>{
      const base=await legacy.catalog();
      return {...base,presentations:(await catalog.saleItems()).map(p=>({...base.presentations.find(old=>old.id===p.id),...p}))};
    },
    recordSale:async item=>{
      const {orderOf}=await import('./orders.mjs'); const order=orderOf(item);
      return safely(catalog.syncSale(item,order,order,next=>legacy.syncSale(item,next,order,null,{persistOrder:false})));
    },
    syncSale:async(item,target,previous,reason,options={})=>{
      const {orderOf}=await import('./orders.mjs'); const order=target||orderOf(item);
      return safely(catalog.syncSale(item,order,previous||orderOf(item),next=>legacy.syncSale(item,next,previous,reason,options)));
    },
    reverseSale:async(item,reason)=>{
      const {orderOf}=await import('./orders.mjs');const original=orderOf(item);
      return safely(catalog.syncSale(item,{...original,items:[],total_capsules:0},original,next=>legacy.syncSale(item,next,original,reason,{persistOrder:false})));
    },
  };
}
