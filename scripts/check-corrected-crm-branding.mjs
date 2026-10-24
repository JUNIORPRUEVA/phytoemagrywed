import {chromium} from 'file:///C:/Users/pc/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=new URL('../docs/capturas/corrected-store-crm-branding/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Users/pc/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',headless:true});
const results=[];
try{
 for(const width of process.argv.includes('--drawer-only')?[]:[360,390,430,1280]){
  for(const colorScheme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:850},colorScheme,reducedMotion:'reduce',serviceWorkers:'block'});
   const page=await context.newPage();
   await page.goto('http://127.0.0.1:8798/admin/',{waitUntil:'networkidle'});
   await page.locator('#login').waitFor({state:'visible'});
   const branding=await page.locator('.login__logo').evaluate(image=>({src:image.currentSrc,loaded:image.complete&&image.naturalWidth>0,width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height}));
   if(!branding.loaded||!branding.src.includes('/admin/assets/branding/fulltech-crm-256.png'))throw Error(JSON.stringify(branding));
   const manifestResponse=await page.request.get('http://127.0.0.1:8798/admin/manifest.json');
   const manifest=await manifestResponse.json();
   if(!manifest.icons.every(icon=>icon.src.includes('/admin/assets/branding/fulltech-crm-')))throw Error('CRM manifest still references another identity');
   for(const icon of manifest.icons){const response=await page.request.get('http://127.0.0.1:8798'+icon.src);if(!response.ok())throw Error(`Missing CRM icon ${icon.src}`)}
   await page.screenshot({path:fileURLToPath(new URL(`crm-login-${width}-${colorScheme}.png`,out))});
   results.push({width,colorScheme,branding,manifest:'OK'});
   await context.close();
  }
 }
 // Use an existing local UAT session; no business records are modified.
 const context=await browser.newContext({viewport:{width:390,height:850},reducedMotion:'reduce',serviceWorkers:'block'});
 const page=await context.newPage();
 await page.goto('http://127.0.0.1:8798/admin/?token=phyto-uat',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'Abrir menú',exact:true}).filter({visible:true}).click();
 await page.locator('#drawer').waitFor({state:'visible'});
 const menuLogo=await page.locator('#drawer .drawer__logo img').evaluate(image=>({src:image.currentSrc,loaded:image.complete&&image.naturalWidth>0}));
 if(!menuLogo.loaded||!menuLogo.src.includes('fulltech-crm-256.png'))throw Error('CRM drawer logo failed');
 await page.screenshot({path:fileURLToPath(new URL('crm-drawer-390.png',out))});
 results.push({drawer:menuLogo});await context.close();
 await writeFile(new URL(process.argv.includes('--drawer-only')?'crm-drawer-results.json':'crm-results.json',out),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
}finally{await browser.close()}
