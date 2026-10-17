export async function handleStoreCatalogRoute({req,res,route,ctx,actor,json,readJson,can,sanitize}) {
  if(!route.startsWith('/api/admin/store/'))return false;
  const send=(status,body)=>{json(res,status,body);return true;};
  if(!can('orders.read'))return send(403,{ok:false,error:'forbidden'});
  if(!ctx.storeCatalog)return send(503,{ok:false,error:'catalog_unavailable',message:'El catálogo necesita almacenamiento SQL.'});
  const catalog=ctx.storeCatalog;
  const match=/^\/api\/admin\/store\/products\/([a-zA-Z0-9_-]+)(?:\/(image|stock))?$/.exec(route);
  try {
    if(match?.[2]==='image'&&req.method==='GET') {
      const image=await catalog.image(match[1]);
      if(!image)return send(404,{ok:false,error:'not_found'});
      res.writeHead(200,{'content-type':image.mime,'cache-control':'private, no-cache','x-content-type-options':'nosniff'});
      res.end(Buffer.from(image.data,'base64'));return true;
    }
    if(route==='/api/admin/store/products'&&req.method==='GET') {
      return send(200,{ok:true,products:sanitize(await catalog.list()),movements:sanitize(await catalog.history()),canManage:actor.role==='ADMIN'});
    }
    if(req.method!=='POST'&&req.method!=='PATCH')return send(405,{ok:false,error:'method_not_allowed'});
    if(actor.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
    const body=await readJson(req,1500000);
    if(route==='/api/admin/store/products'&&req.method==='POST') return send(201,{ok:true,product:await catalog.save(body,actor)});
    if(match&&!match[2]&&req.method==='PATCH')return send(200,{ok:true,product:await catalog.save(body,actor,match[1])});
    if(match?.[2]==='stock'&&req.method==='POST')return send(200,{ok:true,...await catalog.adjust(match[1],body,actor)});
    return send(404,{ok:false,error:'not_found'});
  }catch(e){
    const duplicate=['23505','SQLITE_CONSTRAINT_UNIQUE'].includes(e.code)||/UNIQUE constraint failed/.test(e.message||'');
    if(duplicate)return send(409,{ok:false,error:'duplicate_sku',message:'Ese código ya pertenece a otro producto.'});
    if(e.status)return send(e.status,{ok:false,error:e.code,message:e.message});
    console.error('[catalog] operation failed',{code:e.code,name:e.name});
    return send(500,{ok:false,error:'catalog_error',message:'No se pudo completar la operación. Actualiza antes de reintentar.'});
  }
}
