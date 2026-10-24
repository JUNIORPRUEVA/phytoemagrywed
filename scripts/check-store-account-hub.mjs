// Local-only browser QA: own SQLite, no external requests, no real providers.
import {startCrmServer} from '../server/crm-server.mjs';
import {createServer} from 'node:http';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'fulltech-header-uat-')),root=path.resolve('public'),out='docs/capturas/account-hub';
await mkdir(out,{recursive:true});let app,browser;
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const r=await fetch(app.url+req.url,{method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host},redirect:'manual',...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.statusCode=r.status;for(const[k,v]of r.headers)if(!['set-cookie','transfer-encoding','content-encoding','content-length'].includes(k))res.setHeader(k,v);for(const cookie of r.headers.getSetCookie())res.appendHeader('set-cookie',cookie);res.end(Buffer.from(await r.arrayBuffer()));return;}
 const url=new URL(req.url,'http://local'),file=path.resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 app=await startCrmServer({host:'127.0.0.1',port:0,databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'header-local-only',allowedOrigin:base,quiet:true,schedulerEnabled:false,whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true}});
 browser=await chromium.launch();const admin=await browser.newContext();assert.equal((await admin.request.post(base+'/api/admin/login',{data:{token:'header-local-only'}})).status(),200);
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';let productId;
 for(let i=0;i<26;i++){const r=await admin.request.post(base+'/api/admin/store/products',{data:{name:'Producto visual UAT '+i,sku:'HEADER-UAT-'+i,kind:'product',store:'fulltech',category:['Computadores','POS','Accesorios'][i%3],price:1000,cost:500,quantity:10,image,...(i<2?{compare_at_price:'1250',offer_price:'1000',offer_active:true,daily_offer:true}:{})}});assert.equal(r.status(),201);const p=(await r.json()).product;if(!productId)productId=p.id;assert.equal((await admin.request.post(base+`/api/admin/store/products/${p.id}/publication`,{data:{status:'published'}})).status(),200);}


 const cfg=(await (await admin.request.get(base+'/api/admin/store/commerce/config')).json()).config;
 assert.equal((await admin.request.put(base+'/api/admin/store/commerce/config',{data:{...cfg,expectedVersion:cfg.version,defaultOriginId:'origin_hub',branches:[{id:'branch_hub',name:'Sucursal Hub UAT',active:true}],origins:[{id:'origin_hub',branchId:'branch_hub',city:'Ciudad Hub UAT',latitude:18.6,longitude:-68.7,active:true,delivery:true,pickup:true}],zones:[{id:'zone_hub',name:'Zona Hub UAT',active:true,originIds:['origin_hub'],polygon:[[-68.8,18.5],[-68.5,18.5],[-68.5,18.8],[-68.8,18.8],[-68.8,18.5]],hours:Array.from({length:7},(_,day)=>({day,startMinute:0,endMinute:1440}))}],offers:[{id:'offer_hub',productId,originId:'origin_hub',active:true,regionalPrices:[{zoneId:'zone_hub',priceCents:200000}]}]}})).status(),200);
 const results=[];
 // Additional draft: must never enter any public hub grid.
 const draft=(await (await admin.request.post(base+'/api/admin/store/products',{data:{name:'BORRADOR PRIVADO UAT',sku:'PRIVATE-HUB-UAT',kind:'product',store:'fulltech',category:'Privado',price:500,cost:250,quantity:10,image}})).json()).product;
 assert.ok(draft.id);
 for(const width of [320,375,390,430,768,1024,1440]){
  const context=await browser.newContext({viewport:{width,height:844},geolocation:{latitude:18.61,longitude:-68.71,accuracy:10},permissions:['geolocation'],hasTouch:true,isMobile:width<500,serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const published=async()=>{await page.locator('#main[aria-busy=false]').waitFor();await page.waitForFunction(()=>document.querySelectorAll('[data-hub-products] [data-product-id]').length>=12);assert.equal(await page.locator('[data-product-id="'+draft.id+'"]').count(),0);assert.ok((await page.locator('[data-hub-products] [data-product-id]').count())>=12);};
  await page.goto(base+'/store/',{waitUntil:'networkidle'});await page.locator('#menu-button').click();await page.locator('.ft-hub-header').waitFor();await page.locator('#main[aria-busy=false]').waitFor();await published();
  assert.equal(await page.locator('#drawer').count(),0);assert.equal(await page.locator('#menu-button').getAttribute('aria-current'),'page');assert.equal(await page.locator('.ft-hub-welcome a').count(),2);assert.equal(await page.locator('.ft-hub-actions a[href$="/orders"]').count(),0);assert.equal(await page.locator('.ft-hub-solutions a').count(),2);assert.equal(await page.locator('.ft-hub-header-actions a').count(),2);
  assert.equal(await page.locator('.ft-hub-back').getAttribute('aria-label'),'Volver');
  assert.equal(await page.locator('.ft-hub-logo img').evaluate(e=>e.naturalWidth>0),true);assert.ok(await page.locator('.ft-hub-logo').evaluate(e=>e.clientWidth)<=120);
  await noOverflow();await page.screenshot({path:out+'/menu-guest-'+width+'.png'});
  await page.locator('.ft-hub-back').click();await page.locator('.ft-masthead').waitFor();assert.equal(new URL(page.url()).hash,'');await page.locator('#menu-button').click();await page.locator('.ft-hub-header').waitFor();
  await page.reload({waitUntil:'networkidle'});await page.locator('.ft-hub-header').waitFor();await page.locator('#main[aria-busy=false]').waitFor();
  await page.goBack();await page.locator('.ft-masthead').waitFor();await page.locator('#main[aria-busy=false]').waitFor();await page.locator('#menu-button').click();await page.locator('.ft-hub-company a').click();
  await page.locator('.ft-hub-about-intro').waitFor();await published();assert.equal(await page.locator('#fulltech-company-details').getAttribute('open'),null);
  assert.equal(await page.locator('.ft-hub-about-visual img').evaluate(e=>e.naturalWidth>0),true);
  assert.ok(await page.locator('.ft-hub-about-visual').evaluate(e=>e.getBoundingClientRect().bottom<=document.querySelector('.ft-hub-about-intro').getBoundingClientRect().top));
  assert.ok((await page.locator('#fulltech-company-details').textContent()).includes('Entrega y cobertura'));
  assert.equal(await page.locator('.ft-hub-business .ft-hub-solutions a').count(),2);await noOverflow();
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:out+'/about-'+width+'.png'});
  await page.locator('[data-hub-products] [data-add-cart]').first().click();assert.equal(await page.locator('[data-cart-badge]').textContent(),'1');
  await page.locator('#bottom-nav [data-route=cart]').click();await page.locator('.cart-item').waitFor();assert.equal(await page.locator('.cart-qty__value').textContent(),'1');
  // Real isolated account/session APIs, no OAuth providers contacted.
  assert.equal((await context.request.post(base+'/api/store/account/register',{data:{name:'Cliente Hub '+width,phone:'809555'+String(width).padStart(4,'0'),password:'Hub-Browser-123'}})).status(),201);
  assert.equal((await context.request.patch(base+'/api/store/account/me',{data:{onboarding:'skipped'}})).status(),200);
  const address=await context.request.post(base+'/api/store/account/commerce/addresses',{data:{latitude:18.61,longitude:-68.71,address:'Dirección sintética '+width,name:'Casa UAT',consent:true}});assert.equal(address.status(),201);
  await page.goto(base+'/store/#/menu',{waitUntil:'networkidle'});await page.locator('.ft-hub-welcome h2').filter({hasText:'Cliente Hub '+width}).waitFor();
  assert.equal(await page.locator('.ft-hub-actions a[href$="/account/addresses"]').count(),1);assert.equal(await page.locator('#signup-prompt').isVisible(),false);await noOverflow();
  await page.screenshot({path:out+'/menu-signed-'+width+'.png'});
  await page.locator('[data-menu-location] button').click();await page.waitForFunction(id=>document.querySelector('[data-product-id="'+id+'"] .price')?.textContent.includes('2,000'),productId);
  await page.locator('.ft-hub-actions a[href$="/account/settings"]').click();await page.locator('#save-preferences').waitFor();assert.equal(await page.locator('.page-head h1').textContent(),'Configuración');
  await page.locator('#pref-marketing').check();await page.locator('#save-preferences').click();await page.waitForFunction(()=>document.querySelector('#save-preferences')?.textContent==='Preferencias guardadas');assert.equal((await (await context.request.get(base+'/api/store/account/me')).json()).account.preferences.marketing,true);
  await page.locator('#profile-form [name=name]').fill('Cliente actualizado '+width);await page.locator('#profile-form [type=submit]').click();try{await page.waitForFunction(()=>document.querySelector('.account-hero h2')?.textContent.startsWith('Cliente actualizado'));}catch(error){console.log('profile diagnostic',await page.locator('#profile-error').textContent(),errors);throw error;}await published();await noOverflow();
  await page.goto(base+'/store/#/account',{waitUntil:'networkidle'});await page.locator('#profile-form').waitFor();await published();await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.waitForTimeout(250);await noOverflow();await page.waitForFunction(()=>Math.abs(document.querySelector('#bottom-nav').getBoundingClientRect().bottom+parseFloat(getComputedStyle(document.querySelector('#bottom-nav')).bottom)-innerHeight)<3);assert.ok(await page.locator('#bottom-nav').evaluate(e=>Math.abs(e.getBoundingClientRect().bottom+parseFloat(getComputedStyle(e).bottom)-innerHeight)<3));await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('show'));assert.notEqual(await page.locator('.account-avatar').evaluate(e=>getComputedStyle(e).color),await page.locator('.account-avatar').evaluate(e=>getComputedStyle(e).backgroundColor));await page.screenshot({path:out+'/profile-'+width+'.png'});
  const favorite=page.locator('[data-hub-products] [data-favorite]').first(),id=await favorite.getAttribute('data-favorite');await favorite.click();await page.waitForFunction(id=>document.querySelector('[data-favorite="'+id+'"]')?.getAttribute('aria-pressed')==='true',id);
  await page.locator('#menu-button').click();await page.locator('.ft-hub-actions a[href$="/favorites"]').click();await page.locator('[data-product-id="'+id+'"]').waitFor();
  await page.locator('#menu-button').click();await page.locator('.ft-hub-actions a[href$="/orders"]').click();await page.locator('.page-head h1').filter({hasText:'Mis pedidos'}).waitFor();
  await page.locator('#menu-button').click();await page.locator('.ft-hub-actions a[href$="/account/addresses"]').click();await page.locator('.ft-hub-address').waitFor();assert.ok((await page.locator('.ft-hub-address').textContent()).includes('Dirección sintética '+width));await noOverflow();
  await page.goto(base+'/store/#/menu',{waitUntil:'networkidle'});await page.locator('.ft-hub-header').waitFor();await published();assert.equal(await page.evaluate(()=>document.scrollingElement===document.documentElement),true);await page.evaluate(()=>scrollTo(0,0));await page.mouse.move(Math.min(200,width-20),400);await page.mouse.wheel(0,450);await page.waitForTimeout(200);assert.ok(await page.evaluate(()=>scrollY)>0);
  // Incremental grid is bounded per request and reaches the final published page.
  await page.locator('[data-hub-products]').scrollIntoViewIfNeeded();await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(250);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForFunction(()=>document.querySelectorAll('[data-hub-products] [data-product-id]').length===26);
  assert.equal(await page.locator('[data-product-id="'+draft.id+'"]').count(),0);
  await page.locator('[data-hub-products] .product-link').last().scrollIntoViewIfNeeded();const savedY=await page.evaluate(()=>scrollY);await page.locator('[data-hub-products] .product-link').last().click();await page.locator('.detail--product').waitFor();await page.goBack();await page.locator('.ft-hub-header').waitFor();await page.locator('#main[aria-busy=false]').waitFor();await page.waitForFunction(y=>document.querySelectorAll('[data-hub-products] [data-product-id]').length===26&&Math.abs(scrollY-y)<3,savedY);
  // Installation state remains native; installed apps do not show the install action.
  await page.evaluate(()=>{navigator.__defineGetter__('standalone',()=>true);window.dispatchEvent(new Event('appinstalled'));});assert.equal(await page.locator('#install-app').isVisible(),false);
  await page.goto(base+'/store/#/account',{waitUntil:'networkidle'});await page.locator('#logout').click();await page.locator('#login-form').waitFor();await page.locator('#menu-button').click();await page.locator('.ft-hub-welcome a[href$="/account/login"]').waitFor();assert.equal(await page.locator('.ft-hub-welcome').textContent().then(s=>s.includes('Cliente actualizado')),false);
  assert.deepEqual(errors,[]);results.push({width,guest:true,authenticated:true,about:true,profileSave:true,settingsSave:true,orders:true,favorites:true,addresses:true,regionalMenuPrice:2000,cart:true,publishedOnly:true,paginated26:true,backRestoresGridAndScroll:true,nativeScroll:true,installState:true,overflow:false,errors});await context.close();
 }
 await writeFile(out+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();await new Promise(r=>server.close(r));await app?.close();}

