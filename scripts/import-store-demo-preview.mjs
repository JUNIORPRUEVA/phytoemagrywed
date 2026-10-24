// Import only marked UAT products into the isolated, locally owned preview.
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:4177';
const health=await fetch(base+'/api/health').then(r=>r.json());
assert.equal(health.ok,true);assert.equal(health.storage,'sqlite');
const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'isolated-customer-uat'})});
assert.equal(login.status,200,'Only the isolated customer-preview server is supported.');
const cookie=login.headers.get('set-cookie').split(';')[0];
async function call(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.ok(r.ok,`${route}: ${r.status} ${d.message||d.error||''}`);return d;}
const db=new DatabaseSync('data/uat/phyto-uat.sqlite',{readOnly:true});
try{
 const pubs=new Map(db.prepare('SELECT * FROM fulltech_store_publication_v1').all().map(p=>[p.product_id,p]));
 const products=db.prepare('SELECT doc FROM fulltech_catalog_v1').all().map(r=>JSON.parse(r.doc)).filter(p=>/^UAT-\d{3}$/.test(p.sku||'')&&p.description?.startsWith('DEMO UAT')&&p.kind==='product'&&!p.legacy&&p.store==='fulltech'&&pubs.get(p.id)?.status==='published');
 const existing=new Set((await call('/api/admin/store/products')).products.map(p=>p.sku));let created=0;
 for(const p of products){if(existing.has(p.sku))continue;const images=(p.gallery||[]).map(g=>db.prepare('SELECT mime,data FROM fulltech_product_images_v1 WHERE id=?').get(g.id)).filter(Boolean).map(i=>({data:`data:${i.mime};base64,${i.data}`}));
  const price=p.price_cents/100,reference=p.compare_at_cents/100,offer=Number.isFinite(reference)&&reference>price;
  const result=await call('/api/admin/store/products',{kind:'product',store:'fulltech',sku:p.sku,name:p.name,category:p.category,description:p.description,store_public_name:p.store_public_name,store_short_description:p.store_short_description,store_public_description:p.store_public_description,store_brand:p.store_brand,product_type:p.product_type||'own',track_stock:p.track_stock!==false,store_availability:p.store_availability||'AVAILABLE_NOW',price:price.toFixed(2),cost:(p.cost_cents/100).toFixed(2),quantity:p.quantity??0,min_stock:p.min_stock??1,images,...(offer?{compare_at_price:reference.toFixed(2),offer_price:price.toFixed(2),offer_active:true}:{offer_active:false})});
  const pub=pubs.get(p.id);await call(`/api/admin/store/products/${result.product.id}/publication`,{status:'published',featured:Boolean(pub.featured),sort_order:Number(pub.sort_order)||0});created++;
 }
 const home=await fetch(base+'/api/store/home').then(r=>r.json());const catalog=await fetch(base+'/api/store/catalog?offers=true&limit=48').then(r=>r.json());
 console.log(JSON.stringify({source:'data/uat/phyto-uat.sqlite (solo lectura)',destination:base,created,total:home.total,categories:home.categories,offers:catalog.pagination.total,dailyOffers:home.dailyOffers.map(p=>p.name)},null,2));
}finally{db.close();}
