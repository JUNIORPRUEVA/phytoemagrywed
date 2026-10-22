const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const base='http://127.0.0.1:8898',out='docs/capturas/store-checkout',phase=process.argv[2]||'before';await fs.mkdir(out,{recursive:true});assert.equal((await fetch(base+'/api/health').then(r=>r.json())).uat,true);
const b=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})}),results=[];
for(const theme of ['light','dark'])for(const width of [360,390,430,1440]){
 const c=await b.newContext({viewport:{width,height:844},colorScheme:theme,deviceScaleFactor:2,serviceWorkers:'block'});await c.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/store/',{waitUntil:'networkidle'});const perf=await p.evaluate(()=>({bytes:performance.getEntriesByType('resource').reduce((n,e)=>n+e.transferSize,0),dom:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd}));await p.locator('[data-add-cart]').first().click();
 const tag=Date.now()+''+width;const reg=await c.request.post(base+'/api/store/account/register',{data:{name:'DEMO UAT Checkout',phone:'809'+tag.slice(-7),email:`checkout-${tag}@example.test`,password:'Checkout-Uat-123'}});assert.equal(reg.status(),201,await reg.text());
 await p.goto(base+'/store/#/checkout');await p.locator('#checkout-form').waitFor();await p.screenshot({path:`${out}/${phase}-${theme}-${width}.png`,fullPage:true});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);results.push({theme,width,...perf,errors});await c.close();
}await b.close();await fs.writeFile(`${out}/${phase}-metrics.json`,JSON.stringify(results,null,2));console.log(results);
