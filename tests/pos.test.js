// @vitest-environment node
import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startCrmServer} from '../server/crm-server.mjs';
import {calculateSale} from '../public/admin/pos-math.js';
import {computeOrderTotals} from '../src/lib/catalog.js';
import {receiptPdf} from '../server/orders.mjs';
let app,dir,cookie,p,customer,databaseUrl;
async function call(route,body,auth=cookie){const r=await fetch(app.url+'/api/admin/'+route,{method:body?'POST':'GET',headers:{cookie:auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
const body=(patch={})=>({requestId:randomUUID(),mode:'invoice',customerId:customer.id,items:[{variantId:p.id,quantity:2,discount:{type:'amount',value:0.01}}],discount:{type:'percent',value:10},expectedTotal:225089,paymentMethod:'CASH',...patch});
beforeEach(async()=>{
  dir=mkdtempSync(path.join(tmpdir(),'fulltech-pos-'));
  databaseUrl='';
  if(process.env.FULLTECH_CATALOG_TEST_PG){
    const url=new URL(process.env.FULLTECH_CATALOG_TEST_PG);
    if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/fulltech_qa')throw new Error('Solo base local desechable fulltech_qa.');
    const {Client}=await import('pg');const client=new Client({connectionString:url.href});await client.connect();
    const schema='pos_billing_qa_'+randomUUID().replaceAll('-','');await client.query(`CREATE SCHEMA ${schema}`);await client.end();url.searchParams.set('options',`-c search_path=${schema}`);databaseUrl=url.href;
  }
  app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'pos.sqlite'),token:'pos-test-token',quiet:true,schedulerEnabled:false});
  const login=await fetch(app.url+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'pos-test-token'})});cookie=login.headers.get('set-cookie').split(';')[0];
  p=(await call('store/products',{kind:'service',name:'Servicio Fulltech',sku:'SERV-01',price:'1250.50',cost:'600.25'})).data.product;
  customer=(await call('pos/customers',{name:'Cliente de prueba',phone:'8095550202'})).data.customer;
});
afterEach(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true});});
it('usa centavos exactos por línea y porcentaje general, con el mismo total del pedido',()=>{
  const sale=calculateSale(body().items,[p],body().discount);
  expect(sale).toMatchObject({subtotal_cents:250099,discount_cents:25010,total_cents:225089,profit_cents:105039});
  const order=computeOrderTotals([{variantId:p.id,quantity:2,lineDiscountCents:1}],{product:{variants:[{id:p.id,general:true,price:1250.50}]},discount:250.10});
  expect(order.total).toBe(2250.89);expect(order.items[0].subtotal).toBe(2500.99);
  expect(()=>calculateSale([{variantId:p.id,quantity:1,discount:{type:'percent',value:101}}],[p])).toThrow();
  expect(()=>calculateSale([{variantId:p.id,quantity:1.5}],[p])).toThrow();
});
it('guarda cotizaciones persistentes sin generar pedido, venta ni movimientos y permite imprimirlas',async()=>{
  const quote=await call('pos/quotes',body());expect(quote.status).toBe(201);
  expect(quote.data.document.sale.total_cents).toBe(225089);
  expect((await call('pos/quotes')).data.quotes).toHaveLength(1);
  expect((await call('store/products')).data.movements).toHaveLength(0);
  const data=(await call('data')).data;expect(data.items.filter(i=>i.id?.startsWith('pos'))).toHaveLength(0);
  const receipt=await fetch(app.url+quote.data.receiptUrl,{headers:{cookie}});expect(receipt.status).toBe(200);expect(await receipt.text()).toContain('Cotización comercial');
  await app.close();app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl,dataFile:path.join(dir,'pos.sqlite'),token:'pos-test-token',quiet:true,schedulerEnabled:false});
  expect((await call('pos/quotes')).data.quotes).toHaveLength(1);
});
it('cobrar registra la venta exacta y reutiliza el resultado sin duplicar pedidos',async()=>{
  const input=body();const [first,second]=await Promise.all([call('pos/checkout',input),call('pos/checkout',input)]);
  expect([first.status,second.status].sort()).toEqual([200,201]);expect(first.data.orderId).toBe(second.data.orderId);
  const order=await call('orders/'+first.data.orderId);expect(order.data.order).toMatchObject({total:2250.89,status:'entregado',payment_status:'paid'});
  expect(order.data.order.items[0]).toMatchObject({line_discount_cents:1,product_cost_snapshot_cents:120050});
  expect((await call('pos/checkout',{...input,items:[{variantId:p.id,quantity:3}]})).status).toBe(409);
});
it('guardar pedido lo deja pendiente sin descontar stock',async()=>{
  const saved=await call('pos/checkout',body({mode:'order',deliveryFee:50,expectedTotal:230089,address:'Calle 1',notes:'Entregar por la tarde'}));expect(saved.status).toBe(201);
  const order=(await call('orders/'+saved.data.orderId)).data.order;
  expect(order).toMatchObject({status:'nuevo',payment_status:'pending',delivery:{address:'Calle 1',fee:50},notes:'Entregar por la tarde'});
  expect((await call('store/products')).data.movements).toHaveLength(0);
});
it('una cotización solo se convierte una vez, aunque se envíe otra clave',async()=>{
  const quote=await call('pos/quotes',body()),id=quote.data.document.id;
  const input=body({quoteId:id});const first=await call('pos/checkout',input);expect(first.status).toBe(201);
  const second=await call('pos/checkout',{...input,requestId:randomUUID()});expect(second.status).toBe(200);expect(second.data.orderId).toBe(first.data.orderId);
  expect((await call('pos/quotes')).data.quotes[0]).toMatchObject({status:'converted',order_id:first.data.orderId});
});
it('no acepta importes manipulados, descuentos excesivos, artículos inactivos ni carrito vacío',async()=>{
  expect((await call('pos/checkout',body({expectedTotal:1}))).data.error).toBe('price_changed');
  expect((await call('pos/checkout',body({discount:{type:'amount',value:999999}}))).status).toBe(422);
  expect((await call('pos/checkout',body({items:[]}))).status).toBe(422);
  expect((await call('pos/checkout',body({items:[{variantId:'missing',quantity:1}]}))).status).toBe(422);
  expect((await call('pos/quotes')).data.quotes).toHaveLength(0);
});
it('exige cliente y comprueba que el chat le pertenece',async()=>{
  expect((await call('pos/checkout',body({customerId:'missing'}))).status).toBe(422);
  expect((await call('pos/checkout',body({conversationId:'chat-ajeno'}))).status).toBe(422);
  expect((await call('pos/checkout',body({paymentMethod:'CARD'}))).status).toBe(422);
  expect((await call('pos/checkout',body({deliveryFee:0.5}))).status).toBe(422);
});
it('protege la última unidad, descuenta una sola vez y mantiene el descuento en el comprobante',async()=>{
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS7kAAAAASUVORK5CYII=';
  const product=(await call('store/products',{kind:'product',sku:'PROD-01',name:'Producto de prueba',image,price:'100.01',cost:'50',quantity:1})).data.product;
  const input=body({items:[{variantId:product.id,quantity:1,discount:{type:'percent',value:10}}],discount:{},expectedTotal:9001});
  const results=await Promise.all([call('pos/checkout',input),call('pos/checkout',{...input,requestId:randomUUID()})]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  expect((await call('store/products')).data.products.find(p=>p.id===product.id).quantity).toBe(0);
  const saved=results.find(r=>r.status===201),order=(await call('orders/'+saved.data.orderId)).data;
  expect(order.order.total).toBe(90.01);expect(order.receipt.items[0]).toMatchObject({line_discount:10,subtotal:90.01});
  const receipt=await fetch(app.url+saved.data.receiptUrl,{headers:{cookie}});expect(await receipt.text()).toContain('Descuento:');
});
it('conserva ubicación y permite un descuento del cien por ciento sin recalcular el precio bruto',async()=>{
  const input=body({items:[{variantId:p.id,quantity:1,discount:{type:'percent',value:100}}],discount:{},expectedTotal:0,location:{latitude:18.4861,longitude:-69.9312,source:'manual'}});
  const saved=await call('pos/checkout',input);expect(saved.status).toBe(201);
  const order=(await call('orders/'+saved.data.orderId)).data.order;
  expect(order.total).toBe(0);expect(order.items[0].subtotal).toBe(0);expect(order.delivery.location).toMatchObject({latitude:18.4861,longitude:-69.9312});
});
it('exige confirmar un nuevo pedido cuando el cliente ya tiene otro pendiente',async()=>{
  const pending=await call('pos/checkout',body({mode:'order'}));expect(pending.status).toBe(201);
  const context=await call('pos/context/'+customer.id);expect(context.data.openOrders).toHaveLength(1);
  expect((await call('pos/checkout',body())).data.error).toBe('open_orders');
  expect((await call('pos/checkout',body({acknowledgeOpen:true}))).status).toBe(201);
});
it('los comprobantes largos generan varias páginas sin perder artículos ni descuentos',()=>{
  const items=Array.from({length:100},(_,i)=>({label:`Producto de prueba ${i+1}`,quantity:1,unitPrice:10,subtotal:9,line_discount:1}));
  const pdf=receiptPdf({business:'Fulltech',document:'Factura de compra',order_number:'POS-01',date:new Date().toISOString(),items,total:900,subtotal:900,currency:'DOP'}).toString('latin1');
  expect(pdf).toContain('Producto de prueba 100');expect(pdf).toContain('Descuento:');expect(pdf).not.toContain('/Count 1 >>');expect(pdf).toContain('%%EOF');
});
it('desde el chat real abre Facturación con el cliente y guarda la cotización ligada a la conversación',async()=>{
  await call('conversations/start',{phone:customer.phone_e164,name:'Cliente de prueba'});
  const dom=new JSDOM(readFileSync('public/admin/index.html','utf8'),{url:app.url+'/admin/',runScripts:'outside-only'}),w=dom.window;
  const until=async(check,label)=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timeout: '+label);};
  try{
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.structuredClone=structuredClone;w.calculateSale=calculateSale;
    w.EventSource=class{addEventListener(){}close(){}};
    w.fetch=(url,init={})=>fetch(new URL(url,app.url),{...init,headers:{...init.headers,cookie}});
    w.eval(readFileSync('public/admin/app.js','utf8'));w.eval(readFileSync('public/admin/store.js','utf8'));w.eval(readFileSync('public/admin/pos.js','utf8').replace(/^import[^\n]+\n/,''));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded',{bubbles:true}));
    await until(()=>!w.document.querySelector('#app').hidden,'inicio');
    w.document.querySelector('[data-tab="whatsapp"]').click();await until(()=>w.document.querySelector('[data-conv]'),'conversación');
    w.document.querySelector('[data-conv]').click();await until(()=>w.document.querySelector('#wa-actions')?.disabled===false,'acciones');
    w.document.querySelector('#wa-actions').click();await until(()=>w.document.querySelector('[data-order-new]'),'crear pedido');
    w.document.querySelector('[data-order-new]').click();await until(()=>w.document.body.dataset.tab==='catalogo'&&w.document.querySelector('#pos-client').textContent.includes('Cliente de prueba'),'cliente en POS');
    expect(w.document.querySelector('#sheet').hidden).toBe(true);
    await until(()=>w.document.querySelector(`[data-pos-add="${p.id}"]`),'catálogo');w.document.querySelector(`[data-pos-add="${p.id}"]`).click();w.document.querySelector('[data-pos-quote]').click();
    w.document.querySelector('.pos-modal-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>w.document.querySelector('.pos-dialog').textContent.includes('Cotización guardada'),'cotización');
    const quote=(await call('pos/quotes')).data.quotes[0];expect(quote.input.conversationId).toBeTruthy();expect(quote.customer_id).toBe(customer.id);
  }finally{dom.window.close();}
});
it('no expone ganancias ni costos en cotizaciones de un agente y no permite acceder sin sesión',async()=>{
  await call('users',{username:'pos-agent',displayName:'Agente POS',role:'AGENT',password:'PosTest-12345'});
  const login=await fetch(app.url+'/api/admin/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'pos-agent',password:'PosTest-12345'})});
  const agent=login.headers.get('set-cookie').split(';')[0];
  expect((await call('pos/customers',null,agent)).data).toMatchObject({isAdmin:false,canCreate:true});
  const quote=await call('pos/quotes',body(),agent);expect(quote.status).toBe(201);expect(JSON.stringify(quote.data)).not.toMatch(/cost_cents|profit_cents/);
  expect(JSON.stringify((await call('pos/quotes',null,agent)).data)).not.toMatch(/cost_cents|profit_cents/);
  const receipt=await fetch(app.url+quote.data.receiptUrl);expect(receipt.status).toBe(401);
  const adminQuote=await call('pos/quotes',body());expect((await call('pos/quotes',null,agent)).data.quotes.some(q=>q.id===adminQuote.data.document.id)).toBe(false);
});
