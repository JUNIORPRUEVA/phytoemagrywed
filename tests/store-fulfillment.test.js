// @vitest-environment node
import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startCrmServer} from '../server/crm-server.mjs';
import {pickupPaymentEligible} from '../server/smart-fulfillment.mjs';
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
let app,dir,admin,alice,bob,product,cfg,now,notices;
const op='/api/admin/store/commerce/operations',account='/api/store/account/commerce';
async function api(route,body,cookie=admin,method=body?'POST':'GET'){const r=await fetch(app.url+route,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function count(quantity=2,expectedVersion=0,source='local_count',p=product,originId='origin_uat'){return api(op+'/stock',{originId,productId:p.id,quantity,expectedVersion,source},admin,'PUT');}
async function order(cookie=alice.cookie,key='fulfill_order_001',p=product){const items=[{id:p.id,quantity:1}],q=await api(account+'/quotes',{items,fulfillment:'pickup'},cookie);expect(q.status).toBe(201);expect(q.data.quote.status).toBe('priced');const result=await api('/api/store/orders',{items,fulfillment:'pickup',quoteId:q.data.quote.id,requestKey:key},cookie);return {...result,quote:q.data.quote};}
async function requests(cookie=admin){return (await api(op+'/requests',null,cookie)).data.requests;}
async function action(r,verb,body={}){return api(op+`/requests/${r.id}/${verb}`,body);}
async function ready(r){for(const a of ['accept','prepare','ready']){const result=await action(r,a);expect(result.status,JSON.stringify(result.data)).toBe(200);}}
async function pay(orderId,amount=1000){const payment=await api(`/api/admin/orders/${orderId}/payments`,{amount,expectedDue:amount,method:'TRANSFER',idempotencyKey:'uat-payment-'+orderId,note:'Simulación de banco UAT sin dinero real'});expect(payment.status,JSON.stringify(payment.data)).toBe(200);return payment;}
beforeEach(async()=>{
 dir=mkdtempSync(path.join(tmpdir(),'fulltech-fulfillment-'));now=Date.parse('2026-10-23T16:00:00Z');notices=[];
 app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'fulfillment-uat',quiet:true,schedulerEnabled:false,clock:()=>new Date(now),whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true,router:{configured:true,route:async()=>({ok:true,meters:10790,provider:'fixture'})},capacityProvider:async()=>({available:true}),supplierNotifier:async input=>{notices.push(input);return {state:'sent',providerId:'fake-provider-001'};}}});
 admin=(await api('/api/admin/login',{token:'fulfillment-uat'},null)).cookie;
 product=(await api('/api/admin/store/products',{name:'Producto retiro UAT',sku:'PICKUP-UAT',kind:'product',store:'fulltech',price:1000,cost:500,quantity:2,image:IMAGE})).data.product;
 await api(`/api/admin/store/products/${product.id}/publication`,{status:'published'});
 alice=await api('/api/store/account/register',{name:'Ana UAT',phone:'8095550901',password:'Fulfillment-123'},null);bob=await api('/api/store/account/register',{name:'Luis UAT',phone:'8095550902',password:'Fulfillment-123'},null);
 cfg=(await api('/api/admin/store/commerce/config')).data.config;cfg={...cfg,expectedVersion:0,defaultOriginId:'origin_uat',branches:[{id:'branch_uat',name:'Sucursal sintética UAT',active:true}],origins:[{id:'origin_uat',branchId:'branch_uat',city:'Ciudad UAT A',latitude:18.6,longitude:-68.7,active:true,pickup:true,delivery:true}],zones:[],offers:[],banks:[{id:'bank_uat',name:'Banco ficticio',holder:'UAT',account:'NO-REAL',active:true}]};expect((await api('/api/admin/store/commerce/config',cfg,admin,'PUT')).status).toBe(200);
});
afterEach(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true});});
it('atomically reserves branch stock, rejects overselling and releases on cancellation',async()=>{
 expect((await count(1)).status).toBe(200);
 const [a,b]=await Promise.all([order(alice.cookie,'reservation_race_a'),order(bob.cookie,'reservation_race_b')]);expect([a.status,b.status].sort()).toEqual([201,409]);
 const r=(await requests())[0],stock=(await api(op+'/stock')).data.stock[0];expect(stock.held).toBe(1);
 const cancelled=await api(`/api/admin/orders/${r.order_id}/status`,{status:'CANCELADO',reason:'Cancelación de prueba segura'},admin,'PATCH');expect(cancelled.status,JSON.stringify(cancelled.data)).toBe(200);
 expect((await api(op+'/stock')).data.stock[0].held).toBe(0);expect((await requests())[0].state).toBe('cancelled');
});
it('expires reservations without a live scheduler and escalates without sending messages',async()=>{
 await count(1);expect((await order()).status).toBe(201);now+=16*60000;
 expect((await api(op+'/maintenance',{})).data.expired).toBe(1);expect((await api(op+'/maintenance',{})).data.expired).toBe(0);
 expect((await requests())[0].state).toBe('expired');expect((await api(op+'/stock')).data.stock[0].held).toBe(0);expect(notices).toHaveLength(0);
 expect((await api(op+'/audit')).data.events.some(e=>e.action==='escalation')).toBe(true);
});
it('blocks early code issuance, manual CRM delivery and unverified payments',async()=>{
 await count();const o=await order();expect(o.status).toBe(201);const r=(await requests())[0];
 expect((await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).status).toBe(409);
 expect((await api(`/api/admin/orders/${o.data.order.id}/status`,{status:'ENTREGADO',reason:'Intento de bypass manual'},admin,'PATCH')).data.error).toBe('authorized_pickup_required');
 await ready(r);expect((await api(account+`/fulfillments/${r.id}/code`,{},bob.cookie)).status).toBe(404);
 expect((await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.error).toBe('payment_not_verified');
});
it('completes paid pickup once, consumes branch and master inventory once and recovers retries',async()=>{
 await count();const o=await order();expect(o.status,JSON.stringify(o.data)).toBe(201);const r=(await requests())[0];await ready(r);await pay(o.data.order.id);
 const code=await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie);expect(code.status,JSON.stringify(code.data)).toBe(201);
 const body={code:code.data.code,requestKey:'handover-uat-001'},handover=await action(r,'handover',body);expect(handover.status,JSON.stringify(handover.data)).toBe(200);expect(handover.data.crm?.ok,JSON.stringify(handover.data)).toBe(true);
 const retry=await action(r,'handover',body);expect(retry.data.duplicate).toBe(true);expect((await action(r,'handover',{...body,requestKey:'other-handover-001'})).status).toBe(409);
 const stock=(await api(op+'/stock')).data.stock[0];expect(stock).toMatchObject({on_hand:1,held:0});const master=(await api('/api/admin/store/products')).data.products.find(p=>p.id===product.id);expect(master.quantity).toBe(1);
 expect((await requests())[0].state).toBe('handed_over');expect(JSON.stringify((await api(op+'/audit')).data)).not.toContain(code.data.code);
});
it('persists failed code attempts and invalidates a rotated or expired code',async()=>{
 await count();const o=await order(),r=(await requests())[0];await ready(r);await pay(o.data.order.id);
 const first=(await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.code;const second=(await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.code;
 expect((await action(r,'handover',{code:first,requestKey:'wrong-token-001'})).status).toBe(422);
 for(let i=0;i<4;i++)expect((await action(r,'handover',{code:'bad',requestKey:'wrong-code-001'})).status).toBe(422);
 expect((await action(r,'handover',{code:second,requestKey:'correct-code-001'})).status).toBe(409);
 const fresh=(await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.code;now+=6*60000;expect((await action(r,'handover',{code:fresh,requestKey:'expired-code-001'})).status).toBe(409);
});
it('does not let stale counts, excess allocations or Phyto products become branch stock',async()=>{
 expect((await count(3)).data.error).toBe('global_stock_exceeded');await count(1);expect((await count(1)).data.error).toBe('stock_version_changed');
 const o=await order();expect(o.status).toBe(201);expect((await count(0,2)).data.error).toBe('stock_reserved');
 const phyto=(await api('/api/admin/store/products')).data.products.find(p=>p.legacy||p.store==='phytoemagry');if(phyto)expect((await count(1,0,'local_count',phyto)).status).toBe(422);
});
it('protects allocated stock from ordinary catalog adjustments and filters branch permissions',async()=>{
 await count(2);const adjustment=await api(`/api/admin/store/products/${product.id}/stock`,{type:'out',quantity:1,requestId:'reserved-out-001'});expect(adjustment.status).not.toBe(200);
 const user=await api('/api/admin/users',{username:'supplier-uat',password:'Supplier-Uat-123',displayName:'Operador proveedor UAT',role:'SUPPLIER'});expect(user.status,JSON.stringify(user.data)).toBe(201);
 const staff=(await api('/api/admin/login',{username:'supplier-uat',password:'Supplier-Uat-123'},null)).cookie;
 const o=await order(),r=(await requests())[0];expect((await api(op+`/requests/${r.id}/accept`,{},staff)).status).toBe(403);
 expect((await api(op+'/grants',{userId:user.data.user.id,branchId:'branch_uat',permissions:['confirm']},admin,'PUT')).status).toBe(200);
 expect((await api(op+`/requests/${r.id}/accept`,{},staff)).status).toBe(200);expect((await api(op+`/requests/${r.id}/prepare`,{},staff)).status).toBe(403);
 expect((await api('/api/admin/customers',null,staff)).status).toBe(403);expect((await api('/api/admin/store/commerce/config',null,staff)).status).toBe(403);
 expect((await api('/api/admin/events',null,staff)).status).toBe(403);expect((await api('/api/admin/data',null,staff)).status).toBe(403);
 await api(op+'/grants',{userId:user.data.user.id,branchId:'branch_uat',permissions:[]},admin,'PUT');expect((await api(op+`/requests/${r.id}/prepare`,{},staff)).status).toBe(403);
});
it('keeps supplier-reported availability separate, requires acceptance and never equates sent with accepted',async()=>{
 const supplier=(await api('/api/admin/suppliers',{name:'Proveedor sintético UAT',phone:'8095550999',active:true})).data.supplier;
 cfg.expectedVersion=1;cfg.branches[0].supplierId=supplier.id;expect((await api('/api/admin/store/commerce/config',cfg,admin,'PUT')).status).toBe(200);
 const external=(await api('/api/admin/store/products',{name:'Producto externo UAT',sku:'EXTERNAL-UAT',kind:'product',store:'fulltech',product_type:'third_party',track_stock:false,store_availability:'AVAILABLE_NOW',price:1000,cost:500,quantity:0,image:IMAGE})).data.product;
 expect(external?.id).toBeTruthy();await api(`/api/admin/store/products/${external.id}/publication`,{status:'published'});
 expect((await count(2,0,'supplier_report',external)).status).toBe(200);const o=await order(alice.cookie,'supplier-request-001',external);expect(o.status,JSON.stringify(o.data)).toBe(201);const r=(await requests())[0];
 expect((await api(op+'/stock')).data.stock[0]).toMatchObject({source:'supplier_report',held:0});expect((await action(r,'notify')).data).toMatchObject({state:'sent',accepted:false});expect(notices).toHaveLength(1);expect((await requests())[0].state).toBe('pending');
 expect((await action(r,'accept')).data.error).toBe('stock_unconfirmed');expect((await count(2,1,'supplier_confirmed',external)).status).toBe(200);expect((await action(r,'accept')).status).toBe(200);expect((await action(r,'accept')).status).toBe(200);expect((await api(op+'/stock')).data.stock[0].held).toBe(1);
 for(const step of ['prepare','ready'])expect((await action(r,step)).status).toBe(200);await pay(o.data.order.id);const code=(await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.code;expect((await action(r,'handover',{code,requestKey:'external-handover-001'})).data.crm.ok).toBe(true);
 expect((await api(op+'/stock')).data.stock[0]).toMatchObject({source:'supplier_confirmed',on_hand:1,held:0});expect((await api('/api/admin/store/products')).data.products.find(p=>p.id===product.id).quantity).toBe(2);
});
it('rejects a supplier request idempotently and prevents preparation after rejection',async()=>{
 await count();await order();const r=(await requests())[0];expect((await action(r,'reject')).status).toBe(200);expect((await action(r,'reject')).status).toBe(200);expect((await action(r,'accept')).status).toBe(409);expect((await api(op+'/stock')).data.stock[0].held).toBe(0);
});
it('allows only the customer owner to cancel and never leaks CRM costs in the response',async()=>{
 await count();await order();const r=(await requests())[0];expect((await api(account+`/fulfillments/${r.id}/cancel`,{},bob.cookie)).status).toBe(404);const cancel=await api(account+`/fulfillments/${r.id}/cancel`,{},alice.cookie);expect(cancel.status).toBe(200);expect(JSON.stringify(cancel.data)).not.toMatch(/cost|order_json|payment/);expect((await api(op+'/stock')).data.stock[0].held).toBe(0);
});
it('refuses branch reassignment and generic order edits while reservations exist',async()=>{
 await count();const o=await order();cfg.expectedVersion=1;cfg.origins[0].active=false;expect((await api('/api/admin/store/commerce/config',cfg,admin,'PUT')).data.error).toBe('active_fulfillment_config');
 expect((await api('/api/admin/orders/'+o.data.order.id,{items:[]},admin,'PATCH')).data.error).toBe('managed_order_locked');expect((await api('/api/admin/items/'+o.data.order.id,{status:'entregado'},admin,'PATCH')).data.error).toBe('managed_order_locked');
});
it('does not count reported, rejected, partial or legacy paid flags as pickup eligibility',()=>{
 const order={total:1000,payment_status:'pending',payment:{entries:[{amount:1000,method:'TRANSFER',verification:'pending'}]}};expect(pickupPaymentEligible(order)).toBe(false);order.payment.entries[0].verification='rejected';expect(pickupPaymentEligible(order)).toBe(false);order.payment.entries[0].verification='verified';expect(pickupPaymentEligible(order)).toBe(true);order.payment.entries[0].amount=500;expect(pickupPaymentEligible(order)).toBe(false);expect(pickupPaymentEligible({total:1000,payment_status:'paid'})).toBe(false);
});
it('rejects Phytoemagry stock explicitly, not only when legacy fixtures exist',async()=>{
 const phyto=(await api('/api/admin/store/products',{name:'Producto PHYTO UAT',sku:'PHYTO-ISOLATION-UAT',store:'phytoemagry',kind:'product',price:100,cost:50,quantity:1,image:IMAGE})).data.product;expect(phyto?.id).toBeTruthy();expect((await count(1,0,'local_count',phyto)).data.error).toBe('invalid_branch_stock');
});
it('waits for every pickup origin, consumes each group once and completes one CRM order',async()=>{
 await count(1);const other=(await api('/api/admin/store/products',{name:'Segundo retiro UAT',sku:'PICKUP-SECOND',kind:'product',store:'fulltech',price:1000,cost:500,quantity:2,image:IMAGE})).data.product;await api(`/api/admin/store/products/${other.id}/publication`,{status:'published'});
 cfg.expectedVersion=1;cfg.branches.push({id:'branch_other',name:'Segunda sucursal UAT',active:true});cfg.origins.push({...cfg.origins[0],id:'origin_other',branchId:'branch_other'});cfg.offers=[{id:'offer_other',productId:other.id,originId:'origin_other',active:true}];expect((await api('/api/admin/store/commerce/config',cfg,admin,'PUT')).status).toBe(200);await count(1,0,'local_count',other,'origin_other');
 const items=[{id:product.id,quantity:1},{id:other.id,quantity:1}],q=(await api(account+'/quotes',{items,fulfillment:'pickup'},alice.cookie)).data.quote;expect(q.groups).toHaveLength(2);const o=await api('/api/store/orders',{items,fulfillment:'pickup',quoteId:q.id,requestKey:'multi-pickup-001'},alice.cookie);expect(o.status).toBe(201);const rs=await requests();await ready(rs[0]);await pay(o.data.order.id,2000);
 expect((await api(account+`/fulfillments/${rs[0].id}/code`,{},alice.cookie)).data.error).toBe('pickup_bundle_not_ready');await ready(rs[1]);
 for(const [i,r]of rs.entries()){const code=(await api(account+`/fulfillments/${r.id}/code`,{},alice.cookie)).data.code;const hand=await action(r,'handover',{code,requestKey:'multi-handover-00'+i});expect(hand.status,JSON.stringify(hand.data)).toBe(200);if(i===0)expect(hand.data.crm).toBeUndefined();else expect(hand.data.crm.ok).toBe(true);}
 expect((await api(op+'/stock')).data.stock.every(s=>s.held===0&&s.on_hand===0)).toBe(true);
});
it('persists reservations across a server restart and cannot sell them again',async()=>{
 await count(1);expect((await order()).status).toBe(201);await app.close();app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'fulfillment-uat',quiet:true,schedulerEnabled:false,clock:()=>new Date(now),whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true,router:{configured:false,route:async()=>({ok:false,reason:'fixture_disabled'})}}});admin=(await api('/api/admin/login',{token:'fulfillment-uat'},null)).cookie;expect((await api(op+'/stock')).data.stock[0].held).toBe(1);expect((await order(bob.cookie,'restart-cannot-resell')).status).toBe(409);
});
it('prevents overselling across two server instances sharing the isolated SQLite database',async()=>{
 await count(1);const second=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'uat.sqlite'),token:'fulfillment-uat',quiet:true,schedulerEnabled:false,clock:()=>new Date(now),whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true}});
 try{const items=[{id:product.id,quantity:1}],q1=(await api(account+'/quotes',{items,fulfillment:'pickup'},alice.cookie)).data.quote;
  const post=async(route,body)=>{const r=await fetch(second.url+route,{method:'POST',headers:{cookie:bob.cookie,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const q2=await post(account+'/quotes',{items,fulfillment:'pickup'});expect(q2.status).toBe(201);
  const outcomes=await Promise.all([api('/api/store/orders',{items,quoteId:q1.id,requestKey:'two-instance-first'},alice.cookie),post('/api/store/orders',{items,quoteId:q2.data.quote.id,requestKey:'two-instance-second'})]);expect(outcomes.filter(o=>o.status===201)).toHaveLength(1);expect(outcomes.every(o=>[201,409].includes(o.status)),JSON.stringify(outcomes)).toBe(true);expect((await api(op+'/stock')).data.stock[0].held).toBe(1);
 }finally{await second.close();}
});
it('uses the existing delivery completion engine to atomically consume reserved branch stock',async()=>{
 await count(1);cfg.expectedVersion=1;cfg.zones=[{id:'zone_delivery',name:'Zona sintética entrega',active:true,originIds:['origin_uat'],polygon:[[-68.8,18.5],[-68.5,18.5],[-68.5,18.8],[-68.8,18.8],[-68.8,18.5]],hours:Array.from({length:7},(_,day)=>({day,startMinute:0,endMinute:1440}))}];expect((await api('/api/admin/store/commerce/config',cfg,admin,'PUT')).status).toBe(200);
 const items=[{id:product.id,quantity:1}],input={items,fulfillment:'delivery',destination:{latitude:18.61,longitude:-68.71,accuracy:10},destinationConfirmed:true,address:'Calle de entrega sintética UAT'},q=(await api(account+'/quotes',input,alice.cookie)).data.quote;expect(q.deliveryFeeCents).toBe(110000);
 const o=await api('/api/store/orders',{...input,quoteId:q.id,requestKey:'reserved-delivery-001'},alice.cookie);expect(o.status,JSON.stringify(o.data)).toBe(201);const r=(await requests())[0];await ready(r);
 const finish=await api(`/api/admin/orders/${o.data.order.id}/status`,{status:'ENTREGADO',reason:'Entrega sintética UAT sin cobro'},admin,'PATCH');expect(finish.status,JSON.stringify(finish.data)).toBe(200);expect((await api(op+'/stock')).data.stock[0]).toMatchObject({on_hand:0,held:0});expect((await api('/api/admin/store/products')).data.products.find(p=>p.id===product.id).quantity).toBe(1);
});
