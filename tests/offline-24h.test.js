// @vitest-environment node
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {startCrmServer} from '../server/crm-server.mjs';
import {Readable} from 'node:stream';
import {handleOfflineOperation} from '../server/offline-operations.mjs';
import {offlineReport} from '../public/admin/offline-report.js';
import {calculateSale} from '../public/admin/pos-math.js';
let app,dir,cookie,doms,online,idb,product,customer;
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS7kAAAAASUVORK5CYII=';
async function server(route,body,key){return fetch(app.url+'/api/admin/'+route,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json',...(key?{'x-fulltech-operation':key}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function page(full=false){
  const dom=new JSDOM(full?readFileSync('public/admin/index.html','utf8'):'<html><body></body></html>',{url:app.url+'/admin/',runScripts:'outside-only',pretendToBeVisual:true});doms.push(dom);
  const w=dom.window;Object.defineProperty(w.navigator,'onLine',{get:()=>online});
  Object.assign(w,{indexedDB:idb,structuredClone,Response,Headers,Request,AbortController,Blob,TextDecoder,calculateSale,offlineReport});
  w.fetch=async(url,options={})=>{if(w.offlineTransport)return w.offlineTransport(url,options);if(!online)throw new TypeError('network down');return fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}});};
  w.eval(readFileSync('public/admin/offline-storage.js','utf8'));
  w.eval(readFileSync('public/admin/offline.js','utf8').replace("await import('./pos-math.js')",'({calculateSale:window.calculateSale})').replace("await import('./offline-report.js')",'({offlineReport:window.offlineReport})'));
  await w.FulltechOffline.ready;return w;
}
const call=(w,route,body)=>w.fetch('/api/admin/'+route,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(async()=>{
  dir=mkdtempSync(path.join(tmpdir(),'fulltech-offline-'));doms=[];online=true;idb=new IDBFactory();
  let databaseUrl='';
  if(process.env.FULLTECH_CATALOG_TEST_PG){
    const url=new URL(process.env.FULLTECH_CATALOG_TEST_PG);if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/fulltech_qa')throw new Error('Solo PostgreSQL local desechable.');
    const {Client}=await import('pg');const c=new Client({connectionString:url.href});await c.connect();const schema='offline_qa_'+crypto.randomUUID().replaceAll('-','');await c.query('CREATE SCHEMA '+schema);await c.end();url.searchParams.set('options','-c search_path='+schema);databaseUrl=url.href;
  }
  app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'test.sqlite'),token:'offline-test-token',schedulerEnabled:false,quiet:true});
  const login=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'offline-test-token'})});cookie=login.headers.get('set-cookie').split(';')[0];
  product=(await (await server('store/products',{kind:'product',name:'Cable USB',sku:'USB-1',price:'100.25',cost:'50',quantity:10,image:IMAGE})).json()).product;
  customer=(await (await server('pos/customers',{name:'Cliente local',phone:'8095550202'})).json()).customer;
});
afterEach(async()=>{for(const d of doms){d.window.dispatchEvent(new d.window.Event('phyto:calling-logout'));}await new Promise(r=>setTimeout(r,30));doms.forEach(d=>d.window.close());await app?.close();rmSync(dir,{recursive:true,force:true});});
async function prepare(w){await call(w,'session');for(const route of ['data','store/products','pos/customers','pos/tickets','pos/quotes'])await call(w,route);}
it('reintentar una creación y un movimiento con la misma clave no duplica stock ni productos',async()=>{
  const body={kind:'service',name:'Instalación',sku:'INSTALL-1',price:'10.50',cost:'2'};
  const key=crypto.randomUUID(),a=await (await server('store/products',body,key)).json(),b=await (await server('store/products',body,key)).json();
  expect(a.product.id).toBe(b.product.id);
  const changed=await server('store/products',{...body,name:'Otro'},key);expect(changed.status).toBe(409);
  const stockKey=crypto.randomUUID(),stock={type:'in',quantity:2,reason:'Entrada offline',requestId:crypto.randomUUID()};
  await server('store/products/'+product.id+'/stock',stock,stockKey);await server('store/products/'+product.id+'/stock',stock,stockKey);
  const data=await (await server('store/products')).json();expect(data.products.find(p=>p.id===product.id).quantity).toBe(12);
});
it('abre en frío desde IndexedDB con datos, imágenes y acceso durante 24 horas',async()=>{
  const w=await page();await prepare(w);await call(w,'store/products/'+product.id+'/image');online=false;
  const cold=await page();const list=await (await call(cold,'store/products')).json();expect(list.products.some(p=>p.id===product.id)).toBe(true);
  const image=await call(cold,'store/products/'+product.id+'/image');expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');
  const identity=await cold.FulltechOfflineStore.get('identity');identity.verifiedAt-=86400001;await cold.FulltechOfflineStore.put('identity',identity);
  const expired=await page();expect((await call(expired,'store/products')).status).toBe(503);
});
it('guarda categoría y producto con imagen sin internet y sincroniza sus referencias sin duplicarlos',async()=>{
  const w=await page();await prepare(w);online=false;
  const category=await (await call(w,'store/categories',{name:'Accesorios'})).json();expect(category.category.id).toMatch(/^category_/);
  const created=await (await call(w,'store/products',{kind:'product',name:'Audífonos',sku:'AUDIO-1',price:'399.50',cost:'100',quantity:4,min_stock:1,image:IMAGE,category_id:category.category.id})).json();
  expect(created.product.price_cents).toBe(39950);expect((await w.FulltechOffline.listQueue()).length).toBe(2);
  const cold=await page();expect((await (await call(cold,'store/products')).json()).products.some(p=>p.sku==='AUDIO-1')).toBe(true);
  online=true;await cold.FulltechOffline.synchronize();await cold.FulltechOffline.synchronize();
  const result=await (await server('store/products')).json();expect(result.products.filter(p=>p.sku==='AUDIO-1')).toHaveLength(1);expect(result.products.find(p=>p.sku==='AUDIO-1').category).toBe('Accesorios');expect(await cold.FulltechOffline.listQueue()).toHaveLength(0);
});
it('cobra offline, mantiene el recibo provisional y descuenta stock una sola vez al reconectar',async()=>{
  const w=await page();await prepare(w);online=false;
  const body={requestId:crypto.randomUUID(),mode:'invoice',customerId:customer.id,items:[{variantId:product.id,quantity:2}],expectedTotal:20050,paymentMethod:'CASH'};
  const result=await (await call(w,'pos/checkout',body)).json();expect(result).toMatchObject({ok:true,pending:true,total_cents:20050});
  const stock=await (await call(w,'store/products')).json();expect(stock.products.find(p=>p.id===product.id).quantity).toBe(8);
  expect((await w.FulltechOfflineStore.entries()).some(([k])=>k.endsWith(result.receiptUrl))).toBe(true);
  online=true;await w.FulltechOffline.synchronize();await w.FulltechOffline.synchronize();
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  const actual=await (await server('store/products')).json();expect(actual.products.find(p=>p.id===product.id).quantity).toBe(8);
});
it('un rechazo de stock conserva la operación para revisión y detiene las dependientes',async()=>{
  const w=await page();await prepare(w);online=false;
  await call(w,'pos/checkout',{requestId:crypto.randomUUID(),mode:'invoice',customerId:customer.id,items:[{variantId:product.id,quantity:9}],expectedTotal:90225,paymentMethod:'CASH'});
  online=true;await server('store/products/'+product.id+'/stock',{type:'out',quantity:5,reason:'Otra caja',requestId:crypto.randomUUID()});
  await w.FulltechOffline.synchronize();const queue=await w.FulltechOffline.listQueue();expect(queue).toHaveLength(1);expect(queue[0].state).toBe('review');
});
it('inicia reparto sin red, conserva puntos antiguos y sincroniza la ruta y su cierre',async()=>{
  await server('users',{username:'offline-admin@example.test',password:'Offline-Test-12345',displayName:'Admin reparto',role:'ADMIN'});
  const user=(await (await server('users',{username:'offline-delivery@example.test',password:'Offline-Test-12345',displayName:'Repartidor',role:'DELIVERY'})).json()).user;
  const login=await server('auth/login',{username:'offline-admin@example.test',password:'Offline-Test-12345'});cookie=login.headers.get('set-cookie').split(';')[0];
  const created=await (await server('orders',{name:'Reparto local',phone:'8095550345',paymentMethod:'CASH',items:[{variantId:'capsules_10',quantity:1}],deliveryLocation:{latitude:18.61,longitude:-68.7,name:'Destino'}})).json();
  expect(created.item?.id).toBeTruthy();
  const w=await page();await prepare(w);await call(w,'delivery-tracking');online=false;
  const start=await (await call(w,'orders/'+created.item.id+'/delivery/start',{deliveryUserId:user.id})).json();
  expect(start.session?.status).toBe('ACTIVE');
  const timestamp=new Date(Date.now()-20*60_000).toISOString();
  const point=await (await call(w,'delivery-tracking/'+start.session.id+'/location',{lat:18.60,lng:-68.69,accuracy:8,timestamp})).json();
  expect(point.session.last_position.latitude).toBe(18.60);
  const stop=await (await call(w,'delivery-tracking/'+start.session.id+'/stop',{note:'Fin de recorrido'})).json();expect(stop.session.status).toBe('CANCELLED');
  const cold=await page();expect((await (await call(cold,'delivery-tracking')).json()).sessions[0].status).toBe('CANCELLED');
  online=true;await cold.FulltechOffline.synchronize();
  const pending=await cold.FulltechOffline.listQueue();if(pending.length)throw new Error(JSON.stringify(pending.map(p=>({path:p.path,error:p.error,state:p.state}))));
  expect(pending).toHaveLength(0);
  const actual=(await (await server('delivery-tracking')).json()).sessions.find(s=>s.order_id===created.item.id);
  expect(actual.status).toBe('CANCELLED');expect(actual.last_position.recorded_at).toBe(timestamp);expect(actual.last_position.stale).toBe(true);
},30000);
it('no encola mensajes, llamadas ni contraseñas y cerrar sesión bloquea el acceso a datos privados',async()=>{
  const w=await page();await prepare(w);online=false;
  for(const route of ['calling/calls','conversations/test/messages','users/me/password'])expect((await call(w,route,{text:'hola'})).status).toBe(503);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);await w.FulltechOffline.forget();
  expect((await call(w,'store/products')).status).toBe(503);const cold=await page();expect((await call(cold,'pos/customers')).status).toBe(503);
});
it('no confirma un guardado si el diario local no tiene espacio',async()=>{
  const w=await page();await prepare(w);online=false;
  const update=w.FulltechOfflineStore.update;w.FulltechOfflineStore.update=()=>Promise.reject(new Error('quota'));
  await expect(call(w,'store/categories',{name:'No guardada'})).rejects.toThrow('quota');
  w.FulltechOfflineStore.update=update;expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  expect((await (await call(w,'store/products')).json()).categories.some(c=>c.name==='No guardada')).toBe(false);
});
it('el bloqueo de almacenamiento no impide trabajar en línea ni confirma soporte offline',async()=>{
  const w=await page();Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('Blocked','SecurityError');}});
  expect((await call(w,'session')).status).toBe(200);expect((await call(w,'data')).status).toBe(200);
  expect(w.FulltechOffline.valid()).toBe(false);
  online=false;expect((await call(w,'store/products')).status).toBe(503);
});
it('mantiene varios tickets y convierte una cotización local en venta al reconectar',async()=>{
  const w=await page();await prepare(w);online=false;
  const draft={customerId:customer.id,customer,items:[{variantId:product.id,quantity:1}],discount:{}};
  const first=await (await call(w,'pos/tickets',{requestId:crypto.randomUUID(),name:'Mostrador A',draft})).json();
  await call(w,'pos/tickets',{requestId:crypto.randomUUID(),name:'Mostrador B',draft:{items:[]}});
  const quote=await (await call(w,'pos/quotes',{requestId:crypto.randomUUID(),mode:'quote',customerId:customer.id,items:draft.items,expectedTotal:10025})).json();
  expect((await (await call(w,'pos/tickets')).json()).tickets).toHaveLength(2);
  expect((await (await call(w,'pos/quotes/'+quote.quoteId)).json()).document.number).toMatch(/^COT-/);
  const converted=await (await call(w,'pos/tickets',{requestId:crypto.randomUUID(),quoteId:quote.quoteId})).json();
  expect(converted.ticket.draft.quoteId).toBe(quote.quoteId);
  expect(first.ticket.name).toBe('Mostrador A');online=true;await w.FulltechOffline.synchronize();
  const queue=await w.FulltechOffline.listQueue();expect(queue).toHaveLength(0);
  expect((await (await server('pos/tickets')).json()).tickets).toHaveLength(3);
});
it('prepara los módulos y navega por las pantallas principales sin red',async()=>{
  const w=await page(true);
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.EventSource=class{addEventListener(){}close(){}};
  for(const file of ['app.js','store.js','pos.js'])w.eval(readFileSync('public/admin/'+file,'utf8').replace(/^import[^\n]+\n/,''));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded',{bubbles:true}));
  const until=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw new Error('UI timeout');};
  await until(()=>!w.document.querySelector('#app').hidden);await w.FulltechOffline.warm();online=false;
  const visited=[];
  for(const tab of ['hoy','pedidos','clientes','catalogo','inventario','recuento','cotizaciones','reportes','cierre','historial-cierres','seguimientos','mensajes','ajustes','usuarios','perfil','whatsapp','delivery','mapa']){
    const button=w.document.querySelector(`[data-tab="${tab}"]`)||(tab==='historial-cierres'?w.document.querySelector('[data-close-history-go]'):null);expect(button,tab).toBeTruthy();
    button.click();await until(()=>w.document.body.dataset.tab===tab);
    const view=w.document.getElementById('view-'+tab);if(view)expect(view.hidden,tab).toBe(false);visited.push(tab);
  }
  expect(visited).toEqual(['hoy','pedidos','clientes','catalogo','inventario','recuento','cotizaciones','reportes','cierre','historial-cierres','seguimientos','mensajes','ajustes','usuarios','perfil','whatsapp','delivery','mapa']);
  const snapshot=JSON.parse(w.localStorage.getItem('pe_crm_snapshot'));expect(snapshot.auth).toBeTruthy();
  const report=await (await call(w,'reports/sales?period=custom&from=2020-01-01&to=2099-12-31')).json();expect(report.report.summary.orders).toBe(0);
},30000);

