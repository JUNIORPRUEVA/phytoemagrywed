// @vitest-environment node
import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startCrmServer} from '../server/crm-server.mjs';
import {parseProductImage} from '../server/store-catalog.mjs';
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS7kAAAAASUVORK5CYII=';
let app,dir,cookie,databaseUrl;
async function call(route,body,method='POST',auth=cookie){
  const verb=body?method:method==='POST'?'GET':method;
  const r=await fetch(app.url+route,{method:verb,headers:{cookie:auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json()};
}
const list=()=>call('/api/admin/store/products');
const create=(patch={})=>call('/api/admin/store/products',{kind:'product',name:'Cámara Fulltech',sku:'CAM-001',price:'1250.50',cost:'600.25',quantity:5,min_stock:2,image:IMAGE,...patch});
const sale=items=>call('/api/admin/orders',{name:'Cliente Fulltech',phone:'8095550202',paymentMethod:'CASH',status:'entregado',items});
beforeEach(async()=>{
  dir=mkdtempSync(path.join(tmpdir(),'fulltech-catalog-'));
  databaseUrl='';
  if(process.env.FULLTECH_CATALOG_TEST_PG){
    const url=new URL(process.env.FULLTECH_CATALOG_TEST_PG);
    if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/fulltech_qa')throw new Error('Solo se permite la base local desechable fulltech_qa.');
    const {Client}=await import('pg');const client=new Client({connectionString:url.href});await client.connect();
    const schema='pos_qa_'+randomUUID().replaceAll('-','');
    await client.query(`CREATE SCHEMA ${schema}`);await client.end();url.searchParams.set('options',`-c search_path=${schema}`);databaseUrl=url.href;
  }
  app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'catalog.sqlite'),token:'catalog-test-token',quiet:true,schedulerEnabled:false});
  const r=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'catalog-test-token'})});
  cookie=r.headers.get('set-cookie').split(';')[0];
});
afterEach(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true});});
it('conserva las siete presentaciones y su inventario compartido por cápsulas',async()=>{
  await call('/api/admin/inventory/restock',{quantity:100,unitCost:'126.66'});
  const result=await list();expect(result.status).toBe(200);
  const p=result.data.products;expect(p).toHaveLength(7);expect(p.map(x=>x.capsules)).toEqual([5,7,10,15,20,30,60]);
  expect(p.find(x=>x.id==='capsules_10')).toMatchObject({base_quantity:100,quantity:10,cost_cents:126660});
  expect((await call('/api/admin/inventory')).data.stock).toBe(100);
  const image=await fetch(app.url+p[0].image_url,{headers:{cookie}});
  expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/webp');
  expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
});
it('crea productos con foto, costos, precio exacto y cantidad; persisten al reiniciar',async()=>{
  const r=await create();expect(r.status).toBe(201);expect(r.data.product).toMatchObject({quantity:5,price_cents:125050,cost_cents:60025,sku:'CAM-001'});
  const image=await fetch(app.url+r.data.product.image_url,{headers:{cookie}});expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');
  const id=r.data.product.id;await app.close();
  app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'catalog.sqlite'),token:'catalog-test-token',quiet:true,schedulerEnabled:false});
  expect((await list()).data.products.find(x=>x.id===id)).toMatchObject({quantity:5,price_cents:125050});
});
it('exige foto para productos, evita códigos duplicados y rechaza importes y cantidades inválidos',async()=>{
  expect((await create({image:undefined})).data.error).toBe('image_required');
  expect((await create({cost:'-1'})).status).toBe(422);
  expect((await create({quantity:1.5})).status).toBe(422);
  expect((await create({price:'1.234'})).status).toBe(422);
  expect((await create()).status).toBe(201);
  expect((await create({sku:'cam-001'})).status).toBe(409);
  expect((await list()).data.products.filter(x=>!x.legacy)).toHaveLength(1);
});
it('no admite SVG ni imágenes con contenido o tamaños inválidos',()=>{
  expect(()=>parseProductImage('data:image/svg+xml;base64,PHN2Zz4=')).toThrow();
  expect(()=>parseProductImage('data:image/png;base64,'+Buffer.from('not a png file at all').toString('base64'))).toThrow();
});
it('servicios no llevan stock ni generan seguimiento de consumo de cápsulas',async()=>{
  const c=await create({kind:'service',sku:'INST-01',name:'Instalación de cámara',image:undefined,price:'500.75',cost:'150.25'});
  expect(c.status).toBe(201);expect(c.data.product).toMatchObject({quantity:0,track_stock:false});
  const r=await sale([{variantId:c.data.product.id,quantity:2}]);expect(r.status).toBe(201);
  expect(r.data.order.total).toBe(1001.50);expect(r.data.order.items[0]).toMatchObject({product_cost_snapshot_cents:30050,general:true});
  expect(r.data.delivered.followups).toBeNull();
  expect((await call(`/api/admin/store/products/${c.data.product.id}/stock`,{type:'in',quantity:1,reason:'Prueba',requestId:randomUUID()})).data.error).toBe('service_has_no_stock');
});
it('registra entradas y salidas una vez y protege el recuento si el stock cambia',async()=>{
  const p=(await create()).data.product,key=randomUUID();
  const path=`/api/admin/store/products/${p.id}/stock`;
  const body={type:'in',quantity:2,reason:'Compra',requestId:key};
  expect((await call(path,body)).status).toBe(200);expect((await call(path,body)).data.duplicate).toBe(true);
  expect((await call(path,{type:'count',quantity:3,expected:5,reason:'Recuento',requestId:randomUUID()})).status).toBe(409);
  const count=await call(path,{type:'count',quantity:3,expected:7,reason:'Conteo físico',requestId:randomUUID()});
  expect(count.data.movement).toMatchObject({quantity_before:7,quantity_after:3,quantity_delta:-4,type:'COUNT'});
  expect((await call(path,{type:'out',quantity:4,reason:'Ajuste',requestId:randomUUID()})).status).toBe(409);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(3);
});
it('una venta mixta descuenta unidades y cápsulas sin mezclar costos; cancelar restaura ambos',async()=>{
  await call('/api/admin/inventory/restock',{quantity:100,unitCost:'100.00'});
  const p=(await create()).data.product;
  const r=await sale([{variantId:p.id,quantity:2},{variantId:'capsules_10',quantity:1}]);
  expect(r.status).toBe(201);expect(r.data.order.total).toBe(5001);
  expect(r.data.order.items[0].product_cost_snapshot_cents).toBe(120050);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(3);
  expect((await call('/api/admin/inventory')).data.stock).toBe(90);
  const cancel=await call(`/api/admin/orders/${r.data.item.id}/cancel`,{reason:'Cliente canceló'});expect(cancel.status).toBe(200);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(5);
  expect((await call('/api/admin/inventory')).data.stock).toBe(100);
});
it('impide vender por encima del stock y mantiene el costo histórico después de editar el producto',async()=>{
  const p=(await create()).data.product;
  expect((await sale([{variantId:p.id,quantity:6}])).status).toBe(409);
  const r=await sale([{variantId:p.id,quantity:2}]);expect(r.status).toBe(201);
  const latest=(await list()).data.products.find(x=>x.id===p.id);
  const edit=await create();expect(edit.status).toBe(409);
  expect((await call(`/api/admin/store/products/${p.id}`,{...latest,price:'1500.25',cost:'900.00',version:latest.version},'PATCH')).status).toBe(200);
  const report=await call('/api/admin/reports/sales');
  expect(report.data.report.sales.find(x=>x.id===r.data.item.id).product_cost_cents).toBe(120050);
});
it('archivar retira el artículo del selector sin borrar su ficha ni pedidos',async()=>{
  const p=(await create()).data.product;
  expect((await call(`/api/admin/store/products/${p.id}`,{...p,price:'1250.50',cost:'600.25',active:false},'PATCH')).status).toBe(200);
  expect((await call('/api/admin/catalog')).data.catalog.some(x=>x.id===p.id)).toBe(false);
  expect((await sale([{variantId:p.id,quantity:1}])).status).toBe(422);
  expect((await list()).data.products.find(x=>x.id===p.id).active).toBe(false);
});
it('archivar conserva pedidos y factura, y cancelar restaura el stock',async()=>{
  const p=(await create()).data.product;
  const r=await sale([{variantId:p.id,quantity:2}]);expect(r.status).toBe(201);
  expect((await call(`/api/admin/store/products/${p.id}`,null,'DELETE')).status).toBe(200);
  const order=await call(`/api/admin/orders/${r.data.item.id}`,null,'GET');
  expect(order.status).toBe(200);
  expect(order.data.order.items[0]).toMatchObject({variantId:p.id,quantity:2});
  expect((await call('/api/admin/reports/sales')).data.report.sales.some(x=>x.id===r.data.item.id)).toBe(true);
  const cancel=await call(`/api/admin/orders/${r.data.item.id}/cancel`,{reason:'Cliente canceló'});
  expect(cancel.status).toBe(200);
  const movements=(await list()).data.movements.filter(x=>x.product_id===p.id);
  expect(movements.reduce((sum,move)=>sum+move.quantity_delta,0)).toBe(5);
  const archivedList=await call('/api/admin/store/products?archived=1',null,'GET');
  expect(archivedList.data.products.some(x=>x.id===p.id)).toBe(true);
  const restored=await call(`/api/admin/store/products/${p.id}/restore`,{},'POST');
  expect(restored.status).toBe(200);
  expect(restored.data.product).toMatchObject({id:p.id,sku:p.sku,archived:false,active:false});
  expect((await call('/api/store/catalog?q=camara')).data.products).toEqual([]);
  const afterRestore=await call('/api/admin/store/products');
  expect(afterRestore.data.products.find(x=>x.id===p.id)).toMatchObject({archived:false,active:false,sku:p.sku});
  expect(afterRestore.data.movements.filter(x=>x.product_id===p.id).reduce((sum,move)=>sum+move.quantity_delta,0)).toBe(5);
  expect((await call(`/api/admin/store/products/${p.id}/restore`,{},'POST')).data.error).toBe('not_archived');
});
it('rechaza ediciones antiguas y protege catálogo e imágenes sin sesión',async()=>{
  const p=(await create()).data.product;
  const body={...p,price:'1000',cost:'600.25'};
  expect((await call(`/api/admin/store/products/${p.id}`,body,'PATCH')).status).toBe(200);
  expect((await call(`/api/admin/store/products/${p.id}`,body,'PATCH')).status).toBe(409);
  expect((await call('/api/admin/store/products',null,'GET','')).status).toBe(401);
  expect((await fetch(app.url+p.image_url)).status).toBe(401);
});
it('solo administración modifica el catálogo y un agente no recibe costos internos',async()=>{
  const seeded=await create();
  const user=await call('/api/admin/users',{username:'catalog-agent',displayName:'Agente catálogo',role:'AGENT',password:'Catalog-12345'});expect(user.status).toBe(201);
  const login=await fetch(app.url+'/api/admin/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'catalog-agent',password:'Catalog-12345'})});
  const agent=login.headers.get('set-cookie').split(';')[0];
  const result=await call('/api/admin/store/products',null,'GET',agent);expect(result.status).toBe(200);expect(result.data.canManage).toBe(false);
  expect(JSON.stringify(result.data)).not.toMatch(/cost_cents|unit_cost|presentation_cost/);
  const saleCatalog=await call('/api/admin/catalog',null,'GET',agent);expect(JSON.stringify(saleCatalog.data)).not.toMatch(/cost_cents|unit_cost|presentation_cost/);
  expect((await call('/api/admin/store/products',{kind:'service'},'POST',agent)).status).toBe(403);
  expect((await call('/api/admin/store/categories',{name:'Categoría sin permiso'},'POST',agent)).status).toBe(403);
  const archived=seeded.data.product;
  await call(`/api/admin/store/products/${archived.id}`,null,'DELETE');
  expect((await call(`/api/admin/store/products/${archived.id}/restore`,{},'POST',agent)).status).toBe(403);
});
it('dos ventas concurrentes no pueden consumir la misma última unidad',async()=>{
  const p=(await create({quantity:1})).data.product;
  const results=await Promise.all([sale([{variantId:p.id,quantity:1}]),sale([{variantId:p.id,quantity:1}])]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(0);
  expect((await list()).data.movements.filter(x=>x.type==='SALE')).toHaveLength(1);
});
it('crea categorías con imagen, evita duplicados y enlaza productos conservando el dato al reiniciar',async()=>{
  const result=await call('/api/admin/store/categories',{name:'Cámaras y seguridad',image:IMAGE});expect(result.status).toBe(201);
  const c=result.data.category;expect(c.image_url).toContain('/categories/');
  expect((await call('/api/admin/store/categories',{name:'  cámaras y   seguridad '})).status).toBe(409);
  expect((await call('/api/admin/store/categories',{name:''})).status).toBe(422);
  expect((await create({category_id:'missing'})).status).toBe(422);
  const product=await create({category_id:c.id});expect(product.status).toBe(201);expect(product.data.product).toMatchObject({category:c.name,category_id:c.id});
  const image=await fetch(app.url+c.image_url,{headers:{cookie}});expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');
  expect((await fetch(app.url+c.image_url)).status).toBe(401);
  await app.close();app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'catalog.sqlite'),token:'catalog-test-token',quiet:true,schedulerEnabled:false});
  const listResult=await list();expect(listResult.data.categories.find(x=>x.id===c.id)).toMatchObject({name:c.name,image_url:c.image_url});
  expect(listResult.data.products.find(p=>p.id===product.data.product.id).category_id).toBe(c.id);
});
it('notifica cambios del catálogo en vivo a sesiones autenticadas sin difundir datos financieros',async()=>{
  expect((await fetch(app.url+'/api/admin/store/events')).status).toBe(401);
  const response=await fetch(app.url+'/api/admin/store/events',{headers:{cookie},signal:AbortSignal.timeout(5000)});
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  try {
    expect(decoder.decode((await reader.read()).value)).toContain('event: ready');
    expect((await create()).status).toBe(201);
    const event=decoder.decode((await reader.read()).value);
    expect(event).toContain('event: catalog.changed');expect(event).toContain('data: {}');expect(event).not.toContain('cost');
  }finally{await reader.cancel();}
});
it('editar una venta entregada solo mueve la diferencia y conserva su costo histórico',async()=>{
  const p=(await create({quantity:10})).data.product;
  const r=await sale([{variantId:p.id,quantity:2}]);expect(r.status).toBe(201);
  const edited=await call(`/api/admin/orders/${r.data.item.id}`,{items:[{variantId:p.id,quantity:3}]},'PATCH');
  expect(edited.status).toBe(200);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(7);
  const failed=await call(`/api/admin/orders/${r.data.item.id}`,{items:[{variantId:p.id,quantity:20}]},'PATCH');
  expect(failed.status).toBe(409);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(7);
  const again=await call(`/api/admin/orders/${r.data.item.id}`,{items:[{variantId:p.id,quantity:1}]},'PATCH');expect(again.status).toBe(200);
  expect((await list()).data.products.find(x=>x.id===p.id).quantity).toBe(9);
});
it.skipIf(!process.env.FULLTECH_CATALOG_TEST_PG)('amplía las columnas antiguas de PostgreSQL sin perder ventas en pesos enteros',async()=>{
  await call('/api/admin/inventory/restock',{quantity:100,unitCost:'100'});
  const old=await sale([{variantId:'capsules_5',quantity:1}]);expect(old.status).toBe(201);
  await app.close();app=null;
  const {Client}=await import('pg');const client=new Client({connectionString:databaseUrl});await client.connect();
  try {
    await client.query('ALTER TABLE phytoemagry_items ALTER COLUMN unit_price TYPE integer USING unit_price::integer, ALTER COLUMN total TYPE integer USING total::integer');
  }finally{await client.end();}
  app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'catalog.sqlite'),token:'catalog-test-token',quiet:true,schedulerEnabled:false});
  const login=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'catalog-test-token'})});cookie=login.headers.get('set-cookie').split(';')[0];
  const historical=await call(`/api/admin/orders/${old.data.item.id}`);expect(historical.status).toBe(200);
  expect(historical.data.order.total).toBe(1250);
  const p=(await create({kind:'service',sku:'DEC-01',price:'500.75',cost:'150.25',image:undefined})).data.product;
  const next=await sale([{variantId:p.id,quantity:1}]);expect(next.status).toBe(201);expect(next.data.item.total).toBe(500.75);
});
