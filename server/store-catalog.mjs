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
  for (const p of productConfig.variants) {
    const doc = { id: p.id, sku: `PHYTO-${p.capsules}`, kind: 'product', name: `Phytoemagry · ${p.capsules} cápsulas`,
      category: 'Phytoemagry', description: '', price_cents: p.price * 100, cost_cents: 0,
      image_url: `/api/admin/store/products/${p.id}/image?v=1`, active: true, track_stock: true, min_stock: 0,
      capsules: p.capsules, legacy: true, completeBottle: !!p.completeBottle, unit: 'unidad', created_at: clock().toISOString() };
    await sql.query('INSERT INTO fulltech_catalog_v1(id,sku,doc) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [p.id, doc.sku, JSON.stringify(doc)]);
  }
  let tail = Promise.resolve();
  const listeners = new Set();
  function changed() { for (const listener of listeners) { try { listener(); } catch {} } }
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
  const one = async (id, q = sql.query, lock = false) => decode((await q('SELECT * FROM fulltech_catalog_v1 WHERE id=$1'+(lock&&backend==='postgres'?' FOR UPDATE':''), [id])).rows[0]);
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
    return { id: p.id, name: p.name, label: p.name, kind: p.kind, product_id: p.id,
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
      const name = clean(input.name), sku = clean(input.sku, 60).toUpperCase();
      if (!name || !/^[A-Z0-9][A-Z0-9._-]{0,59}$/.test(sku)) throw fail('invalid_product', 'Escribe un nombre y un código válido sin espacios.');
      if (kind === 'product' && !image && !previous?.image_url) throw fail('image_required', 'Agrega la imagen del producto.');
      if (!integer(input.min_stock ?? 0)) throw fail('invalid_quantity', 'El stock mínimo debe ser un número entero mayor o igual a cero.');
      const p = { ...previous, id: id || `product_${randomUUID()}`, sku, name, kind,
        description: clean(input.description, 2000), category: clean(input.category, 100), unit: 'unidad',
        price_cents: money(input.price), cost_cents: previous?.legacy ? 0 : money(input.cost),
        track_stock: kind === 'product', active: input.active !== false, min_stock: Number(input.min_stock ?? 0),
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
    const reason = clean(input.reason,300);
    if (!reason) throw fail('reason_required','Escribe el motivo del movimiento.');
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
  return {list,save,adjust,history,checkOrder,syncSale,exclusive,integrity,orderLock,changed,
    subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},
    product:(options={})=>list({includeInactive:options.includeInactive===true}).then(rows=>({variants:rows.map(p=>({...saleItem(p),general:!p.legacy}))})),
    saleItems:()=>list({includeInactive:false}).then(rows=>rows.map(saleItem)),
    image:async id=>{
      const stored=(await sql.query('SELECT mime,data FROM fulltech_product_images_v1 WHERE id=$1',[id])).rows[0];
      if(stored)return stored;
      const seed=productConfig.variants.find(p=>p.id===id);
      if(!seed)return null;
      const data=await readFile(new URL(`../public${seed.image}-320.webp`,import.meta.url));
      return {mime:'image/webp',data:data.toString('base64')};
    },
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
