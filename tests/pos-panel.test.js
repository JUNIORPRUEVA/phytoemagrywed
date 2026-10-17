// @vitest-environment node
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {calculateSale} from '../public/admin/pos-math.js';
const script=readFileSync('public/admin/pos.js','utf8').replace(/^import[^\n]+\n/,'');
const store=readFileSync('public/admin/store.js','utf8');
let dom,w,requests,admin,customers,fail,products;
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
const click=s=>w.document.querySelector(s).click();
const fill=(name,value)=>{w.document.querySelector(`.pos-dialog [name=${name}]`).value=value;};
const submit=async()=>{w.document.querySelector('.pos-modal-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();};
beforeEach(async()=>{
  dom=new JSDOM(readFileSync('public/admin/index.html','utf8'),{url:'https://fulltech.test/admin/?v=catalogo',runScripts:'outside-only'});w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.HTMLElement.prototype.scrollIntoView=function(){};
  w.structuredClone=structuredClone;w.calculateSale=calculateSale;w.EventSource=class{addEventListener(){}close(){}};
  w.crypto.randomUUID=()=> 'b1234567-1234-1234-1234-123456789000';
  requests=[];admin=true;fail=false;customers=[{id:'c1',name:'Cliente <script>',phone_e164:'+18095550101'}];
  products=[{id:'p1',name:'Producto Fulltech',sku:'P1',active:true,kind:'product',track_stock:true,quantity:5,price_cents:125050,cost_cents:60025,image_url:'/image'}];
  w.fetch=vi.fn(async(url,options={})=>{requests.push({url,...options});
    const data=url.endsWith('/store/products')?{products,categories:[],movements:[],canManage:admin}:url.endsWith('/pos/customers')?{customers,isAdmin:admin,canCreate:true,actorId:admin?'admin':'agent'}:{orderId:'order1',receiptUrl:'/api/admin/orders/order1/receipt'};
    return {ok:!fail,json:async()=>({ok:!fail,...data,...(fail?{message:'Prueba de conexión'}:{})})};
  });
  w.eval(store);w.eval(script);w.dispatchEvent(new w.CustomEvent('fulltech:tab',{detail:{tab:'catalogo'}}));await flush();
});
afterEach(()=>dom.window.close());
it('sin carrito deshabilita acciones, imagen abre detalle y el nombre agrega sin navegar',async()=>{
  expect(w.document.querySelector('[data-pos-pay]').disabled).toBe(true);
  click('[data-pos-add]');expect(w.document.querySelector('.pos-total').textContent).toContain('1,250.50');
  expect(w.location.search).not.toContain('product=');expect(w.document.querySelector('.pos-card-quantity').textContent).toBe('1');
  click('[data-store-detail]');expect(w.location.search).toContain('product=p1');expect(w.document.querySelector('#store-detail-title').textContent).toBe('Producto Fulltech');
});
it('permite cantidades, descuentos por línea y total, y eliminar artículos',async()=>{
  click('[data-pos-add]');click('[data-pos-add]');click('[data-pos-expand]');
  expect(w.document.querySelector('[data-pos-quantity]').textContent).toBe('2');
  click('[data-pos-discount="0"]');fill('type','amount');fill('value','0.01');await submit();
  click('[data-pos-discount="total"]');fill('type','percent');fill('value','10');await submit();
  expect(w.document.querySelector('.pos-total').textContent).toContain('2,250.89');expect(w.document.querySelector('.pos-profit').textContent).toContain('1,050.39');
  click('[data-pos-delete]');expect(w.document.querySelector('[data-pos-pay]').disabled).toBe(true);
});
it('recibe cliente y chat, confirma la cotización y envía el contexto y total exactos',async()=>{
  w.dispatchEvent(new w.CustomEvent('fulltech:pos-context',{detail:{customerId:'c1',conversationId:'chat1'}}));await flush();
  click('[data-pos-add]');click('[data-pos-quote]');
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Confirmar cotización');
  expect(requests.some(r=>r.url.endsWith('/quotes'))).toBe(false);
  await submit();const sent=requests.find(r=>r.url.endsWith('/quotes'));expect(JSON.parse(sent.body)).toMatchObject({customerId:'c1',conversationId:'chat1',expectedTotal:125050,items:[{variantId:'p1',quantity:1}]});
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Cotización guardada');expect(w.document.querySelector('[data-pos-pay]').disabled).toBe(true);
});
it('el cobro exige importe suficiente y conserva la clave tras un fallo de red',async()=>{
  w.dispatchEvent(new w.CustomEvent('fulltech:pos-context',{detail:{customerId:'c1'}}));await flush();click('[data-pos-add]');click('[data-pos-pay]');await flush();
  fill('received','100');await submit();expect(requests.some(r=>r.url.endsWith('/checkout'))).toBe(false);
  fill('received','1300');const original=w.fetch;let dropped=true;
  w.fetch=async(url,options)=>{if(url.endsWith('/checkout')&&dropped){dropped=false;requests.push({url,...options});throw new Error('Red interrumpida');}return original(url,options);};
  await submit();expect(w.document.querySelector('.pos-modal-error').textContent).toContain('Red interrumpida');
  await submit();const calls=requests.filter(r=>r.url.endsWith('/checkout'));expect(calls).toHaveLength(2);expect(calls[0].body).toBe(calls[1].body);
});
it('un agente no ve ganancia y al cerrar sesión se limpia el carrito privado',async()=>{
  w.dispatchEvent(new w.Event('phyto:calling-logout'));admin=false;products=products.map(({cost_cents,...p})=>p);
  w.dispatchEvent(new w.CustomEvent('fulltech:tab',{detail:{tab:'catalogo'}}));await flush();click('[data-pos-add]');
  expect(w.document.querySelector('.pos-profit')).toBeNull();expect(w.document.querySelector('#pos-client script')).toBeNull();
  w.dispatchEvent(new w.Event('phyto:calling-logout'));expect(w.document.querySelector('#pos-root').textContent).toBe('');expect(w.sessionStorage.getItem('fulltech.pos.draft.agent')).toBeNull();
});
it('el carrito responde al gesto vertical y se conserva al actualizar catálogo',()=>{
  click('[data-pos-add]');const handle=w.document.querySelector('[data-pos-expand]');
  for(const [type,y] of [['pointerdown',500],['pointerup',300]]){const event=new w.Event(type,{bubbles:true});Object.defineProperty(event,'clientY',{value:y});handle.dispatchEvent(event);}
  expect(w.document.querySelector('#pos-root').classList.contains('pos-expanded')).toBe(true);
  w.dispatchEvent(new w.CustomEvent('fulltech:pos-products',{detail:{products:[{...products[0],price_cents:130000}]}}));expect(w.document.querySelector('.pos-total').textContent).toContain('1,300.00');
});
