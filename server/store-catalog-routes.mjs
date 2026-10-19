export async function handleStoreCatalogRoute({req,res,route,ctx,actor,json,readJson,can,sanitize}) {
  if(!route.startsWith('/api/admin/store/'))return false;
  const send=(status,body)=>{json(res,status,body);return true;};
  if(!can('orders.read'))return send(403,{ok:false,error:'forbidden'});
  if(!ctx.storeCatalog)return send(503,{ok:false,error:'catalog_unavailable',message:'El catálogo necesita almacenamiento SQL.'});
  const catalog=ctx.storeCatalog;
  if(route==='/api/admin/store/events'&&req.method==='GET') {
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store',connection:'keep-alive','x-accel-buffering':'no'});
    const write=()=>res.write('event: catalog.changed\ndata: {}\n\n');
    const unsubscribe=catalog.subscribe(write);
    res.write('event: ready\ndata: {}\n\n');
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),25000);
    req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
    return true;
  }
  const match=/^\/api\/admin\/store\/products\/([a-zA-Z0-9_-]+)(?:\/(image|stock))?$/.exec(route);
  const publicationMatch=/^\/api\/admin\/store\/products\/([a-zA-Z0-9_-]+)\/publication$/.exec(route);
  const categoryImage=/^\/api\/admin\/store\/categories\/(category_[a-zA-Z0-9_-]+)\/image$/.exec(route);
  try {
    if((match?.[2]==='image'||categoryImage)&&req.method==='GET') {
      const image=await catalog.image(categoryImage?.[1]||match[1]);
      if(!image)return send(404,{ok:false,error:'not_found'});
      res.writeHead(200,{'content-type':image.mime,'cache-control':'private, no-cache','x-content-type-options':'nosniff'});
      res.end(Buffer.from(image.data,'base64'));return true;
    }
    if(route==='/api/admin/store/products'&&req.method==='GET') {
      const products=sanitize(await catalog.list());
      const publication=await catalog.publicationStates();
      for(const product of products)product.store_publication=publication[product.id]||{status:'unpublished',featured:false,sort_order:0,updated_at:null};
      return send(200,{ok:true,products,categories:await catalog.categories(),movements:sanitize(await catalog.history()),canManage:actor.role==='ADMIN'});
    }
    if(route==='/api/admin/store/categories'&&req.method==='GET')return send(200,{ok:true,categories:await catalog.categories()});
    if(req.method!=='POST'&&req.method!=='PATCH')return send(405,{ok:false,error:'method_not_allowed'});
    if(actor.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
    const body=await readJson(req,1500000);
    if(route==='/api/admin/store/categories'&&req.method==='POST')return send(201,{ok:true,category:await catalog.createCategory(body,actor)});
    if(route==='/api/admin/store/products'&&req.method==='POST') return send(201,{ok:true,product:await catalog.save(body,actor)});
    if(publicationMatch&&req.method==='POST') {
      if(actor.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
      const publication=await catalog.setPublication(publicationMatch[1],body);
      await ctx.audit?.record({entity:'product',entityId:publication.product_id,action:publication.status==='published'?'store.product_published':'store.product_unpublished',actor:actor.display_name,summary:publication.status==='published'?'Artículo publicado en FULLTECH Store':'Artículo retirado de FULLTECH Store'});
      return send(200,{ok:true,publication});
    }
    if(match&&!match[2]&&req.method==='PATCH')return send(200,{ok:true,product:await catalog.save(body,actor,match[1])});
    if(match?.[2]==='stock'&&req.method==='POST')return send(200,{ok:true,...await catalog.adjust(match[1],body,actor)});
    return send(404,{ok:false,error:'not_found'});
  }catch(e){
    const duplicate=['23505','SQLITE_CONSTRAINT_UNIQUE'].includes(e.code)||/UNIQUE constraint failed/.test(e.message||'');
    if(duplicate)return send(409,{ok:false,error:route.endsWith('/categories')?'duplicate_category':'duplicate_sku',message:route.endsWith('/categories')?'Ya existe una categoría con ese nombre.':'Ese código ya pertenece a otro producto.'});
    if(e.status)return send(e.status,{ok:false,error:e.code,message:e.message});
    console.error('[catalog] operation failed',{code:e.code,name:e.name});
    return send(500,{ok:false,error:'catalog_error',message:'No se pudo completar la operación. Actualiza antes de reintentar.'});
  }
}
