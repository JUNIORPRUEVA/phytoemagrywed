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
  const restoreMatch=/^\/api\/admin\/store\/products\/([a-zA-Z0-9_-]+)\/restore$/.exec(route);
  const categoryImage=/^\/api\/admin\/store\/categories\/(category_[a-zA-Z0-9_-]+)\/image$/.exec(route);
  const galleryImage=/^\/api\/admin\/store\/products\/([a-zA-Z0-9_-]+)\/images\/([a-zA-Z0-9_-]+)$/.exec(route);
  try {
    if(route==='/api/admin/store/gallery-audit'&&req.method==='GET')return actor.role==='ADMIN'?send(200,{ok:true,...await catalog.galleryAudit()}):send(403,{ok:false,error:'forbidden'});
    if((match?.[2]==='image'||categoryImage||galleryImage)&&req.method==='GET') {
      const image=await catalog.image(categoryImage?.[1]||galleryImage?.[1]||match[1],galleryImage?.[2]);
      if(!image)return send(404,{ok:false,error:'not_found'});
      res.writeHead(200,{'content-type':image.mime,'cache-control':'private, no-cache','x-content-type-options':'nosniff'});
      res.end(Buffer.from(image.data,'base64'));return true;
    }
    if(route==='/api/admin/store/products'&&req.method==='GET') {
      const archivedOnly=new URL(req.url,'http://localhost').searchParams.get('archived')==='1';
      const all=sanitize(await catalog.list({includeArchived:true}));
      const products=all.filter(product=>archivedOnly?product.archived===true:product.archived!==true);
      const publication=await catalog.publicationStates();
      for(const product of products)product.store_publication=publication[product.id]||{status:'unpublished',featured:false,sort_order:0,updated_at:null};
      /*
       * Cada artículo viaja con su DUEÑO (`store`) y el panel recibe la lista de
       * tiendas disponibles y en cuál está corriendo esta instalación.
       */
      return send(200,{ok:true,products,categories:await catalog.categories(),movements:sanitize(await catalog.history()),canManage:actor.role==='ADMIN',stores:typeof catalog.stores==='object'?catalog.stores:null,storeKey:catalog.storeKey??null});
    }
    if(route==='/api/admin/store/categories'&&req.method==='GET')return send(200,{ok:true,categories:await catalog.categories()});
    if(req.method!=='POST'&&req.method!=='PATCH'&&req.method!=='DELETE')return send(405,{ok:false,error:'method_not_allowed'});
    if(actor.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
    if(match&&!match[2]&&req.method==='DELETE') {
      const archived=await catalog.archive(match[1],actor);
      await ctx.audit?.record({entity:'product',entityId:archived.id,action:'store.product_archived',actor:actor.display_name,summary:`Artículo archivado: ${archived.name}`});
      return send(200,{ok:true,archived});
    }
    if(restoreMatch&&req.method==='POST') {
      const restored=await catalog.restore(restoreMatch[1],actor);
      await ctx.audit?.record({entity:'product',entityId:restored.id,action:'store.product_restored',actor:actor.display_name,summary:`Artículo restaurado (sin publicar): ${restored.name}`});
      return send(200,{ok:true,product:restored});
    }
    const body=await readJson(req,4500000);
    if(route==='/api/admin/store/categories'&&req.method==='POST')return send(201,{ok:true,category:await catalog.createCategory(body,actor)});
    if(route==='/api/admin/store/products'&&req.method==='POST') {
      const product=await catalog.save(body,actor);
      const offerChange=['offer_active','compare_at_price','offer_price','offer_start_at','offer_end_at','daily_offer'].some(field=>Object.prototype.hasOwnProperty.call(body,field));
      await ctx.audit?.record({entity:'product',entityId:product.id,action:offerChange?'store.product_offer_updated':'store.product_saved',actor:actor.display_name,summary:offerChange?'Configuración de oferta actualizada':'Producto creado en el catálogo'});
      return send(201,{ok:true,product});
    }
    if(publicationMatch&&req.method==='POST') {
      if(actor.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
      const publication=await catalog.setPublication(publicationMatch[1],body);
      await ctx.audit?.record({entity:'product',entityId:publication.product_id,action:publication.status==='published'?'store.product_published':'store.product_unpublished',actor:actor.display_name,summary:publication.status==='published'?'Artículo publicado en FULLTECH Store':'Artículo retirado de FULLTECH Store'});
      return send(200,{ok:true,publication});
    }
    if(match&&!match[2]&&req.method==='PATCH') {
      const product=await catalog.save(body,actor,match[1]);
      const offerChange=['offer_active','compare_at_price','offer_price','offer_start_at','offer_end_at','daily_offer'].some(field=>Object.prototype.hasOwnProperty.call(body,field));
      await ctx.audit?.record({entity:'product',entityId:product.id,action:offerChange?'store.product_offer_updated':'store.product_saved',actor:actor.display_name,summary:offerChange?'Configuración de oferta actualizada':'Producto actualizado en el catálogo'});
      return send(200,{ok:true,product});
    }
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
