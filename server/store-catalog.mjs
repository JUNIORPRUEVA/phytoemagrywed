import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSqlQuery } from './sql-query.mjs';
import { productConfig } from '../src/config/product.config.js';
import { moneyToCents } from './inventory.mjs';

const fail = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const clean = (v, n = 160) => String(v ?? '').trim().slice(0, n);
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
  // Store publication is deliberately separate from the operational catalog.
  // Existing and newly created rows start hidden until an administrator opts in.
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_store_publication_v1 (
    product_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unpublished',
    featured INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL)`);
  await sql.query('CREATE INDEX IF NOT EXISTS fulltech_store_publication_status_order_idx ON fulltech_store_publication_v1(status, sort_order, product_id)');
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_store_search_terms_v1 (
    product_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(product_id,token))`);
  await sql.query('CREATE INDEX IF NOT EXISTS fulltech_store_search_token_product_idx ON fulltech_store_search_terms_v1(token,product_id)');
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
    const current = await one(id);
    if (!current) throw fail('not_found', 'El artículo ya no existe.', 404);
    if (status === 'published' && !current.active) throw fail('inactive_product', 'Activa el artículo en el catálogo antes de publicarlo.', 409);
    const featured = input?.featured === true;
    const rawOrder = input?.sort_order ?? 0;
    if (!Number.isSafeInteger(Number(rawOrder)) || Number(rawOrder) < 0 || Number(rawOrder) > 1000000) throw fail('invalid_sort_order', 'El orden debe ser un número válido.');
    await sql.query('INSERT INTO fulltech_store_publication_v1(product_id,status,featured,sort_order,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_id) DO UPDATE SET status=excluded.status,featured=excluded.featured,sort_order=excluded.sort_order,updated_at=excluded.updated_at', [id, status, featured ? 1 : 0, Number(rawOrder), clock().toISOString()]);
    changed();
    return { product_id: id, status, featured, sort_order: Number(rawOrder) };
  }
  async function publicationStates() {
    const rows = (await sql.query('SELECT product_id,status,featured,sort_order,updated_at FROM fulltech_store_publication_v1')).rows;
    return Object.fromEntries(rows.map(row => [row.product_id, { status: row.status, featured: Boolean(Number(row.featured)), sort_order: Number(row.sort_order), updated_at: row.updated_at }]));
  }
  async function publicProducts() {
    if (publicCache && publicCache.expiresAt > Date.now()) return publicCache.items;
    const pubs = (await sql.query("SELECT product_id,featured,sort_order FROM fulltech_store_publication_v1 WHERE status='published' ORDER BY sort_order,product_id")).rows;
    if (!pubs.length) { publicCache = { items: [], expiresAt: Date.now() + 5000 }; return []; }
    const all = await list({ includeInactive: false });
    const byId = new Map(all.map(p => [p.id, p]));
    const items = pubs.flatMap(pub => {
      const p = byId.get(pub.product_id);
      if (!p?.active) return [];
      let availability;
      if (p.kind === 'service') availability = 'consult';
      else if (p.track_stock === false || p.product_type === 'third_party') availability = 'by_order';
      else if (p.quantity == null) availability = 'check';
      else if (p.quantity <= 0) availability = 'out_of_stock';
      else if (p.quantity <= 2) availability = 'low_stock';
      else availability = 'available';
      return [{
        id: p.id, kind: p.kind === 'service' ? 'service' : 'product', name: p.store_public_name || p.name,
        category: p.category || null, price: Number(p.price_cents) / 100, currency: 'DOP',
        availability, shortDescription: p.store_short_description || '', description: p.store_public_description || '',
        brand: p.store_brand || null,
        imageUrl: p.image_url ? `/api/store/products/${encodeURIComponent(p.id)}/image` : null,
        featured: Boolean(Number(pub.featured)), sortOrder: Number(pub.sort_order),
      }];
    });
    publicCache = { items, expiresAt: Date.now() + 5000 };
    return items;
  }
  async function searchPublicProducts(value) {
    const terms = [...new Set(normalizeSearch(value).split(/[^a-z0-9]+/).filter(Boolean))].slice(0, 8);
    if (!terms.length) return publicProducts();
    let matches = null;
    for (const term of terms) {
      const rows = (await sql.query('SELECT product_id FROM fulltech_store_search_terms_v1 WHERE token LIKE $1', [`${term}%`])).rows;
      const ids = new Set(rows.map(row => row.product_id));
      matches = matches === null ? ids : new Set([...matches].filter(id => ids.has(id)));
      if (!matches.size) return [];
    }
    return (await publicProducts()).filter(product => matches.has(product.id));
  }
  async function image(id) {
    const stored=(await sql.query('SELECT mime,data FROM fulltech_product_images_v1 WHERE id=$1',[id])).rows[0];
    if(stored)return stored;
    const seed=productConfig.variants.find(p=>p.id===id);
    if(!seed)return null;
    const data=await readFile(new URL(`../public${seed.image}-320.webp`,import.meta.url));
    return {mime:'image/webp',data:data.toString('base64')};
  }
  async function publicImage(id) {
    const pub = (await sql.query("SELECT status FROM fulltech_store_publication_v1 WHERE product_id=$1", [id])).rows[0];
    if (pub?.status !== 'published') return null;
    const p = await one(id);
    if (!p?.active) return null;
    return image(id);
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
  const decode = r => r ? { ...JSON.parse(r.doc), quantity: Number(r.quantity), version: Number(r.version) } : null;
  const normalizeSearch = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  async function indexProductSearch(q, product) {
    const tokens = [...new Set(normalizeSearch(`${product.name} ${product.store_public_name || ''} ${product.sku} ${product.category || ''} ${product.description || ''} ${product.store_short_description || ''} ${product.store_public_description || ''} ${product.store_brand || ''}`).split(/[^a-z0-9]+/).filter(token => token.length > 0 && token.length <= 80))];
    await q('DELETE FROM fulltech_store_search_terms_v1 WHERE product_id=$1', [product.id]);
    for (const token of tokens) await q('INSERT INTO fulltech_store_search_terms_v1(product_id,token) VALUES($1,$2) ON CONFLICT(product_id,token) DO NOTHING', [product.id, token]);
  }
  if (Number((await sql.query('SELECT COUNT(*) AS count FROM fulltech_store_search_terms_v1')).rows[0]?.count || 0) === 0) {
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
  async function list({ includeInactive = true } = {}) {
    const [rows, legacy] = await Promise.all([sql.query('SELECT * FROM fulltech_catalog_v1 ORDER BY sku'), legacyInventory.catalog()]);
    return rows.rows.map(decode).filter(p => includeInactive || p.active).sort((a,b)=>a.legacy&&b.legacy?a.capsules-b.capsules:a.legacy?-1:b.legacy?1:a.name.localeCompare(b.name)).map(p => p.legacy ? { ...p,
      quantity: legacy.initialized ? Math.floor(legacy.stock / p.capsules) : null,
      stock_initialized: legacy.initialized, base_quantity: legacy.stock, base_unit: 'cápsulas',
      cost_cents: legacy.product.current_unit_cost_cents * p.capsules,
      image_url: p.image_url?.startsWith('/assets/') ? `/api/admin/store/products/${p.id}/image?v=${p.version}` : p.image_url,
    } : { ...p, stock_initialized: true });
  }
  function saleItem(p) {
    return { id: p.id, name: p.name, label: p.name, kind: p.kind, product_type: p.product_type ?? null, product_id: p.id,
      price: p.price_cents / 100, currency: 'DOP', available: p.active, active: p.active,
      capsules: p.capsules || 0, capsule_quantity: p.capsules || 0, completeBottle: !!p.completeBottle,
      general: !p.legacy, track_stock: p.track_stock, stock: p.quantity,
      image_url: p.image_url, sale_price_cents: p.price_cents };
  }
  async function save(input, actor, id = null) {
    const image = input.image ? parseProductImage(input.image) : null;
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
      if (kind === 'product' && !image && !previous?.image_url && !previous?.imported_from) throw fail('image_required', 'Agrega la imagen del producto.');
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
        price_cents: money(input.price), cost_cents: previous?.legacy ? 0 : money(input.cost),
        track_stock: trackStock, active: input.active !== false, min_stock: Number(input.min_stock ?? 0),
        legacy: !!previous?.legacy, created_at: previous?.created_at || clock().toISOString(),
        updated_at: clock().toISOString(), updated_by: actor?.display_name || 'Administración' };
      if (image) {
        await q('INSERT INTO fulltech_product_images_v1(id,mime,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET mime=excluded.mime,data=excluded.data', [p.id,image.mime,image.data]);
        p.image_url = `/api/admin/store/products/${encodeURIComponent(p.id)}/image?v=${(previous?.version || 0)+1}`;
      }
      const initial = kind === 'product' && !previous ? Number(input.quantity ?? 0) : 0;
      if (!integer(initial)) throw fail('invalid_quantity', 'La cantidad inicial debe ser un número entero mayor o igual a cero.');
      if (previous) await q('UPDATE fulltech_catalog_v1 SET sku=$1,doc=$2,version=version+1 WHERE id=$3', [sku,JSON.stringify(p),p.id]);
      else {
        await q('INSERT INTO fulltech_catalog_v1(id,sku,quantity,doc) VALUES($1,$2,$3,$4)', [p.id,sku,initial,JSON.stringify(p)]);
        if (initial) await movement(q,p,initial,0,initial,'INITIAL','Inventario inicial',actor,`initial:${p.id}`);
      }
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
  return {list,save,setProductType,adjust,history,checkOrder,syncSale,exclusive,integrity,orderLock,changed,categories,createCategory,setPublication,publicationStates,publicProducts,searchPublicProducts,publicImage,
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
