import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch(),base='http://127.0.0.1:4177',c=await browser.newContext({viewport:{width:390,height:844}}),p=await c.newPage();
try{
 await p.goto(base+'/store/',{waitUntil:'networkidle'});
 await p.waitForFunction(()=>!!navigator.serviceWorker.controller,{timeout:20000});
 // Cache public responses during a controlled online visit before testing offline.
 await p.reload({waitUntil:'networkidle'});await p.locator('#home-feed-result article').first().waitFor();
 await p.waitForFunction(async()=>{const c=await caches.open('fulltech-store-v72-public');return (await c.keys()).some(r=>new URL(r.url).pathname==='/api/store/catalog');});
 const cache=await p.evaluate(async()=>{const names=await caches.keys(),shell=await caches.open('fulltech-store-v72');return {names,keys:(await shell.keys()).map(r=>new URL(r.url).pathname)};});
 for(const asset of ['product-feed.js','masonry.js','navigation-icons.js','shopping-experience.css'])assert.ok(cache.keys.includes('/store/'+asset),asset);
 await c.setOffline(true);await p.reload({waitUntil:'domcontentloaded'});await p.locator('#home-feed-result article').first().waitFor();assert.equal(await p.locator('#bottom-nav > a:visible').count(),4);
 await c.setOffline(false);
 const reg=await c.request.post(base+'/api/store/account/register',{data:{name:'QA Shopping',email:`shopping-${Date.now()}@example.test`,password:'Shopping-UAT-123'}});assert.equal(reg.status(),201);
 assert.equal((await c.request.patch(base+'/api/store/account/me',{data:{onboarding:'skipped'}})).status(),200);
 await p.reload({waitUntil:'networkidle'});await p.locator('#home-feed-result article').first().waitFor();assert.equal(await p.locator('#signup-prompt').isVisible(),false);
 const favorite=p.locator('#home-feed-result [data-favorite]').first();await favorite.click();await p.waitForFunction(()=>document.querySelector('#home-feed-result [data-favorite]')?.getAttribute('aria-pressed')==='true');
 await p.locator('#home-feed-result [data-add-cart]').first().click();assert.equal(await p.locator('#bottom-nav [data-cart-badge]').innerText(),'1');
 await p.locator('#bottom-nav [data-route=cart]').click();await p.locator('.cart-item').waitFor();assert.equal(await p.locator('#bottom-nav [data-route=cart] .ft-nav-icon--filled').isVisible(),true);
 const result={worker:'fulltech-store-v72',newAssetsCached:true,offlinePublicFeed:true,privateAuthNotCached:true,signedInSignupHidden:true,favoriteSaved:true,cartPreserved:true};
 const privateKeys=await p.evaluate(async()=>{const names=await caches.keys();return (await Promise.all(names.map(async n=>(await (await caches.open(n)).keys()).map(r=>new URL(r.url).pathname)))).flat().filter(path=>path.startsWith('/api/store/account')||path.startsWith('/api/admin'));});assert.deepEqual(privateKeys,[]);
 await fs.writeFile('docs/capturas/store-shopping/pwa-auth-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
