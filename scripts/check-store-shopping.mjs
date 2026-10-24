import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:4177',out='docs/capturas/store-shopping',browser=await chromium.launch();await fs.mkdir(out,{recursive:true});
const home=await fetch(base+'/api/store/home').then(r=>r.json()),id=home.products[0].id,results=[];
try{
 for(const width of process.argv.includes('--pagination-only')?[]:[320,360,375,390,430,768,1024,1440]){
  const c=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),p=await c.newPage(),errors=[];
  p.on('pageerror',e=>errors.push(e.message));
  const ready=async()=>{await p.waitForLoadState('networkidle');await p.waitForTimeout(120);};
  for(const route of ['','catalog','offers','search?q=SSD',`product/${id}`,'cart','account/register','orders']){
   await p.goto(`${base}/store/#/${route}`,{waitUntil:'networkidle'});
   if(route==='')await p.locator('#home-feed-result article').first().waitFor();
   if(['catalog','offers'].includes(route))await p.locator('#catalog-result article').first().waitFor();
   await ready();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}:${route}`);
   assert.equal(await p.locator('#bottom-nav > a:visible').count(),4);
   assert.equal(await p.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(255, 255, 255)');
   const navRoute=route===''?'home':route==='catalog'||route.startsWith('search')?'catalog':route==='offers'?'offers':route==='cart'?'cart':null;
   if(navRoute){const active=p.locator(`#bottom-nav [data-route="${navRoute}"]`);assert.equal(await active.getAttribute('aria-current'),'page');assert.equal(await active.locator('.ft-nav-icon--filled').isVisible(),true);assert.equal(await active.locator('.ft-nav-icon--outline').isVisible(),false);assert.equal(await active.evaluate(e=>getComputedStyle(e).color),'rgb(22, 93, 255)');}
   await p.screenshot({path:`${out}/after-${route.split('/')[0].split('?')[0]||'home'}-${width}.png`,animations:'disabled'});
   if(route===''||route==='catalog'||route==='offers'){
    await p.evaluate(()=>scrollTo(0,900));await p.waitForTimeout(150);
    const bar=p.locator(route===''?'.ft-home-search':'.ft-browse-search');const box=await bar.boundingBox();assert.ok(box.y>=0&&box.y<2,`${width}:${route} sticky ${box.y}`);
    if(route==='')assert.ok((await p.locator('.ft-home-chips').boundingBox()).y<90);
    const grid=p.locator(route===''?'#home-feed-result .product-grid':'#catalog-result .product-grid');
    assert.equal(await grid.evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),width<600?2:width<900?3:width<1200?4:5);
    const positions=await grid.locator('article').evaluateAll(cards=>cards.map(e=>({id:e.dataset.productId,y:e.offsetTop,h:e.offsetHeight})));
    assert.ok(positions.every((pos,i)=>!i||pos.y>=positions[i-1].y),'logical visual order');
    await p.screenshot({path:`${out}/after-${route||'home'}-scroll-${width}.png`,animations:'disabled'});
   }
  }
  await p.goto(base+'/store/',{waitUntil:'networkidle'});await p.locator('#home-feed-result article').first().waitFor();
  const category='Hogar';await p.locator(`[data-home-category="${category}"]`).click();await p.waitForFunction(()=>[...document.querySelectorAll('#home-feed-result article')].every(e=>e.dataset.category==='Hogar')&&document.querySelectorAll('#home-feed-result article').length>0);
  await p.locator('[data-home-category=""]').click();await p.waitForFunction(()=>document.querySelectorAll('#home-feed-result article').length===51);
  await p.locator('#home-feed-result [data-add-cart]').first().click();assert.equal(await p.locator('#bottom-nav [data-cart-badge]').innerText(),'1');
  await p.locator('#bottom-nav [data-route=cart]').click();await p.locator('.cart-item').waitFor();assert.ok(await p.locator('.cart-item').count()>0);assert.equal(await p.locator('#bottom-nav [data-route=cart]').getAttribute('aria-current'),'page');
  assert.deepEqual(errors,[]);results.push({width,errors,sticky:true,navbar:4,whiteCanvas:true,masonry:true,categoryFilter:true,cart:true});await c.close();
 }
 // Large-catalog fixture only in this browser, never inserted into any database.
 const c=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),p=await c.newPage(),requests=[];
 const products=Array.from({length:251},(_,i)=>({...home.products[0],id:`fixture-${i}`,name:`Producto QA ${i}`,category:i%2?'Hogar':'Tecnología',shortDescription:i%3?'Descripción real del fixture para validar alturas variables.':'',description:'',featured:false}));
 let failSecond=true,slow=false;
 await c.route('**/api/store/catalog?*',async r=>{
  const u=new URL(r.request().url()),page=Number(u.searchParams.get('page')),limit=Number(u.searchParams.get('limit'));requests.push({page,limit,category:u.searchParams.get('category'),q:u.searchParams.get('q')});
  if(slow&&u.searchParams.get('q')==='viejo'){await new Promise(resolve=>setTimeout(resolve,500));}
  if(page===2&&failSecond){failSecond=false;await r.fulfill({status:503,json:{error:'test-retry'}});return;}
  let rows=products;if(u.searchParams.get('category'))rows=rows.filter(x=>x.category===u.searchParams.get('category'));if(u.searchParams.get('q'))rows=rows.filter(x=>x.name.includes(u.searchParams.get('q')));
  await r.fulfill({json:{products:rows.slice((page-1)*limit,page*limit),pagination:{page,limit,total:rows.length,pages:Math.ceil(rows.length/limit)}}});
 });
 await p.goto(base+'/store/#/catalog',{waitUntil:'networkidle'});await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===100);assert.deepEqual(requests[0],{page:1,limit:100,category:null,q:null});assert.equal(await p.locator('#load-more').count(),0);
 await p.locator('.ft-feed-sentinel').scrollIntoViewIfNeeded();await p.locator('.ft-feed-retry').waitFor();assert.equal(await p.locator('#catalog-result article').count(),100);
 await p.locator('.ft-feed-retry').click();await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===200);
 await p.locator('.ft-feed-sentinel').scrollIntoViewIfNeeded();await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===251);
 const ids=await p.locator('#catalog-result article').evaluateAll(nodes=>nodes.map(n=>n.dataset.productId));assert.equal(new Set(ids).size,251);assert.ok((await p.locator('.ft-feed-status').innerText()).includes('Has visto todos'));
 await p.screenshot({path:out+'/after-feed-251-390.png',animations:'disabled'});
 // Navigate with a real published product while retaining the fixture listing snapshot.
 await p.evaluate(()=>scrollTo(0,2200));await p.waitForTimeout(100);const y=await p.evaluate(()=>scrollY);
 await p.evaluate(id=>{location.hash='/product/'+id;},id);await p.locator('.detail--product').waitFor();await p.goBack();await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===251);await p.waitForTimeout(150);assert.ok(Math.abs(await p.evaluate(()=>scrollY)-y)<4,'back restores scroll');
 await p.locator('#category-filter').selectOption('Hogar');await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===100&&document.querySelector('#catalog-count').textContent.includes('125'));
 assert.equal(requests.at(-1).page,1);assert.equal(requests.at(-1).category,'Hogar');assert.equal(await p.locator('#catalog-result article').evaluateAll(nodes=>nodes.every(n=>n.querySelector('.ft-card__category').textContent==='Hogar')),true);
 await p.locator('#clear-filters').click();await p.waitForFunction(()=>document.querySelector('#catalog-count')?.textContent.includes('251'));
 slow=true;await p.locator('#store-search').fill('viejo');await p.waitForTimeout(300);await p.locator('#store-search').fill('QA 250');await p.waitForFunction(()=>document.querySelectorAll('#catalog-result article').length===1);await p.waitForTimeout(600);assert.ok((await p.locator('#catalog-result').innerText()).includes('QA 250'));
 await c.close();
 await fs.writeFile(out+'/results.json',JSON.stringify({responsive:results,pagination:{total:251,batches:[100,100,51],retry:true,duplicates:0,backScroll:true,resetFilter:true,staleIgnored:true,requests}},null,2));console.log(JSON.stringify({responsive:results,pagination:'251 products, retry, back, filters and stale responses passed'}));
}finally{await browser.close();}
