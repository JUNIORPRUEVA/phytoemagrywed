import { chromium } from 'file:///C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output=new URL('../docs/capturas/store-favorites/',import.meta.url);
await mkdir(output,{recursive:true});
const directory=await mkdtemp(path.join(tmpdir(),'fulltech-favorites-browser-'));
for(const key of ['PHYTO_CRM_DATABASE_URL','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_BUSINESS_ACCOUNT_ID','WHATSAPP_VERIFY_TOKEN','META_APP_SECRET','META_APP_ID','PHYTO_META_CAPI_ACCESS_TOKEN','PHYTO_META_PIXEL_ID','PHYTO_WEB_PUSH_PUBLIC_KEY','PHYTO_WEB_PUSH_PRIVATE_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME','R2_ENDPOINT'])process.env[key]='';
const {startCrmServer}=await import('../server/crm-server.mjs');
const app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',uatMode:true,adminDir:path.resolve('public/admin'),dataFile:path.join(directory,'favorites.sqlite'),token:'favorites-browser-uat',quiet:true,schedulerEnabled:false,whatsappMock:true,metaCapi:{enabled:false},storage:{enabled:false},storeOAuth:{},storeSms:{mode:'off'},storeMail:{mode:'off'}});
const browser=await chromium.launch({executablePath:'C:/Users/pc/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',headless:true});
async function api(route,body,cookie){const r=await fetch(app.url+route,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`${route}: ${r.status}`);return {data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
try{
  for(const width of [360,390,430,1280]){
    const context=await browser.newContext({viewport:{width,height:850},reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8898/store/',{waitUntil:'networkidle'});
    await page.locator('#signup-prompt').waitFor({state:'visible'});
    const geometry=await page.evaluate(()=>{
      const a=document.querySelector('.ft-hero__duo img').getBoundingClientRect(),b=document.querySelector('.ft-hero__duo img + img').getBoundingClientRect();
      const google=document.querySelector('#signup-prompt').getBoundingClientRect(),nav=document.querySelector('.ft-nav').getBoundingClientRect();
      return {overflow:document.documentElement.scrollWidth>innerWidth,gap:b.top-a.bottom,imageWidth:a.width,leftOffset:a.left-b.left,rightGap:innerWidth-google.right,navGap:nav.top-google.bottom,fit:getComputedStyle(document.querySelector('.ft-hero__duo img')).objectFit};
    });
    if(geometry.overflow||geometry.gap<10||geometry.imageWidth<110||geometry.leftOffset<20||geometry.rightGap>(width<760?10:32)||geometry.navGap<0||geometry.fit!=='cover')throw Error(JSON.stringify(geometry));
    await page.screenshot({path:fileURLToPath(new URL(`home-${width}.png`,output))});
    await page.locator('[data-favorite]').first().click();
    await page.waitForURL('**/#/favorites');
    await page.getByRole('heading',{name:'Guarda lo que te gusta'}).waitFor();
    if(errors.length)throw Error(errors.join('\n'));
    await context.close();console.log(JSON.stringify({width,...geometry,guestGate:'OK'}));
  }
  const admin=(await api('/api/admin/login',{token:'favorites-browser-uat'})).cookie;
  const home=await (await fetch('http://127.0.0.1:8898/api/store/home')).json();
  for(const [index,p] of home.products.slice(0,2).entries()){
    const imageResponse=await fetch(new URL(p.imageUrl,'http://127.0.0.1:8898'));
    const image=`data:${imageResponse.headers.get('content-type')};base64,${Buffer.from(await imageResponse.arrayBuffer()).toString('base64')}`;
    const product=(await api('/api/admin/store/products',{kind:'product',name:p.name,sku:`FAV-BROWSER-${index}`,price:p.price,cost:1,quantity:3,category:p.category,shortDescription:p.shortDescription,image},admin)).data.product;
    await api(`/api/admin/store/products/${product.id}/publication`,{status:'published',featured:true},admin);
  }
  await api('/api/store/account/register',{name:'Cliente Favoritos UAT',phone:'8095550821',email:'favorites-browser@example.test',password:'Cliente-Uat123'});
  const context=await browser.newContext({viewport:{width:390,height:850},reducedMotion:'reduce',serviceWorkers:'block'}),page=await context.newPage();
  // Use the source storefront for static assets, keeping real account APIs on the disposable server.
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(!url.pathname.startsWith('/store/'))return route.continue();
    const response=await route.fetch({url:'http://127.0.0.1:8898'+url.pathname+url.search});
    return route.fulfill({response});
  });
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url+'/store/',{waitUntil:'networkidle'});
  await page.locator('[data-favorite]').first().click();
  await page.getByRole('link',{name:'Iniciar sesión',exact:true}).click();
  await page.locator('[name="identifier"]').fill('favorites-browser@example.test');
  await page.locator('[name="password"]').fill('Cliente-Uat123');
  await page.locator('#login-form [type="submit"]').click();
  await page.waitForURL('**/#/favorites');
  await page.locator('.ft-favorites-grid [data-favorite][aria-pressed="true"]').waitFor();
  await page.locator('.ft-nav__item[data-route="catalog"]').click();
  await page.locator('[data-favorite][aria-pressed="true"]').waitFor();
  await page.reload({waitUntil:'networkidle'});
  await page.locator('[data-favorite][aria-pressed="true"]').waitFor();
  await page.locator('#menu-button').click();
  await page.locator('#drawer a[data-route="favorites"]').click();
  await page.locator('.ft-favorites-grid [data-favorite][aria-pressed="true"]').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({path:fileURLToPath(new URL('saved-390.png',output))});
  if(await page.locator('#signup-prompt').isVisible())throw Error('Google signup shown to authenticated customer');
  await page.locator('.ft-favorites-grid [data-add-cart]').click();
  await page.locator('.cart-shortcut').waitFor({state:'visible'});
  await page.locator('.ft-favorites-grid [data-favorite]').click();
  await page.getByRole('heading',{name:'Aún no tienes favoritos disponibles'}).waitFor();
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Aún no tienes favoritos disponibles'}).waitFor();
  if(errors.length)throw Error(errors.join('\n'));
  await context.close();console.log('Real login, account persistence, drawer, favorite catalog, add to cart, removal: OK');
}finally{await browser.close();await app.close();await rm(directory,{recursive:true,force:true})}
