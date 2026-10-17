import {createHash} from 'node:crypto';
import {calculateSale} from '../public/admin/pos-math.js';
import {orderOf} from './orders.mjs';

const queues = new WeakMap();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(cents/100);
function visible(doc, actor) {return actor.role === 'ADMIN' || doc.actor_id === actor.id;}
function publicDocument(doc, actor) {
  const clean = structuredClone(doc);
  delete clean.fingerprint; delete clean.failure;
  if(actor.role !== 'ADMIN') {
    delete clean.sale?.profit_cents;
    clean.sale?.items?.forEach(i=>delete i.cost_cents);
  }
  return clean;
}
export function quotationHtml(doc) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cotización ${escape(doc.number)}</title><style>body{font:15px system-ui;max-width:760px;margin:36px auto;padding:20px;color:#14243b}header,footer{padding:20px 0;border-bottom:1px solid #ddd}table{width:100%;border-collapse:collapse}td,th{padding:12px 6px;text-align:right;border-bottom:1px solid #eee}td:first-child,th:first-child{text-align:left}.total{text-align:right;font-size:22px}small{color:#526078}@media print{button{display:none}}</style><header><h1>Fulltech · Cotización</h1><p>${escape(doc.number)} · ${escape(new Date(doc.created_at).toLocaleDateString('es-DO'))}</p><p>${escape(doc.customer.name)} · ${escape(doc.customer.phone_e164)}</p></header><table><thead><tr><th>Artículo</th><th>Cant.</th><th>Precio</th><th>Descuento</th><th>Importe</th></tr></thead><tbody>${doc.sale.items.map(i=>`<tr><td>${escape(i.name)}</td><td>${i.quantity}</td><td>${money(i.unit_price_cents)}</td><td>${money(i.discount_cents)}</td><td>${money(i.subtotal_cents)}</td></tr>`).join('')}</tbody></table><p class="total">Total: ${money(doc.sale.total_cents)}</p><p>Descuento general: ${money(doc.sale.discount_cents)} · Envío: ${money(doc.sale.delivery_cents)}</p><p>${escape(doc.input.notes)}</p><footer><small>Cotización comercial. No acredita pago ni reserva inventario. Precios y disponibilidad se verifican al confirmar la venta.</small></footer><button onclick="window.print()">Imprimir / guardar PDF</button></html>`;
}

