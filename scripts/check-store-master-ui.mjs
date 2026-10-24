import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const phase=process.argv[2]||'after',base=process.env.STORE_UAT_URL||'http://127.0.0.1:4177',out='docs/capturas/store-master';
await fs.mkdir(out,{recursive:true});const browser=await chromium.launch();const results=[];
try{for(const width of [320,360,375,390,430,768,1024,1440]){
 const c=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const products=Array.from({length:12},(_,i)=>({id:`visual-${i}`,name:`Producto de tecnología para uso diario ${i+1}`,category:`Categoría ${i%9+1}`,kind:'product',price:800+i,compareAtPrice:1000+i,discountPercent:20,currency:'DOP',purchaseable:true,availabilityState:'AVAILABLE_NOW',imageUrl:'/store/assets/presentation/fulltech-scene-480.webp',featured:i<2}));
 let offerCount=6;
 await c.route('**/api/store/home',r=>r.fulfill({json:{products,total:products.length,sections:{featured:products.slice(0,2),offers:products.slice(2,8)},dailyOffers:products.slice(0,2)}}));
 await c.route('**/api/store/categories',r=>r.fulfill({json:{categories:Array.from({length:9},(_,i)=>`Categoría ${i+1}`),categoryCards:Array.from({length:9},(_,i)=>({name:`Categoría ${i+1}`,imageUrl:products[i].imageUrl,count:1}))}}));
 await c.route('**/api/store/catalog?*',r=>{const u=new URL(r.request().url());let rows=products.slice(0,u.searchParams.has('offers')?offerCount:12);if(u.searchParams.get('category'))rows=rows.filter(p=>p.category===u.searchParams.get('category'));return r.fulfill({json:{products:rows,pagination:{total:rows.length,pages:1,page:1}}});});
 await c.route('**/api/store/products/visual-*',r=>r.fulfill({json:{product:products.find(p=>p.id===new URL(r.request().url()).pathname.split('/').pop())||products[0]}}));
 const capture=async name=>{await p.screenshot({path:`${out}/${phase}-${name}-${width}.png`,animations:'disabled'});if(phase==='after')assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}:${width}`);};
 for(const route of ['','catalog','offers','product/visual-0','cart']){if(route==='cart')await p.evaluate(()=>localStorage.setItem('fulltech_cart_v1',JSON.stringify([{id:'visual-0',quantity:1}])));await p.goto(`${base}/store/#/${route}`,{waitUntil:'networkidle'});await capture(route.replace('/','-')||'home');}
 await p.locator('#menu-button').click();await capture('drawer');await p.locator('#close-drawer').click();
 if(phase==='after'){
  assert.equal(await p.locator('#bottom-nav > a').count(),4);
  for(const count of [0,1,2,4,6]){offerCount=count;await p.goto(`${base}/store/#/offers?visual=${count}`,{waitUntil:'networkidle'});await p.waitForFunction(n=>document.querySelectorAll('#catalog-result .product-card').length===n&&Boolean(document.querySelector('#catalog-result .product-grid,#catalog-result .empty')),count);await capture(`offers-${count}`);assert.equal(await p.locator('#catalog-result .product-card').count(),count);assert.equal(await p.locator('.ft-offer-carousel').count(),count>0?1:0);assert.equal(await p.locator('[data-carousel-play]').count(),count>=3?1:0);}
  await p.goto(`${base}/store/#/catalog`,{waitUntil:'networkidle'});if(width<=430)assert.equal(await p.locator('.ft-category-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),3);
  await p.locator('[data-add-cart]').first().click();assert.ok(await p.evaluate(()=>JSON.parse(localStorage.getItem('fulltech_cart_v1')).length)>0);
  assert.equal(await p.locator('.product-card .availability').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await p.locator('.ft-category-tile').first().click();await p.waitForFunction(()=>document.querySelector('#catalog-title')?.textContent==='Categoría 1');await p.goBack();await p.locator('.ft-category-grid').waitFor();
  await p.goto(`${base}/store/#/offers?visual=keyboard`,{waitUntil:'networkidle'});await p.locator('.ft-offer-track').waitFor();await p.locator('.ft-offer-track').focus();await p.keyboard.press('ArrowRight');
  await p.goto(`${base}/store/#/request`,{waitUntil:'networkidle'});assert.equal(await p.locator('#request-form').count(),0);
 }
 results.push({width,errors});if(phase==='after')assert.deepEqual(errors,[]);await c.close();
}await fs.writeFile(`${out}/${phase}-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{await browser.close();}