it('una copia del service worker nunca renueva las 24 horas como si fuera una sesión verificada',async()=>{
  const w=await page();await prepare(w);
  const identity=await w.FulltechOfflineStore.get('identity');identity.verifiedAt-=23*3600000;await w.FulltechOfflineStore.put('identity',identity);
  const cold=await page();cold.offlineTransport=async()=>new Response(JSON.stringify({ok:true,legacy:true,permissions:[]}),{headers:{'content-type':'application/json','x-fulltech-offline':'1'}});
  await call(cold,'session');expect((await cold.FulltechOffline.status()).expiresAt).toBe(identity.verifiedAt+86400000);
});

it('un resultado incierto no vuelve a ejecutar la operación en el servidor',async()=>{
  const key=crypto.randomUUID();let executions=0;
  const invoke=async()=>{
    const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{headers:{'x-fulltech-operation':key},method:'POST',url:'/api/admin/store/products'});
    let result;const res={writeHead(){},end(){}};
    await handleOfflineOperation({req,res,route:'/api/admin/store/products',ctx:app.ctx,actor:{id:'offline-admin',role:'ADMIN'},json:(_r,status,body)=>{result={status,body};},handle:async()=>{executions++;throw new Error('Connection lost after write');}});
    return result;
  };
  expect((await invoke()).body.error).toBe('offline_operation_uncertain');expect((await invoke()).status).toBe(409);expect(executions).toBe(1);
});
it('ajusta las cápsulas sin conexión y conserva el costo al sincronizar',async()=>{
  const w=await page();await prepare(w);await call(w,'inventory');online=false;
  const result=await (await call(w,'inventory/restock',{quantity:100,unitCost:'0.50',reason:'Entrada local'})).json();expect(result.inventory.stock).toBe(100);
  const products=await (await call(w,'store/products')).json();expect(products.products.find(p=>p.id==='capsules_5').quantity).toBe(20);
  online=true;await w.FulltechOffline.synchronize();expect((await (await server('inventory')).json()).stock).toBe(100);
});
it('abre la app completa en frío sin localStorage usando solo la descarga de IndexedDB',async()=>{
  const first=await page();await prepare(first);online=false;
  const w=await page(true);w.history.replaceState({},'', '/admin/?v=catalogo');
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.EventSource=class{addEventListener(){}close(){}};
  for(const file of ['app.js','store.js','pos.js'])w.eval(readFileSync('public/admin/'+file,'utf8').replace(/^import[^\n]+\n/,''));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded',{bubbles:true}));
  for(let i=0;i<150;i++){if(!w.document.querySelector('#app').hidden&&w.document.querySelector('[data-store-detail]'))break;await new Promise(r=>setTimeout(r,20));}
  expect(w.document.querySelector('#app').hidden).toBe(false);expect(w.document.querySelector('#store-catalogo').textContent).toContain('Cable USB');
  expect(w.document.body.dataset.tab).toBe('catalogo');
});