export async function handlePosRoute({req,res,route,ctx,actor,json,readJson,can,createOrder,findOrder}) {
  if(!route.startsWith('/api/admin/pos/')) return false;
  const send=(status,body)=>{json(res,status,body);return true;};
  if(!can('orders.read')) return send(403,{ok:false,error:'forbidden'});
  if(!ctx.storeCatalog) return send(503,{ok:false,message:'Facturación necesita almacenamiento SQL.'});
  const db=ctx.db;
  let claimedOrder=null;
  try {
    if(route.startsWith('/api/admin/pos/context/')&&req.method==='GET') {
      const customerId=decodeURIComponent(route.slice('/api/admin/pos/context/'.length));
      const rows=await ctx.store.listAdmin({limit:5000});
      return send(200,{ok:true,openOrders:rows.filter(i=>i.customer_id===customerId&&!['entregado','cancelado','perdido'].includes(i.status)).map(i=>({id:i.id,number:i.order_number||i.id}))});
    }
    if(route==='/api/admin/pos/customers' && req.method==='POST') {
      if(!can('orders.create')) return send(403,{ok:false});
      const body=await readJson(req);
      const found=await ctx.customers.findOrCreateByPhone({name:String(body.name||'').slice(0,120),phone:body.phone,source:'manual'});
      if(!found.ok) return send(422,{ok:false,message:'Escribe un teléfono válido con código de país.'});
      return send(200,{ok:true,customer:{id:found.customer.id,name:found.customer.name,phone_e164:found.customer.phone_e164}});
    }
    if(route==='/api/admin/pos/customers' && req.method==='GET') {
      const rows=await db.list('customers',{limit:5000});
      return send(200,{ok:true,actorId:actor.id||actor.role,canCreate:can('orders.create'),isAdmin:actor.role==='ADMIN',customers:rows.map(c=>({id:c.id,name:c.name,phone_e164:c.phone_e164}))});
    }
    if(route==='/api/admin/pos/quotes' && req.method==='GET') {
      const rows=await db.list('pos_documents',{by:'created_at',order:'desc',limit:1000});
      return send(200,{ok:true,quotes:rows.filter(d=>d.kind==='quote'&&visible(d,actor)).slice(0,100).map(d=>publicDocument(d,actor))});
    }
    const receipt=/^\/api\/admin\/pos\/quotes\/([a-z0-9_-]+)\/receipt$/.exec(route);
    if(receipt&&req.method==='GET') {
      const doc=await db.get('pos_documents',receipt[1]);
      if(!doc||doc.kind!=='quote'||!visible(doc,actor)) return send(404,{ok:false});
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      res.end(quotationHtml(doc));return true;
    }
    if(!['/api/admin/pos/quotes','/api/admin/pos/checkout'].includes(route)||req.method!=='POST') return send(404,{ok:false});
    if(!can('orders.create')) return send(403,{ok:false,error:'forbidden'});
    const body=await readJson(req), kind=route.endsWith('/quotes')?'quote':body.mode==='order'?'order':'invoice';
    if(kind!=='quote'&&!['order','invoice'].includes(body.mode))return send(422,{ok:false,message:'Elige Pedido o Factura.'});
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId||'')) return send(422,{ok:false,message:'Falta el identificador de la operación.'});
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>100) return send(422,{ok:false,message:'Agrega entre 1 y 100 artículos.'});
    // Un solo cobro por cotización, incluso desde dos navegadores o dos servidores.
    const source=body.quoteId?await db.get('pos_documents',String(body.quoteId)):null;
    if(body.quoteId&&(!source||source.kind!=='quote'||!visible(source,actor))) return send(404,{ok:false,message:'Cotización no disponible.'});
    const input={customerId:String(body.customerId||''),conversationId:String(body.conversationId||''),
      items:body.items.map(i=>({variantId:String(i.variantId),quantity:Number(i.quantity),discount:i.discount||{}})),
      discount:body.discount||{},deliveryFee:Number(body.deliveryFee||0),notes:String(body.notes||'').slice(0,2000),
      address:String(body.address||'').slice(0,500),paymentMethod:body.paymentMethod||'CASH',location:body.location||null};
    const fingerprint=hash({kind,input,expectedTotal:body.expectedTotal});
    const id='pos_'+hash(source?['quote-sale',source.id]:[actor.id||actor.role,body.requestId]).slice(0,40);
    const prior=queues.get(ctx)||Promise.resolve();let release;const current=new Promise(r=>release=r);queues.set(ctx,current);await prior;
    try {
      const previous=await db.get('pos_documents',id);
      if(previous) {
        if(previous.fingerprint!==fingerprint) return send(409,{ok:false,message:'Esta operación ya fue utilizada con otros datos. Abre el pedido guardado antes de continuar.'});
        if(previous.result) return send(200,{ok:true,...previous.result,duplicate:true});
        if(previous.kind==='quote')return send(200,{ok:true,quoteId:id,receiptUrl:`/api/admin/pos/quotes/${id}/receipt`,duplicate:true});
        const saved=previous.order_id?await findOrder(previous.order_id):null,order=orderOf(saved);
        if(order&&(previous.kind==='order'||(order.status==='entregado'&&saved.inventory_deducted_at))) {
          const recovered={orderId:order.id,number:order.order_number,total_cents:Math.round(order.total*100),mode:previous.kind,receiptUrl:`/api/admin/orders/${order.id}/receipt`};
          await db.update('pos_documents',id,{status:'completed',result:recovered});
          if(source)await db.update('pos_documents',source.id,{status:'converted',order_id:order.id});
          return send(200,{ok:true,...recovered,duplicate:true});
        }
        return send(409,{ok:false,error:'operation_pending',orderId:previous.order_id,message:'La operación está en revisión. No repitas el cobro: revisa el pedido en Pedidos.'});
      }
      const customer=await ctx.customers.get(input.customerId);
      if(!customer) return send(422,{ok:false,message:'Selecciona un cliente para continuar.'});
      if(kind!=='quote'&&!body.acknowledgeOpen) {
        const open=(await ctx.store.listAdmin({limit:5000})).filter(i=>i.customer_id===customer.id&&!['entregado','cancelado','perdido'].includes(i.status));
        if(open.length)return send(409,{ok:false,error:'open_orders',message:'El cliente ya tiene un pedido abierto. Confirma que deseas crear uno nuevo.'});
      }
      if(input.conversationId) {
        const conversation=await db.get('conversations',input.conversationId);
        if(!conversation||conversation.customer_id!==customer.id) return send(422,{ok:false,message:'La conversación no pertenece al cliente seleccionado.'});
      }
      if(!['CASH','TRANSFER'].includes(input.paymentMethod)) return send(422,{ok:false,message:'Selecciona efectivo o transferencia.'});
      if(!Number.isInteger(input.deliveryFee)) return send(422,{ok:false,message:'El envío debe expresarse en pesos enteros.'});
      const products=await ctx.storeCatalog.list();
      let sale;
      try{sale=calculateSale(input.items,products,input.discount,input.deliveryFee);}catch(e){return send(422,{ok:false,message:e.message});}
      if(!Number.isSafeInteger(body.expectedTotal)||body.expectedTotal!==sale.total_cents) return send(409,{ok:false,error:'price_changed',message:'Los precios cambiaron. Revisa el total actualizado antes de confirmar.'});
      if(kind!=='quote') {
        const stock=await ctx.storeCatalog.checkOrder({items:sale.items});
        if(!stock.ok)return send(stock.status||409,{...stock,operationPending:false});
        const stockState=await ctx.inventory.stock();
        const capsules=sale.items.reduce((n,i)=>n+(Number(products.find(p=>p.id===i.variantId)?.capsules)||0)*i.quantity,0);
        if(stockState.initialized&&stockState.current<capsules)return send(409,{ok:false,error:'insufficient_stock',message:`Stock insuficiente: hay ${stockState.current} cápsulas y necesitas ${capsules}.`});
      }
      const created_at=ctx.clock().toISOString(),orderId='pos'+hash(id).slice(0,29);
      const document={id,kind,status:kind==='quote'?'quoted':'processing',actor_id:actor.id,customer_id:customer.id,
        customer:{id:customer.id,name:customer.name,phone_e164:customer.phone_e164},created_at,fingerprint,input,sale,
        number:`COT-${id.slice(-10).toUpperCase()}`,order_id:kind==='quote'?null:orderId};
      const claim=await db.insert('pos_documents',document);
      if(claim.duplicate) return send(409,{ok:false,message:'Esta operación ya está siendo procesada. Revisa Pedidos antes de reintentar.'});
      claimedOrder=kind==='quote'?null:orderId;
      let result;
      if(kind==='quote') result={document:publicDocument(document,actor),receiptUrl:`/api/admin/pos/quotes/${id}/receipt`};
      else {
        const created=await createOrder(ctx,{...input,id:orderId,items:sale.items.map(i=>({variantId:i.variantId,quantity:i.quantity,unitPrice:i.unit_price_cents/100,lineDiscountCents:i.discount_cents})),
          discount:sale.discount_cents/100,status:kind==='invoice'?'entregado':'nuevo',delivery:{address:input.address},deliveryLocation:input.location,pos:true},actor);
        if(!created.ok) {
          await db.update('pos_documents',id,{status:'failed',failure:created.error});
          return send(created.status||422,{ok:false,error:created.error,operationPending:true,orderId:created.orderId||orderId,message:created.message||'No se pudo guardar. Revisa Pedidos antes de volver a cobrar.'});
        }
        result={orderId,number:created.order.order_number,total_cents:sale.total_cents,mode:kind,receiptUrl:`/api/admin/orders/${orderId}/receipt`};
        if(source) await db.update('pos_documents',source.id,{status:'converted',order_id:orderId});
      }
      // Se guarda sin ganancia/costos en el resultado reutilizado por otro rol.
      const storedResult=kind==='quote'?{receiptUrl:result.receiptUrl,quoteId:id}:result;
      await db.update('pos_documents',id,{status:kind==='quote'?'quoted':'completed',result:storedResult});
      return send(201,{ok:true,...result});
    } finally {release();}
  } catch(e) {
    console.error('[pos]',e.name,e.code||'');
    const status=claimedOrder?500:e.status||500;
    return send(status,{ok:false,operationPending:!!claimedOrder,orderId:claimedOrder,message:claimedOrder?'La operación necesita revisión. Consulta Pedidos antes de repetir el cobro.':status>=500?'No se pudo completar la operación. Vuelve a intentarlo.':e.message});
  }
}
