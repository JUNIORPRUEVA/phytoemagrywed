import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createProductFeed} from '../public/store/product-feed.js';
let root,feed,intersect;
const rows=(start,count)=>Array.from({length:count},(_,i)=>({id:String(start+i)}));
const data=(products,page=1,total=250)=>({products,pagination:{page,total,pages:Math.ceil(total/100),limit:100}});
const make=(fetchPage,extra={})=>feed=createProductFeed({root,fetchPage,renderItem:p=>`<article data-id="${p.id}">${p.id}</article>`,...extra});
beforeEach(()=>{
 document.body.innerHTML='<div id="feed"></div>';root=document.querySelector('#feed');
 vi.stubGlobal('IntersectionObserver',class{constructor(cb){intersect=cb;}observe(){}disconnect(){}});
});
afterEach(()=>{feed?.dispose();vi.unstubAllGlobals();});
it('loads 100 then 100 then 50 automatically without duplicates or premature end',async()=>{
 const request=vi.fn(async page=>data(rows((page-1)*100,page===3?50:100),page));make(request);await feed.start();
 expect(request).toHaveBeenLastCalledWith(1,100,expect.any(AbortSignal));expect(root.textContent).not.toContain('Has visto');
 intersect([{isIntersecting:true}]);await vi.waitFor(()=>expect(feed.state.page).toBe(2));
 intersect([{isIntersecting:true}]);await vi.waitFor(()=>expect(feed.state.page).toBe(3));
 expect(feed.state.items).toHaveLength(250);expect(new Set(feed.state.items.map(p=>p.id)).size).toBe(250);expect(root.textContent).toContain('Has visto todos');
 await feed.loadNext();expect(request).toHaveBeenCalledTimes(3);
});
it('guards simultaneous requests and removes duplicate IDs within/across batches',async()=>{
 let resolve;const request=vi.fn(()=>new Promise(r=>{resolve=r;}));make(request);const first=feed.start();await feed.loadNext();expect(request).toHaveBeenCalledTimes(1);
 resolve(data([{id:'a'},{id:'a'},{id:'b'}]));await first;expect(feed.state.items).toHaveLength(2);
 request.mockResolvedValue(data([{id:'b'},{id:'c'}],2));await feed.loadNext();expect(feed.state.items.map(p=>p.id)).toEqual(['a','b','c']);
});
it('keeps existing cards after a failed page and retries that same page',async()=>{
 const request=vi.fn().mockResolvedValueOnce(data(rows(0,100))).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(data(rows(100,100),2));
 make(request);await feed.start();await feed.loadNext();expect(feed.state.page).toBe(1);expect(root.querySelectorAll('article')).toHaveLength(100);expect(root.querySelector('.ft-feed-retry')).not.toBeNull();
 intersect([{isIntersecting:true}]);expect(request).toHaveBeenCalledTimes(2);
 root.querySelector('button').click();await vi.waitFor(()=>expect(feed.state.page).toBe(2));expect(request.mock.calls[2][0]).toBe(2);
});
it('aborts stale responses on filter changes/unmount',async()=>{
 let resolve;const request=vi.fn(()=>new Promise(r=>{resolve=r;}));make(request);const pending=feed.start();const signal=request.mock.calls[0][2];feed.dispose();expect(signal.aborted).toBe(true);
 resolve(data(rows(0,100)));await pending;expect(root.querySelectorAll('article')).toHaveLength(0);
});
it('restores all loaded pages without refetching or losing the next page',async()=>{
 const request=vi.fn(async n=>data(rows(200,50),n));make(request,{snapshot:{items:rows(0,200),page:2,pages:3,total:250}});await feed.start();expect(request).not.toHaveBeenCalled();expect(root.querySelectorAll('article')).toHaveLength(200);
 await feed.loadNext();expect(request.mock.calls[0][0]).toBe(3);expect(feed.state.items).toHaveLength(250);
});
it('starts a fresh selection at page 1 and handles empty results without a spinner',async()=>{
 make(vi.fn(async()=>data([],1,0)));await feed.start();expect(feed.state.page).toBe(1);expect(root.getAttribute('aria-busy')).toBe('false');expect(root.textContent).toContain('No hay productos');expect(root.querySelector('button')).toBeNull();
});
it('refreshes loaded pages atomically and keeps all results if refresh fails',async()=>{
 const request=vi.fn(async n=>data(rows((n-1)*100,100),n));make(request);await feed.start();await feed.loadNext();await feed.refresh();expect(feed.state.items).toHaveLength(200);request.mockRejectedValue(Error('offline'));await feed.refresh();expect(feed.state.items).toHaveLength(200);
});
it('supports smaller incremental account/about batches, including refresh',async()=>{
 const request=vi.fn(async page=>({products:rows((page-1)*12,12),pagination:{page,pages:3,total:36,limit:12}}));
 make(request,{batchSize:12});await feed.start();expect(feed.state.items).toHaveLength(12);
 await feed.loadNext();expect(feed.state.items).toHaveLength(24);await feed.refresh();
 expect(request.mock.calls.every(call=>call[1]===12)).toBe(true);expect(feed.state.items).toHaveLength(24);
});
it('rearms the sentinel after nonempty small pages that may remain in the preload margin',async()=>{
 const observe=vi.fn(),unobserve=vi.fn();vi.stubGlobal('IntersectionObserver',class{constructor(cb){intersect=cb;}observe=observe;unobserve=unobserve;disconnect(){}});
 make(vi.fn(async page=>({products:rows((page-1)*12,12),pagination:{page,pages:3,total:36}})),{batchSize:12});
 await feed.start();expect(unobserve).toHaveBeenCalledTimes(1);intersect([{isIntersecting:true}]);await vi.waitFor(()=>expect(feed.state.page).toBe(2));expect(unobserve).toHaveBeenCalledTimes(2);
});
