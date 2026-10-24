import {chromium, webkit} from 'file:///C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=new URL('../docs/capturas/official-app-branding/',import.meta.url);
await mkdir(out,{recursive:true});
const source=await readFile(new URL('../public/store/first-launch.js',import.meta.url),'utf8');
const origin='http://127.0.0.1:8898';
const results=[];
for(const engine of (process.argv.includes('--sw-only')?['chromium']:process.argv.includes('--webkit-only')?['webkit']:['chromium','webkit'])){
 const matchingWebkit=(await import('file:///C:/Users/pc/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.mjs')).webkit;
 const browser=await (engine==='chromium'?chromium:matchingWebkit).launch(engine==='chromium'?{executablePath:'C:/Users/pc/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',headless:true}:{headless:true});
 try{
  for(const width of process.argv.includes('--sw-only')?[]:engine==='chromium'?[360,390,430,768,1280]:[390]){
   const context=await browser.newContext({viewport:{width,height:850},reducedMotion:'no-preference',serviceWorkers:'block'});
   const page=await context.newPage();let videos=0;
   page.on('request',r=>{if(/\/assets\/welcome\/.*\.mp4$/.test(r.url()))videos++});
   await page.goto(origin+'/store/',{waitUntil:'domcontentloaded'});
   await page.locator('.ft-welcome').waitFor();
   await page.waitForFunction(()=>document.querySelector('.ft-welcome video')?.currentTime>.1);
   const rect=await page.locator('.ft-welcome').boundingBox();
   if(rect.width!==width||rect.height!==850)throw Error('Welcome viewport mismatch');
   await page.screenshot({path:fileURLToPath(new URL(`${engine}-first-${width}.png`,out))});
   await page.locator('.ft-welcome').waitFor({state:'detached',timeout:8500});
   if(!await page.evaluate(()=>localStorage.getItem('fulltech_store_welcome_seen_v1')==='1'))throw Error('Completion not persisted');
   if(await page.locator('.app-shell').evaluate(el=>el.inert))throw Error('App remains inert');
   const initialVideoRequests=videos;
   await page.reload({waitUntil:'networkidle'});
   if(await page.locator('.ft-welcome').count()||videos!==initialVideoRequests)throw Error('Intro replay/download after refresh');
   await page.evaluate(()=>location.hash='/catalog');await page.waitForTimeout(150);
   if(await page.locator('.ft-welcome').count()||videos!==initialVideoRequests)throw Error('Intro replay on navigation');
   await page.screenshot({path:fileURLToPath(new URL(`${engine}-after-${width}.png`,out))});
   results.push({engine,width,playback:'ended',refresh:'no video',navigation:'no video'});
   console.log(`${engine} ${width}: playback, persistence, navigation OK`);
   await context.close();
  }
  if(engine==='chromium'){
   for(const scenario of process.argv.includes('--sw-only')?[]:['skip','reduced','error','storage-denied','stall','offline','checkout','autoplay-denied']){
    const context=await browser.newContext({viewport:{width:390,height:850},reducedMotion:scenario==='reduced'?'reduce':'no-preference',serviceWorkers:'block'});
    const page=await context.newPage();let videos=0;
    page.on('request',r=>{if(/\/assets\/welcome\/.*\.mp4$/.test(r.url()))videos++});
    if(scenario==='storage-denied')await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw Error('denied')}});Object.defineProperty(window,'sessionStorage',{get(){throw Error('denied')}})});
    if(scenario==='autoplay-denied')await page.addInitScript(()=>{HTMLMediaElement.prototype.play=()=>Promise.reject(Error('not allowed'))});
    if(scenario==='offline')await page.addInitScript(()=>Object.defineProperty(navigator,'onLine',{get:()=>false}));
    if(scenario==='error')await page.route('**/assets/welcome/*.mp4',r=>r.abort());
    if(scenario==='stall')await page.addInitScript(()=>{HTMLMediaElement.prototype.play=()=>new Promise(()=>{})});
    await page.goto(origin+'/store/'+(scenario==='checkout'?'#/checkout':''),{waitUntil:'domcontentloaded'});
    if(['skip','storage-denied'].includes(scenario)){
     await page.locator('.ft-welcome__skip').click();
     if(scenario==='storage-denied')await page.addScriptTag({content:source});
    }
    await page.waitForTimeout(scenario==='stall'?2200:600);
    if(await page.locator('.ft-welcome').count())throw Error(`Trapped in ${scenario}`);
    if(await page.locator('.app-shell').evaluate(el=>el.inert))throw Error(`Inert after ${scenario}`);
    if(['reduced','offline','checkout','stall'].includes(scenario)&&videos)throw Error(`Unexpected download: ${scenario}`);
    results.push({scenario,result:'OK',videoRequests:videos});await context.close();
    console.log(`${scenario}: OK`);
   }
   const context=await browser.newContext({viewport:{width:390,height:850},reducedMotion:'reduce'});
   const page=await context.newPage();let mediaRequests=0;
   page.on('request',r=>{if(/\/assets\/welcome\/.*\.mp4$/.test(r.url()))mediaRequests++});
   await page.goto(origin+'/store/',{waitUntil:'networkidle'});
   await page.evaluate(()=>navigator.serviceWorker.ready);
   await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
   const cachedMedia=await page.evaluate(async()=>{
     const cache=await caches.open('fulltech-store-v102');
     const requests=await cache.keys();
     return {size:requests.length,video:requests.some(r=>r.url.includes('/assets/welcome/')),startup:requests.some(r=>r.url.includes('first-launch.js'))};
   });
   if(cachedMedia.video||!cachedMedia.startup)throw Error(`SW cache: ${JSON.stringify(cachedMedia)}`);
   await context.setOffline(true);
   await page.reload({waitUntil:'domcontentloaded'});
   if(await page.locator('.ft-welcome').count()||mediaRequests)throw Error('Offline welcome/media requested');
   await page.locator('#main').waitFor();
   await context.close();results.push({scenario:'service-worker/offline',...cachedMedia,result:'OK'});
   console.log('Service worker startup cached, video excluded, offline reopen: OK');
  }
 }finally{await browser.close()}
}
console.log(JSON.stringify(results,null,2));
await writeFile(new URL(process.argv.includes('--sw-only')?'sw-results.json':process.argv.includes('--webkit-only')?'webkit-results.json':'results.json',out),JSON.stringify(results,null,2));
