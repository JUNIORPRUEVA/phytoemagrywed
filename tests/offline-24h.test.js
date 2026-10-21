import {receiptPdfBytes} from '../public/admin/receipt-pdf.js';
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
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
async function server(route,body,key){return fetch(app.url+'/api/admin/'+route,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json',...(key?{'x-fulltech-operation':key}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function page(full=false){
  const dom=new JSDOM(full?readFileSync('public/admin/index.html','utf8'):'<html><body></body></html>',{url:app.url+'/admin/',runScripts:'outside-only',pretendToBeVisual:true});doms.push(dom);
  const w=dom.window;Object.defineProperty(w.navigator,'onLine',{get:()=>online});
  Object.assign(w,{indexedDB:idb,structuredClone,Response,Headers,Request,AbortController,Blob,TextDecoder,calculateSale,offlineReport,receiptPdfBytes});
  w.fetch=async(url,options={})=>{if(w.offlineTransport)return w.offlineTransport(url,options);if(!online)throw new TypeError('network down');return fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}});};
  w.eval(readFileSync('public/admin/offline-storage.js','utf8'));
  w.eval(readFileSync('public/admin/offline.js','utf8').replace("await import('./pos-math.js')",'({calculateSale:window.calculateSale})').replace("await import('./offline-report.js')",'({offlineReport:window.offlineReport})').replace("await import('./receipt-pdf.js')",'({receiptPdfBytes:window.receiptPdfBytes})'));
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
it('requiere conexión para galería y publicación sin encolar ni afirmar cambios locales',async()=>{
  const w=await page();await prepare(w);online=false;
  const before=(await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id);
  for(const [route,body] of [['store/products/'+product.id,{...before,images:[]}],['store/products/'+product.id+'/publication',{status:'published'}]]){
    const result=await call(w,route,body);expect(result.status).toBe(503);expect((await result.json()).message).toContain('necesitan conexión');
  }
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  expect((await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id).image_url).toBe(before.image_url);
});
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
  expect(result.receiptUrl).toMatch(/^\/admin\/receipt-viewer\.html\?pdf=/);
  expect((await w.FulltechOfflineStore.validProjection((await w.FulltechOfflineStore.get('identity')).key)).records.some(([url])=>url.endsWith(result.pdfUrl))).toBe(true);
  const cold=await page(),pdfResponse=await cold.fetch(result.pdfUrl);
  expect(pdfResponse.headers.get('content-type')).toBe('application/pdf');
  const bytes=new Uint8Array(await pdfResponse.arrayBuffer());expect(new TextDecoder().decode(bytes.slice(0,8))).toBe('%PDF-1.4');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:bytes,useSystemFonts:false,standardFontDataUrl:process.cwd()+'/node_modules/pdfjs-dist/standard_fonts/'});
  const pdf=await task.promise,content=await(await pdf.getPage(1)).getTextContent();
  expect(content.items.map(i=>i.str).join(' ')).toContain('Cliente local');expect(content.items.map(i=>i.str).join(' ')).toContain('Cable USB');await task.destroy();
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
  for(const route of ['calling/calls','conversations/test/messages','users/me/password','ai/reply-suggestion'])expect((await call(w,route,{text:'hola'})).status).toBe(503);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);await w.FulltechOffline.forget();
  expect((await call(w,'store/products')).status).toBe(503);const cold=await page();expect((await call(cold,'pos/customers')).status).toBe(503);
});
it('una sugerencia IA requiere red y nunca se mete en la cola de sincronización',async()=>{
  const w=await page();await prepare(w);const owner=(await w.FulltechOfflineStore.get('identity')).key;
  const pending={id:'pending-conversation',path:'/api/admin/conversations',method:'POST',body:{},localId:'local_chat_pending',at:Date.now(),state:'pending',local:{body:'{}',status:200,headers:[]}};
  await w.FulltechOfflineStore.put('queue:'+owner,[pending]);
  let calls=0;w.offlineTransport=async()=>{calls+=1;return new Response('{"ok":true,"text":"respuesta de prueba"}',{status:200,headers:{'content-type':'application/json'}});};
  const response=await call(w,'ai/reply-suggestion',{conversationId:pending.localId});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,text:'respuesta de prueba'});expect(calls).toBe(1);
  expect(await w.FulltechOffline.listQueue()).toEqual([pending]);
  online=false;expect((await call(w,'ai/reply-suggestion',{conversationId:'cnv_online_only'})).status).toBe(503);
  expect(await w.FulltechOffline.listQueue()).toEqual([pending]);
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
it('muestra los cambios de ambas colas en el menú sin tapar la pantalla con avisos',async()=>{
  const w=await page();await prepare(w);online=false;
  await call(w,'store/categories',{name:'Categoría pendiente'});
  w.localStorage.setItem('pe_crm_outbox',JSON.stringify([{kind:'followup-create',label:'Seguimiento pendiente'}]));
  w.document.body.innerHTML='<footer class="drawer__foot"></footer><div id="update-bar">Actualizar</div>';
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(readFileSync('public/admin/offline-ui.js','utf8'));w.dispatchEvent(new w.Event('DOMContentLoaded'));
  for(let i=0;i<100&&!w.document.querySelector('.drawer__offline')?.textContent.includes('2');i++)await new Promise(r=>setTimeout(r,10));
  w.document.querySelector('.drawer__offline').click();
  for(let i=0;i<100&&!w.document.querySelector('.offline-dialog')?.open;i++)await new Promise(r=>setTimeout(r,10));
  const dialog=w.document.querySelector('.offline-dialog');expect(dialog.textContent).toContain('2 cambios pendientes');
  expect(dialog.textContent).toContain('Categoría pendiente');expect(dialog.textContent).toContain('Seguimiento pendiente');
  // La barra de actualizar NO se mete dentro del menú (empezaría oculta).
  expect(w.document.querySelector('#update-bar')).toBeTruthy();
  expect(w.document.querySelector('.drawer__foot #update-bar')).toBeNull();
});
it('los rechazos históricos no se presentan como sincronización pendiente y siguen recuperables',async()=>{
  const w=await page();await prepare(w);const owner=(await w.FulltechOfflineStore.get('identity')).key;
  const historical={id:'android-old-404',state:'review',historical:true,status:404,path:'/api/admin/old-route',method:'POST',body:{original:'preservar'},at:123,error:'HTTP 404'};
  await w.FulltechOfflineStore.put('queue:'+owner,[historical]);
  w.document.body.innerHTML='<footer class="drawer__foot"><button id="drawer-offline"></button></footer>';
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.eval(readFileSync('public/admin/offline-ui.js','utf8'));w.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r=>setTimeout(r,30));
  expect(w.document.querySelector('.drawer__offline').hidden).toBe(true);
  w.document.querySelector('#drawer-offline').click();
  await new Promise(r=>setTimeout(r,30));
  expect(w.document.querySelector('.offline-dialog').textContent).toContain('HTTP 404');
  expect(await w.FulltechOffline.listQueue()).toEqual([historical]);
  expect((await w.FulltechOffline.exportRecovery()).operaciones).toEqual([historical]);
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
it('si se pierde la respuesta después del guardado, reenvía la misma clave sin duplicar el artículo',async()=>{
  const w=await page();await prepare(w);let lost=true;
  w.offlineTransport=async(url,options)=>{
    const response=await fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}});
    if(lost&&options.method==='POST'){lost=false;online=false;throw new TypeError('Response lost');}
    return response;
  };
  const created=await (await call(w,'store/products',{kind:'service',name:'Guardado antes del corte',sku:'LOST-1',price:'150',cost:'20'})).json();
  expect(created.pending).toBe(true);expect(await w.FulltechOffline.listQueue()).toHaveLength(1);
  online=true;await w.FulltechOffline.synchronize();
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  const actual=await (await server('store/products')).json();expect(actual.products.filter(p=>p.sku==='LOST-1')).toHaveLength(1);
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


