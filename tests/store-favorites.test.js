// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCrmServer } from '../server/crm-server.mjs';

let app, dir, admin, product, alice, bob;
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMI7VgV2rGKAUIBACl+Bh2rITjYAAAAAElFTkSuQmCC';
async function request(route, { method='GET', cookie, body, origin }={}) {
  const response=await fetch(app.url+route,{method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const launch=()=>startCrmServer({port:0,host:'127.0.0.1',databaseUrl:'',dataFile:path.join(dir,'favorites.sqlite'),token:'favorites-uat',quiet:true,schedulerEnabled:false});
beforeEach(async()=>{
  dir=mkdtempSync(path.join(tmpdir(),'fulltech-favorites-'));app=await launch();
  admin=(await request('/api/admin/login',{method:'POST',body:{token:'favorites-uat'}})).cookie;
  product=(await request('/api/admin/store/products',{method:'POST',cookie:admin,body:{kind:'product',name:'Favorito UAT',sku:'FAV-UAT',price:1250,cost:600,quantity:3,image:IMAGE,category:'Tecnología',shortDescription:'Producto de prueba'}})).data.product;
  expect((await request('/api/admin/store/products/'+product.id+'/publication',{method:'POST',cookie:admin,body:{status:'published'}})).status).toBe(200);
  alice=await request('/api/store/account/register',{method:'POST',body:{name:'Ana UAT',phone:'8095550811',password:'Cliente-Uat123'}});
  bob=await request('/api/store/account/register',{method:'POST',body:{name:'Luis UAT',phone:'8095550812',password:'Cliente-Uat123'}});
});
afterEach(async()=>{await app?.close();rmSync(dir,{recursive:true,force:true})});

it('requires a customer session, isolates lists, and persists an idempotent favorite across restart',async()=>{
  expect(product?.id).toBeTruthy();expect(alice.status).toBe(201);expect(bob.status).toBe(201);
  const endpoint='/api/store/account/favorites',item=endpoint+'/'+product.id;
  for(const cookie of [undefined,admin]) {
    expect((await request(endpoint,{cookie})).status).toBe(401);
    expect((await request(item,{method:'POST',cookie})).status).toBe(401);
    expect((await request(item,{method:'DELETE',cookie})).status).toBe(401);
  }
  expect((await request(item,{method:'POST',cookie:alice.cookie,origin:'https://other.example'})).status).toBe(403);
  expect((await request(item,{method:'POST',cookie:alice.cookie})).data.ids).toEqual([product.id]);
  expect((await request(item,{method:'POST',cookie:alice.cookie})).data.ids).toEqual([product.id]);
  expect((await request(endpoint,{cookie:bob.cookie})).data.products).toEqual([]);
  expect((await request(item,{method:'DELETE',cookie:bob.cookie})).data.ids).toEqual([]);
  await app.close();app=await launch();
  const saved=await request(endpoint,{cookie:alice.cookie});
  expect(saved.data.ids).toEqual([product.id]);expect(saved.data.products).toHaveLength(1);
  expect(saved.data.products[0]).not.toHaveProperty('cost');expect(saved.data.products[0]).not.toHaveProperty('quantity');
  expect((await request(item,{method:'DELETE',cookie:alice.cookie})).data.ids).toEqual([]);
  expect((await request(endpoint,{cookie:alice.cookie})).data.products).toEqual([]);
});

it('rejects unknown products and hides archived products without losing the saved selection',async()=>{
  const endpoint='/api/store/account/favorites',item=endpoint+'/'+product.id;
  expect((await request(endpoint+'/not-a-product',{method:'POST',cookie:alice.cookie})).status).toBe(404);
  await request(item,{method:'POST',cookie:alice.cookie});
  expect((await request('/api/admin/store/products/'+product.id,{method:'DELETE',cookie:admin})).status).toBe(200);
  const saved=await request(endpoint,{cookie:alice.cookie});
  expect(saved.data.ids).toEqual([product.id]);expect(saved.data.products).toEqual([]);
  expect((await request(item,{method:'DELETE',cookie:alice.cookie})).data.ids).toEqual([]);
});
