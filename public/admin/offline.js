/* Copia privada de 24 horas, descarga anticipada y diario durable de operaciones. */
(() => {
  'use strict';
  const db=window.FulltechOfflineStore, network=window.fetch.bind(window), DAY=86400000;
  let identity=null,warming=null,syncing=null,epoch=0,localTail=Promise.resolve(),storageAvailable=true;
  const ready=db.get('identity').then(value=>{identity=value||null;}).catch(()=>{storageAvailable=false;});
  const valid=()=>storageAvailable&&!!identity&&Date.now()-identity.verifiedAt<=DAY;
  const owner=()=>identity?.key;
  const responseKey=url=>'response:'+owner()+':'+new URL(url,location.href).href;
  const queueKey=()=> 'queue:'+owner();
  const clone=value=>structuredClone(value);
  const uuid=()=>crypto.randomUUID();
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-fulltech-local':'1'}});
  const excluded=url=>/\/(calling|push-subscriptions|proofreading)(\/|$)|\/wa-templates.*sync|\/(send|invoice-whatsapp|meta-purchase|message-send)(\/|$)|\/conversations\/[^/]+\/messages$/.test(url.pathname);
  const protectedWrite=url=>excluded(url)||/\/(auth|login|logout)(\/|$)|\/password(?:\/|$)|\/whatsapp|\/deepseek\/test$|\/locations\/[^/]+\/share$|\/conversations\/[^/]+\/(location|order-confirmation)$|\/customer-campaigns\//.test(url.pathname);
  function signal(){window.dispatchEvent(new Event('fulltech:offline-status'));}
  async function identify(payload){
    await localTail.catch(()=>{});
    if(!storageAvailable)return;
    try{
    const auth=payload.auth||payload;
    if(!auth.user&&!auth.legacy)return;
    const key=JSON.stringify([auth.user?.id||'LEGACY_PANEL',auth.user?.role||'ADMIN',auth.permissions||[]]);
    if(identity?.key!==key){
      epoch++;localStorage.removeItem('pe_crm_snapshot');
      const previous=localStorage.getItem('fulltech.offline.legacy-owner');
      if(previous&&previous!==key){
        await db.put('legacyQueue:'+previous,{queue:localStorage.getItem('pe_crm_outbox'),problems:localStorage.getItem('pe_crm_outbox_problems')});
        localStorage.removeItem('pe_crm_outbox');localStorage.removeItem('pe_crm_outbox_problems');
      }
      const saved=await db.get('legacyQueue:'+key);
      if(saved&&!localStorage.getItem('pe_crm_outbox')){if(saved.queue)localStorage.setItem('pe_crm_outbox',saved.queue);if(saved.problems)localStorage.setItem('pe_crm_outbox_problems',saved.problems);}
      localStorage.setItem('fulltech.offline.legacy-owner',key);
    }
    identity={key,user:auth.user,role:auth.user?.role||'ADMIN',permissions:auth.permissions||[],verifiedAt:Date.now()};
    await db.put('identity',identity).catch(()=>signal());
    navigator.serviceWorker?.controller?.postMessage({type:'FULLTECH_OFFLINE_IDENTITY'});
    signal();
    }catch{storageAvailable=false;identity=null;await db.remove('identity').catch(()=>{});signal();}
  }
  async function forget(){
    await localTail.catch(()=>{});
    epoch++;
    try{if(identity)await db.put('legacyQueue:'+identity.key,{queue:localStorage.getItem('pe_crm_outbox'),problems:localStorage.getItem('pe_crm_outbox_problems')}).catch(()=>{});}catch{}
    identity=null;await db.remove('identity').catch(()=>{});
    try{for(const key of ['pe_crm_snapshot','pe_crm_outbox','pe_crm_outbox_problems','fulltech.offline.legacy-owner'])localStorage.removeItem(key);}catch{}
    signal();
  }
  async function remember(url,response,remote=false){
    if(!valid()||!response.ok)return;
    const mine=owner(),copy=response.clone(),body=await copy.arrayBuffer();
    if(mine!==owner())return;
    const headers=[...copy.headers].filter(([name])=>!['set-cookie','content-length','content-encoding'].includes(name));
    const record={owner:mine,url:new URL(url,location.href).href,at:Date.now(),status:copy.status,headers,body};
    if(remote){try{if(JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]').length)return;}catch{}await db.putRemote(responseKey(url),record,queueKey());}
    else await db.put(responseKey(url),record);
  }
  async function cached(url){
    if(!valid())return null;
    let saved=await db.get(responseKey(url));
    const requested=new URL(url,location.href);
    if(requested.pathname==='/api/admin/reports/sales'&&identity.role==='ADMIN'){
      const history=await db.get(responseKey('/api/admin/reports/sales?period=custom&from=1900-01-01&to=9999-12-31&offline=1'));
      if(history){
        const all=JSON.parse(new TextDecoder().decode(history.body)).report.sales;
        const pending=(await data('/api/admin/data',{})).items?.filter(i=>i.pending&&i.status==='entregado')||[];
        for(const item of pending){const order=JSON.parse(item.order_json);all.push({id:item.id,date:item.updated_at,customer_name:item.name,order_number:item.order_number,lines:order.items,product_revenue_cents:money(order.total-order.delivery_fee),delivery_revenue_cents:money(order.delivery_fee),total_collected_cents:money(order.total),product_cost_cents:order.items.reduce((n,l)=>n+Number(l.product_cost_snapshot_cents||0),0),gross_product_profit_cents:money(order.total-order.delivery_fee)-order.items.reduce((n,l)=>n+Number(l.product_cost_snapshot_cents||0),0),capsules:order.items.reduce((n,l)=>n+Number(l.totalCapsules||0),0),pending:true});}
        const {offlineReport}=await import('./offline-report.js');
        return json({ok:true,offline:true,report:offlineReport(all,requested.searchParams.get('period')||'hoy',Object.fromEntries(requested.searchParams))});
      }
    }
    if(!saved&&['/api/admin/locations','/api/admin/wa-templates'].includes(requested.pathname)){
      const records=await db.entries();saved=records.find(([,v])=>v?.owner===owner()&&v.url&&new URL(v.url).pathname===requested.pathname)?.[1];
    }
    if(!saved&&requested.pathname==='/api/admin/conversations'){
      const records=await db.entries(),source=records.find(([,v])=>v?.owner===owner()&&v.url&&new URL(v.url).pathname===requested.pathname)?.[1];
      if(source){
        const value=JSON.parse(new TextDecoder().decode(source.body)),q=(requested.searchParams.get('q')||'').toLocaleLowerCase();
        if(q)value.conversations=(value.conversations||[]).filter(c=>JSON.stringify(c).toLocaleLowerCase().includes(q));
        return json(value);
      }
    }
    if(!saved||saved.owner!==owner())return null;
    return new Response(saved.body,{status:saved.status,headers:[...saved.headers,['x-fulltech-offline','1']]});
  }
  async function data(path,fallback={}){const r=await cached(path);return r?await r.json():clone(fallback);}
  async function save(path,value){await remember(path,json(value));}
  async function listQueue(){return valid()?(await db.get(queueKey())||[]):[];}
  async function changeQueue(fn){const list=await db.update(queueKey(),q=>fn(q||[]));signal();return list;}
  const money=n=>Math.round(Number(n||0)*100);
  async function saveCatalog(snapshot){
    await save('/api/admin/store/products',snapshot);
    const catalog=snapshot.products.filter(p=>p.active).map(p=>({...p,price:p.price_cents/100,currency:'DOP',available:p.active,capsule_quantity:p.capsules||0,general:!p.legacy}));
    await save('/api/admin/catalog',{ok:true,catalog});
    const all=await data('/api/admin/data',{});all.catalog=catalog;await save('/api/admin/data',all);
  }
  function localError(message,status=422){return json({ok:false,message},status);}
  async function consumeStock(lines){
    const snapshot=await data('/api/admin/store/products',{products:[]}),quantities=new Map();
    for(const line of lines||[])quantities.set(line.variantId,(quantities.get(line.variantId)||0)+Number(line.quantity));
    let capsules=0;
    for(const [id,quantity] of quantities){const p=snapshot.products.find(p=>p.id===id);if(!p)continue;if(p.legacy)capsules+=quantity*p.capsules;else if(p.track_stock&&Number(p.quantity)<quantity)return 'No hay existencias suficientes en la copia local.';}
    const legacy=snapshot.products.find(p=>p.legacy);
    if(capsules&&(!legacy?.stock_initialized||Number(legacy.base_quantity)<capsules))return 'Inicializa el inventario o revisa las cápsulas disponibles antes de facturar.';
    for(const [id,quantity] of quantities){const p=snapshot.products.find(p=>p.id===id);if(p?.track_stock&&!p.legacy&&p.quantity!=null)p.quantity-=quantity;}
    for(const p of snapshot.products.filter(p=>p.legacy))if(p.base_quantity!=null){p.base_quantity-=capsules;p.quantity=Math.floor(p.base_quantity/p.capsules);}
    await saveCatalog(snapshot);
    if(capsules){const inventory=await data('/api/admin/inventory',{});inventory.stock=legacy.base_quantity;inventory.pending=true;await save('/api/admin/inventory',inventory);const all=await data('/api/admin/data',{});all.inventory=inventory;await save('/api/admin/data',all);}
    return null;
  }
  function replace(value,mapping){
    if(typeof value==='string')return Object.entries(mapping).reduce((s,[a,b])=>s.replaceAll(a,b),value);
    if(Array.isArray(value))return value.map(v=>replace(v,mapping));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v,mapping)]));
    return value;
  }
  async function project(path,method,body,operation){
    const now=new Date().toISOString(), id=operation.localId;
    if(path.startsWith('/api/admin/inventory/')){
      if(identity.role!=='ADMIN')return localError('Solo administración puede cambiar el inventario.',403);
      const value=await data('/api/admin/inventory',{}),inventory=value.inventory||value;
      if(!inventory.product)return localError('Descarga primero el inventario.');
      const action=path.split('/').pop(),quantity=Number(body.countedQuantity??body.quantity??0),before=Number(inventory.stock||0);
      if(!Number.isSafeInteger(quantity)||quantity<0)return localError('Escribe una cantidad entera válida.');
      const after=action==='count'?quantity:action==='cost'?before:before+(action==='adjust'&&body.direction==='out'?-quantity:quantity);
      if(after<0)return localError('No hay existencias suficientes.');
      inventory.stock=after;inventory.initialized=true;inventory.pending=true;
      if(body.unitCost!==undefined&&body.unitCost!==''){const cost=money(body.unitCost);if(!Number.isSafeInteger(cost)||cost<0)return localError('Escribe un costo válido.');inventory.product.current_unit_cost_cents=cost;}
      inventory.inventory_value_cents=after*inventory.product.current_unit_cost_cents;
      const snapshot=await data('/api/admin/store/products',{products:[],categories:[],movements:[]});
      for(const p of snapshot.products.filter(p=>p.legacy)){p.base_quantity=after;p.quantity=Math.floor(after/p.capsules);p.stock_initialized=true;p.cost_cents=inventory.product.current_unit_cost_cents*p.capsules;}
      await saveCatalog(snapshot);await save('/api/admin/inventory',{...inventory,ok:true});
      const all=await data('/api/admin/data',{});all.inventory=inventory;await save('/api/admin/data',all);
      return json({ok:true,inventory,pending:true,offline:true});
    }
    if(path.startsWith('/api/admin/store/')){
      if(identity.role!=='ADMIN')return localError('Solo administración puede cambiar el catálogo o el stock.',403);
      const snapshot=await data('/api/admin/store/products',{ok:true,products:[],categories:[],movements:[],canManage:true});
      const parts=path.split('/'), target=parts[5], action=parts[6];
      if(parts[4]==='categories'){
        const category={id,name:body.name,image_url:body.image||null,created_at:now,pending:true};
        if(!String(category.name||'').trim())return localError('Escribe el nombre de la categoría.');
        snapshot.categories.push(category);await saveCatalog(snapshot);return json({ok:true,category,pending:true});
      }
      let product=snapshot.products.find(p=>p.id===target);
      if(action==='stock'){
        if(!product)return localError('Descarga primero el producto.');
        if(!Number.isSafeInteger(Number(body.quantity))||Number(body.quantity)<0)return localError('Escribe una cantidad entera válida.');
        const old=Number(product.quantity||0), amount=Number(body.quantity);
        const next=body.type==='count'?amount:body.type==='out'?old-amount:old+amount;
        if(next<0)return localError('No hay existencias suficientes en la copia local.');
        product.quantity=next;product.pending=true;product.version++;
        snapshot.movements.unshift({id,product_id:product.id,created_at:now,quantity_delta:next-old,balance_after:next,type:body.type,reason:body.reason,pending:true});
      }else{
        if(target&&!product)return localError('El artículo no está descargado.');
        if(!String(body.name||'').trim()||!String(body.sku||'').trim())return localError('Escribe nombre y código del artículo.');
        if(body.kind==='product'&&!body.image&&!product?.image_url)return localError('Agrega la imagen del producto.');
        if(snapshot.products.some(p=>p.sku===String(body.sku).toUpperCase()&&p!==product))return localError('Ese código ya existe.');
        const category=snapshot.categories.find(c=>c.id===body.category_id);
        const next={...product,...body,id:product?.id||id,sku:String(body.sku).toUpperCase(),price_cents:money(body.price),cost_cents:money(body.cost),quantity:product?.quantity??Number(body.quantity||0),version:(product?.version||0)+1,track_stock:body.kind==='product',active:body.active!==false,category:category?.name||body.category||'',image_url:body.image||product?.image_url||null,pending:true};
        if(!Number.isFinite(next.price_cents)||next.price_cents<0||next.cost_cents<0)return localError('Escribe precios válidos.');
        if(product)Object.assign(product,next);else{product=next;snapshot.products.push(product);}
      }
      await saveCatalog(snapshot);return json({ok:true,product,...snapshot,pending:true});
    }
    if(path.startsWith('/api/admin/pos/')){
      const people=await data('/api/admin/pos/customers',{customers:[],canCreate:false});
      if(!people.canCreate)return localError('Tu cuenta no puede crear ventas.',403);
      if(path.endsWith('/customers')){
        const digits=String(body.phone||'').replace(/\D/g,'');if(digits.length<10||digits.length>15)return localError('Escribe un teléfono válido con código de país.');
        const existing=people.customers.find(c=>String(c.phone_e164).replace(/\D/g,'').endsWith(digits));
        const customer=existing||{id,name:body.name||digits,phone_e164:'+'+digits,pending:true};
        if(!existing)people.customers.push(customer);
        await save('/api/admin/pos/customers',people);await save('/api/admin/pos/context/'+customer.id,{ok:true,openOrders:[]});
        const all=await data('/api/admin/data',{});all.customers||=[];if(!all.customers.some(c=>c.id===customer.id))all.customers.push(customer);await save('/api/admin/data',all);
        return json({ok:true,customer,pending:true});
      }
      if(path.includes('/tickets')){
        const list=await data('/api/admin/pos/tickets',{ok:true,tickets:[]});
        const target=path.split('/')[5], old=list.tickets.find(t=>t.id===target);
        if(target&&!old)return localError('El ticket no está descargado.');
        const ticket={...old,id:old?.id||id,name:body.name||old?.name||'Ticket local',actor_id:identity.user?.id||'LEGACY_PANEL',draft:clone(body.draft||old?.draft||{}),version:(old?.version||0)+1,status:path.endsWith('/discard')?'discarded':'open',created_at:old?.created_at||now,updated_at:now,pending:true};
        if(body.quoteId){const quote=(await data('/api/admin/pos/quotes/'+body.quoteId)).document;if(!quote)return localError('La cotización no está descargada.');ticket.draft={...quote.input,customer:quote.customer,quoteId:quote.id};}
        if(old)Object.assign(old,ticket);else list.tickets.push(ticket);
        await save('/api/admin/pos/tickets',list);await save('/api/admin/pos/tickets/'+ticket.id,{ok:true,ticket});return json({ok:true,ticket,pending:true});
      }
      const snapshot=await data('/api/admin/store/products',{products:[]});
      const {calculateSale}=await import('./pos-math.js');let sale;
      try{sale=calculateSale(body.items,snapshot.products,body.discount,body.deliveryFee);}catch(e){return localError(e.message);}
      const customer=people.customers.find(c=>c.id===body.customerId);if(!customer)return localError('Selecciona un cliente descargado.');
      if(body.expectedTotal!==sale.total_cents)return localError('Revisa el total de la venta.');
      const mode=body.mode||'quote',number=(mode==='quote'?'COT':'LOCAL')+'-'+id.slice(-8).toUpperCase();
      const document={id,kind:mode,number,customer,customer_id:customer.id,created_at:now,status:'pending_sync',sale,input:body,pending:true};
      if(mode==='quote'){
        const list=await data('/api/admin/pos/quotes',{ok:true,quotes:[]});list.quotes.unshift(document);await save('/api/admin/pos/quotes',list);await save('/api/admin/pos/quotes/'+id,{ok:true,document});
      }else{
        for(const line of body.items){const p=snapshot.products.find(p=>p.id===line.variantId);if(mode==='invoice'&&p?.track_stock&&p.quantity!=null&&p.quantity<line.quantity)return localError('No hay stock suficiente en la copia local.');}
        const capsules=body.items.reduce((n,line)=>n+(snapshot.products.find(p=>p.id===line.variantId)?.legacy?Number(snapshot.products.find(p=>p.id===line.variantId).capsules)*line.quantity:0),0);
        const legacy=snapshot.products.find(p=>p.legacy);
        if(mode==='invoice'&&legacy?.stock_initialized&&legacy?.base_quantity!=null&&capsules>legacy.base_quantity)return localError('No hay cápsulas suficientes en la copia local.');
        if(mode==='invoice'){const error=await consumeStock(body.items);if(error)return localError(error);}
        const all=await data('/api/admin/data',{});
        const lines=sale.items.map(i=>({...i,label:i.name,variantName:i.name,unitPrice:i.unit_price_cents/100,subtotal:i.subtotal_cents/100,subtotal_snapshot_cents:i.subtotal_cents,product_cost_snapshot_cents:i.cost_cents||0}));
        const order={id,order_number:number,items:lines,customer_id:customer.id,conversation_id:body.conversationId||null,subtotal:sale.subtotal_cents/100,discount:sale.discount_cents/100,delivery_fee:sale.delivery_cents/100,total:sale.total_cents/100,status:mode==='invoice'?'entregado':'nuevo',payment_method:body.paymentMethod,currency:'DOP',created_at:now,...(mode==='invoice'?{delivered_at:now}:{}),pending:true};
        const item={id,order_number:number,customer_id:customer.id,name:customer.name,phone:customer.phone_e164,type:'order_intent',status:order.status,order_json:JSON.stringify(order),total:sale.total_cents/100,received_at:now,updated_at:now,offline:true,pending:true};
        (all.items||=[]).unshift(item);await save('/api/admin/data',all);
        await save('/api/admin/orders/'+id,{ok:true,item,order,customer,receipt:order});
      }
      if(body.ticketId){const list=await data('/api/admin/pos/tickets',{tickets:[]});const t=list.tickets.find(t=>t.id===body.ticketId);if(t)t.status='completed';await save('/api/admin/pos/tickets',{ok:true,...list});}
      const receiptUrl='/api/admin/pos/local/'+id+'/receipt';
      const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const html=`<!doctype html><meta name="viewport" content="width=device-width"><title>${escape(number)}</title><style>body{font:16px system-ui;max-width:720px;margin:24px auto;padding:16px}td{padding:12px}table{width:100%}</style><h1>FullTECH</h1><p>${escape(number)} · Documento local pendiente de sincronización</p><p>${escape(customer.name)}</p><table>${sale.items.map(i=>`<tr><td>${escape(i.name)}</td><td>${i.quantity}</td><td>${(i.subtotal_cents/100).toFixed(2)}</td></tr>`).join('')}</table><h2>Total RD$${(sale.total_cents/100).toFixed(2)}</h2><p>El número definitivo y la disponibilidad se validan al sincronizar.</p><button onclick="print()">Imprimir / guardar PDF</button>`;
      await remember(receiptUrl,new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));
      if(mode==='quote')await remember('/api/admin/pos/quotes/'+id+'/receipt',new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}));
      return json({ok:true,offline:true,pending:true,document,quoteId:mode==='quote'?id:null,orderId:mode!=='quote'?id:null,number,receiptUrl,total_cents:sale.total_cents});
    }
    if(/\/orders\/[^/]+\/delivery\/start$/.test(path)||path.startsWith('/api/admin/delivery-tracking/')){
      const all=await data('/api/admin/data',{}),tracking=await data('/api/admin/delivery-tracking',{ok:true,sessions:[]});
      const starting=path.endsWith('/delivery/start'),target=path.split('/')[4];
      let session=starting?tracking.sessions.find(s=>s.order_id===target&&s.status==='ACTIVE'):tracking.sessions.find(s=>s.id===target);
      let item=(all.items||[]).find(i=>i.id===(starting?target:session?.order_id)),order;
      try{order=JSON.parse(item?.order_json||'null');}catch{}
      if(!item||!order)return localError('Descarga primero el pedido y su ruta.');
      if(starting){
        if(['entregado','cancelado','perdido'].includes(order.status))return localError('Este pedido ya está cerrado.');
        if(!order.delivery?.location)return localError('El pedido no tiene ubicación de entrega.');
        const userId=body.deliveryUserId||body.delivery_user_id||identity.user?.id;
        if(!userId)return localError('Selecciona un repartidor.');
        if(identity.role!=='ADMIN'&&order.delivery.delivery_user_id!==userId)return localError('Este pedido está asignado a otro repartidor.',403);
        if(!session){session={id,order_id:target,delivery_user_id:userId,delivery_user_name:identity.user?.display_name,status:'ACTIVE',started_at:now,last_position:null,destination:order.delivery.location};tracking.sessions.unshift(session);}
        item.status=order.status='enviado';
      }else{
        if(!session)return localError('Descarga primero la entrega.');
        if(identity.role!=='ADMIN'&&session.delivery_user_id!==identity.user?.id)return localError('No puedes cambiar esta entrega.',403);
        if(path.endsWith('/location')){
          if(!Number.isFinite(Number(body.lat))||!Number.isFinite(Number(body.lng))||Math.abs(body.lat)>90||Math.abs(body.lng)>180)return localError('La ubicación no es válida.');
          session.last_position={latitude:Number(body.lat),longitude:Number(body.lng),accuracy:body.accuracy,heading:body.heading,speed:body.speed,recorded_at:new Date(body.timestamp||Date.now()).toISOString(),stale:false};
        }else if(path.endsWith('/stop')||path.endsWith('/complete')){
          session.status=path.endsWith('/complete')?'COMPLETED':'CANCELLED';session.ended_at=now;
          if(session.status==='COMPLETED'&&order.status!=='entregado'){const error=await consumeStock(order.items);if(error)return localError(error);item.status=order.status='entregado';}
        }else return localError('Esta operación de reparto requiere conexión.',503);
      }
      session.pending=true;session.updated_at=now;item.pending=true;item.order_json=JSON.stringify(order);
      all.deliveryTracking=tracking.sessions;await save('/api/admin/data',all);await save('/api/admin/delivery-tracking',tracking);
      await save('/api/admin/orders/'+item.id,{...(await data('/api/admin/orders/'+item.id,{})),ok:true,item,order});
      return json({ok:true,session,order,offline:true,pending:true});
    }
    // Los módulos existentes siguen usando sus proyecciones de dominio (guardar/aplicar).
    const parts=path.split('/').filter(Boolean),resource=parts[2],target=parts[3];
    if(['settings','messages','users'].includes(resource)&&identity.role!=='ADMIN'&&!(resource==='users'&&target==='me'))return localError('Tu cuenta no tiene permiso para esta acción.',403);
    const all=await data('/api/admin/data',{});
    const plural=({orders:'items',items:'items',customers:'customers',conversations:'conversations',followups:'followups',notifications:'notifications',scheduled:'scheduled',locations:'locations',messages:'messages',users:'users'})[resource];
    const resourceCopy=await data('/api/admin/'+resource,{});
    const list=Array.isArray(all[plural])?all[plural]:Array.isArray(all[plural]?.items)?all[plural].items:Array.isArray(resourceCopy[plural])?resourceCopy[plural]:[];
    let row=list.find(r=>r.id===(target||body.id))||{id:target||body.id||id,created_at:now};
    const delta={...body,pending:true};
    if(resource==='customers'&&path.endsWith('/stage'))delta.customer_stage=body.stage;
    if(resource==='users'&&body.displayName)delta.display_name=body.displayName;
    if(resource==='conversations'&&/\/(archive|unarchive)$/.test(path))delta.archived=path.endsWith('/archive');
    if(resource==='orders'&&path.endsWith('/finish'))delta.status='entregado';
    if(resource==='orders'&&path.endsWith('/cancel'))delta.status='cancelado';
    if(row.order_json&&delta.status){
      const order=JSON.parse(row.order_json);
      if(delta.status==='entregado'&&order.status!=='entregado'){const error=await consumeStock(order.items);if(error)return localError(error);order.delivered_at=now;}
      order.status=delta.status;row.order_json=JSON.stringify(order);row.updated_at=now;
    }
    if(row.order_json&&body.status){try{const order=JSON.parse(row.order_json);order.status=body.status;row.order_json=JSON.stringify(order);}catch{}}
    if(method==='DELETE'){const i=list.indexOf(row);if(i>=0)list.splice(i,1);}else{Object.assign(row,delta);if(!list.includes(row))list.push(row);}
    if(plural){if(!all[plural])all[plural]=list;await save('/api/admin/data',all);}
    const base='/api/admin/'+resource;
    const cachedList=await data(base,{});
    if(Array.isArray(cachedList[resource]))cachedList[resource]=list;
    await save(base,cachedList);
    const current=await data(path,{}),result={...current,...delta,ok:true,offline:true,pending:true,item:row,order:row,customer:row,followup:row,tracking:row,user:row,users:list};
    if(resource==='messages')result.messages=list;
    if(resource==='settings'){result.settings={...(current.settings||{}),...body};await save(path,result);}
    if(path==='/api/admin/settings/deepseek'){result.deepseek={...(current.deepseek||{}),...body,pending:true};await save(path,result);}
    if(path==='/api/admin/settings/chat-sharing'){const previous=await data('/api/admin/chat-sharing',{});result.sharing={...(previous.sharing||{}),...body,pending:true};await save('/api/admin/chat-sharing',result);}
    if(target)await save('/api/admin/'+resource+'/'+target,{...result});
    return json(result);
  }
  function enqueue(url,options){
    const mine=owner();
    const run=()=>{if(mine!==owner())throw new Error('La cuenta cambió antes de guardar.');return enqueueRun(url,options);};
    const next=localTail.catch(()=>{}).then(()=>navigator.locks?.request?navigator.locks.request('fulltech-offline-write:'+mine,run):run());
    localTail=next;return next;
  }
  async function enqueueRun(url,options){
    if(!valid())return localError('Conéctate para renovar el acceso sin conexión de 24 horas.',401);
    if(protectedWrite(url))return localError('Esta acción requiere conexión con el servicio.',503);
    const body=options.body?JSON.parse(options.body):{};
    if(/password|apiKey|accessToken|secret/i.test(JSON.stringify(Object.keys(body))))return localError('Las contraseñas y claves se cambian con conexión segura al servidor.',503);
    const pending=await listQueue();
    const same=pending.find(p=>p.path===url.pathname+url.search&&p.method===options.method&&JSON.stringify(p.body)===JSON.stringify(body)&&p.state==='pending');
    if(same)return new Response(same.local.body,{status:same.local.status,headers:same.local.headers});
    const prefix=url.pathname.includes('/store/categories')?'category_':url.pathname.includes('/store/products')?'product_':url.pathname.includes('/tickets')?'ticket_':url.pathname.includes('/quotes')?'pos_':'local_';
    const operation={id:options.operationId||uuid(),path:url.pathname+url.search,method:options.method,body,localId:prefix+uuid().replaceAll('-',''),at:Date.now(),state:'pending'};
    // El diario se escribe ANTES de aplicar cambios o decir que están guardados.
    await changeQueue(q=>[...q,{...operation,state:'preparing'}]);
    try{
      const response=await project(url.pathname,options.method,body,operation);
      if(!response.ok){await changeQueue(q=>q.filter(p=>p.id!==operation.id));return response;}
      const text=await response.clone().text();
      await changeQueue(q=>q.map(p=>p.id===operation.id?{...operation,local:{body:text,status:response.status,headers:[...response.headers]}}:p));
      if(navigator.onLine)setTimeout(()=>synchronize().catch(()=>{}),0);
      return response;
    }catch(e){await changeQueue(q=>q.map(p=>p.id===operation.id?{...p,state:'review',error:e.message}:p));throw e;}
  }
  async function send(input,options={}){
    await ready;
    if(valid()&&options.method&&options.method!=='GET'){
      const mapping=await db.get('mapping:'+owner())||{};
      if(typeof input==='string')input=replace(input,mapping);
      if(typeof options.body==='string'){try{options={...options,body:JSON.stringify(replace(JSON.parse(options.body),mapping))};}catch{}}
    }
    const url=new URL(typeof input==='string'?input:input.url,location.href),method=(options.method||input.method||'GET').toUpperCase();
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/admin/')||url.pathname.includes('/events'))return network(input,options);
    const mine=owner(),myEpoch=epoch;
    const canRead=(!excluded(url)||/\/conversations\/[^/]+\/messages$/.test(url.pathname))&&!url.pathname.includes('/android-apk/download');
    let legacy=new Headers(options.headers||{}).has('x-fulltech-legacy-outbox');
    if(legacy&&(await listQueue()).some(p=>(url.pathname+String(options.body||'')).includes(p.localId)))legacy=false;
    if(method!=='GET'&&!legacy&&!protectedWrite(url)&&valid()&&(await listQueue()).length)return enqueue(url,{...options,method});
    // Mientras haya trabajo local pendiente, no taparlo con una copia remota anterior.
    if(method==='GET'&&canRead&&valid()&&!/\/(auth\/me|session)$/.test(url.pathname)&&(await listQueue()).length){const r=await cached(url);if(r)return r;}
    if(method==='GET'&&!navigator.onLine){const r=await cached(url);if(r&&canRead)return r;return localError('Este contenido todavía no está descargado en el dispositivo.',503);}
    if(method!=='GET'&&!navigator.onLine&&!/\/(login|logout)(\/|$)/.test(url.pathname)){if(legacy)throw new TypeError('offline');return enqueue(url,{...options,method});}
    const operationId=method!=='GET'&&!protectedWrite(url)?new Headers(options.headers||{}).get('x-fulltech-operation')||uuid():null;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
    const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
    try{
      const headers=new Headers(options.headers||{});if(operationId)headers.set('x-fulltech-operation',operationId);
      const response=await network(input,{...options,headers,signal:controller.signal});
      if(response.status===409&&operationId){
        const failure=await response.clone().json().catch(()=>({}));
        if(failure.error==='offline_operation_uncertain')await changeQueue(q=>[...q,{id:operationId,path:url.pathname+url.search,method,body:options.body?JSON.parse(options.body):{},localId:'uncertain_'+operationId,state:'review',at:Date.now(),error:failure.message}]);
      }
      if(response.status===401){await forget();return response;}
      if([502,503,504].includes(response.status)&&canRead){
        if(method==='GET'){const r=await cached(url);if(r)return r;}
        else if(!legacy)return enqueue(url,{...options,method,operationId});
      }
      const localResponse=response.headers.get('x-fulltech-offline')==='1';
      if(response.ok&&!localResponse&&method==='GET'&&/\/(data|session|auth\/me)$/.test(url.pathname)){
        await identify(await response.clone().json());
      }else if(response.ok&&/\/(login)$/.test(url.pathname))await identify(await response.clone().json());
      if(myEpoch!==epoch&&mine&&mine!==owner())return response;
      if(method==='GET'&&canRead&&response.ok&&!localResponse){await remember(url,response,true).catch(()=>signal());}
      if(response.ok&&identity&&!warming&&url.pathname==='/api/admin/data')setTimeout(()=>warm().catch(()=>{}),100);
      return response;
    }catch(e){
      if(options.signal?.aborted)throw e;
      if(method==='GET'&&canRead){const r=await cached(url);if(r)return r;}
      if(method!=='GET'&&!protectedWrite(url)&&!legacy)return enqueue(url,{...options,method,operationId});
      throw e;
    }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',onAbort);}
  }
  async function synchronize(){
    if(syncing)return syncing;
    if(!navigator.onLine||!valid())return;
    const run=async()=>{
      const mine=owner(),mapping=await db.get('mapping:'+mine)||{};
      for(const entry of await listQueue()){
        if(mine!==owner())break;
        if(entry.state!=='pending')break;
        const path=replace(entry.path,mapping),body=replace(entry.body,mapping);
        let r;
        try{r=await network(path,{method:entry.method,credentials:'same-origin',headers:{'content-type':'application/json','x-fulltech-operation':entry.id},body:JSON.stringify(body)});}catch{break;}
        if(r.status===401){await forget();break;}
        if(r.status>=500)break;
        const result=await r.json();
        if(!r.ok){await changeQueue(q=>q.map(p=>p.id===entry.id?{...p,state:'review',error:result.message||result.error||'Revisa la operación.'}:p));break;}
        const real=result.session?.id||result.product?.id||result.category?.id||result.customer?.id||result.ticket?.id||result.document?.id||result.quoteId||result.orderId;
        if(real&&real!==entry.localId)mapping[entry.localId]=real;
        await db.put('mapping:'+mine,mapping);
        await changeQueue(q=>q.filter(p=>p.id!==entry.id));
      }
      if(mine===owner()){
        const url=new URL(location.href);for(const key of ['product','quote','ticket']){const old=url.searchParams.get(key);if(mapping[old])url.searchParams.set(key,mapping[old]);}history.replaceState(history.state,'',url);
        if(!(await listQueue()).length)await warm(true);
        window.dispatchEvent(new CustomEvent('fulltech:offline-synced',{detail:{mapping}}));
        window.dispatchEvent(new Event('fulltech:catalog-updated'));window.dispatchEvent(new Event('fulltech:pos-saved'));
      }
    };
    const prepare=async()=>{const legacy=await window.FulltechLegacyOffline?.synchronize();if(legacy?.pending||legacy?.dropped)return;return navigator.locks?.request?navigator.locks.request('fulltech-offline-write:'+owner(),run):run();};
    syncing=prepare().finally(()=>{syncing=null;signal();});return syncing;
  }
  const ROOTS=['session','data?offline=1','catalog','pos/customers','store/products','pos/tickets','pos/quotes','inventory','inventory/reconcile','customers?limit=5000','conversations?limit=5000','followups','customer-tags','notifications','delivery-tracking','locations?limit=5000','users','settings/followup','settings/deepseek','messages','scheduled','reports/sales?period=custom&from=1900-01-01&to=9999-12-31&offline=1','reports/sales?period=hoy','reports/sales?period=ayer','reports/sales?period=7d','reports/sales?period=30d','reports/sales?period=mes','metrics?period=hoy','metrics?period=7d','metrics?period=30d','push-status','chat-sharing','wa-templates','audit?limit=10'];
  async function warm(force=false){
    if(warming)return warming;
    if(!navigator.onLine||!valid())return;
    warming=(async()=>{
      if((await listQueue()).length)return;
      try{if(JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]').length)return;}catch{}
      const mine=owner(),todo=ROOTS.map(p=>'/api/admin/'+p),seen=new Set();let completed=0,failed=0;
      await navigator.storage?.persist?.().catch(()=>{});
      while(todo.length&&mine===owner()&&navigator.onLine){
        const batch=todo.splice(0,4).filter(p=>!seen.has(p));batch.forEach(p=>seen.add(p));
        await Promise.all(batch.map(async path=>{
          try{
            const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
            let r;try{r=await network(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal});}finally{clearTimeout(timeout);}
            if(r.headers.get('x-fulltech-offline')==='1'){failed++;return;}
            if(r.status===401){await forget();return;}
            if(!r.ok)return;
            await remember(path,r,true);if(path==='/api/admin/data?offline=1')await remember('/api/admin/data',r,true);completed++;
            if(!r.headers.get('content-type')?.includes('json'))return;
            const value=await r.json();
            const visit=v=>{
              if(typeof v==='string'&&v.startsWith('/api/admin/')&&!/events|calling|token=|sync=/.test(v)&&!seen.has(v))todo.push(v);
              else if(Array.isArray(v))v.forEach(visit);
              else if(v&&typeof v==='object')Object.values(v).forEach(visit);
            };visit(value);
            for(const [key,items] of Object.entries(value))if(Array.isArray(items)){
              const prefix=({customers:'customers',conversations:'conversations',quotes:'pos/quotes',tickets:'pos/tickets'})[key];
              if(prefix)for(const item of items)if(item.id){todo.push('/api/admin/'+prefix+'/'+encodeURIComponent(item.id)+(key==='conversations'?'/messages':''));if(key==='customers')todo.push('/api/admin/customers/'+item.id+'/tags','/api/admin/pos/context/'+item.id);if(key==='quotes')todo.push('/api/admin/pos/quotes/'+item.id+'/receipt','/api/admin/pos/quotes/'+item.id+'/pdf');}
              if(key==='items'&&path.startsWith('/api/admin/data'))for(const item of items)if(item.type==='order'||item.type==='order_intent')todo.push('/api/admin/orders/'+encodeURIComponent(item.id),'/api/admin/orders/'+encodeURIComponent(item.id)+'/receipt');
              if(key==='customers')for(const item of items)if(item.id)todo.push('/api/admin/customers/'+item.id+'/locations');
              if(key==='deliveryOrders')for(const item of items)if(item.id)todo.push('/api/admin/delivery/orders/'+item.id);
            }
          }catch{failed++;}
        }));
        await db.put('preparation:'+mine,{at:Date.now(),completed,failed,remaining:todo.length});signal();
      }
      if(!force&&await listQueue().then(q=>q.length)&&!syncing)setTimeout(()=>synchronize().catch(()=>{}),0);
    })().finally(()=>{warming=null;signal();});return warming;
  }
  window.fetch=send;
  function saveLegacySnapshot(snapshot){
    const mine=owner();
    const run=async()=>{
      if(!valid()||mine!==owner()||!JSON.parse(localStorage.getItem('pe_crm_outbox')||'[]').length)return;
      const all=await data('/api/admin/data',{});
      for(const key of ['items','customers','conversations','followups','settings','scheduled','messages','deliveryTracking'])if(snapshot[key])all[key]=snapshot[key];
      await save('/api/admin/data',all);
    };
    const next=localTail.catch(()=>{}).then(run);localTail=next;return next;
  }
  window.FulltechOffline={ready,valid,warm,synchronize,listQueue,saveLegacySnapshot,status:async()=>({valid:valid(),expiresAt:identity?identity.verifiedAt+DAY:null,shell:await db.get('shell'),preparation:await db.get('preparation:'+owner()),queue:await listQueue()}),forget};
  window.addEventListener('online',()=>setTimeout(()=>synchronize().catch(()=>{}),0));
  window.addEventListener('phyto:calling-logout',()=>forget().catch(()=>{}));
  window.addEventListener('pageshow',()=>{if(navigator.onLine)warm().catch(()=>{});});
  setInterval(()=>{if(navigator.onLine&&valid())listQueue().then(q=>{if(q.some(p=>p.state==='pending'))synchronize().catch(()=>{});}).catch(()=>{});},30000);
})();