it('un cambio que el móvil cree sin red se envía igual si el servidor responde',async()=>{
  /*
   * CAUSA REAL DE «TENGO QUE SALIR A SINCRONIZAR».
   *
   * `navigator.onLine` se equivoca (VPN, wifi cautivo, app reanudada). El envío
   * de la cola del panel lo comprobaba ANTES de intentar nada y se rendía: el
   * cambio quedaba en el aparato y el reintento automático volvía a rendirse.
   * Quien decide es el servidor.
   */
  const w=await page();await prepare(w);
  online=false; // el navegador dice «sin conexión»…
  w.offlineTransport=(url,options={})=>fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}}); // …pero la red funciona
  const response=await w.fetch('/api/admin/store/categories',{method:'POST',headers:{'content-type':'application/json','x-fulltech-legacy-outbox':'1'},body:JSON.stringify({name:'Sin aviso de red'})});
  expect(response.status).toBe(201);
  const list=await (await server('store/categories')).json();
  expect(list.categories.some(c=>c.name==='Sin aviso de red')).toBe(true);
});
it('una cola del panel atascada no bloquea las operaciones nuevas',async()=>{
  /*
   * LAS DOS COLAS SON INDEPENDIENTES.
   *
   * Antes, si la cola del panel devolvía un rechazo, `synchronize()` terminaba
   * sin enviar NADA del diario de operaciones: un cambio viejo bloqueaba para
   * siempre todo lo nuevo.
   */
  const w=await page();await prepare(w);
  w.localStorage.setItem('pe_crm_outbox',JSON.stringify([{kind:'desconocido',key:'POST /api/admin/no-existe',label:'Cambio viejo',method:'POST',path:'/api/admin/no-existe',body:{},at:Date.now(),tries:0}]));
  online=false;
  await call(w,'store/categories',{name:'Nueva con cola vieja'});
  expect((await w.FulltechOffline.listQueue()).length).toBe(1);
  online=true;
  await w.FulltechOffline.synchronize();
  const list=await (await server('store/categories')).json();
  expect(list.categories.some(c=>c.name==='Nueva con cola vieja')).toBe(true);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
});
it('la cola sigue visible y enviable cuando la copia local de 24 h caducó',async()=>{
  /*
   * CADUCAR NO ES PERDER.
   *
   * `listQueue()` devolvía [] si la autorización local tenía más de 24 h: los
   * cambios seguían en el aparato pero el panel no los veía ni los enviaba.
   */
  const w=await page();await prepare(w);online=false;
  await call(w,'store/categories',{name:'Guardada antes de caducar'});
  const identity=await w.FulltechOfflineStore.get('identity');identity.verifiedAt-=86400001;await w.FulltechOfflineStore.put('identity',identity);
  expect((await w.FulltechOffline.listQueue()).length).toBe(1);
  online=true;
  await w.FulltechOffline.synchronize();
  const list=await (await server('store/categories')).json();
  expect(list.categories.some(c=>c.name==='Guardada antes de caducar')).toBe(true);
});
it('una marca de leído no se guarda como cambio pendiente',async()=>{
  /*
   * EL CAMBIO FANTASMA.
   *
   * Abrir un chat manda `POST /conversations/:id/read`. Sin red, eso se guardaba
   * en la cola y el panel mostraba para siempre «1 cambio pendiente de
   * sincronizar» que ya no significaba nada. No es trabajo de nadie: si no sale,
   * se descarta.
   */
  const w=await page();await prepare(w);online=false;
  const response=await w.fetch('/api/admin/conversations/cnv_prueba/read',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  expect(response.ok).toBe(true);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  expect(JSON.parse(w.localStorage.getItem('pe_crm_outbox')||'[]')).toHaveLength(0);
});
it('una marca de leído vieja guardada en la cola se descarta al sincronizar',async()=>{
  const w=await page();await prepare(w);
  const owner=(await w.FulltechOfflineStore.get('identity')).key;
  await w.FulltechOfflineStore.put('queue:'+owner,[{id:'vieja',path:'/api/admin/conversations/cnv_prueba/read',method:'POST',body:{},localId:'local_vieja',at:Date.now()-90000000,state:'pending',local:{body:'{}',status:200,headers:[]}}]);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(1);
  await w.FulltechOffline.synchronize();
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
});
it('el motor envía solo: nadie tiene que pulsar «Sincronizar»',async()=>{
  /*
   * EL COMPORTAMIENTO QUE SE PEDÍA: COMO UN MENSAJE DE WHATSAPP.
   *
   * Se guarda un cambio sin red y se recupera la red. Sin llamar a
   * `synchronize()` desde la prueba, sin pulsar nada y sin tocar la app: el
   * motor lo envía por su cuenta.
   */
  const w=await page();await prepare(w);online=false;
  w.eval(readFileSync('public/admin/sync-engine.js','utf8'));
  await call(w,'store/categories',{name:'Auto sin botón'});
  expect((await w.FulltechOffline.listQueue()).length).toBe(1);
  w.FulltechSync.configure({
    pending:()=>w.FulltechOffline.pendientes(),
    flush:async()=>{const r=await w.FulltechOffline.synchronize();return {...r};},
  });
  online=true; // vuelve la red: el motor se despierta por sí mismo
  w.dispatchEvent(new w.Event('online'));
  await new Promise(r=>setTimeout(r,2500));
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  const list=await (await server('store/categories')).json();
  expect(list.categories.some(c=>c.name==='Auto sin botón')).toBe(true);
});
it('Cloud First: pendientes y rechazos no ocultan datos nuevos ni bloquean escrituras independientes',async()=>{
  const w=await page();await prepare(w);online=false;
  await call(w,'store/categories',{name:'Pendiente local'});
  /*
   * AHORA LOS CAMBIOS SE ENVÍAN SOLOS.
   *
   * Con la sincronización automática, un pendiente desaparece en cuanto hay red;
   * para seguir probando el escenario de «rechazo en la cola» se marca como
   * revisión ANTES de volver a estar en línea (los rechazos no se reenvían solos).
   */
  const key='queue:'+(await w.FulltechOfflineStore.get('identity')).key;
  await w.FulltechOfflineStore.update(key,q=>q.map(p=>({...p,state:'review'})));
  online=true;
  await server('store/products/'+product.id+'/stock',{type:'in',quantity:3,reason:'Cambio remoto',requestId:crypto.randomUUID()});
  const response=await call(w,'store/products');
  expect(response.headers.get('x-fulltech-offline')).toBeNull();
  expect((await response.json()).products.find(p=>p.id===product.id).quantity).toBe(13);
  const write=await (await call(w,'store/categories',{name:'Directa nube'})).json();
  expect(write.pending).not.toBe(true);
  expect((await w.FulltechOffline.listQueue()).length).toBe(1);
  online=false;
  expect((await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id).quantity).toBe(13);
});
it('Cloud First: navigator.onLine false no impide consultar un backend accesible',async()=>{
  const w=await page();await prepare(w);online=false;
  w.offlineTransport=(url,options)=>fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}});
  const r=await call(w,'store/categories',{name:'Red real'});
  expect((await r.json()).pending).not.toBe(true);expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
});
it('404 y 422 no se convierten en desconexión ni en éxito local',async()=>{
  const w=await page();await prepare(w);
  for(const code of [404,422]){
    w.offlineTransport=async()=>new Response(JSON.stringify({ok:false,error:'not_found'}),{status:code});
    expect((await call(w,'store/products')).status).toBe(code);
    expect((await call(w,'store/categories',{name:'No guardar'})).status).toBe(code);
  }
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
});
it('consulta el estado de una respuesta larga sin truncar el JSON',async()=>{
  const id=crypto.randomUUID();await server('store/categories',{name:'Respuesta registrada'},id);
  const result=await (await server('offline-operations/status',{ids:[id]})).json();
  expect(result.estados[0]).toMatchObject({estado:'completada',aplicada:true,http:201});
});
it('una resolución rechazada conserva la operación en revisión',async()=>{
  const w=await page();await prepare(w);online=false;await call(w,'store/categories',{name:'Conservar'});
  const key='queue:'+(await w.FulltechOfflineStore.get('identity')).key;
  await w.FulltechOfflineStore.update(key,q=>q.map(p=>({...p,state:'review'})));
  const entry=(await w.FulltechOffline.listQueue())[0];
  w.offlineTransport=async()=>new Response('{}',{status:403});
  await expect(w.FulltechOffline.resolver(entry.id,'No autorizada')).rejects.toThrow('no confirmó');
  expect((await w.FulltechOffline.listQueue())[0].state).toBe('review');
});
it('la migración transaccional conserva el original y no resucita operaciones confirmadas',async()=>{
  const w=await page();await prepare(w);const store=w.FulltechOfflineStore;
  const owner=(await store.get('identity')).key,target='queue:'+owner,source='queue:'+JSON.stringify([...JSON.parse(owner),[]]);
  const entry={id:crypto.randomUUID(),state:'pending',body:{name:'Legado'},path:'/api/admin/store/categories',method:'POST'};
  await store.put(source,[entry]);await store.adoptQueue(source,target);
  expect(await store.get(target)).toEqual([entry]);expect(await store.get(source)).toEqual([entry]);
  await store.put(target,[]);await store.adoptQueue(source,target);
  expect(await store.get(target)).toEqual([]);expect((await store.get('migration-backup:'+source)).operaciones).toEqual([entry]);
});
it('una copia dañada se respalda y reemplaza desde la nube sin tocar la cola',async()=>{
  const w=await page();await prepare(w);const store=w.FulltechOfflineStore,owner=(await store.get('identity')).key;
  const key='response:'+owner+':'+app.url+'/api/admin/store/products';
  await store.put(key,{owner,body:'dañado'});await call(w,'store/products');
  expect((await store.get('repair-backup:'+key)).original.body).toBe('dañado');
  expect((await store.get('repair:'+key)).state).toBe('replaced-from-server');
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
});
it('una sesión revocada impide enviar la cola y conserva sus datos',async()=>{
  const w=await page();await prepare(w);online=false;await call(w,'store/categories',{name:'No enviar'});
  const owner=(await w.FulltechOfflineStore.get('identity')).key;let writes=0;
  w.offlineTransport=async(url,opts)=>{if(opts.method==='POST')writes++;return new Response('{}',{status:401});};
  online=true;await w.FulltechOffline.synchronize();
  expect(writes).toBe(0);expect(w.FulltechOffline.valid()).toBe(false);
  expect(await w.FulltechOfflineStore.get('queue:'+owner)).toHaveLength(1);
});

