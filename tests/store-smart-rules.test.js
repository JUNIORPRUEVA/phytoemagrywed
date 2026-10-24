import {expect,it,vi} from 'vitest';
import {deliveryPriceMeters,insidePolygon,coordinates,normalizedItems,regionalPrice} from '../server/smart-commerce-rules.mjs';
import {createRoadRouter} from '../server/smart-commerce-routing.mjs';
import {createSmartCommerce} from '../server/smart-commerce.mjs';
it.each([[100,100],[500,100],[1000,100],[1001,150],[1010,150],[1200,150],[1500,150],[1501,200],[1510,200],[2000,200],[2100,250],[2500,250],[3000,300],[5000,500],[10790,1100],[15000,1500]])('prices %im as RD$%i',(meters,fee)=>expect(deliveryPriceMeters(meters).feeDop).toBe(fee));
it('rejects 15001m, invalid distances and accidental fractional increments',()=>{
 expect(deliveryPriceMeters(15001)).toMatchObject({eligible:false,feeDop:null});
 for(const m of [0,-1,NaN,Infinity,1000.1,'1000',null])expect(()=>deliveryPriceMeters(m)).toThrow();
 for(let m=1;m<=15000;m+=17){const fee=deliveryPriceMeters(m).feeDop;expect(fee%50).toBe(0);expect(fee).toBeGreaterThanOrEqual(100);}
});
it('uses configured polygon boundaries, not a circular radius',()=>{const ring=[[0,0],[2,0],[2,2],[0,2],[0,0]];expect(insidePolygon({latitude:1,longitude:1},ring)).toBe(true);expect(insidePolygon({latitude:2,longitude:2},ring)).toBe(true);expect(insidePolygon({latitude:1,longitude:2.01},ring)).toBe(false);});
it('validates coordinates, quantities and regional validity',()=>{expect(()=>coordinates({latitude:100,longitude:0})).toThrow();expect(()=>coordinates({latitude:'',longitude:0})).toThrow();expect(normalizedItems([{id:'a',quantity:1},{id:'a',quantity:2}])).toEqual([{id:'a',quantity:3}]);expect(()=>normalizedItems([{id:'a',quantity:100}])).toThrow();expect(regionalPrice(100,{priceCents:200,from:'2026-01-01',until:'2027-01-01'},Date.parse('2026-06-01'))).toBe(200);expect(regionalPrice(100,{priceCents:200,until:'2026-01-01'},Date.parse('2026-06-01'))).toBe(100);});
it('uses road meters, rounds fractional meters upward and caches only successful responses',async()=>{
 const fetchImpl=vi.fn(async()=>({ok:true,json:async()=>({code:'Ok',routes:[{distance:15000.01,duration:900.2}]})}));const router=createRoadRouter({baseUrl:'https://routing.example.test',fetchImpl});
 const origin={latitude:18,longitude:-68},destination={latitude:18.01,longitude:-68.01};const result=await router.route(origin,destination);expect(result.meters).toBe(15001);expect(result.durationSeconds).toBe(901);expect(deliveryPriceMeters(result.meters).eligible).toBe(false);await router.route(origin,destination);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(String(fetchImpl.mock.calls[0][0])).toContain('/route/v1/driving/-68,18;-68.01,18.01');
});
it('does not fabricate a route on provider failure or missing configuration',async()=>{const origin={latitude:18,longitude:-68};expect(await createRoadRouter().route(origin,origin)).toMatchObject({ok:false,reason:'routing_unconfigured'});const router=createRoadRouter({baseUrl:'https://routing.example.test',fetchImpl:async()=>{throw Error('timeout');}});expect(await router.route(origin,origin)).toEqual({ok:false,reason:'routing_unavailable'});});
it('does not migrate or enable another storefront when disabled',async()=>{
 expect(await createSmartCommerce({enabled:false})).toBeNull();expect(await createSmartCommerce({enabled:true,catalog:{storeKey:'phytoemagry'}})).toBeNull();
});
it('rejects unsafe route providers and monetary overflow',()=>{
 for(const baseUrl of ['http://router.test','https://user:secret@router.test','https://router.test?key=secret','https://router.test/#fragment'])expect(createRoadRouter({baseUrl}).configured).toBe(false);
 expect(()=>deliveryPriceMeters(1,{minimumFeeDop:Number.MAX_SAFE_INTEGER})).toThrow();expect(()=>regionalPrice(100,{priceCents:-1,from:'2099-01-01'},Date.now())).toThrow();
});
