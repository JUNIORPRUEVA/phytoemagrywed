// Set PLAYWRIGHT_MODULE to an installed Playwright module URL if not installed locally.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import fs from 'node:fs/promises';
const phase=process.argv[2]||'before';const out='docs/capturas/store-discovery';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true});const results=[];
for(const theme of ['light','dark'])for(const [width,height] of [[360,800],[390,844],[430,932],[768,1024],[1440,900]]){
 const context=await browser.newContext({viewport:{width,height},colorScheme:theme,deviceScaleFactor:1,serviceWorkers:'block'});
 await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 const page=await context.newPage();const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.metrics={cls:0,lcp:0};new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.metrics.cls+=e.value}).observe({type:'layout-shift',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())window.metrics.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true})});
 await page.goto('http://127.0.0.1:8898/store/',{waitUntil:'networkidle'});await page.locator('.ft-hero').waitFor();
 const initial=await page.evaluate(()=>({...window.metrics,requests:performance.getEntriesByType('resource').length,bytes:performance.getEntriesByType('resource').reduce((n,e)=>n+e.transferSize,0)}));
 for(let y=0;y<await page.evaluate(()=>document.documentElement.scrollHeight);y+=700){await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(70)}
 await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(200);
 await page.screenshot({path:`${out}/${phase}-${theme}-${width}-home.png`,fullPage:true});
 results.push({theme,width,...await page.evaluate(()=>({...window.metrics,overflow:document.documentElement.scrollWidth>innerWidth,images:[...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src),cards:document.querySelectorAll('.ft-card').length,header:document.querySelector('.ft-header').getBoundingClientRect().height,requests:performance.getEntriesByType('resource').length,bytes:performance.getEntriesByType('resource').reduce((n,e)=>n+e.transferSize,0)})),...initial,errors});
 if(phase==='after'){for(const [name,hash,wait] of [['search','/catalog?q=USB','#catalog-result .product-card'],['category','/catalog?category=Tecnolog%C3%ADa','#catalog-result .product-card'],['offers','/catalog?offers=1','#catalog-result .product-card'],['about','/nosotros','.about-hero']]){await page.goto('http://127.0.0.1:8898/store/#'+hash,{waitUntil:'networkidle'});await page.locator(wait).first().waitFor();for(let y=0;y<await page.evaluate(()=>document.documentElement.scrollHeight);y+=700){await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(60)}await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(100);await page.screenshot({path:`${out}/${phase}-${theme}-${width}-${name}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`overflow ${name} ${width}`)}}
 await context.close();
}
await fs.writeFile(`${out}/${phase}-metrics.json`,JSON.stringify(results,null,2));console.log(results);await browser.close();
