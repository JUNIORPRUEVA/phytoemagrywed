// Isolated browser UAT. All geography, capacity and road routes below are fixtures.
import {startCrmServer} from '../server/crm-server.mjs';
import {createServer} from 'node:http';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'fulltech-smart-browser-'));
let app;const appOptions={port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'smart-browser-uat',quiet:true,schedulerEnabled:false,whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true,router:{configured:true,route:async()=>({ok:true,meters:10790,provider:'synthetic-uat',durationSeconds:900})},capacityProvider:async()=>({available:true,cashCollection:true})}};
const root=path.resolve('public'),out='docs/capturas/smart-commerce';await mkdir(out,{recursive:true});
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const upstream=await fetch(app.url+req.url,{method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host},redirect:'manual',...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.statusCode=upstream.status;for(const [k,v]of upstream.headers)if(!['set-cookie','transfer-encoding','content-encoding','content-length'].includes(k))res.setHeader(k,v);const cookies=upstream.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);res.end(Buffer.from(await upstream.arrayBuffer()));return;}
 const url=new URL(req.url,'http://local'),file=path.resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
app=await startCrmServer({...appOptions,allowedOrigin:base});
const browser=await chromium.launch(),results=[];
try{
 const admin=await browser.newContext();await admin.request.post(base+'/api/admin/login',{data:{token:'smart-browser-uat'}});
 const product=(await (await admin.request.post(base+'/api/admin/store/products',{data:{name:'Cámara Smart UAT',sku:'BROWSER-SMART-001',kind:'product',store:'fulltech',price:1000,cost:500,quantity:50,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC'}})).json()).product;
 assert.ok(product?.id);assert.equal((await admin.request.post(base+`/api/admin/store/products/${product.id}/publication`,{data:{status:'published'}})).status(),200);
 const cfg=(await (await admin.request.get(base+'/api/admin/store/commerce/config')).json()).config;
 const config={...cfg,expectedVersion:cfg.version,defaultOriginId:'origin_uat',cashOnDelivery:true,branches:[{id:'branch_uat',name:'Sucursal sintética UAT',active:true}],origins:[{id:'origin_uat',branchId:'branch_uat',city:'Ciudad UAT A',latitude:18.6,longitude:-68.7,active:true,delivery:true,pickup:true}],zones:[{id:'zone_uat',name:'Zona sintética UAT',active:true,originIds:['origin_uat'],polygon:[[-68.8,18.5],[-68.5,18.5],[-68.5,18.8],[-68.8,18.8],[-68.8,18.5]],hours:Array.from({length:7},(_,day)=>({day,startMinute:0,endMinute:1440}))}],offers:[{id:'offer_uat',productId:product.id,originId:'origin_uat',active:true,regionalPrices:[{zoneId:'zone_uat',priceCents:200000}]}],banks:[{id:'bank_uat',name:'Banco ficticio UAT',holder:'Solo pruebas',account:'NO-REAL-ACCOUNT',active:true}]};
 assert.equal((await admin.request.put(base+'/api/admin/store/commerce/config',{data:config})).status(),200);
 for(const [width,height] of [[320,568],[375,667],[390,844],[430,932],[768,1024],[1024,768],[1440,900]]){
  const context=await browser.newContext({viewport:{width,height},geolocation:{latitude:18.61,longitude:-68.71,accuracy:10},permissions:['geolocation'],serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  assert.equal((await context.request.post(base+'/api/store/account/register',{data:{name:'Cliente UAT',phone:`8095550${String(width).padStart(4,'0')}`,password:'Smart-Browser-123'}})).status(),201);
  await context.request.patch(base+'/api/store/account/me',{data:{onboarding:'skipped'}});
  await page.goto(base+'/store/',{waitUntil:'networkidle'});await page.evaluate(id=>localStorage.setItem('fulltech_cart_v1',JSON.stringify([{id,quantity:1}])),product.id);
  await page.goto(base+'/store/#/checkout',{waitUntil:'networkidle'});
  await page.locator('[data-smart-gps]').click();await page.locator('[data-smart-location]').filter({hasText:'Ubicación obtenida'}).waitFor();
  await page.locator('[name=address]').fill('Calle sintética UAT 123');await page.locator('[data-smart-confirm]').check();await page.locator('[data-smart-calculate]').click();await page.locator('[type=submit]').filter({hasText:'Enviar pedido'}).waitFor();
  assert.match(await page.locator('[data-smart-summary]').innerText(),/3,100/);assert.ok(await page.locator('.checkout-summary').isHidden());
  await page.locator('[data-smart-payment]').selectOption('transfer_now');await page.locator('[data-smart-bank]').filter({hasText:'NO-REAL-ACCOUNT'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/checkout-${width}.png`,fullPage:true,animations:'disabled'});
  const created=page.waitForResponse(r=>r.url().endsWith('/api/store/orders')&&r.request().method()==='POST');await page.locator('[type=submit]').click();await page.getByRole('heading',{name:'Recibimos tu pedido'}).waitFor();assert.equal((await (await created).json()).order.payment_status,'pending');
  const orders=(await (await context.request.get(base+'/api/store/account/orders')).json()).orders;assert.equal(orders.length,1);assert.equal(orders[0].total,3100);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('fulltech_cart_v1'))),[]);
  await page.evaluate(id=>localStorage.setItem('fulltech_cart_v1',JSON.stringify([{id,quantity:1}])),product.id);
  await page.reload({waitUntil:'networkidle'});await page.locator('[data-smart-gps]').waitFor();
  await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=(_ok,error)=>error({code:1});});await page.locator('[data-smart-gps]').click();await page.locator('[data-smart-location]').filter({hasText:'No se pudo obtener'}).waitFor();
  await page.locator('[name=address]').fill('Otra ciudad sintética UAT');await page.locator('[data-smart-confirm]').check();await page.locator('[data-smart-calculate]').click();await page.locator('[type=submit]').filter({hasText:'Solicitar cotización'}).waitFor();await page.locator('[type=submit]').click();await page.locator('[data-smart-summary]').filter({hasText:'Solicitud de cotización registrada'}).waitFor();
  assert.equal((await (await context.request.get(base+'/api/store/account/orders')).json()).orders.length,1);assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem('fulltech_cart_v1')))).length,1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/manual-${width}.png`,fullPage:true,animations:'disabled'});assert.deepEqual(errors,[]);results.push({width,height,regionalTotal:3100,paymentPending:true,manualRequest:true,cartPreserved:true,horizontalOverflow:false,pageErrors:errors});await context.close();
 }
 const page=await admin.newPage();page.on('pageerror',e=>console.log('OPERATOR PAGE ERROR',e.message));page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/operations/'))console.log('OPERATOR API ERROR',r.status(),await r.text());});await page.setViewportSize({width:390,height:844});await page.goto(base+'/admin/smart-commerce.html',{waitUntil:'networkidle'});await page.screenshot({path:`${out}/admin-390.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal((await admin.request.put(base+'/api/admin/store/commerce/operations/stock',{data:{originId:'origin_uat',productId:product.id,quantity:10,expectedVersion:0,source:'local_count'}})).status(),200);
 for(const [width,height]of [[320,568],[390,844],[1024,768]]){
  const c=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  assert.equal((await c.request.post(base+'/api/store/account/register',{data:{name:'Cliente retiro UAT',phone:`8095558${String(width).padStart(4,'0')}`,password:'Smart-Pickup-123'}})).status(),201);await c.request.patch(base+'/api/store/account/me',{data:{onboarding:'skipped'}});
  await p.goto(base+'/store/',{waitUntil:'networkidle'});await p.evaluate(id=>localStorage.setItem('fulltech_cart_v1',JSON.stringify([{id,quantity:1}])),product.id);await p.goto(base+'/store/#/checkout',{waitUntil:'networkidle'});
  await p.locator('[name=fulfillment][value=pickup]').check();await p.locator('[data-smart-confirm]').check();await p.locator('[data-smart-calculate]').click();await p.locator('[type=submit]').filter({hasText:'Enviar pedido'}).click();await p.getByRole('heading',{name:'Recibimos tu pedido'}).waitFor();
  const r=(await (await c.request.get(base+'/api/store/account/commerce/fulfillments')).json()).requests[0];assert.ok(r?.id);
  await page.goto(base+'/admin/fulfillment.html',{waitUntil:'networkidle'});const article=page.locator(`[data-request="${r.id}"]`);for(const [name,state] of [['Aceptar','accepted'],['Preparar','preparing'],['Marcar listo','ready']]){await article.getByRole('button',{name,exact:true}).click();await article.getByText(state,{exact:true}).waitFor().catch(async e=>{console.log('OPERATOR STATUS',await page.locator('#status').innerText());await page.screenshot({path:`${out}/operator-failure.png`,fullPage:true});throw e;});}
  await p.goto(base+'/store/#/orders',{waitUntil:'networkidle'});await p.getByRole('button',{name:'Mostrar código de retiro'}).click();await p.getByText('El pago debe estar verificado antes de autorizar retiro.',{exact:true}).waitFor();
  const payment=await admin.request.post(base+`/api/admin/orders/${r.order_id}/payments`,{data:{amount:1000,expectedDue:1000,method:'TRANSFER',idempotencyKey:'browser-pickup-payment-'+width,note:'Simulación UAT sin operación bancaria'}});assert.equal(payment.status(),200);
  await p.getByRole('button',{name:'Mostrar código de retiro'}).click();const code=await p.locator('.ft-pickup-code').innerText();assert.equal(code.length,32);assert.equal(await p.locator('[data-pickup-status]').innerText(),'');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.evaluate(()=>scrollTo(0,0));await p.screenshot({path:`${out}/pickup-customer-${width}.png`,fullPage:true,animations:'disabled'});
  await page.setViewportSize({width,height});await article.locator('[name=code]').fill(code);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${out}/pickup-operator-${width}.png`,fullPage:true});await article.getByRole('button',{name:'Validar código y entregar'}).click();await article.getByText('handed_over',{exact:true}).waitFor();
  await p.getByRole('button',{name:'Actualizar estado',exact:true}).click();await p.locator('[data-pickups] strong').getByText('Entregado',{exact:true}).waitFor();assert.equal(await p.locator('[data-code]').count(),0);assert.deepEqual(errors,[]);results.push({width,height,pickup:true,unpaidBlocked:true,singleUse:true,crmIntegrated:true,pageErrors:errors,horizontalOverflow:false});await c.close();
 }
 await admin.close();
 await writeFile(`${out}/results.json`,JSON.stringify({fixtureOnly:true,externalProviders:false,results},null,2));console.log(JSON.stringify({results,database:dir}));
}finally{await browser.close();await new Promise(r=>server.close(r));await app.close();}
