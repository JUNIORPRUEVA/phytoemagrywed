// @vitest-environment node
import {beforeEach,afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startCrmServer} from '../server/crm-server.mjs';
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
let app,dir,admin,alice,bob,product,cfg,now,route,capacity;
async function api(url,{method='GET',body,cookie=admin,origin}={}){const r=await fetch(app.url+url,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const account=async phone=>api('/api/store/account/register',{method:'POST',cookie:null,body:{name:'Smart UAT',phone,password:'Smart-UAT-123'}});
const draft=()=>({items:[{id:product.id,quantity:1}],fulfillment:'delivery',destination:{latitude:18.61,longitude:-68.71,accuracy:10,source:'browser_geolocation'},destinationConfirmed:true,address:'Calle de prueba 123, UAT'});
const quote=async input=>api('/api/store/account/commerce/quotes',{method:'POST',cookie:alice.cookie,body:{...draft(),...input}});
beforeEach(async()=>{
 dir=mkdtempSync(path.join(tmpdir(),'fulltech-smart-'));now=Date.parse('2026-10-23T16:00:00Z');route={ok:true,meters:10790,provider:'fixture',durationSeconds:900};capacity={available:true,cashCollection:true};
 app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'smart.sqlite'),token:'smart-uat',quiet:true,schedulerEnabled:false,clock:()=>new Date(now),whatsapp:{enabled:false},metaCapi:{enabled:false},storeSmartCommerce:{enabled:true,router:{configured:true,route:async()=>route},capacityProvider:async()=>capacity}});
 admin=(await api('/api/admin/login',{method:'POST',cookie:null,body:{token:'smart-uat'}})).cookie;
 product=(await api('/api/admin/store/products',{method:'POST',body:{name:'Cámara Smart UAT',sku:'SMART-UAT-001',kind:'product',store:'fulltech',price:1000,cost:500,quantity:8,image:IMAGE}})).data.product;
 expect((await api(`/api/admin/store/products/${product.id}/publication`,{method:'POST',body:{status:'published'}})).status).toBe(200);
 alice=await account('8095550801');bob=await account('8095550802');expect(alice.status).toBe(201);expect(bob.status).toBe(201);
 cfg=(await api('/api/admin/store/commerce/config')).data.config;
 cfg={...cfg,expectedVersion:cfg.version,defaultOriginId:'origin_uat',cashOnDelivery:true,branches:[{id:'branch_uat',name:'Sucursal UAT',active:true}],origins:[{id:'origin_uat',branchId:'branch_uat',city:'Ciudad UAT A',address:'Origen de prueba',latitude:18.6,longitude:-68.7,active:true,delivery:true,pickup:true}],zones:[{id:'zone_uat',name:'Polígono sintético UAT',active:true,originIds:['origin_uat'],polygon:[[-68.8,18.5],[-68.5,18.5],[-68.5,18.8],[-68.8,18.8],[-68.8,18.5]],hours:Array.from({length:7},(_,day)=>({day,startMinute:0,endMinute:1440}))}],offers:[],banks:[{id:'bank_uat',name:'Banco UAT ficticio',holder:'Solo pruebas',account:'NO-REAL-ACCOUNT',active:true}]};
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
});
afterEach(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true});});
it('quotes exact road distance and reuses the existing CRM order engine without trusting client amounts',async()=>{
 const q=await quote();expect(q.status).toBe(201);expect(q.data.quote).toMatchObject({status:'priced',deliveryFeeCents:110000,totalCents:210000});
 const body={...draft(),quoteId:q.data.quote.id,requestKey:'smart_order_001',deliveryFee:1,total:1,paymentStatus:'paid',paymentMethod:'transfer_now'};
 const order=await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body});expect(order.status).toBe(201);expect(order.data.order).toMatchObject({total:2100,payment_status:'pending'});
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body})).data.duplicate).toBe(true);
 expect((await api('/api/store/account/orders',{cookie:alice.cookie})).data.orders).toHaveLength(1);
 expect((await api('/api/store/account/commerce/quotes/'+q.data.quote.id,{cookie:alice.cookie})).data.quote.state).toBe('committed');
});
it('requires a quote only when enabled and rejects expiry, tampering, invalid payment and cross-account reads',async()=>{
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...draft(),requestKey:'no_quote_001'}})).data.error).toBe('quote_required');
 const q=(await quote()).data.quote;
 expect((await api('/api/store/account/commerce/quotes/'+q.id,{cookie:bob.cookie})).status).toBe(404);
 expect((await api('/api/store/account/commerce/quotes',{method:'POST',cookie:alice.cookie,origin:'https://attacker.test',body:draft()})).status).toBe(403);
 const body={...draft(),quoteId:q.id,requestKey:'smart_expiry_001'};
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...body,items:[{id:product.id,quantity:2}]}})).data.error).toBe('cart_changed');
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...body,paymentMethod:'crypto'}})).data.error).toBe('payment_not_eligible');
 now+=6*60000;expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body})).data.error).toBe('quote_expired');
});
it('never turns coverage, GPS errors, missing capacity or failed routing into a confirmed local fee',async()=>{
 route={ok:false,reason:'routing_unavailable'};expect((await quote()).data.quote).toMatchObject({status:'manual_quote_required',totalCents:null});
 route={ok:true,meters:15001,provider:'fixture'};expect((await quote()).data.quote.reasons).toContain('route_too_long');
 route={ok:true,meters:500,provider:'fixture'};expect((await quote({destination:{latitude:18.9,longitude:-68.9}})).data.quote.reasons).toContain('outside_enabled_service_area');
 expect((await quote({destination:{latitude:18.61,longitude:-68.71,accuracy:200}})).data.quote.reasons).toContain('gps_inaccurate');
 capacity={available:false};expect((await quote()).data.quote.reasons).toContain('capacity_confirmation_pending');
 expect((await quote({destination:null})).data.quote.status).toBe('manual_quote_required');
});
it('creates an idempotent manual intercity request, not a fake confirmed order or pickup code',async()=>{
 const q=(await quote({fulfillment:'intercity'})).data.quote;expect(q.totalCents).toBeNull();expect(q.reasons).toContain('intercity_manual_quote');
 for(let i=0;i<2;i++)expect((await api(`/api/store/account/commerce/quotes/${q.id}/request`,{method:'POST',cookie:alice.cookie,body:{}})).status).toBe(202);
 expect((await api('/api/store/account/orders',{cookie:alice.cookie})).data.orders).toHaveLength(0);
 expect((await quote({fulfillment:'pickup'})).data.quote.reasons).toContain('pickup_reservation_contract_pending');
});
it('resolves regional prices on the server and invalidates a changed configuration',async()=>{
 cfg.offers=[{id:'offer_uat',productId:product.id,originId:'origin_uat',active:true,regionalPrices:[{zoneId:'zone_uat',priceCents:200000}]}];cfg.expectedVersion=1;
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
 const q=(await quote()).data.quote;expect(q.subtotalCents).toBe(200000);
 expect((await api('/api/store/catalog?zone=zone_uat',{cookie:null})).data.products[0].price).toBe(2000);
 const order=await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...draft(),quoteId:q.id,requestKey:'regional_order_001'}});expect(order.status).toBe(201);expect(order.data.order.total).toBe(3100);
 const fresh=(await quote()).data.quote;cfg.expectedVersion=2;cfg.offers[0].regionalPrices[0].priceCents=210000;expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...draft(),quoteId:fresh.id,requestKey:'stale_order_001'}})).data.error).toBe('quote_changed');
});
it('persists addresses only with consent, scopes them to the customer and protects administrative data',async()=>{
 const address={latitude:18.61,longitude:-68.71,address:'Calle UAT 123'};
 expect((await api('/api/store/account/commerce/addresses',{method:'POST',cookie:alice.cookie,body:address})).status).toBe(422);
 const saved=await api('/api/store/account/commerce/addresses',{method:'POST',cookie:alice.cookie,body:{...address,consent:true}});expect(saved.status).toBe(201);
 expect((await api('/api/store/account/commerce/addresses',{cookie:bob.cookie})).data.addresses).toEqual([]);
 expect((await api('/api/store/account/commerce/quotes',{method:'POST',cookie:bob.cookie,body:{...draft(),addressId:saved.data.address.id}})).status).toBe(404);
 expect((await api('/api/admin/store/commerce/config',{cookie:alice.cookie})).status).not.toBe(200);
 const resolved=await api('/api/store/commerce/resolve',{method:'POST',cookie:null,body:address});expect(resolved.data.zone.id).toBe('zone_uat');expect(JSON.stringify(resolved.data)).not.toMatch(/account|latitude|longitude|supplier_cost/);
});
it('claims a quote once across different request keys and ignores a tampered fulfillment method',async()=>{
 const q=(await quote()).data.quote;
 const responses=await Promise.all(['race_order_001','race_order_002'].map(requestKey=>api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{items:draft().items,fulfillment:'pickup',quoteId:q.id,requestKey}})));
 expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
 expect((await api('/api/store/account/orders',{cookie:alice.cookie})).data.orders).toHaveLength(1);
 expect(responses.find(r=>r.status===201).data.order.total).toBe(2100);
});
it('rejects stale configuration versions, invalid future prices and closed operating hours',async()=>{
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).data.error).toBe('config_changed');
 cfg.expectedVersion=1;cfg.offers=[{id:'bad_offer',productId:product.id,originId:'origin_uat',active:true,regionalPrices:[{zoneId:'zone_uat',priceCents:-1,from:'2099-01-01'}]}];
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).data.error).toBe('invalid_regional_price');
 cfg.offers=[];cfg.zones[0].hours=[];expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
 expect((await quote()).data.quote.reasons).toContain('outside_operating_hours');
});
it('keeps supplier-confirmation and multiple-origin baskets in manual review',async()=>{
 cfg.expectedVersion=1;cfg.offers=[{id:'confirm_offer',productId:product.id,originId:'origin_uat',active:true,requiresConfirmation:true}];
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
 const q=(await quote()).data.quote;expect(q.status).toBe('manual_quote_required');expect(q.reasons).toContain('supplier_confirmation_required');
 expect((await api('/api/store/orders',{method:'POST',cookie:alice.cookie,body:{...draft(),quoteId:q.id,requestKey:'supplier_order_001'}})).data.error).toBe('manual_quote_required');
 const other=(await api('/api/admin/store/products',{method:'POST',body:{name:'Otra cámara UAT',sku:'SMART-UAT-002',kind:'product',store:'fulltech',price:500,cost:250,quantity:8,image:IMAGE}})).data.product;
 await api(`/api/admin/store/products/${other.id}/publication`,{method:'POST',body:{status:'published'}});
 const single=(await quote({items:[...draft().items,{id:other.id,quantity:1}]})).data.quote;expect(single.groups).toHaveLength(1);expect(single.subtotalCents).toBe(150000);
 cfg.expectedVersion=2;cfg.origins.push({...cfg.origins[0],id:'origin_other',city:'Ciudad UAT B'});cfg.offers.push({id:'other_offer',productId:other.id,originId:'origin_other',active:true});
 expect((await api('/api/admin/store/commerce/config',{method:'PUT',body:cfg})).status).toBe(200);
 const multi=(await quote({items:[...draft().items,{id:other.id,quantity:1}]})).data.quote;
 expect(multi.groups).toHaveLength(2);expect(multi.reasons).toContain('multiple_or_missing_origins');expect(multi.totalCents).toBeNull();
});
