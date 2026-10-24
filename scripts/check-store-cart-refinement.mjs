import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:4177',out='docs/capturas/store-cart';await fs.mkdir(out,{recursive:true});
const catalog=await fetch(base+'/api/store/catalog?kind=product&limit=100').then(r=>r.json()),products=catalog.products.filter(p=>p.purchaseable),[a,b]=products;assert.ok(a&&b);
const browser=await chromium.launch(),results=[];
try{
 for(const width of [320,360,375,390,430,768,1024,1440]){
  const c=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await c.addInitScript(rows=>{if(!localStorage.getItem('fulltech_cart_v1'))localStorage.setItem('fulltech_cart_v1',JSON.stringify(rows));},[{id:a.id,quantity:1},{id:b.id,quantity:2}]);
  await p.goto(base+'/store/#/cart',{waitUntil:'networkidle'});await p.locator('.cart-item').first().waitFor();await p.locator('#cart-recommendations article').first().waitFor();await p.waitForTimeout(100);
  assert.equal(await p.locator('.ft-header').isVisible(),false);assert.equal(await p.locator('.ft-cart-heading h1').innerText(),'Carrito');assert.equal(await p.locator('.cart-shortcut').count(),0);
  const badge=p.locator('#bottom-nav [data-cart-badge]');assert.equal(await badge.innerText(),'3');assert.equal(await badge.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(17, 24, 39)');assert.equal(await badge.evaluate(e=>getComputedStyle(e).color),'rgb(255, 133, 133)');assert.ok((await badge.boundingBox()).height>=20);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const images=await p.locator('.cart-item__image img').evaluateAll(nodes=>nodes.map(n=>({loaded:n.complete&&n.naturalWidth>0,w:n.getBoundingClientRect().width})));assert.ok(images.every(i=>i.loaded&&i.w<=88));
  assert.ok((await p.locator('[data-cart-minus] .ft-custom-icon').first().evaluate(e=>getComputedStyle(e).maskImage)).includes('menos.png'));
  await p.screenshot({path:`${out}/cart-${width}.png`,animations:'disabled'});
  const item=p.locator(`[data-cart-item="${a.id}"]`),quantity=item.locator('.cart-qty__value');
  await item.locator('[data-cart-plus]').click();await p.waitForFunction(id=>document.querySelector(`[data-cart-item="${id}"] .cart-qty__value`)?.textContent==='2',a.id);assert.equal(await badge.innerText(),'4');assert.equal(await item.locator('[data-cart-plus]').evaluate(e=>document.activeElement===e),true);
  await item.locator('[data-cart-minus]').click();await p.waitForFunction(id=>document.querySelector(`[data-cart-item="${id}"] .cart-qty__value`)?.textContent==='1',a.id);assert.equal(await badge.innerText(),'3');
  await p.locator('#cart-recommendations').evaluate(e=>e.dataset.keep='same-feed');
  await item.locator('[data-cart-minus]').click();await p.waitForFunction(id=>!document.querySelector(`[data-cart-item="${id}"]`),a.id);assert.equal(await badge.innerText(),'2');
  await p.locator('[data-cart-remove]').click();await p.locator('.ft-cart-empty').waitFor();assert.equal(await badge.isVisible(),false);
  await p.screenshot({path:`${out}/empty-${width}.png`,animations:'disabled'});
  await p.locator('#cart-recommendations [data-add-cart]').first().click();await p.locator('.cart-item').waitFor();assert.equal(await badge.innerText(),'1');assert.equal(await p.locator('#cart-recommendations').getAttribute('data-keep'),'same-feed');assert.equal(await p.locator('#cart-recommendations article').count(),catalog.products.length);
  const amount=await p.locator('.cart-total strong').innerText();assert.ok(amount.includes('RD$'));
  await p.locator('.cart-item__image').click();await p.locator('.detail--product').waitFor();await p.goBack();await p.locator('.cart-item').waitFor();assert.equal(await badge.innerText(),'1');
  assert.deepEqual(errors,[]);results.push({width,photos:true,minus:true,plus:true,empty:true,recommendations:true,cartBadge:true,back:true,noOverflow:true,errors});await c.close();
 }
 const c=await browser.newContext({viewport:{width:320,height:844},serviceWorkers:'block'}),p=await c.newPage();
 await c.addInitScript(rows=>localStorage.setItem('fulltech_cart_v1',JSON.stringify(rows)),[{id:a.id,quantity:99},{id:b.id,quantity:1}]);await p.goto(base+'/store/#/cart',{waitUntil:'networkidle'});await p.locator('.cart-item').first().waitFor();assert.equal(await p.locator('#bottom-nav [data-cart-badge]').innerText(),'100');assert.equal(await p.locator(`[data-cart-plus="${a.id}"]`).isDisabled(),true);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:out+'/badge-100-320.png',animations:'disabled'});await c.close();
 const d=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),q=await d.newPage();await d.addInitScript(rows=>localStorage.setItem('fulltech_cart_v1',JSON.stringify(rows)),[{id:a.id,quantity:1}]);
 await d.route('**/api/store/catalog?limit=48',r=>r.fulfill({json:{products:[{...a,purchaseable:false,availabilityState:'UNAVAILABLE'}]}}));await q.goto(base+'/store/#/cart',{waitUntil:'networkidle'});await q.locator('.cart-problems').waitFor();assert.equal(await q.locator('.cart-actions a[href*="checkout"]').count(),0);await d.close();
 await fs.writeFile(out+'/results.json',JSON.stringify({responsive:results,largeBadge:100,quantityLimit:99,unavailableProductProtected:true},null,2));console.log(JSON.stringify({responsive:results,largeBadge:100,quantityLimit:99,unavailableProductProtected:true}));
}finally{await browser.close();}
