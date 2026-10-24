import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch();
const out='docs/capturas/store-refinements';
await fs.mkdir(out,{recursive:true});
for(const width of [320,390,768]){
 const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
 const p=await context.newPage();
 const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const product={id:'visual-1',name:'Producto de prueba visual',price:1000,compareAtPrice:2000,discountPercent:50,currency:'DOP',imageUrl:'/store/assets/presentation/fulltech-scene-480.webp',kind:'product',category:'Tecnología',availabilityState:'IN_STOCK',description:'Producto temporal de revisión visual.'};
 await context.route('**/api/store/home',async r=>{const res=await r.fetch();await r.fulfill({json:{...await res.json(),dailyOffers:[product,{...product,id:'visual-2'}]}})});
 await context.route('**/api/store/categories',r=>r.fulfill({json:{categories:Array.from({length:12},(_,i)=>`Categoría ${i+1}`),categoryCards:Array.from({length:12},(_,i)=>({name:`Categoría ${i+1}`,imageUrl:product.imageUrl,count:1}))}}));
 await context.route('**/api/store/products/visual-1',r=>r.fulfill({json:{product}}));
 await p.goto('http://localhost:4175/store/',{waitUntil:'networkidle'});
 assert.equal(await p.locator('.ft-hero-offer').count(),2);
 assert.equal(await p.locator('.ft-hero-offer strong,.ft-hero-offer__prices').count(),0);
 await p.screenshot({path:`${out}/home-${width}.png`});
 for(const route of ['nosotros','catalog','product/visual-1']){
  await p.goto(`http://localhost:4175/store/#/${route}`,{waitUntil:'networkidle'});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(route==='nosotros')assert.ok(Math.abs(await p.locator('.ft-intro-photo').evaluate(e=>e.getBoundingClientRect().height)-844*.7)<2);
  if(route==='catalog'){assert.equal(await p.locator('.ft-category-tile').count(),12);await p.getByRole('button',{name:'Ofertas',exact:true}).click();assert.ok(p.url().includes('offers=1'));}
  if(route.startsWith('product')){
   assert.equal(await p.locator('.ft-gallery-action').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   await p.evaluate(()=>{navigator.share=async data=>{window.sharedProduct=data;};});
   await p.locator('[data-product-share]').click();
   assert.ok((await p.evaluate(()=>window.sharedProduct.url)).endsWith('/store/p/visual-1'));
  }
  await p.screenshot({path:`${out}/${route.replace('/','-')}-${width}.png`});
 }
 assert.deepEqual(errors,[]);
 await context.close();
}
await browser.close();
console.log('PASS: responsive home, about, category filters, product icons and canonical sharing (visual fixtures only).');
