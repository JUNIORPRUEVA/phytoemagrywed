import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const phase=process.argv[2]||'after',base='http://127.0.0.1:4177',out='docs/capturas/store-final';await fs.mkdir(out,{recursive:true});
const home=await fetch(base+'/api/store/home').then(r=>r.json()),id=home.products[0]?.id;assert.ok(id,'Seed the isolated UAT preview first.');
const browser=await chromium.launch();const results=[];
try{for(const width of [320,360,375,390,430,768,1440]){
 const c=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 for(const route of ['','catalog','offers',`product/${id}`]){
  await p.goto(`${base}/store/#/${route}`,{waitUntil:'networkidle'});
  await p.locator(route.startsWith('product/')?'.detail--product':route==='offers'?'.ft-offer-track':route==='catalog'?'.product-grid':'.ft-masthead').waitFor();
  await p.waitForLoadState('networkidle');await p.waitForTimeout(100);
  await p.screenshot({path:`${out}/${phase}-${route.split('/')[0]||'home'}-${width}.png`,animations:'disabled'});
  if(phase==='after'){
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${route}:${width}`);
   assert.equal(await p.locator('.ft-signup-prompt:visible').evaluateAll(nodes=>nodes.some(n=>getComputedStyle(n).position==='fixed')),false);
   if(route==='catalog'||route==='offers'){
    assert.ok(await p.locator('.ft-card__summary').count()>0);await p.evaluate(()=>scrollTo(0,650));
    const top=await p.locator('.ft-browse-search').evaluate(e=>e.getBoundingClientRect().top);assert.ok(top>=0&&top<3,`sticky ${top}`);
    await p.locator('#store-search').fill('cámara');await p.waitForTimeout(350);assert.equal(await p.locator('#store-search').inputValue(),'cámara');await p.locator('#store-search').fill('');await p.waitForTimeout(350);
    await p.waitForLoadState('networkidle');await p.screenshot({path:`${out}/${phase}-${route}-scroll-${width}.png`,animations:'disabled'});
    if(route==='offers'){assert.equal(await p.locator('.ft-offer-track').evaluate(e=>getComputedStyle(e).scrollbarWidth),'none');const play=p.locator('[data-carousel-play]');await play.click();assert.equal(await play.getAttribute('aria-pressed'),'true');}
   }
   if(route.startsWith('product/'))assert.equal(await p.locator('.ft-gallery-actions .ft-favorite').count(),1);
  }
 }
 if(phase==='after'){
  const email=`visual-${width}-${Date.now()}@example.test`;
  const reg=await c.request.post(base+'/api/store/account/register',{data:{name:'QA Visual',email,password:'Prueba-Visual-123'}});assert.equal(reg.status(),201);
  await c.request.patch(base+'/api/store/account/me',{data:{onboarding:'skipped'}});
  await p.goto(`${base}/store/#/product/${id}`,{waitUntil:'networkidle'});const favorite=p.locator('.ft-gallery-actions .ft-favorite');await favorite.click();await p.waitForFunction(()=>document.querySelector('.ft-gallery-actions .ft-favorite')?.getAttribute('aria-pressed')==='true');
  await p.screenshot({path:`${out}/${phase}-favorite-active-${width}.png`,animations:'disabled'});assert.equal(await p.locator('#signup-prompt').isVisible(),false);await favorite.click();
 }
 assert.deepEqual(errors,[]);results.push({width,errors});await c.close();
}await fs.writeFile(`${out}/${phase}-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{await browser.close();}
