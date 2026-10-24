import {startCrmServer} from '../server/crm-server.mjs';
import {createServer} from 'node:http';
import {mkdtemp,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'fulltech-customer-uat-'));
const app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'isolated-customer-uat',quiet:true,schedulerEnabled:false,metaCapi:{enabled:false},whatsapp:{enabled:false},storeOAuth:{},storeSms:{},storeMail:{}});
const root=path.resolve('public'),out='docs/capturas/customer-uat';await mkdir(out,{recursive:true});
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);const upstream=await fetch(app.url+req.url,{method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host},redirect:'manual',...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.statusCode=upstream.status;for(const [k,v]of upstream.headers)if(!['set-cookie','transfer-encoding','content-encoding','content-length'].includes(k))res.setHeader(k,v);const cookies=upstream.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);res.end(Buffer.from(await upstream.arrayBuffer()));return;}
 const url=new URL(req.url,'http://local');const file=path.resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(process.env.CUSTOMER_UAT_PREVIEW==='1'?4177:0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
if(process.env.CUSTOMER_UAT_PREVIEW==='1'){
 console.log(`UAT aislada: ${base}/store/ · SQLite temporal: ${dir} · scheduler y proveedores externos desactivados`);
 await new Promise(resolve=>process.once('SIGINT',resolve));
 await new Promise(r=>server.close(r));await app.close();process.exit(0);
}
const browser=await chromium.launch();const results=[];
try{
for(const [width,height]of [[320,568],[375,667],[390,844],[412,915],[430,932]]){
 const c=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});const p=await c.newPage();p.setDefaultTimeout(10000);const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});p.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/'))console.log('API ERROR',new URL(r.url()).pathname,r.status(),await r.text().catch(()=>''));});
 await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 // Capture the committed UI before these refinements, with the same viewport.
 await c.route('**/store/**',async r=>{const pathname=new URL(r.request().url()).pathname;const file=pathname==='/store/'?'public/store/index.html':'public'+pathname;try{if(/\.(css|js|html)$/.test(file)){const body=execFileSync('git',['show',`HEAD:${file}`]);await r.fulfill({body,contentType:mime[path.extname(file)]});return;}}catch{}await r.continue();});
 await p.goto(base+'/store/',{waitUntil:'networkidle'});await p.locator('#menu-button').click();await p.screenshot({path:`${out}/before-drawer-${width}.png`,animations:'disabled'});
 await c.unroute('**/store/**');await p.goto(base+'/store/',{waitUntil:'networkidle'});await p.locator('#menu-button').click();await p.screenshot({path:`${out}/after-guest-${width}.png`,animations:'disabled'});
 assert.equal(await p.locator('#drawer > [data-route="request"]').count(),0);
 await p.locator('#drawer-customer').getByRole('link',{name:'Regístrate',exact:true}).click();await p.getByRole('link',{name:'Crear cuenta manual',exact:true}).click();
 const email=`uat-${width}@example.test`,password='Cliente-Uat-123';
 const f=p.locator('#manual-form');await f.locator('[name=name]').fill('Ana');await f.locator('[name=surname]').fill('UAT');await f.locator('[name=email]').fill(email);await f.locator('[name=password]').fill(password);await f.locator('[name=confirm]').fill(password);await f.getByRole('button',{name:'Continuar',exact:true}).click();
 await p.locator('#welcome-form').waitFor().catch(async e=>{await p.screenshot({path:`${out}/failure-${width}.png`});console.log(await p.locator('#auth-error').textContent());throw e;});assert.ok(await p.getByRole('heading',{name:'¡Bienvenido, Ana!'}).count());await p.screenshot({path:`${out}/welcome-${width}.png`});
 const me=async()=>{const r=await c.request.get(base+'/api/store/account/me');return (await r.json()).account;};
 await p.locator('#welcome-form [name=phone]').fill('80912');await p.locator('#welcome-form').getByRole('button',{name:'Continuar',exact:true}).click();await p.locator('#welcome-error').filter({hasText:'WhatsApp válido'}).waitFor();assert.equal((await me()).onboarding,'pending');
 await p.locator('#welcome-form [name=phone]').fill(`8095550${width}`);await p.locator('#welcome-form [name=city]').fill('Higüey');
 // Exercise server save failure as well as field validation.
 await c.route('**/api/store/account/me',r=>r.request().method()==='PATCH'?r.fulfill({status:503,json:{message:'Servicio temporalmente no disponible'}}):r.continue());
 await p.locator('#welcome-form').getByRole('button',{name:'Continuar',exact:true}).click();await p.locator('#welcome-error').filter({hasText:'temporalmente'}).waitFor();assert.equal((await me()).onboarding,'pending');await c.unroute('**/api/store/account/me');
 await p.locator('#welcome-form').getByRole('button',{name:'Continuar',exact:true}).click();await p.locator('#profile-form').waitFor();assert.equal((await me()).city,'Higüey');assert.equal((await me()).onboarding,'completed');
 await p.locator('#profile-form [name=city]').fill('Santo Domingo');await p.locator('#profile-form').getByRole('button',{name:'Guardar datos'}).click();await p.getByText('Tus datos se guardaron',{exact:true}).waitFor();assert.equal((await me()).city,'Santo Domingo');await p.screenshot({path:`${out}/profile-${width}.png`});
 await p.locator('#menu-button').click();await p.locator('#drawer-customer strong').filter({hasText:'Ana'}).waitFor();await p.screenshot({path:`${out}/after-member-${width}.png`,animations:'disabled'});
 await p.locator('#drawer-customer').getByRole('link',{name:'Mis pedidos',exact:true}).click();await p.getByRole('heading',{name:'Todavía no hay pedidos'}).waitFor();
 await p.goto(base+'/store/#/favorites',{waitUntil:'networkidle'});await p.getByRole('heading',{name:'Aún no tienes favoritos disponibles'}).waitFor();
 await p.goto(base+'/store/#/request',{waitUntil:'networkidle'});await p.locator('#catalog-result').waitFor();assert.equal(await p.locator('#request-form').count(),0);
 const requests=await c.request.post(base+'/api/store/requests',{data:{title:'No se crea',kind:'product'}});assert.equal(requests.status(),410);
 await p.goto(base+'/store/#/account',{waitUntil:'networkidle'});await p.locator('#logout').click();await p.locator('#menu-button').click();await p.locator('#drawer-customer').getByRole('link',{name:'Iniciar sesión',exact:true}).click();
 await p.locator('#login-form [name=identifier]').fill(email);await p.locator('#login-form [name=password]').fill(password);await p.locator('#login-form').getByRole('button',{name:'Entrar',exact:true}).click();await p.locator('#profile-form').waitFor();assert.equal(await p.locator('#welcome-form').count(),0);assert.equal((await me()).city,'Santo Domingo');
 // A separate account intentionally skips; reload and re-login must preserve skip.
 await p.locator('#logout').click();await p.locator('#login-form').waitFor();await p.goto(base+'/store/#/account/register/manual',{waitUntil:'networkidle'});
 for(const [name,value]of Object.entries({name:'Luis',surname:'UAT',email:`skip-${width}@example.test`,password,confirm:password}))await p.locator(`#manual-form [name=${name}]`).fill(value);
 await p.locator('#manual-form').getByRole('button',{name:'Continuar'}).click();await p.locator('#welcome-skip').click();await p.locator('#profile-form').waitFor();assert.equal((await me()).onboarding,'skipped');await p.reload({waitUntil:'networkidle'});await p.locator('#profile-form').waitFor();
 assert.equal((await c.request.get(base+'/api/store/account/requests')).status(),410);
 await p.locator('#logout').click();await p.locator('#login-form').waitFor();await p.locator('#login-form [name=identifier]').fill(`skip-${width}@example.test`);await p.locator('#login-form [name=password]').fill(password);await p.locator('#login-form').getByRole('button',{name:'Entrar',exact:true}).click();await p.locator('#profile-form').waitFor();assert.equal((await me()).onboarding,'skipped');
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 results.push({width,height,registration:true,persistence:true,saveFailure:true,skip:true,login:true,sourcingRetired:true,errors});await c.close();
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({results,database:dir}));
}catch(e){console.error(e);throw e;}finally{await browser.close();await new Promise(r=>server.close(r));await app.close();}
