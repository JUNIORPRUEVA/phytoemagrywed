// @vitest-environment node
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const html=readFileSync('public/admin/index.html','utf8'),script=readFileSync('public/admin/store.js','utf8');
let dom,w,products,canManage,requests;
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
const tab=async name=>{w.dispatchEvent(new w.CustomEvent('fulltech:tab',{detail:{tab:name}}));await flush();};
beforeEach(()=>{
  dom=new JSDOM(html,{url:'https://fulltech.test/admin/',runScripts:'outside-only'});w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.crypto.randomUUID=()=> 'a1234567-1234-1234-1234-123456789000';
  products=[{id:'p1',name:'Cámara <script>prueba</script>',sku:'CAM-1',kind:'product',quantity:4,min_stock:1,price_cents:125050,cost_cents:60025,active:true,track_stock:true,image_url:'/api/admin/store/products/p1/image'}];
  requests=[];canManage=true;
  w.fetch=vi.fn(async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true,products,movements:[],canManage})};});
  w.eval(script);
});
afterEach(()=>dom.window.close());
it('cada página presenta su función y los nombres del catálogo se tratan como texto',async()=>{
  await tab('catalogo');expect(w.document.querySelector('#store-product-grid script')).toBeNull();
  expect(w.document.querySelector('#store-catalogo').textContent).toContain('Cámara <script>prueba</script>');
  expect(w.document.querySelector('#store-catalogo').textContent).toContain('1,250.50');
  await tab('inventario');expect(w.document.querySelector('#store-inventario').textContent).toContain('Existencias por producto');
  await tab('recuento');expect(w.document.querySelector('#store-recuento').textContent).toContain('Comparar el inventario físico');
});
it('el agente ve artículos sin acciones de administración',async()=>{
  canManage=false;await tab('catalogo');
  expect(w.document.querySelector('[data-store-new]')).toBeNull();expect(w.document.querySelector('[data-store-edit]')).toBeNull();
  expect(w.document.querySelector('#store-catalogo').textContent).not.toContain('Costo:');
  await tab('recuento');expect(w.document.querySelector('#store-stock-form')).toBeNull();
});
it('pasar de inventario a recuento mantiene un único formulario y actualiza su diferencia',async()=>{
  await tab('inventario');await tab('recuento');
  expect(w.document.querySelectorAll('#store-stock-form')).toHaveLength(1);
  const form=w.document.querySelector('#store-stock-form');expect(form.dataset.count).toBe('true');
  form.elements.quantity.value='2';form.elements.quantity.dispatchEvent(new w.Event('input',{bubbles:true}));
  expect(w.document.querySelector('#store-stock-preview').textContent).toContain('Diferencia: -2 · Quedará: 2');
});
it('el recuento incluye la existencia esperada y una operación idempotente',async()=>{
  await tab('recuento');const form=w.document.querySelector('#store-stock-form');
  form.elements.quantity.value='2';form.elements.reason.value='Conteo de cierre';
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  const sent=requests.find(r=>r.options.body);const body=JSON.parse(sent.options.body);
  expect(body).toMatchObject({type:'count',quantity:'2',expected:4,reason:'Conteo de cierre'});expect(body.requestId).toHaveLength(36);
});
it('permite crear un servicio sin inventario y conserva el formulario si el servidor falla',async()=>{
  await tab('catalogo');w.document.querySelector('[data-store-new]').click();
  const form=w.document.querySelector('#store-product-form');form.elements.kind.value='service';
  form.elements.kind.dispatchEvent(new w.Event('change',{bubbles:true}));
  expect([...form.querySelectorAll('[data-stock-field]')].every(x=>x.hidden)).toBe(true);
  form.elements.name.value='Instalación';form.elements.sku.value='INST-1';form.elements.price.value='200.50';form.elements.cost.value='50.25';
  w.fetch.mockResolvedValueOnce({ok:false,json:async()=>({ok:false,message:'Conexión interrumpida'})});
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  expect(form.querySelector('[role=alert]').textContent).toBe('Conexión interrumpida');expect(form.elements.name.value).toBe('Instalación');
  expect(w.document.querySelector('dialog.store-dialog').open).toBe(true);
});
it('cerrar sesión borra el catálogo y cualquier edición con costos visibles',async()=>{
  await tab('catalogo');w.document.querySelector('[data-store-new]').click();
  w.dispatchEvent(new w.Event('phyto:calling-logout'));
  expect(w.document.querySelector('#store-catalogo').textContent).toBe('');
  expect(w.document.querySelector('dialog.store-dialog').open).toBe(false);
  expect(w.document.querySelector('#store-product-form')).toBeNull();
});
