// @vitest-environment node
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {startCrmServer} from '../server/crm-server.mjs';
it('isolates customer retry keys, returns immutable orders, enforces stock/prices and links CRM',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'checkout-uat-'));const app=await startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'test.sqlite'),token:'checkout-test',quiet:true,schedulerEnabled:false});
 const call=async(route,body,cookie)=>{const r=await fetch(app.url+route,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 try{
 const admin=(await call('/api/admin/login',{token:'checkout-test'})).cookie;
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
 const product=(await call('/api/admin/store/products',{kind:'product',name:'DEMO Checkout',sku:'CHECKOUT-UAT',price:'1250.50',cost:'600',quantity:5,image},admin)).data.product;
 await call(`/api/admin/store/products/${product.id}/publication`,{status:'published'},admin);
 const register=phone=>call('/api/store/account/register',{name:'DEMO UAT',phone,password:'Checkout-123'});
 const a=await register('8095550621'),b=await register('8095550622');
 const body={items:[{id:product.id,quantity:2,price:0.01}],fulfillment:'pickup',requestKey:'shared-retry-key',customerId:b.data.account.customer_id,total:0.02,payment_status:'paid'};
 expect((await call('/api/store/orders',body)).status).toBe(401);
 expect((await call('/api/store/orders',{...body,items:[{id:product.id,quantity:99}]},a.cookie)).status).toBe(409);
 expect((await call('/api/store/orders',{...body,items:[...body.items,...body.items]},a.cookie)).status).toBe(422);
 expect((await call('/api/store/orders',{...body,items:Array.from({length:31},(_,i)=>({id:'fake'+i,quantity:1}))},a.cookie)).status).toBe(422);
 const results=await Promise.all([call('/api/store/orders',body,a.cookie),call('/api/store/orders',body,a.cookie)]);
 expect(results.map(r=>r.status)).toEqual([201,201]);expect(results[0].data.order.id).toBe(results[1].data.order.id);expect(results.some(r=>r.data.duplicate)).toBe(true);
 expect(results[0].data.order.total).toBe(2501);expect(results[0].data.order.payment_status).toBe('pending');
 const id=results[0].data.order.id;
 const customer=(await call('/api/admin/customers?q=8095550621',null,admin)).data.customers[0];
 const profile=await call(`/api/admin/customers/${customer.id}`,null,admin);
 expect(JSON.stringify(profile.data)).toContain(id);
 const other=await call('/api/store/orders',body,b.cookie);expect(other.data.order.id).not.toBe(id);
 const before=await call(`/api/admin/orders/${id}`,null,admin);
 await call(`/api/admin/store/products/${product.id}/publication`,{status:'unpublished'},admin);
 const retry=await call('/api/store/orders',{...body,fulfillment:'delivery',address:'Changed address',items:[]},a.cookie);
 expect(retry.status).toBe(201);expect(retry.data.duplicate).toBe(true);expect(retry.data.order).toEqual(results[0].data.order);
 const after=await call(`/api/admin/orders/${id}`,null,admin);expect(before.status).toBe(200);expect(after.data).toEqual(before.data);
 const products=await call('/api/admin/store/products',null,admin);expect(products.data.products.find(p=>p.id===product.id).quantity).toBe(5);
 const mine=await call('/api/store/account/orders',null,a.cookie);expect(JSON.stringify(mine.data)).toContain(id);expect(JSON.stringify(mine.data)).not.toContain(other.data.order.id);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
},30000);
