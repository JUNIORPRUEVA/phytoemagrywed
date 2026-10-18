// @vitest-environment node
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const html=readFileSync('public/admin/index.html','utf8'),script=readFileSync('public/admin/store.js','utf8');
let dom,w,products,categories,canManage,requests,sources;
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
const tab=async name=>{w.dispatchEvent(new w.CustomEvent('fulltech:tab',{detail:{tab:name}}));await flush();};
beforeEach(()=>{
  dom=new JSDOM(html,{url:'https://fulltech.test/admin/',runScripts:'outside-only'});w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.crypto.randomUUID=()=> 'a1234567-1234-1234-1234-123456789000';
  Object.defineProperty(w.document,'hidden',{configurable:true,value:false});
  sources=[];w.EventSource=class {constructor(url){this.url=url;this.listeners={};this.closed=false;sources.push(this);}addEventListener(name,fn){this.listeners[name]=fn;}close(){this.closed=true;}};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  products=[{id:'p1',name:'Cámara <script>prueba</script>',sku:'CAM-1',kind:'product',quantity:4,min_stock:1,price_cents:125050,cost_cents:60025,active:true,track_stock:true,image_url:'/api/admin/store/products/p1/image'}];
  requests=[];categories=[];canManage=true;
  w.fetch=vi.fn(async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true,products,categories,movements:[],canManage})};});
  w.eval(script);
});
afterEach(()=>dom.window.close());
it('cada página presenta su función y los nombres del catálogo se tratan como texto',async()=>{
  await tab('catalogo');expect(w.document.querySelector('#store-product-grid script')).toBeNull();
  expect(w.document.querySelector('#store-catalogo').textContent).toContain('Cámara <script>prueba</script>');
  expect(w.document.querySelector('#store-catalogo').textContent).toContain('1,250.50');
  await tab('inventario');expect(w.document.querySelector('#store-inventario').textContent).toContain('Existencias por producto');
  await tab('recuento');expect(w.document.querySelector('#store-recuento').textContent).toContain('unidades contadas');
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
  expect([...w.document.querySelectorAll('#store-stock-preview strong')].map(n=>n.textContent)).toEqual(['4','-2','2']);
});
it('el recuento incluye la existencia esperada y una operación idempotente',async()=>{
  await tab('recuento');const form=w.document.querySelector('#store-stock-form');
  form.elements.quantity.value='2';form.elements.reason.value='Conteo de cierre';
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  const sent=requests.find(r=>r.options.body);const body=JSON.parse(sent.options.body);
  expect(body).toMatchObject({type:'count',quantity:'2',expected:4,reason:'Conteo de cierre'});expect(body.requestId).toHaveLength(36);
});
it('permite crear un servicio sin inventario y conserva el formulario si el servidor falla',async()=>{
  await tab('catalogo');w.dispatchEvent(new w.Event('fulltech:store-create'));
  const form=w.document.querySelector('#store-product-form');form.elements.kind.value='service';
  form.elements.kind.dispatchEvent(new w.Event('change',{bubbles:true}));
  expect([...form.querySelectorAll('[data-stock-field]')].every(x=>x.hidden)).toBe(true);
  form.elements.name.value='Instalación';form.elements.sku.value='INST-1';form.elements.price.value='200.50';form.elements.cost.value='50.25';
  w.fetch.mockResolvedValueOnce({ok:false,json:async()=>({ok:false,message:'Conexión interrumpida'})});
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  expect(form.querySelector('[role=alert]').textContent).toBe('Conexión interrumpida');expect(form.elements.name.value).toBe('Instalación');
  expect(w.document.querySelector('dialog.store-product-dialog').open).toBe(true);
});
it('cerrar sesión borra el catálogo y cualquier edición con costos visibles',async()=>{
  await tab('catalogo');w.dispatchEvent(new w.Event('fulltech:store-create'));
  w.dispatchEvent(new w.Event('phyto:calling-logout'));
  expect(w.document.querySelector('#store-catalogo').textContent).toBe('');
  expect(w.document.querySelector('dialog.store-product-dialog').open).toBe(false);
  expect(w.document.querySelector('#store-product-form')).toBeNull();
  expect(sources.every(s=>s.closed)).toBe(true);
});
it('muestra productos sin grupos ni contadores y filtra categorías sin distinguir mayúsculas',async()=>{
  products[0].category='Phytoemagry';
  products.push({...products[0],id:'p2',name:'Frasco 10',category:' phytoemagry ',sku:'PHY-10'});
  products.push({...products[0],id:'p3',name:'Cable',category:'Accesorios',sku:'CAB-1'});
  await tab('catalogo');
  expect(w.document.querySelectorAll('.store-category-group,.store-group-heading,#store-result-count')).toHaveLength(0);
  expect(w.document.querySelectorAll('#store-product-grid .store-items')).toHaveLength(1);
  expect(w.document.querySelectorAll('[data-store-detail]')).toHaveLength(3);
  w.document.querySelector('[data-store-filters]').click();
  const radio=w.document.querySelector('input[name=category][value="phytoemagry"]');radio.checked=true;radio.dispatchEvent(new w.Event('change',{bubbles:true}));
  expect(w.document.querySelectorAll('[data-store-detail]')).toHaveLength(2);
  expect(w.document.querySelector('#store-product-grid').textContent).not.toContain('Cable');
  expect(radio.checked).toBe(true);expect(w.document.querySelector('.store-filter-dot')).not.toBeNull();
});
it('usa tarjetas compactas, alterna lista/cuadrícula y conserva la preferencia',async()=>{
  await tab('catalogo');
  const card=w.document.querySelector('[data-store-detail]');
  expect(card.textContent).not.toContain('600.25');expect(card.textContent).not.toContain('unidades');expect(card.textContent).not.toContain('CAM-1');
  expect(w.document.querySelector('[data-store-sale],[data-store-refresh]')).toBeNull();
  expect(w.document.querySelector('[data-pos-actions]').getAttribute('aria-label')).toBe('Acciones de facturación');
  w.document.querySelector('[data-store-filters]').click();w.document.querySelector('[data-store-layout="list"]').click();
  expect(w.document.querySelector('#store-product-grid').dataset.layout).toBe('list');
  expect(w.localStorage.getItem('fulltech.catalog.layout')).toBe('list');
});
it('abre una página de detalle con enlace propio, regresa y respeta la privacidad del agente',async()=>{
  products[0].description='Descripción completa';await tab('catalogo');
  w.document.querySelector('[data-store-detail]').click();
  expect(new URL(w.location.href).searchParams.get('product')).toBe('p1');
  expect(w.document.querySelector('#store-detail-title').textContent).toBe(products[0].name);
  expect(w.document.querySelector('.store-detail').textContent).toContain('600.25');
  expect(w.document.querySelector('.store-detail').textContent).toContain('Descripción completa');
  expect(w.document.querySelector('[data-store-back],.store-detail-nav')).toBeNull();
  w.dispatchEvent(new w.CustomEvent('fulltech:back',{cancelable:true}));await new Promise(r=>setTimeout(r,20));await flush();expect(w.document.querySelector('#store-search')).not.toBeNull();
  canManage=false;await tab('inventario');await tab('catalogo');w.document.querySelector('[data-store-detail]').click();
  expect(w.document.querySelector('.store-detail').textContent).not.toContain('600.25');expect(w.document.querySelector('[data-store-edit]')).toBeNull();
});
it('recibe cambios en vivo sin perder búsqueda ni un recuento en curso',async()=>{
  await tab('catalogo');const search=w.document.querySelector('#store-search');search.value='Cámara';search.dispatchEvent(new w.Event('input',{bubbles:true}));search.focus();search.setSelectionRange(2,2);
  w.document.querySelector('#store-product-grid').scrollTop=120;
  products[0].price_cents=200000;sources.at(-1).listeners['catalog.changed']();await flush();
  expect(w.document.querySelector('#store-product-grid').scrollTop).toBe(120);
  expect(w.document.querySelector('#store-search').value).toBe('Cámara');expect(w.document.activeElement.id).toBe('store-search');
  expect(w.document.querySelector('#store-search').selectionStart).toBe(2);expect(w.document.querySelector('.store-price').textContent).toContain('2,000.00');
  await tab('recuento');let form=w.document.querySelector('#store-stock-form');form.elements.quantity.value='2';form.elements.reason.value='Conteo físico';form.elements.reason.focus();
  products[0].quantity=3;sources.at(-1).listeners['catalog.changed']();await flush();form=w.document.querySelector('#store-stock-form');
  expect(form.elements.quantity.value).toBe('2');expect(form.elements.reason.value).toBe('Conteo físico');expect(form.dataset.expected).toBe('4');
  expect(w.document.activeElement).toBe(form.elements.reason);
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  expect(JSON.parse(requests.find(r=>r.options.body).options.body).expected).toBe(4);
});
it('una respuesta sin sesión al iniciar no interrumpe el formulario de acceso',async()=>{
  const expired=vi.fn();w.addEventListener('fulltech:session-expired',expired);
  w.fetch.mockResolvedValueOnce({ok:false,status:401,json:async()=>({ok:false})});
  await tab('catalogo');expect(expired).not.toHaveBeenCalled();
});
it('una sesión caducada cierra las conexiones y borra el contenido privado',async()=>{
  await tab('catalogo');const expired=vi.fn(()=>w.dispatchEvent(new w.Event('phyto:calling-logout')));
  w.addEventListener('fulltech:session-expired',expired);
  w.fetch.mockResolvedValueOnce({ok:false,status:401,json:async()=>({ok:false})});
  sources.at(-1).listeners['catalog.changed']();await flush();
  expect(expired).toHaveBeenCalledOnce();expect(w.document.querySelector('#store-catalogo').textContent).toBe('');expect(sources.at(-1).closed).toBe(true);
});
it('crea una categoría desde el artículo sin perder sus campos ni cerrar su formulario',async()=>{
  await tab('catalogo');w.dispatchEvent(new w.Event('fulltech:store-create'));
  const productForm=w.document.querySelector('#store-product-form');productForm.elements.name.value='Cámara';productForm.elements.price.value='900.50';
  productForm.querySelector('[data-category-new]').click();
  const categoryForm=w.document.querySelector('#store-category-form');categoryForm.elements.name.value='Seguridad';
  const c={id:'category_new',name:'Seguridad',image_url:'/api/admin/store/categories/category_new/image'};
  categories.push(c);w.fetch.mockResolvedValueOnce({ok:true,json:async()=>({ok:true,category:c})});
  categoryForm.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  expect(productForm.elements.category_id.value).toBe(c.id);expect(productForm.elements.name.value).toBe('Cámara');expect(productForm.elements.price.value).toBe('900.50');
  expect(w.document.querySelector('.store-product-dialog').open).toBe(true);expect(w.document.querySelector('.store-category-dialog').open).toBe(false);
});
it('filtros están en el panel derecho y combinan categoría, tipo y vista',async()=>{
  products[0].category='Seguridad';products.push({...products[0],id:'p2',kind:'service',name:'Instalación'});
  categories=[{id:'cat1',name:'Seguridad',image_url:'/category.png'}];await tab('catalogo');
  expect(w.document.querySelector('#store-catalogo select')).toBeNull();expect(w.document.querySelector('.store-category-bar')).toBeNull();
  w.document.querySelector('[data-store-filters]').click();const drawer=w.document.querySelector('.store-filter-drawer');
  expect(drawer.open).toBe(true);expect(drawer.querySelector('img').getAttribute('src')).toBe('/category.png');
  const type=drawer.querySelector('[name=kind][value=service]');type.checked=true;type.dispatchEvent(new w.Event('change',{bubbles:true}));
  expect(w.document.querySelectorAll('[data-store-detail]')).toHaveLength(1);expect(w.document.querySelector('#store-product-grid').textContent).toContain('Instalación');
  const back=new w.CustomEvent('fulltech:back',{cancelable:true});w.dispatchEvent(back);expect(back.defaultPrevented).toBe(true);expect(drawer.open).toBe(false);
});
it('volver del detalle consume una sola entrada de historial y no vuelve a abrirlo al salir',async()=>{
  await tab('catalogo');const before=w.history.length;w.document.querySelector('[data-store-detail]').click();expect(w.history.length).toBe(before+1);
  const back=new w.CustomEvent('fulltech:back',{cancelable:true});w.dispatchEvent(back);await new Promise(r=>setTimeout(r,20));await flush();
  expect(back.defaultPrevented).toBe(true);expect(new URL(w.location.href).searchParams.has('product')).toBe(false);expect(w.document.querySelector('#store-search')).not.toBeNull();
  const exit=new w.CustomEvent('fulltech:back',{cancelable:true});w.dispatchEvent(exit);expect(exit.defaultPrevented).toBe(false);
});
it('salir de la pantalla cierra formularios y filtros para no dejar una capa pendiente al volver',async()=>{
  await tab('catalogo');w.dispatchEvent(new w.Event('fulltech:store-create'));await tab('hoy');
  expect(w.document.querySelector('.store-product-dialog').open).toBe(false);
  await tab('catalogo');w.document.querySelector('[data-store-filters]').click();await tab('hoy');
  expect(w.document.querySelector('.store-filter-drawer').open).toBe(false);
});
it('filtra productos de ajuste por búsqueda y categoría sin permitir guardar resultados vacíos',async()=>{
  products[0].category='Equipos';products.push({...products[0],id:'p2',name:'Cable',sku:'CAB',category:'Accesorios'});
  await tab('inventario');const search=w.document.querySelector('#stock-search'),category=w.document.querySelector('#stock-category'),form=w.document.querySelector('#store-stock-form');
  category.value='Accesorios';category.dispatchEvent(new w.Event('change',{bubbles:true}));expect(form.elements.productId.value).toBe('p2');
  search.value='inexistente';search.dispatchEvent(new w.Event('input',{bubbles:true}));expect(form.querySelector('[type=submit]').disabled).toBe(true);
  search.value='Cable';search.dispatchEvent(new w.Event('input',{bubbles:true}));expect(form.querySelector('[type=submit]').disabled).toBe(false);expect(form.elements.productId.value).toBe('p2');
});
it('ajusta el saldo compartido en cápsulas usando la API de inventario',async()=>{
  products=[{...products[0],id:'capsules_5',legacy:true,base_quantity:100,quantity:20}];
  await tab('inventario');const form=w.document.querySelector('#store-stock-form');
  expect(w.document.querySelector('#stock-quantity-label').textContent).toBe('Cantidad de cápsulas');
  form.elements.quantity.value='3';form.elements.type.value='out';form.elements.reason.value='Prueba';form.elements.quantity.dispatchEvent(new w.Event('input',{bubbles:true}));
  expect([...w.document.querySelectorAll('#store-stock-preview div strong')].map(n=>n.textContent)).toEqual(['100','-3','97']);
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  const sent=requests.find(r=>r.url==='/api/admin/inventory/adjust');expect(JSON.parse(sent.options.body)).toMatchObject({direction:'out',quantity:3,reason:'Prueba'});
});
