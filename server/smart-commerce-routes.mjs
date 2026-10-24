const prefix='/api/store/account/commerce';
const failures=(json,res,error)=>{json(res,error.status||500,{ok:false,error:error.code||'commerce_unavailable',message:error.status?error.message:'No pudimos procesar la cotización.'},{'cache-control':'no-store'});return true;};
const limits=new Map();
function rate(key){const now=Date.now(),old=limits.get(key),entry=old&&old.until>now?old:{count:0,until:now+60000};entry.count++;if(limits.size>5000)limits.clear();limits.set(key,entry);return entry.count<=20;}
export async function handleCommercePublic({req,res,route,ctx,json,readJson}){
  if(!route.startsWith('/api/store/commerce/'))return false;
  const service=ctx.smartCommerce,send=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;};
  if(route==='/api/store/commerce/config'&&req.method==='GET')return send(200,service?{ok:true,...await service.publicConfig()}:{ok:true,enabled:false});
  if(!service)return send(404,{ok:false,error:'commerce_disabled',message:'Esta función no está habilitada.'});
  try{if(route==='/api/store/commerce/resolve'&&req.method==='POST'){
    if(!rate('resolve:'+(ctx.requestTrust?.clientIp(req)||req.socket.remoteAddress)))return send(429,{ok:false,error:'rate_limit',message:'Espera un minuto antes de repetir.'});
    return send(200,{ok:true,...await service.resolveLocation(await readJson(req,4096))});
  }}catch(error){return failures(json,res,error);}return send(404,{ok:false,error:'not_found'});
}
/** Called only AFTER the existing customer session and CSRF checks. */
export async function handleCommerceAccount({req,res,route,ctx,current,json,readJson}){
  if(!route.startsWith(prefix))return false;
  const send=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;},service=ctx.smartCommerce;
  if(!current)return send(401,{ok:false,error:'unauthorized',message:'Inicia sesión para continuar.'});
  if(!service)return send(404,{ok:false,error:'commerce_disabled',message:'Esta función no está habilitada.'});
  const account=current.account;
  try{
    if(route===prefix+'/fulfillments'&&req.method==='GET')return send(200,{ok:true,requests:await service.fulfillment.requests(null,account)});
    const pickupCode=new RegExp('^'+prefix+'/fulfillments/(ftf_[a-f0-9]+)/code$').exec(route);
    if(pickupCode&&req.method==='POST'){if(!rate('pickup-code:'+account.id))return send(429,{ok:false,error:'rate_limit'});return send(201,{ok:true,...await service.fulfillment.issueCode(account,pickupCode[1])});}
    const cancel=new RegExp('^'+prefix+'/fulfillments/(ftf_[a-f0-9]+)/cancel$').exec(route);
    if(cancel&&req.method==='POST'){const result=await service.fulfillment.customerCancel(account,cancel[1]);return send(result.ok?200:result.status||409,result);}
    if(route===prefix+'/addresses'&&req.method==='GET')return send(200,{ok:true,addresses:await service.addresses(account)});
    if(route===prefix+'/addresses'&&req.method==='POST')return send(201,{ok:true,address:await service.saveAddress(account,await readJson(req,8192))});
    if(route===prefix+'/quotes'&&req.method==='POST'){
      if(!rate('quote:'+account.id))return send(429,{ok:false,error:'rate_limit',message:'Espera un minuto antes de recalcular.'});
      return send(201,{ok:true,quote:await service.quote(account,await readJson(req,30000))});
    }
    const match=new RegExp('^'+prefix+'/quotes/(ftq_[a-f0-9]+)(/request)?$').exec(route);
    if(match&&!match[2]&&req.method==='GET')return send(200,{ok:true,quote:await service.get(account,match[1])});
    if(match&&match[2]&&req.method==='POST')return send(202,{ok:true,quote:await service.requestReview(account,match[1]),message:'Solicitud de cotización registrada; pendiente de revisión. No es un pedido confirmado.'});
  }catch(error){return failures(json,res,error);}return send(404,{ok:false,error:'not_found'});
}
export async function handleCommerceAdmin({req,res,route,ctx,actor,json,readJson}){
  if(!route.startsWith('/api/admin/store/commerce/'))return false;
  const send=(status,body)=>{json(res,status,body,{'cache-control':'no-store'});return true;};
  if(!ctx.smartCommerce)return send(404,{ok:false,error:'commerce_disabled',message:'Smart Commerce está desactivado en el servidor.'});
  try{
    if(req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host&&origin.origin!==ctx.allowedOrigin)return send(403,{ok:false,error:'cross_origin'});}
    const f=ctx.smartCommerce.fulfillment,op='/api/admin/store/commerce/operations';
    if(route===op+'/stock'&&req.method==='GET')return send(200,{ok:true,stock:await f.stock(actor)});
    if(route===op+'/stock'&&req.method==='PUT')return send(200,{ok:true,stock:await f.setStock(actor,await readJson(req,10000))});
    if(route===op+'/requests'&&req.method==='GET')return send(200,{ok:true,requests:await f.requests(actor)});
    if(route===op+'/grants'&&req.method==='PUT'){if(actor?.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});const body=await readJson(req,10000);if(!(await ctx.users.listUsers()).some(u=>u.id===body.userId&&u.active!==false))return send(422,{ok:false,error:'user_not_found',message:'El usuario no existe o está inactivo.'});return send(200,await f.grant(actor,body));}
    if(route===op+'/maintenance'&&req.method==='POST'){if(actor?.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});return send(200,{ok:true,expired:await f.maintenance()});}
    if(route===op+'/audit'&&req.method==='GET')return send(200,{ok:true,events:await f.audit(actor)});
    const action=new RegExp('^'+op+'/requests/(ftf_[a-f0-9]+)/(accept|reject|prepare|ready|handover|notify)$').exec(route);
    if(action&&req.method==='POST'){const body=await readJson(req,10000);return send(200,{ok:true,...(action[2]==='handover'?await f.handover(actor,action[1],body):action[2]==='notify'?await f.notify(actor,action[1]):{request:await f.decision(actor,action[1],action[2])})});}
    if(actor?.role!=='ADMIN')return send(403,{ok:false,error:'forbidden'});
    if(route==='/api/admin/store/commerce/config'&&req.method==='GET')return send(200,{ok:true,config:await ctx.smartCommerce.config()});
    if(route==='/api/admin/store/commerce/config'&&req.method==='PUT')return send(200,{ok:true,config:await ctx.smartCommerce.saveConfig(await readJson(req,250000),actor)});
    if(route==='/api/admin/store/commerce/quotes'&&req.method==='GET')return send(200,{ok:true,quotes:await ctx.smartCommerce.adminQuotes()});
  }catch(error){return failures(json,res,error);}return send(404,{ok:false,error:'not_found'});
}
