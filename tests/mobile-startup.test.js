// @vitest-environment node
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {describe,it,expect,vi} from 'vitest';
const read=name=>readFileSync('public/admin/'+name,'utf8');
function worker({network,cached={}}){
 const handlers=new Map(),puts=[];
 const match=async(request,options={})=>{
  const url=new URL(typeof request==='string'?request:request.url,'https://test.example');
  return cached[options.ignoreSearch?url.pathname:url.pathname+url.search]?.clone();
 };
 const cache={put:async(req,res)=>puts.push([req.url,res.headers.get('content-type')])};
 vm.runInNewContext(read('sw.js'),{URL,Request,Response,Headers,fetch:network,caches:{open:async()=>cache,match},self:{location:{origin:'https://test.example'},addEventListener:(key,fn)=>handlers.set(key,fn)}});
 return{puts,fetch:async(path)=>{let promise;handlers.get('fetch')({request:new Request('https://test.example'+path),respondWith:value=>promise=value});return await promise;}};
}
const offline=async()=>{throw new Error('offline');};
describe('arranque móvil: recursos de caché válidos',()=>{
 it('recupera el script con ?v desde el archivo base guardado sin conexión',async()=>{
  const sw=worker({network:offline,cached:{'/admin/app.js':new Response('window.app=true',{headers:{'content-type':'application/javascript'}}),'/admin/index.html':new Response('<html>shell</html>')}});
  const res=await sw.fetch('/admin/app.js?v=108');expect(await res.text()).toBe('window.app=true');
 });
 it('un script ausente nunca recibe el HTML de la página',async()=>{
  const sw=worker({network:offline,cached:{'/admin/index.html':new Response('<html>shell</html>')}});
  const res=await sw.fetch('/admin/missing.js?v=108');expect(res.status).toBe(503);expect(await res.text()).not.toContain('<html>');
 });
 it('rechaza HTML entregado como JavaScript y conserva la copia válida',async()=>{
  const sw=worker({network:async()=>new Response('<html>error</html>',{headers:{'content-type':'text/html'}}),cached:{'/admin/app.js':new Response('valid script',{headers:{'content-type':'application/javascript'}})}});
  const res=await sw.fetch('/admin/app.js?v=108');expect(await res.text()).toBe('valid script');expect(sw.puts).toHaveLength(0);
 });
 it('sí usa el HTML como respaldo al abrir la aplicación sin red',async()=>{
  const sw=worker({network:offline,cached:{'/admin/index.html':new Response('<html>shell</html>')}});
  expect(await(await sw.fetch('/admin/?v=hoy')).text()).toContain('<html>');
 });
});
describe('actualización de la app instalada',()=>{
 it.each([['/admin/app.js',false],['/admin/fulltech-logo.png',true]])('archivo ausente %s: activación=%s',async(missing,activated)=>{
  const handlers=new Map(),skipWaiting=vi.fn();let install;
  vm.runInNewContext(read('sw.js'),{self:{addEventListener:(key,fn)=>handlers.set(key,fn),skipWaiting},caches:{open:async()=>({add:async path=>{if(path===missing)throw new Error('network interrupted');}})}});
  handlers.get('install')({waitUntil:promise=>install=promise});
  if(activated){await install;expect(skipWaiting).toHaveBeenCalledTimes(1);}else{await expect(install).rejects.toThrow('network interrupted');expect(skipWaiting).not.toHaveBeenCalled();}
 });
});
describe('salida visible ante fallos del inicio',()=>{
 it('muestra recuperación ante un fallo de arranque y no borra el borrador local',()=>{
  const dom=new JSDOM(read('index.html'),{url:'https://test.example/admin/',runScripts:'outside-only'}),win=dom.window;
  win.localStorage.setItem('pending-order','keep');win.eval(read('startup-recovery.js'));
  win.dispatchEvent(new win.Event('fulltech:startup-failed'));
  expect(win.document.querySelector('#startup-recovery').textContent).toContain('Volver a cargar');expect(win.localStorage.getItem('pending-order')).toBe('keep');dom.window.close();
 });
 it('no tapa una sesión que ya terminó de iniciar por un error posterior',()=>{
  const dom=new JSDOM(read('index.html'),{url:'https://test.example/admin/',runScripts:'outside-only'}),win=dom.window;
  win.eval(read('startup-recovery.js'));win.dispatchEvent(new win.Event('fulltech:startup-ready'));win.dispatchEvent(new win.Event('fulltech:startup-failed'));
  expect(win.document.querySelector('#startup-recovery')).toBeNull();win.close();
 });
 it('abre la entrada aunque el teléfono bloquee localStorage',async()=>{
  const dom=new JSDOM(read('index.html'),{url:'https://test.example/admin/',runScripts:'outside-only'}),win=dom.window;
  Object.defineProperty(win,'localStorage',{get(){throw new win.DOMException('Blocked','SecurityError');}});
  win.matchMedia=()=>({matches:false,addEventListener(){}});win.scrollTo=()=>{};
  win.fetch=vi.fn(async()=>new Response(JSON.stringify({ok:false}),{status:401}));
  expect(()=>win.eval(read('app.js'))).not.toThrow();win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(win.document.querySelector('#login').hidden).toBe(false);win.close();
 });
 it('una consulta de sesión sin respuesta termina en la entrada, sin quedar bloqueada',async()=>{
  const dom=new JSDOM(read('index.html'),{url:'https://test.example/admin/',runScripts:'outside-only'}),win=dom.window;
  win.matchMedia=()=>({matches:false,addEventListener(){}});win.scrollTo=()=>{};
  win.fetch=()=>new Promise(()=>{});
  const schedule=win.setTimeout.bind(win);win.setTimeout=(fn,ms,...args)=>schedule(fn,ms===8000?0:ms,...args);
  win.eval(read('app.js'));win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await new Promise(resolve=>setTimeout(resolve,30));expect(win.document.querySelector('#login').hidden).toBe(false);win.close();
 });

});