it('un rechazo no bloquea una operación independiente y no se reintenta infinitamente',async()=>{
  const w=await page();await prepare(w);online=false;
  await call(w,'store/categories',{name:'Primera'});await call(w,'store/categories',{name:'Segunda'});
  const owner=(await w.FulltechOfflineStore.get('identity')).key;
  await w.FulltechOfflineStore.update('queue:'+owner,q=>q.map((p,i)=>i===0?{...p,path:'/api/admin/ruta-antigua'}:p));
  online=true;await w.FulltechOffline.synchronize();
  const remaining=await w.FulltechOffline.listQueue();expect(remaining).toHaveLength(1);expect(remaining[0].state).toBe('review');
  expect((await (await server('store/products')).json()).categories.some(c=>c.name==='Segunda')).toBe(true);
  await w.FulltechOffline.synchronize();expect((await w.FulltechOffline.listQueue())[0].attempts).toBe(1);
});
it('si falla el respaldo se anota pero no se detiene el envío',async()=>{
  /*
   * EL RESPALDO PROTEGE, NO BLOQUEA.
   *
   * Antes, un respaldo fallido (cuota llena) detenía TODOS los envíos en silencio:
   * el panel decía «pendiente» para siempre y parecía que había que pulsar
   * «Sincronizar». La operación solo se borra cuando el SERVIDOR confirma y lleva
   * su clave de idempotencia, así que enviarla sin respaldo no pierde nada.
   */
  const w=await page();await prepare(w);online=false;await call(w,'store/categories',{name:'Conservar respaldo'});
  const backup=w.FulltechOfflineStore.backupQueue;w.FulltechOfflineStore.backupQueue=()=>Promise.reject(new Error('quota respaldo'));
  online=true;
  await w.FulltechOffline.synchronize();
  expect((await (await server('store/products')).json()).categories.some(c=>c.name==='Conservar respaldo')).toBe(true);
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  expect(w.FulltechOffline.diagnostics().some(d=>d.path==='/offline/respaldo')).toBe(true);
  w.FulltechOfflineStore.backupQueue=backup;
});
it('una respuesta 200 inválida no confirma ni elimina una operación',async()=>{
  const w=await page();await prepare(w);online=false;await call(w,'store/categories',{name:'Sin evidencia'});
  online=true;w.offlineTransport=async(url,options)=>String(url).endsWith('/store/categories')?new Response('<html>Error proxy</html>'):fetch(new URL(url,app.url),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),cookie}});
  await w.FulltechOffline.synchronize();expect((await w.FulltechOffline.listQueue())[0].state).toBe('review');
});

