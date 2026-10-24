export const PRODUCT_BATCH_SIZE=100;

/** A disposable feed: one request at a time, explicit retry and stable ID deduplication. */
export function createProductFeed({root,fetchPage,renderItem,onChange=()=>{},onSnapshot=()=>{},snapshot,emptyText='No hay productos en esta selección.'}){
  let items=[],ids=new Set(),page=0,pages=1,total=0,busy=false,failed=false,disposed=false,request;
  root.innerHTML='<div class="product-grid ft-masonry"></div><div class="ft-feed-status" role="status" aria-live="polite"></div><div class="ft-feed-sentinel" aria-hidden="true"></div>';
  const grid=root.querySelector('.product-grid'),status=root.querySelector('.ft-feed-status'),sentinel=root.querySelector('.ft-feed-sentinel');
  const notify=(restored=false)=>{const state={items:[...items],page,pages,total};onSnapshot(state);onChange({...state,restored});};
  const paintStatus=()=>{
    root.setAttribute('aria-busy',String(busy));
    if(busy){status.textContent='Cargando productos…';return;}
    if(failed){status.innerHTML='<span>No pudimos cargar los productos. </span><button type="button" class="ft-feed-retry">Reintentar</button>';return;}
    status.textContent=page>=pages?(items.length?'Has visto todos los productos de esta selección.':emptyText):'';
    if(!observer&&page<pages)status.innerHTML='<button type="button" class="ft-feed-retry">Cargar siguientes productos</button>';
  };
  async function loadNext(){
    if(disposed||busy||page>=pages)return;
    busy=true;failed=false;request=new AbortController();paintStatus();let added=null;
    try{
      const next=page+1,data=await fetchPage(next,PRODUCT_BATCH_SIZE,request.signal);
      if(disposed||request.signal.aborted)return;
      const batch=(data.products||[]).filter(item=>item.id&&!ids.has(item.id)&&(ids.add(item.id),true));
      items.push(...batch);grid.insertAdjacentHTML('beforeend',batch.map(renderItem).join(''));
      added=batch.length;
      page=next;pages=Math.max(page,Number(data.pagination?.pages)||0);total=Number(data.pagination?.total??items.length);
      notify();
    }catch(error){if(!disposed&&error.name!=='AbortError')failed=true;}
    finally{busy=false;if(!disposed){paintStatus();if(added===0&&!failed&&page<pages){observer?.unobserve?.(sentinel);observer?.observe(sentinel);}}}
  }
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&!failed)loadNext();},{rootMargin:'600px 0px'}):null;
  status.addEventListener('click',event=>{if(event.target.closest('.ft-feed-retry'))loadNext();});
  if(snapshot){items=[...snapshot.items];ids=new Set(items.map(p=>p.id));page=snapshot.page;pages=snapshot.pages;total=snapshot.total;grid.innerHTML=items.map(renderItem).join('');notify(true);paintStatus();}
  async function start(){if(!page)await loadNext();if(!disposed)observer?.observe(sentinel);}
  async function refresh(){
    if(disposed||busy||!page)return;
    busy=true;request=new AbortController();
    try{
      const fresh=[],seen=new Set();let last;
      for(let n=1;n<=page;n++){
        last=await fetchPage(n,PRODUCT_BATCH_SIZE,request.signal);
        if(disposed||request.signal.aborted)return;
        for(const item of last.products||[])if(!seen.has(item.id)){seen.add(item.id);fresh.push(item);}
        if(n>=last.pagination?.pages)break;
      }
      items=fresh;ids=seen;total=Number(last.pagination?.total??fresh.length);pages=Number(last.pagination?.pages)||0;page=Math.min(page,pages||1);
      grid.innerHTML=items.map(renderItem).join('');notify(true);
    }catch{/* Keep the last confirmed results; checkout always revalidates. */}
    finally{busy=false;if(!disposed)paintStatus();}
  }
  return {start,loadNext,refresh,dispose(){disposed=true;request?.abort();observer?.disconnect();},get state(){return {items:[...items],page,pages,total,busy,failed};}};
}
