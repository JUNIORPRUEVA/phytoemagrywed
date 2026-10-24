import {coordinates} from './smart-commerce-rules.mjs';

/** OSRM-compatible provider. No default/demo host, redirects or straight-line fallback. */
export function createRoadRouter({baseUrl='',profile='driving',fetchImpl=fetch,timeoutMs=4000,clock=Date.now}={}){
  let url;try{url=new URL(baseUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)url=null;}catch{url=null;}
  if(!/^[a-z0-9_-]{1,32}$/i.test(profile))url=null;
  const cache=new Map(),pending=new Map();let active=0;
  return {configured:!!url,async route(origin,destination){
    coordinates(origin);coordinates(destination);if(!url)return {ok:false,reason:'routing_unconfigured'};
    const key=[origin.longitude,origin.latitude,destination.longitude,destination.latitude].join(',');
    if(cache.get(key)?.expires>clock())return cache.get(key).result;
    if(pending.has(key))return pending.get(key);
    if(active>=4)return {ok:false,reason:'routing_busy'};
    const work=(async()=>{active++;try{
      const endpoint=new URL(`${url.pathname.replace(/\/$/,'')}/route/v1/${profile}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`,url.origin);endpoint.search='overview=false&steps=false&alternatives=false';
      const response=await fetchImpl(endpoint,{signal:AbortSignal.timeout(Math.min(10000,Math.max(100,timeoutMs))),redirect:'error',headers:{accept:'application/json'}});
      if(!response.ok)return {ok:false,reason:'routing_unavailable'};
      const raw=await response.json(),r=raw.code==='Ok'&&raw.routes?.[0];
      if(!r||typeof r.distance!=='number'||!Number.isFinite(r.distance)||r.distance<=0)return {ok:false,reason:'no_road_route'};
      const result={ok:true,meters:Math.ceil(r.distance),durationSeconds:Number.isFinite(r.duration)&&r.duration>=0?Math.ceil(r.duration):null,provider:'osrm'};
      if(cache.size>500)cache.delete(cache.keys().next().value);cache.set(key,{expires:clock()+30000,result});return result;
    }catch{return {ok:false,reason:'routing_unavailable'};}finally{active--;pending.delete(key);}})();pending.set(key,work);return work;
  }};
}