it('dos sesiones SSE reciben el pedido confirmado en el backend',async()=>{
  const login=await server('login',{token:'offline-test-token'}),secondCookie=login.headers.get('set-cookie').split(';')[0];
  const controllers=[new AbortController(),new AbortController()];
  const timer=setTimeout(()=>controllers.forEach(c=>c.abort()),4000);
  try{
    const responses=await Promise.all([cookie,secondCookie].map((session,i)=>fetch(app.url+'/api/admin/events?device=uat-'+i,{headers:{cookie:session},signal:controllers[i].signal})));
    const readers=responses.map(r=>r.body.getReader());
    await Promise.all(readers.map(r=>r.read()));
    const result=await (await server('orders',{name:'Pedido SSE',phone:'8095550311',paymentMethod:'CASH',items:[{variantId:'capsules_10',quantity:1}]})).json();
    expect(result.ok).toBe(true);
    const events=await Promise.all(readers.map(async reader=>{
      let text='';while(!text.includes('order.created')){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}return text;
    }));
    for(const event of events)expect(event).toContain('order.created');
  }finally{clearTimeout(timer);controllers.forEach(c=>c.abort());}
});

it('reconstruye stock pendiente sobre nube nueva, sin duplicar proyecciones ni contaminar confirmados',async()=>{
  const w=await page();await prepare(w);online=false;
  await call(w,'pos/checkout',{requestId:crypto.randomUUID(),mode:'invoice',customerId:customer.id,items:[{variantId:product.id,quantity:2}],expectedTotal:20050,paymentMethod:'CASH'});
  const owner=(await w.FulltechOfflineStore.get('identity')).key;
  const cloud=await w.FulltechOfflineStore.get('response:'+owner+':'+app.url+'/api/admin/store/products');
  expect(JSON.parse(new TextDecoder().decode(cloud.body)).products.find(p=>p.id===product.id).quantity).toBe(10);
  online=true;await server('store/products/'+product.id+'/stock',{type:'in',quantity:3,reason:'Otro terminal',requestId:crypto.randomUUID()});
  expect((await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id).quantity).toBe(13);
  online=false;
  for(let i=0;i<3;i++)expect((await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id).quantity).toBe(11);
  await w.FulltechOfflineStore.update('queue:'+owner,q=>q.map(p=>({...p,state:'review'})));
  expect((await (await call(w,'store/products')).json()).products.find(p=>p.id===product.id).quantity).toBe(13);
});
it('aísla rechazos históricos sin borrar payloads ni bloquear lecturas y escrituras nuevas',async()=>{
  const w=await page();await prepare(w);const owner=(await w.FulltechOfflineStore.get('identity')).key;
  const old=[404,404,422].map((status,i)=>({id:crypto.randomUUID(),state:'review',status,path:'/api/admin/ruta-antigua',method:'POST',body:{original:i},error:i===2?'invalid_dismissals':'HTTP 404 not_found',at:123+i}));
  await w.FulltechOfflineStore.put('queue:'+owner,old);await call(w,'session');
  expect((await w.FulltechOffline.listQueue()).every(p=>p.historical&&p.state==='review')).toBe(true);
  await call(w,'store/categories',{name:'Operación nueva'});await w.FulltechOffline.synchronize();
  const recovery=await w.FulltechOffline.exportRecovery();expect(recovery.operaciones.map(p=>p.body)).toEqual(old.map(p=>p.body));
  expect(recovery.original.operaciones).toEqual(old);
  expect((await (await server('store/products')).json()).categories.some(c=>c.name==='Operación nueva')).toBe(true);
});
it('un recuento antiguo no sobrescribe stock confirmado más reciente',async()=>{
  const w=await page();await prepare(w);await server('inventory/restock',{quantity:100,unitCost:'10',reason:'Inicial',idempotencyKey:crypto.randomUUID()});await call(w,'inventory');
  online=false;await call(w,'inventory/count',{countedQuantity:95,reason:'Recuento local',idempotencyKey:crypto.randomUUID()});
  online=true;await server('inventory/adjust',{direction:'in',quantity:10,reason:'Entrada remota',idempotencyKey:crypto.randomUUID()});
  await w.FulltechOffline.synchronize();
  expect((await w.FulltechOffline.listQueue())[0].state).toBe('review');
  expect((await (await server('inventory')).json()).stock).toBe(110);
});
async function paymentOrder(){
  const r=await (await server('orders',{name:'Pago Cloud First',phone:'8095550332',paymentMethod:'CASH',items:[{variantId:'capsules_10',quantity:1}]})).json();return r.item.id;
}
it('cobros concurrentes no pierden entradas ni superan el saldo y una copia vieja no borra el pago',async()=>{
  const id=await paymentOrder(),old=await (await server('orders/'+id)).json();
  const results=await Promise.all([100,150].map(amount=>server('orders/'+id+'/payments',{amount,method:'CASH',idempotencyKey:crypto.randomUUID()})));
  expect(results.every(r=>r.ok)).toBe(true);
  const after=await (await server('orders/'+id)).json();expect(after.order.payment.entries).toHaveLength(2);
  expect(after.order.payment.received_total).toBe(250);
  await app.ctx.store.update(id,{orderJson:JSON.stringify(old.order)});
  expect((await (await server('orders/'+id)).json()).order.payment.received_total).toBe(250);
  const racing=await Promise.all([1,2].map(()=>server('orders/'+id+'/payments',{amount:2000,method:'CASH',idempotencyKey:crypto.randomUUID()})));
  expect(racing.filter(r=>r.ok)).toHaveLength(1);
  expect((await (await server('orders/'+id)).json()).order.payment.received_total).toBe(2250);
});
it('un cobro offline reserva el saldo pero no declara dinero confirmado; conflicto remoto queda en revisión',async()=>{
  const id=await paymentOrder(),w=await page();await prepare(w);await call(w,'orders/'+id);online=false;
  const local=await (await call(w,'orders/'+id+'/payments',{amount:100,method:'CASH',idempotencyKey:crypto.randomUUID()})).json();
  expect(local.pending).toBe(true);expect(local.order.payment?.entries||[]).toHaveLength(0);expect(local.order.pendingFinancial).toHaveLength(1);
  online=true;await server('orders/'+id+'/payments',{amount:200,method:'CASH',idempotencyKey:crypto.randomUUID()});
  await w.FulltechOffline.synchronize();expect((await w.FulltechOffline.listQueue())[0].state).toBe('review');
  expect((await (await server('orders/'+id)).json()).order.payment.received_total).toBe(200);
});
it('dos cobros offline consecutivos mantienen sus precondiciones y se confirman una sola vez',async()=>{
  const id=await paymentOrder(),w=await page();await prepare(w);await call(w,'orders/'+id);online=false;
  for(const amount of [100,150])expect((await (await call(w,'orders/'+id+'/payments',{amount,method:'CASH',idempotencyKey:crypto.randomUUID()})).json()).pending).toBe(true);
  online=true;await w.FulltechOffline.synchronize();await w.FulltechOffline.synchronize();
  expect(await w.FulltechOffline.listQueue()).toHaveLength(0);
  const result=await (await server('orders/'+id)).json();expect(result.order.payment.received_total).toBe(250);expect(result.order.payment.entries).toHaveLength(2);
});
it('un cambio de permisos en otra pestaña invalida la copia privada anterior',async()=>{
  const w=await page();await prepare(w);const auth=await w.FulltechOfflineStore.get('identity');
  await w.FulltechOfflineStore.put('identity',{...auth,permissions:['permission-revoked'],legacyCacheDisabled:true});online=false;
  expect((await call(w,'store/products')).status).toBe(503);
});
it('la migración puede adoptar entradas nuevas sin resucitar las ya procesadas',async()=>{
  const w=await page();await prepare(w);const store=w.FulltechOfflineStore,owner=(await store.get('identity')).key;
  const target='queue:'+owner,source='queue:'+JSON.stringify([...JSON.parse(owner),['old']]);
  const first={id:crypto.randomUUID(),state:'pending'},second={id:crypto.randomUUID(),state:'pending'};
  await store.put(source,[first]);await store.adoptQueue(source,target);await store.put(target,[]);
  await store.put(source,[first,second]);await store.adoptQueue(source,target);
  expect(await store.get(target)).toEqual([second]);expect((await store.get('migration-backup:'+source)).operaciones).toEqual([first]);
});
