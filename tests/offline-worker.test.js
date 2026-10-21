// @vitest-environment node
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
function worker(){
  const handlers={},records=new Map(),shell=new Map([['https://crm.test/admin/index.html',new Response('<html>CRM</html>')],['https://crm.test/admin/pos.js',new Response('export const pos = true;')]]);
  let online=false,status=200;
  const context={URL,Request,Response,Headers,console,setTimeout,clearTimeout,Date,
    self:{location:{origin:'https://crm.test'},addEventListener:(name,fn)=>handlers[name]=fn},
    FullTECHOfflineStore:{get:async k=>records.get(k),remove:async k=>records.delete(k),entries:async()=>[...records.entries()]},
    fetch:async()=>{if(!online)throw new TypeError('offline');return new Response('{}',{status});},
    caches:{match:async(request,options)=>{const u=new URL(typeof request==='string'?request:request.url,'https://crm.test');if(options?.ignoreSearch)u.search='';return shell.get(u.href)?.clone();},
      /*
       * El service worker abre su caché versionada para guardar lo que sirve.
       * El doble tiene que ofrecerla: sin `open` la rama de recursos lanzaba y
       * la prueba fallaba por el arnés, no por el comportamiento.
       */
      open:async()=>({match:async(request,options)=>{const u=new URL(typeof request==='string'?request:request.url,'https://crm.test');if(options?.ignoreSearch)u.search='';return shell.get(u.href)?.clone();},put:async()=>{}})},
  };
  vm.runInNewContext(readFileSync('public/admin/sw.js','utf8'),context);
  return {records,setNetwork:(on,code=200)=>{online=on;status=code;},get:async(path,navigate=false)=>{let promise;handlers.fetch({request:{url:'https://crm.test'+path,method:'GET',mode:navigate?'navigate':'same-origin',headers:new Headers()},respondWith:p=>promise=p});return promise;}};
}
it('el arranque en frío usa el HTML y los módulos con versión usan su JavaScript, nunca HTML como script',async()=>{
  const w=worker();expect(await (await w.get('/admin/?v=catalogo',true)).text()).toContain('<html>');
  expect(await (await w.get('/admin/pos.js?v=7')).text()).toContain('export const pos');
  expect((await w.get('/admin/archivo-inexistente.js')).status).toBe(503);
});
it('sin red, un módulo con OTRA versión se sirve desde la copia guardada (el panel tiene que abrir)',async()=>{
  /*
   * `index.html` pide `/admin/pos.js?v=<versión>` y el armazón guarda
   * `/admin/pos.js`. Si cada publicación cambia la versión y el service worker
   * solo aceptara la coincidencia exacta, el panel NO arrancaría sin conexión
   * hasta abrirlo una vez con red (fallo real, medido en Chromium).
   */
  const w=worker();w.setNetwork(false);
  expect(await (await w.get('/admin/pos.js?v=99')).text()).toContain('export const pos');
});
it('abre imágenes y recibos privados de la cuenta durante 24 h y bloquea acceso tras expirar o cambiar de cuenta',async()=>{
  const w=worker(),identity={key:'ADMIN-1',verifiedAt:Date.now()};w.records.set('identity',identity);
  const path='/api/admin/pos/quotes/pos_123/receipt';
  w.records.set('response:ADMIN-1:https://crm.test'+path,{owner:'ADMIN-1',status:200,headers:[['content-type','text/html']],body:new TextEncoder().encode('Recibo privado').buffer});
  expect(await (await w.get(path,true)).text()).toBe('Recibo privado');
  w.records.set('identity',{key:'AGENT-2',verifiedAt:Date.now()});expect((await w.get(path,true)).status).toBe(503);
  w.records.set('identity',{...identity,verifiedAt:Date.now()-86400001});expect((await w.get(path,true)).status).toBe(503);
});
it('un 401 SOLO cierra el acceso local si viene de los endpoints de sesión',async()=>{
  /*
   * REGLA CORREGIDA: un 401 de un módulo (recibos, llamadas, una ruta de
   * administración) NO significa que la cuenta caducó. Antes borraba la
   * identidad local —y con ella la copia y la cola— por una petición de fondo.
   */
  const modulo=worker();modulo.records.set('identity',{key:'ADMIN-1',verifiedAt:Date.now()});modulo.setNetwork(true,401);
  expect((await modulo.get('/api/admin/pos/quotes/pos_123/receipt',true)).status).toBe(401);
  expect(modulo.records.has('identity')).toBe(true);
  const sesion=worker();sesion.records.set('identity',{key:'ADMIN-1',verifiedAt:Date.now()});sesion.setNetwork(true,401);
  expect((await sesion.get('/api/admin/session')).status).toBe(401);
  expect(sesion.records.has('identity')).toBe(false);
});
