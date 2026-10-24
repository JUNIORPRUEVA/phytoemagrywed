import {randomUUID,createHash} from 'node:crypto';
import {createSqlQuery} from './sql-query.mjs';
import {createSmartFulfillment} from './smart-fulfillment.mjs';
import {coordinates,insidePolygon,regionalPrice,normalizedItems,deliveryPriceMeters,DEFAULT_DELIVERY_POLICY,inOperatingHours,smartError as fail} from './smart-commerce-rules.mjs';

const clean=(v,n=160)=>String(v??'').trim().slice(0,n);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
async function confirmedCapacity(provider,input){
  if(!provider)return null;
  const controller=new AbortController();let timeout;
  try{return await Promise.race([Promise.resolve().then(()=>provider({...input,signal:controller.signal})),new Promise(resolve=>{timeout=setTimeout(()=>{controller.abort();resolve(null);},3000);})]);}catch{return null;}finally{clearTimeout(timeout);}
}
const initialConfig=()=>({branches:[],origins:[],offers:[],zones:[],banks:[],policy:{...DEFAULT_DELIVERY_POLICY},defaultOriginId:null,cashOnDelivery:false});

/** Additive quote/preflight layer. It never creates a second order or stock ledger. */
export async function createSmartCommerce({enabled=false,backend,handle,catalog,db,customers,audit,router,capacityProvider,supplierNotifier=null,faultInjector=null,clock=()=>new Date()}={}){
  if(!enabled||catalog?.storeKey!=='fulltech')return null;
  const sql=createSqlQuery({backend,handle});if(!sql.enabled)return null;
  await sql.query(`CREATE TABLE IF NOT EXISTS fulltech_smart_config_v1(id TEXT PRIMARY KEY,version INTEGER NOT NULL,doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulltech_checkout_quotes_v1(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,state TEXT NOT NULL,request_key TEXT,order_id TEXT,expires_at TEXT NOT NULL,doc TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fulltech_checkout_quotes_account_idx ON fulltech_checkout_quotes_v1(account_id,created_at);
    CREATE INDEX IF NOT EXISTS fulltech_checkout_quotes_state_idx ON fulltech_checkout_quotes_v1(state,created_at);`);
  await sql.query('INSERT INTO fulltech_smart_config_v1(id,version,doc) VALUES($1,0,$2) ON CONFLICT(id) DO NOTHING',['fulltech',JSON.stringify(initialConfig())]);
  const config=async()=>{const row=(await sql.query('SELECT version,doc FROM fulltech_smart_config_v1 WHERE id=$1',['fulltech'])).rows[0];return {version:Number(row.version),...JSON.parse(row.doc)};};
  async function record(action,id,actor){await audit?.record({entity:'smart_commerce',entityId:id,action,summary:action,data:{actor_id:actor?.id||null},idempotencyKey:`smart:${action}:${id}`});}
  async function saveConfig(input,actor){
    if(!Number.isSafeInteger(input.expectedVersion))throw fail('version_required','Recarga la configuración antes de guardar.',409);
    const next=initialConfig();next.policy={...DEFAULT_DELIVERY_POLICY,...input.policy};deliveryPriceMeters(1,next.policy);
    for(const key of ['branches','origins','offers','zones','banks']){if(!Array.isArray(input[key])||input[key].length>1000)throw fail('invalid_config',`La lista ${key} no es válida.`);next[key]=[];const seen=new Set();for(const row of input[key]){if(!validId(row.id)||seen.has(row.id))throw fail('invalid_config','Hay identificadores duplicados o no válidos.');seen.add(row.id);}}
    for(const b of input.branches){if(clean(b.name).length<2)throw fail('invalid_branch','Falta el nombre de la sucursal.');const supplier=b.supplierId?await db.get('suppliers',b.supplierId):null;if(b.supplierId&&(!supplier||supplier.active===false))throw fail('invalid_supplier','El proveedor no existe o está inactivo.');next.branches.push({id:b.id,name:clean(b.name),supplierId:supplier?.id||null,active:b.active===true});}
    for(const o of input.origins){if(!next.branches.some(b=>b.id===o.branchId))throw fail('invalid_branch','El origen necesita una sucursal existente.');const point=coordinates(o);next.origins.push({id:o.id,branchId:o.branchId,city:clean(o.city,100),address:clean(o.address,240),...point,active:o.active===true,delivery:o.delivery===true,pickup:o.pickup===true});if(!clean(o.city))throw fail('invalid_origin','Indica la ciudad real del origen.');}
    for(const z of input.zones){
      if(!clean(z.name)||!Array.isArray(z.polygon)||z.polygon.length<4||z.polygon.length>500)throw fail('invalid_polygon','La zona necesita un polígono cerrado de al menos cuatro puntos.');
      const polygon=z.polygon.map(p=>{if(!Array.isArray(p)||p.length!==2)throw fail('invalid_polygon','Coordenadas del polígono no válidas.');const c=coordinates({latitude:p[1],longitude:p[0]});return [c.longitude,c.latitude];});
      if(JSON.stringify(polygon[0])!==JSON.stringify(polygon.at(-1)))throw fail('invalid_polygon','Cierra el polígono de cobertura.');
      const area=Math.abs(polygon.slice(1).reduce((sum,p,i)=>sum+polygon[i][0]*p[1]-p[0]*polygon[i][1],0));if(area<1e-12)throw fail('invalid_polygon','El polígono no tiene superficie.');
      if(!Array.isArray(z.originIds)||z.originIds.some(id=>!next.origins.some(o=>o.id===id)))throw fail('invalid_origin','La zona contiene un origen desconocido.');
      const hours=z.hours||[];if(!Array.isArray(hours)||hours.some(h=>!Number.isInteger(h.day)||h.day<0||h.day>6||!Number.isInteger(h.startMinute)||!Number.isInteger(h.endMinute)||h.startMinute<0||h.endMinute>1440||h.startMinute>=h.endMinute))throw fail('invalid_hours','Los horarios deben usar día 0–6 e inicio/fin en minutos.');
      const policy={...next.policy,...z.policy};deliveryPriceMeters(1,policy);next.zones.push({id:z.id,name:clean(z.name,100),active:z.active===true,priority:Number.isSafeInteger(z.priority)?z.priority:0,polygon,originIds:[...new Set(z.originIds)],hours,policy});
    }
    const all=new Map((await catalog.list()).map(p=>[p.id,p])),bindings=new Set();
    for(const o of input.offers){
      const product=all.get(o.productId),key=o.productId+':'+o.originId;if(!product||catalog.storeOf(product)!=='fulltech'||product.kind==='service'||!next.origins.some(p=>p.id===o.originId)||bindings.has(key))throw fail('invalid_offer','El producto/origen no existe en FULLTECH o está duplicado.');bindings.add(key);
      if(o.priceCents!==undefined&&(!Number.isSafeInteger(o.priceCents)||o.priceCents<=0))throw fail('invalid_price','El precio debe estar en centavos positivos.');
      const prices=(o.regionalPrices||[]).map(r=>{if(!next.zones.some(z=>z.id===r.zoneId))throw fail('invalid_zone','La regla regional necesita una zona existente.');regionalPrice(1,r,clock().getTime());return {zoneId:r.zoneId,priceCents:r.priceCents,from:r.from||null,until:r.until||null};});
      if(new Set(prices.map(p=>p.zoneId)).size!==prices.length)throw fail('duplicate_region','Solo una regla de precio por oferta y zona.');
      next.offers.push({id:o.id,productId:o.productId,originId:o.originId,priceCents:o.priceCents,regionalPrices:prices,active:o.active===true,requiresConfirmation:o.requiresConfirmation===true,priority:Number.isSafeInteger(o.priority)?o.priority:0});
    }
    for(const b of input.banks){if(!clean(b.name)||!clean(b.holder)||!clean(b.account))throw fail('invalid_bank','Indica banco, titular y cuenta receptora.');next.banks.push({id:b.id,name:clean(b.name,80),holder:clean(b.holder,120),account:clean(b.account,80),type:clean(b.type,40),active:b.active===true});}
    next.defaultOriginId=input.defaultOriginId||null;if(next.defaultOriginId&&!next.origins.some(o=>o.id===next.defaultOriginId))throw fail('invalid_origin','El origen por defecto no existe.');next.cashOnDelivery=input.cashOnDelivery===true;
    const changed=await fulfillment.commitConfig(next,input.expectedVersion);if(!changed.rows.length)throw fail('config_changed','Otra persona cambió la configuración. Recarga y revisa.',409);
    await record('smart.config.updated',String(changed.rows[0].version),actor);return config();
  }
  const zoneAt=(c,point)=>point?c.zones.filter(z=>z.active&&insidePolygon(point,z.polygon)).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id))[0]||null:null;
  async function resolveLocation(input){const point=coordinates(input),c=await config(),zone=zoneAt(c,point);return {zone:zone?{id:zone.id,name:zone.name}:null,accuracyAcceptable:point.accuracy===undefined||point.accuracy<=100,automaticDeliveryConfigured:!!zone&&router.configured};}
  async function destinationFor(account,input){
    if(input.addressId){const loc=await customers.getLocation(input.addressId);if(!account.customer_id||!loc||loc.customer_id!==account.customer_id)throw fail('address_not_found','La dirección no existe.',404);return {...coordinates(loc),source:'reused_location',address:clean(loc.address,240)};}
    if(!input.destination)return null;return {...coordinates(input.destination),source:input.destination.source==='browser_geolocation'?'browser_geolocation':'manual_coordinates',address:clean(input.address,240)};
  }
  const fulfillment=await createSmartFulfillment({backend,handle,catalog,config,clock,notifier:supplierNotifier,faultInjector});
  catalog.setReservationHooks?.(fulfillment);
  async function plan(account,input){
    const c=await config(),items=normalizedItems(input.items),destination=await destinationFor(account,input),method=input.fulfillment||'delivery';
    if(!['delivery','pickup','intercity'].includes(method))throw fail('invalid_fulfillment','La forma de entrega no es válida.');
    if(method!=='pickup'&&(input.destinationConfirmed!==true||(!destination&&clean(input.address,240).length<8)))throw fail('destination_required','Confirma la ubicación o dirección de entrega antes de cotizar.');
    const zone=zoneAt(c,destination),published=new Map((await catalog.publicProducts({fresh:true})).map(p=>[p.id,p])),lines=[],groups=new Map(),reasons=[];
    for(const item of items){
      const p=published.get(item.id);if(!p||!p.purchaseable||p.kind!=='product')throw fail('item_unavailable','Un artículo ya no está disponible para compra directa.',409);
      const candidates=c.offers.filter(o=>o.active&&o.productId===p.id).map(o=>({offer:o,origin:c.origins.find(x=>x.id===o.originId&&x.active)})).filter(x=>x.origin&&c.branches.some(b=>b.id===x.origin.branchId&&b.active));
      if(!candidates.length){const origin=c.origins.find(o=>o.id===c.defaultOriginId&&o.active&&c.branches.some(b=>b.id===o.branchId&&b.active));if(origin)candidates.push({origin,offer:null});}
      const priceFor=o=>regionalPrice(o?.priceCents??Math.round(p.price*100),o?.regionalPrices?.find(r=>r.zoneId===zone?.id),clock().getTime());
      candidates.sort((a,b)=>Number(method==='pickup'?!a.origin.pickup:!a.origin.delivery)-Number(method==='pickup'?!b.origin.pickup:!b.origin.delivery)||priceFor(a.offer)-priceFor(b.offer)||(a.offer?.priority||0)-(b.offer?.priority||0)||a.origin.id.localeCompare(b.origin.id));
      const selected=candidates[0],origin=selected?.origin,offer=selected?.offer,branch=origin&&c.branches.find(b=>b.id===origin.branchId),unitPriceCents=priceFor(offer);
      if(!origin)reasons.push('dispatch_origin_unconfigured');if(offer?.requiresConfirmation||branch?.supplierId)reasons.push('supplier_confirmation_required');
      lines.push({id:p.id,name:p.name,quantity:item.quantity,unitPriceCents,originId:origin?.id||null,dispatchCity:origin?.city||null,offerId:offer?.id||null,basePriceCents:Math.round(p.price*100),stockSource:await fulfillment.stockSource(p.id,origin?.id)});
      if(origin){if(!groups.has(origin.id))groups.set(origin.id,{originId:origin.id,branchId:branch.id,supplierId:branch.supplierId,city:origin.city,items:[]});groups.get(origin.id).items.push(item);}
    }
    const managedFulfillment=await fulfillment.managed([...groups.values()]);
    if(managedFulfillment){for(let i=reasons.length-1;i>=0;i--)if(reasons[i]==='supplier_confirmation_required')reasons.splice(i,1);}
    const native=(await catalog.publicOrderItems(items));if(native.length!==lines.length)throw fail('invalid_cart','Actualiza el carrito.',409);
    const stock=await catalog.checkOrder({smart_reservation_check:managedFulfillment,items:items.map(i=>({variantId:i.id,quantity:i.quantity}))});if(!stock.ok)throw fail(stock.error||'insufficient_stock',stock.message||'El stock cambió.',409);
    let feeCents=null,route=null,capacity=null;
    if(method==='pickup'){if(managedFulfillment&&[...groups.keys()].every(id=>c.origins.some(o=>o.id===id&&o.pickup)))feeCents=0;else reasons.push('pickup_reservation_contract_pending');}
    else if(method==='intercity')reasons.push('intercity_manual_quote');
    else if(groups.size!==1)reasons.push('multiple_or_missing_origins');
    else if(destination?.accuracy>100)reasons.push('gps_inaccurate');
    else if(!zone)reasons.push('outside_enabled_service_area');
    else{
      const origin=c.origins.find(o=>o.id===[...groups.keys()][0]);
      if(!origin.delivery||!zone.originIds.includes(origin.id))reasons.push('origin_not_covered');
      else if(!inOperatingHours(zone,clock().getTime()))reasons.push('outside_operating_hours');
      else{
        route=await router.route(origin,destination);if(!route.ok)reasons.push(route.reason);else{const price=deliveryPriceMeters(route.meters,zone.policy);if(!price.eligible)reasons.push(price.reason);else{feeCents=price.feeDop*100;capacity=await confirmedCapacity(capacityProvider,{zoneId:zone.id,originId:origin.id,destination});if(capacity?.available!==true)reasons.push('capacity_confirmation_pending');}}
      }
    }
    const subtotalCents=lines.reduce((n,l)=>n+l.unitPriceCents*l.quantity,0);if(!Number.isSafeInteger(subtotalCents)||!Number.isSafeInteger(subtotalCents+(feeCents||0)))throw fail('invalid_total','El total está fuera de rango.');
    const paymentMethods=['arrange_later',...(c.banks.some(b=>b.active)?['transfer_now','transfer_later']:[]),...(c.cashOnDelivery&&capacity?.available===true&&capacity?.cashCollection===true?['cash']:[])];
    const result={items,lines,groups:[...groups.values()],destination,fulfillment:method,zone:zone?{id:zone.id,name:zone.name}:null,configVersion:c.version,status:reasons.length?'manual_quote_required':'priced',reasons:[...new Set(reasons)],subtotalCents,deliveryFeeCents:reasons.length?null:feeCents,estimatedDeliveryFeeCents:feeCents,totalCents:reasons.length?null:subtotalCents+feeCents,route:route?.ok?{meters:route.meters,durationSeconds:route.durationSeconds??null,provider:clean(route.provider,40)}:null,paymentMethods,currency:'DOP',saveAddressPreference:input.saveAddressPreference===true};
    result.managedFulfillment=managedFulfillment;result.address=clean(input.address,240);return {...result,fingerprint:hash(result)};
  }
  async function quote(account,input){const proposed=await plan(account,input),id='ftq_'+randomUUID().replaceAll('-',''),now=clock(),expiresAt=new Date(now.getTime()+5*60000).toISOString(),doc={...proposed,id,expiresAt,input:{items:proposed.items,destination:proposed.destination,destinationConfirmed:true,fulfillment:proposed.fulfillment,address:proposed.address,saveAddressPreference:proposed.saveAddressPreference}};
    await sql.query('INSERT INTO fulltech_checkout_quotes_v1(id,account_id,state,expires_at,doc,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,account.id,'open',expiresAt,JSON.stringify(doc),now.toISOString()]);await record('smart.quote.created',id,account);return publicQuote(doc,'open');}
  async function owned(account,id){const row=(await sql.query('SELECT * FROM fulltech_checkout_quotes_v1 WHERE id=$1 AND account_id=$2',[id,account.id])).rows[0];if(!row)throw fail('quote_not_found','La cotización no existe.',404);return {...row,data:JSON.parse(row.doc)};}
  function publicQuote(doc,state){const {input,fingerprint,groups,...safe}=doc;return {...safe,groups:groups.map(g=>({originId:g.originId,dispatchCity:g.city,items:g.items})),state,expiresAt:doc.expiresAt};}
  async function get(account,id){const row=await owned(account,id);return publicQuote(row.data,['open','claimed'].includes(row.state)&&clock().toISOString()>=row.expires_at?'expired':row.state);}
  async function requestReview(account,id){const row=await owned(account,id);if(clock().toISOString()>=row.expires_at)throw fail('quote_expired','La cotización venció. Vuelve a calcular.',409);if(row.data.status!=='manual_quote_required')throw fail('review_not_required','Esta cotización no requiere revisión.');if(row.state==='requested')return get(account,id);const r=await sql.query("UPDATE fulltech_checkout_quotes_v1 SET state='requested' WHERE id=$1 AND account_id=$2 AND state='open' RETURNING id",[id,account.id]);if(!r.rows.length)throw fail('quote_state','La cotización ya fue procesada.',409);await record('smart.quote.review_requested',id,account);return get(account,id);}
  async function prepareOrder(account,id,requestKey,items,paymentMethod='arrange_later'){
    const row=await owned(account,id),q=row.data;if(clock().toISOString()>=row.expires_at)throw fail('quote_expired','La cotización venció. Confirma nuevamente los importes.',409);
    if(q.status!=='priced')throw fail('manual_quote_required','La entrega necesita revisión; solicita la cotización.',409);
    if(JSON.stringify(normalizedItems(items))!==JSON.stringify(q.items))throw fail('cart_changed','El carrito cambió. Vuelve a cotizar.',409);
    if(!q.paymentMethods.includes(paymentMethod))throw fail('payment_not_eligible','Ese método de pago no está habilitado para este pedido.');
    const current=await plan(account,q.input);if(current.fingerprint!==q.fingerprint)throw fail('quote_changed','Cambió el precio, destino o condición de entrega. Vuelve a cotizar.',409);
    const claim=await sql.query("UPDATE fulltech_checkout_quotes_v1 SET state='claimed',request_key=$1 WHERE id=$2 AND account_id=$3 AND (state='open' OR (state='claimed' AND request_key=$1)) RETURNING id",[requestKey,id,account.id]);if(!claim.rows.length)throw fail('quote_used','La cotización ya se usó con otro pedido.',409);
    await record('smart.quote.claimed',id,account);return {...q,paymentIntent:paymentMethod};
  }
  async function completeOrder(account,id,requestKey,orderId){await sql.query("UPDATE fulltech_checkout_quotes_v1 SET state='committed',order_id=$1 WHERE id=$2 AND account_id=$3 AND request_key=$4 AND state IN ('claimed','committed')",[orderId,id,account.id,requestKey]);await record('smart.quote.committed',id,account);}
  async function saveAddress(account,input){if(input.consent!==true||!account.customer_id)throw fail('location_consent_required','Confirma que deseas guardar esta dirección.');const point=coordinates(input);const saved=await customers.saveLocation({customerId:account.customer_id,location:{...point,source:input.source==='browser_geolocation'?'browser_geolocation':'manual_coordinates',address:clean(input.address,240),name:clean(input.name,80)},createdAt:clock().toISOString()});if(!saved.ok)throw fail(saved.error,saved.message);return saved.location;}
  async function regionalize(products,zoneId){
    const c=await config(),zone=c.zones.find(z=>z.id===zoneId&&z.active);if(!zone)throw fail('zone_not_found','La zona comercial ya no está disponible.');
    return products.map(p=>{const eligible=c.offers.filter(o=>o.active&&o.productId===p.id).map(o=>({offer:o,origin:c.origins.find(x=>x.id===o.originId&&x.active&&c.branches.some(b=>b.id===x.branchId&&b.active))})).filter(x=>x.origin).map(x=>({...x,price:regionalPrice(x.offer.priceCents??Math.round(p.price*100),x.offer.regionalPrices.find(r=>r.zoneId===zoneId),clock().getTime())})).sort((a,b)=>a.price-b.price||a.offer.priority-b.offer.priority||a.offer.id.localeCompare(b.offer.id));
      const selected=eligible[0];if(!selected)return p;const different=selected.price!==Math.round(p.price*100);
      return {...p,price:selected.price/100,...(different?{compareAtPrice:null,discountPercent:null}:{}),commerce:{zoneId,dispatchCity:selected.origin.city,availabilityLabel:`Despacho desde ${selected.origin.city}${selected.offer.requiresConfirmation?' · por confirmar':''}`,requiresConfirmation:selected.offer.requiresConfirmation}};
    });
  }
  return {checkpoint:(point,data)=>faultInjector?.(point,data),config,saveConfig,resolveLocation,quote,get,requestReview,prepareOrder,completeOrder,saveAddress,regionalize,fulfillment,
    async addresses(account){return account.customer_id?customers.listLocations(account.customer_id):[];},
    async publicConfig(){const c=await config();return {enabled:true,routingConfigured:router.configured,banks:c.banks.filter(b=>b.active),pickupAutomatic:false,regionalPricing:true};},
    async adminQuotes(){return (await sql.query('SELECT id,account_id,state,order_id,expires_at,doc,created_at FROM fulltech_checkout_quotes_v1 ORDER BY created_at DESC LIMIT 200')).rows.map(r=>({id:r.id,accountId:r.account_id,state:r.state,orderId:r.order_id,createdAt:r.created_at,...publicQuote(JSON.parse(r.doc),r.state)}));},
  };
}
