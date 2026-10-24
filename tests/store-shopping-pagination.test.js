// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {handleStorePublicRoute} from '../server/store-public-routes.mjs';
const products=Array.from({length:251},(_,i)=>({id:`id-${String(i).padStart(4,'0')}`,kind:'product',name:'Mismo nombre',price:100,sortOrder:0,category:i%2?'Hogar':'Tecnología',availabilityState:'AVAILABLE_NOW',featured:false}));
async function request(query){
 const catalog={publicProducts:vi.fn(async()=>[...products].reverse())};let body;
 const res={writeHead(){},end(value){body=JSON.parse(value);}};
 await handleStorePublicRoute({req:{method:'GET'},res,route:'/api/store/catalog',url:new URL('http://local/api/store/catalog?'+query),ctx:{storeCatalog:catalog},json(){}});return body;
}
it('honors batches of 100 across more than 200 products with stable ID tie-breaks',async()=>{
 const pages=await Promise.all([1,2,3].map(n=>request(`limit=100&page=${n}`)));
 expect(pages.map(p=>p.products.length)).toEqual([100,100,51]);expect(pages[0].pagination).toMatchObject({limit:100,total:251,pages:3});
 const ids=pages.flatMap(p=>p.products.map(row=>row.id));expect(new Set(ids).size).toBe(251);expect(ids).toEqual([...ids].sort());
});
it('caps oversized batches and retains category/offer filtering',async()=>{
 expect((await request('limit=1000')).pagination.limit).toBe(100);
 const category=await request('limit=100&category=Hogar');expect(category.products.every(p=>p.category==='Hogar')).toBe(true);expect(category.pagination.total).toBe(125);
 expect((await request('offers=true&limit=100')).products).toHaveLength(0);
});
