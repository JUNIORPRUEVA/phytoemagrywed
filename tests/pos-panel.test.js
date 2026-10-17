// @vitest-environment node
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {calculateSale} from '../public/admin/pos-math.js';
const script=readFileSync('public/admin/pos.js','utf8').replace(/^import[^\n]+\n/,'');
const store=readFileSync('public/admin/store.js','utf8');
let dom,w,requests,admin,customers,fail,products,tickets,ticketCounter;
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
const click=s=>w.document.querySelector(s).click();
const fill=(name,value)=>{w.document.querySelector(`.pos-dialog [name=${name}]`).value=value;};
const submit=async()=>{w.document.querySelector('.pos-modal-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await flush();};
beforeEach(async()=>{
  dom=new JSDOM(readFileSync('public/admin/index.html','utf8'),{url:'https://fulltech.test/admin/?v=catalogo',runScripts:'outside-only'});w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.HTMLElement.prototype.scrollIntoView=function(){};
  w.structuredClone=structuredClone;w.calculateSale=calculateSale;w.EventSource=class{addEventListener(){}close(){}};
  w.crypto.randomUUID=()=> 'b1234567-1234-1234-1234-123456789000';
  requests=[];tickets=new Map();ticketCounter=0;admin=true;fail=false;customers=[{id:'c1',name:'Cliente <script>',phone_e164:'+18095550101'}];
  products=[{id:'p1',name:'Producto Fulltech',sku:'P1',active:true,kind:'product',track_stock:true,quantity:5,price_cents:125050,cost_cents:60025,image_url:'/image'}];
  w.fetch=vi.fn(async(url,options={})=>{requests.push({url,...options});
    let data=url.endsWith('/store/products')?{products,categories:[],movements:[],canManage:admin}:url.endsWith('/pos/customers')?{customers,isAdmin:admin,canCreate:true,actorId:admin?'admin':'agent'}:{orderId:'order1',quoteId:'quote1',receiptUrl:'/api/admin/orders/order1/receipt'};
    if(url.includes('/pos/tickets')){
      const body=options.body?JSON.parse(options.body):null,id=url.split('/tickets/')[1]?.split('/')[0];
      if(body){const key=id||'ticket_'+(++ticketCounter),old=tickets.get(key);const ticket=url.endsWith('/discard')?{...old,status:'discarded',version:old.version+1}:{id:key,name:body.name||old?.name||'Ticket '+ticketCounter,version:(old?.version||0)+1,status:'open',draft:{...body.draft,customer:customers.find(c=>c.id===body.draft?.customerId)||null}};tickets.set(key,ticket);data={ticket};}
      else data=id?{ticket:tickets.get(id)}:{tickets:[...tickets.values()]};
    }
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
  expect(w.document.querySelector('.pos-stepper')).toBeNull();expect(w.document.querySelector('[data-pos-discount="0"]')).toBeNull();
  click('[data-pos-quantity="0"]');await flush();
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Editar artículo');
  click('[data-pos-line-step="1"]');expect(w.document.querySelector('.pos-dialog [name=quantity]').value).toBe('3');
  fill('quantity','2');fill('type','amount');fill('value','0.01');await submit();
  click('[data-pos-discount="total"]');fill('type','percent');fill('value','10');await submit();
  expect(w.document.querySelector('.pos-total').textContent).toContain('2,250.89');expect(w.document.querySelector('.pos-profit').textContent).toContain('1,050.39');
  click('[data-pos-quantity="0"]');await flush();click('[data-pos-line-remove]');await flush();await submit();
  expect(w.document.querySelector('[data-pos-pay]').disabled).toBe(true);
});
it('recibe cliente y chat, confirma la cotización y envía el contexto y total exactos',async()=>{
  w.dispatchEvent(new w.CustomEvent('fulltech:pos-context',{detail:{customerId:'c1',conversationId:'chat1'}}));await flush();
  click('[data-pos-add]');click('[data-pos-quote]');
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Confirmar cotización');
  expect(requests.some(r=>r.url.endsWith('/quotes'))).toBe(false);
  await submit();const sent=requests.find(r=>r.url.endsWith('/quotes'));expect(JSON.parse(sent.body)).toMatchObject({customerId:'c1',conversationId:'chat1',expectedTotal:125050,items:[{variantId:'p1',quantity:1}]});
  expect(w.document.querySelector('.pos-document-toast').textContent).toContain('Cotización guardada');expect(w.document.querySelector('[data-pos-pay]').disabled).toBe(true);
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
it('acciones permite guardar varias ventas y cambiar entre tickets sin perder artículos',async()=>{
  click('[data-pos-add]');click('[data-pos-actions]');click('[data-pos-new-ticket]');await flush();
  expect(tickets.size).toBe(2);expect(w.document.querySelector('.pos-total').textContent).toContain('0.00');
  click('[data-pos-add]');click('[data-pos-add]');click('[data-pos-tickets]');await flush();
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Tickets');
  expect([...tickets.values()].map(t=>t.draft.items.reduce((n,i)=>n+i.quantity,0))).toEqual([1,2]);
  click('[data-pos-ticket="ticket_1"]');await flush();expect(w.document.querySelector('.pos-total').textContent).toContain('1,250.50');
  expect(w.document.querySelector('.pos-cart-handle').textContent).toContain('Ticket 1');
});
it('acciones permite agregar una venta ocasional sin crear un producto de catálogo',async()=>{
  click('[data-pos-actions]');click('[data-pos-manual]');fill('name','Trabajo ocasional');fill('quantity','2');fill('price','1250.50');fill('cost','600.25');await submit();
  expect(w.document.querySelector('.pos-total').textContent).toContain('2,501.00');
  expect(w.document.querySelector('.pos-cart-lines').textContent).toContain('Trabajo ocasional');
  expect(requests.some(r=>r.url.endsWith('/store/products')&&r.body)).toBe(false);
});
it('acciones es un drawer separado, ordena venta rápida primero y no incluye guardar ticket ni gestión de tickets',()=>{
  click('[data-pos-actions]');const drawer=w.document.querySelector('.pos-actions-drawer');
  expect(drawer.open).toBe(true);expect(w.document.querySelector('.pos-dialog').open).toBe(false);
  expect(drawer.querySelector('nav button').hasAttribute('data-pos-manual')).toBe(true);
  expect(drawer.querySelector('nav button:nth-of-type(2)').hasAttribute('data-pos-new-ticket')).toBe(true);
  expect(drawer.querySelector('[data-pos-save-ticket]')).toBeNull();
  expect(drawer.querySelector('nav button:nth-of-type(3)').hasAttribute('data-pos-note')).toBe(true);
  expect(drawer.querySelector('[data-pos-tickets],[data-pos-ticket-rename],[data-pos-ticket-discard]')).toBeNull();
  expect(w.document.querySelector('#pos-client [data-pos-tickets]').textContent).toContain('Tickets');
  drawer.dispatchEvent(new w.Event('cancel',{cancelable:true}));expect(drawer.open).toBe(false);
});
it('la nota del pedido se edita desde acciones y se refleja en el carrito',async()=>{
  click('[data-pos-actions]');await flush();click('[data-pos-note]');await flush();
  expect(w.document.querySelector('.pos-dialog').textContent).toContain('Nota del pedido');
  fill('notes','Entregar por la tarde');await submit();
  expect(w.document.querySelector('.pos-cart-note').textContent).toContain('Entregar por la tarde');
});
it('cancelar o rechazar una edición inválida conserva la cantidad, el descuento y el total',async()=>{
  click('[data-pos-add]');click('[data-pos-expand]');
  click('[data-pos-quantity="0"]');fill('quantity','4');fill('value','25');click('[data-pos-close]');
  expect(w.document.querySelector('[data-pos-quantity]').textContent).toBe('1');
  expect(w.document.querySelector('.pos-total').textContent).toContain('1,250.50');
  click('[data-pos-quantity="0"]');fill('quantity','0');await submit();
  expect(w.document.querySelector('.pos-modal-error').textContent).toContain('cantidad');
  fill('quantity','2');fill('type','percent');fill('value','101');await submit();
  expect(w.document.querySelector('.pos-modal-error').textContent).toContain('100');
  expect(w.document.querySelector('[data-pos-quantity]').textContent).toBe('1');
  click('[data-pos-line-discount="10"]');await submit();
  expect(w.document.querySelector('[data-pos-quantity]').textContent).toBe('2');
  expect(w.document.querySelector('.pos-total').textContent).toContain('2,250.90');
  click('[data-pos-quantity="0"]');
  expect(w.document.querySelector('.pos-dialog [name=type]').value).toBe('percent');
  expect(w.document.querySelector('.pos-dialog [name=value]').value).toBe('10');
});
it('conserva la nota al guardar y recuperar un ticket',async()=>{
  click('[data-pos-add]');click('[data-pos-actions]');click('[data-pos-note]');
  fill('notes','Llamar antes de entregar');await submit();
  click('[data-pos-actions]');click('[data-pos-new-ticket]');await flush();
  click('[data-pos-tickets]');await flush();click('[data-pos-ticket="ticket_1"]');await flush();
  expect(w.document.querySelector('.pos-cart-note').textContent).toContain('Llamar antes de entregar');
  expect(tickets.get('ticket_1').draft.notes).toBe('Llamar antes de entregar');
});
it('los gestos de los bordes abren cada drawer y los gestos verticales o centrales no los abren',()=>{
  Object.defineProperty(w,'innerWidth',{configurable:true,value:390});w.document.querySelector('#app').hidden=false;w.document.body.dataset.tab='catalogo';
  const main=vi.fn();w.addEventListener('fulltech:main-drawer',main);
  const swipe=(x1,y1,x2,y2)=>{for(const [type,x,y] of [['pointerdown',x1,y1],['pointermove',x2,y2],['pointerup',x2,y2]]){const event=new w.Event(type,{bubbles:true,cancelable:true});for(const [key,value] of Object.entries({clientX:x,clientY:y,pointerId:7,pointerType:'touch',isPrimary:true}))Object.defineProperty(event,key,{value});w.document.body.dispatchEvent(event);}};
  swipe(4,200,8,320);swipe(140,200,250,205);expect(main).not.toHaveBeenCalled();
  swipe(4,200,110,208);expect(main.mock.calls[0][0].detail.open).toBe(true);
  swipe(387,200,270,207);expect(w.document.querySelector('.pos-actions-drawer').open).toBe(true);
  swipe(260,200,370,205);expect(w.document.querySelector('.pos-actions-drawer').open).toBe(false);
});
it('cada ticket ofrece editar y eliminar en sus tres puntos, conservando el nombre',async()=>{
  click('[data-pos-add]');click('[data-pos-actions]');click('[data-pos-new-ticket]');await flush();click('[data-pos-tickets]');await flush();
  expect(w.document.querySelectorAll('.pos-ticket-more')).toHaveLength(2);
  expect(w.document.querySelectorAll('.pos-ticket-menu:not([hidden])')).toHaveLength(0);
  click('[data-pos-ticket-menu="ticket_1"]');expect(w.document.querySelector('.pos-ticket-menu:not([hidden])').textContent).toContain('Eliminar ticket');
  click('[data-pos-ticket-rename="ticket_1"]');await flush();fill('name','Venta de María');await submit();
  expect(w.document.querySelector('.pos-ticket-list').textContent).toContain('Venta de María');
  click('[data-pos-ticket-menu="ticket_1"]');click('[data-pos-ticket-discard="ticket_1"]');await flush();await submit();
  expect(w.document.querySelector('.pos-ticket-list').textContent).not.toContain('Venta de María');expect(tickets.get('ticket_1').status).toBe('discarded');
  expect(requests.some(r=>r.url.endsWith('/checkout'))).toBe(false);
});
