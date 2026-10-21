import {calculateSale} from './pos-math.js';

/* Sin documento (pestaña descargada o ventana de UAT cerrada) no hay nada que pintar. */
const doc=()=>(typeof document==='undefined'||!document?null:document);
const $=s=>doc()?.querySelector(s)??null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=c=>new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(c||0)/100);
const empty=()=>({items:[],discount:{},customer:null,conversationId:'',location:null,deliveryFee:0,address:'',notes:'',quoteId:null,flow:'order',ticketId:null,ticketVersion:null,ticketName:'',deliveryMethod:'delivery',scheduledAt:'',deliveryNotes:'',deliveryReference:'',deliveryAgentId:'',deliveryContact:null,paymentStatus:'pending',paymentMethod:'CASH',orderPrefs:null,saveOrderPrefs:true,feeReviewed:false,openAck:false,guidedFlow:false,createdOrderId:null,orderDirty:false});
const personIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg>';
const quotesIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"/></svg>';
const actionIcon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({quick:'<path d="m13 2-9 12h7l-1 8 10-13h-8z"/>',ticket:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4zM15 5v3m0 3v2m0 3v3"/>',save:'<path d="M5 3h12l4 4v14H3V3h2zm2 0v6h10V3M7 21v-8h10v8"/>',note:'<path d="M4 4h11l5 5v11H4zM15 4v5h5M8 12h8M8 16h6"/>',stock:'<path d="m3 7 9-4 9 4v12l-9 3-9-3zM3 7l9 4 9-4M12 11v11M16 3v6M13 6h6"/>',product:'<path d="M4 5h16v15H4zM4 10h16M12 13v5m-2.5-2.5h5"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'})[name]||''}</svg>`;
let draft=empty(),products=[],customers=[],suppliers=[],isAdmin=false,canCreate=false,expanded=false,busy=false,loaded=false,generation=0,operation=null,message='',initializing=null,dragged=false,draftKey=null;
const root=$('#pos-root'),client=document.createElement('div');client.id='pos-client';root?.parentElement.prepend(client);
const modal=document.createElement('dialog');modal.className='pos-dialog';document.body.append(modal);
const actionsDrawer=document.createElement('dialog');actionsDrawer.className='pos-actions-drawer';actionsDrawer.setAttribute('aria-label','Acciones de facturación');document.body.append(actionsDrawer);
function closeActions(){actionsDrawer.close();delete document.body.dataset.posActions;document.querySelectorAll('[data-pos-actions]').forEach(b=>b.setAttribute('aria-expanded','false'));}
actionsDrawer.addEventListener('cancel',e=>{e.preventDefault();closeActions();});
actionsDrawer.addEventListener('click',e=>{
  if(e.target===actionsDrawer){const r=actionsDrawer.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right)closeActions();}
  if(e.target.closest('button'))closeActions();
});
function persist(){try{if(draftKey)localStorage.setItem(draftKey,JSON.stringify({draft,operation}));}catch{}}
function changed(){operation=null;message='';draft.ticketDirty=true;if(draft.createdOrderId)draft.orderDirty=true;persist();render();if(draft.ticketId||draft.flow==='order')scheduleTicketSave();}
async function api(path,body){
  const epoch=generation;
  const response=await fetch(`/api/admin/pos/${path}`,{credentials:'same-origin',cache:'no-store',method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(epoch!==generation)throw new Error('La sesión cambió.');
  if(response.status===401){window.dispatchEvent(new Event('fulltech:session-expired'));throw new Error('Tu sesión terminó.');}
  if(!response.ok||!data.ok){const e=new Error(data.message||'No se pudo completar la operación.');e.data=data;throw e;}return data;
}
function totals(){try{return calculateSale(draft.items,products,draft.discount,draft.deliveryFee);}catch(e){
  // Conserva las líneas editables aunque un cambio de cantidad invalide un descuento fijo.
  const items=draft.items.map(line=>{const p=products.find(p=>p.id===line.variantId)||(line.manual?{name:line.manual.name,price_cents:Math.round(Number(line.manual.price)*100)}:null);return {variantId:line.variantId,name:p?.name||'Artículo no disponible',quantity:line.quantity,unit_price_cents:p?.price_cents||0,subtotal_cents:(p?.price_cents||0)*line.quantity,discount_cents:0};});
  return {items,total_cents:items.reduce((n,i)=>n+i.subtotal_cents,0),discount_cents:0,error:e.message};
}}
function updateBadges(){
  const d=doc();if(!d)return;
  d.querySelectorAll('[data-product-id]').forEach(card=>{const n=draft.items.filter(i=>i.variantId===card.dataset.productId).reduce((s,i)=>s+i.quantity,0),badge=card.querySelector('.pos-card-quantity');if(badge){badge.hidden=!n;badge.textContent=n;card.classList.toggle('pos-in-cart',!!n);}});
}
function render(){
  if(!root)return;
  const sale=totals(),quantity=draft.items.reduce((n,i)=>n+i.quantity,0),disabled=!draft.items.length||!!sale.error||!canCreate||busy;
  const wide=window.matchMedia?.('(min-width:900px)').matches;
  client.innerHTML=`<button type="button" class="pos-client-button" data-pos-client><span class="pos-client-icon">${personIcon}</span><strong>${esc(draft.customer?.name||'Selecciona cliente')}</strong><span class="pos-client-chevron" aria-hidden="true">⌄</span></button>${draft.customer?'<button class="pos-icon" type="button" data-pos-remove-client aria-label="Quitar cliente">×</button>':''}<button class="pos-tickets-trigger" type="button" data-pos-tickets aria-haspopup="dialog">${actionIcon('ticket')}<span>Tickets</span></button>`;
  root.classList.toggle('pos-expanded',expanded);
  root.innerHTML=`<section class="pos-cart" aria-label="Carrito de venta"><button class="pos-cart-handle" type="button" data-pos-expand aria-expanded="${expanded||wide}" ${wide?'disabled':''} aria-label="${expanded||wide?'Contraer':'Expandir'} carrito"><span class="pos-grip"></span><span>Carrito <small>${quantity} ${quantity===1?'artículo':'artículos'}</small></span><span>${expanded?'⌄':'⌃'}</span></button><div class="pos-cart-lines" ${expanded?'':'inert'}>${sale.items.length?sale.items.map((line,index)=>`<article class="pos-cart-line"><button type="button" class="pos-line-edit" data-pos-edit="${index}" aria-label="Editar cantidad y descuento de ${esc(line.name)}"><span class="pos-line-qty" data-pos-quantity="${index}">${line.quantity}</span><span class="pos-line-info"><strong>${esc(line.name)}</strong><small>${cash(line.unit_price_cents)} c/u${line.discount_cents?` · <span class="pos-line-save">−${cash(line.discount_cents)}</span>`:''}</small></span></button><span class="pos-line-total"><strong>${cash(line.subtotal_cents)}</strong></span></article>`).join(''):'<p class="pos-empty">Toca + en un artículo para comenzar.</p>'}</div>${draft.notes?`<button type="button" class="pos-cart-note" data-pos-note aria-label="Editar nota del pedido">${actionIcon('note')}<span>${esc(draft.notes)}</span></button>`:''}<div class="pos-cart-tools" ${expanded?'':'hidden'}><button type="button" class="pos-text" data-pos-options>Envío y notas</button><button type="button" class="pos-text" data-pos-pending ${disabled?'disabled':''}>Guardar pedido</button><button type="button" class="pos-text" data-pos-clear ${!draft.items.length||busy?'disabled':''}>Vaciar</button></div></section><div class="pos-feedback" role="status" aria-live="polite">${esc(message||sale.error||'')}</div><section class="pos-summary" aria-label="Resumen de venta"><div class="pos-summary-values">${isAdmin?`<div class="pos-profit"><small>Ganancia</small><strong>${sale.profit_cents===undefined?'—':cash(sale.profit_cents)}</strong></div>`:'<span></span>'}<button type="button" class="pos-discount-total" data-pos-discount="total"><small>Descuento</small><strong>${cash(sale.discount_cents)}</strong></button><div class="pos-total"><small>Total</small><strong>${cash(sale.total_cents)}</strong></div></div><div class="pos-actions"><button type="button" class="btn btn--ghost" data-pos-quote ${disabled?'disabled':''}>Cotizar</button><button type="button" class="btn btn--primary" data-pos-pay ${disabled?'disabled':''}>${busy?'Guardando…':orderFromChat()?'Continuar':'Cobrar'}</button></div></section>`;
  root.querySelector('.pos-cart-lines')?.removeAttribute('inert');
  root.classList.toggle('pos-has-items',!!sale.items.length);
  const cartCaption=root.querySelector('.pos-cart-handle>span:nth-child(2)');if(cartCaption&&draft.ticketName)cartCaption.innerHTML=`${esc(draft.ticketName)} <small>${quantity} ${quantity===1?'artículo':'artículos'}</small>`;
  if(wide){root.querySelector('.pos-cart-tools')?.removeAttribute('hidden');}
  updateBadges();
  const handle=$('[data-pos-expand]');let startY=null;
  handle?.addEventListener('pointerdown',e=>{startY=e.clientY;handle.setPointerCapture?.(e.pointerId);});
  handle?.addEventListener('pointerup',e=>{if(startY!==null&&Math.abs(e.clientY-startY)>25){dragged=true;expanded=e.clientY<startY;render();setTimeout(()=>dragged=false,0);}startY=null;});
}
async function initialize(){
  if(loaded)return;if(initializing)return initializing;const epoch=generation;
  initializing=(async()=>{
  try{
    const data=await api('customers');if(epoch!==generation)return;
    customers=data.customers;isAdmin=data.isAdmin;canCreate=data.canCreate;loaded=true;draftKey='fulltech.pos.draft.'+data.actorId;
    try{const saved=JSON.parse(localStorage.getItem(draftKey)||sessionStorage.getItem(draftKey));if(saved?.draft?.items){draft=saved.draft;operation=saved.operation;}}catch{}
    if(!products.length){const response=await fetch('/api/admin/store/products',{credentials:'same-origin',cache:'no-store'});const catalog=await response.json();if(epoch!==generation)return;products=catalog.products||[];}
    /* Tiendas proveedoras: hacen falta para vender un producto de terceros. */
    try{const respuesta=await fetch('/api/admin/suppliers',{credentials:'same-origin',cache:'no-store'});if(respuesta.ok){const lista=await respuesta.json();suppliers=(lista.suppliers||[]).filter(s=>s.active!==false);}}catch{}
    render();
  }catch(e){if(epoch===generation){message=e.message;render();}}finally{initializing=null;}
  })();return initializing;
}
function show(title,body,submitText,onSubmit){
  closeActions();modal.classList.toggle('pos-client-dialog',title==='Seleccionar cliente');modal.classList.toggle('pos-tickets-dialog',title==='Tickets');
  modal.innerHTML=`<form class="pos-modal-form"><header><h2>${esc(title)}</h2><button class="pos-icon" type="button" data-pos-close aria-label="Cerrar">×</button></header><div class="pos-modal-body">${body}<p class="pos-modal-error" role="alert"></p></div>${submitText?`<footer><button class="btn btn--primary" type="submit">${esc(submitText)}</button></footer>`:''}</form>`;
  modal.setAttribute('aria-label',title);if(!modal.open)modal.showModal();
  modal.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();if(!onSubmit)return;const epoch=generation,button=modal.querySelector('[type=submit]');if(!button||button.disabled)return;button.disabled=true;try{await onSubmit(new FormData(e.target));}catch(err){const error=modal.querySelector('.pos-modal-error');if(error&&epoch===generation)error.textContent=err.message;}finally{button.disabled=false;}});
}
/*
 * EL CLIENTE DEL CARRITO ES UN DATO, NO UN TEXTO.
 *
 * El grupo de negocio sale del campo `groups` del cliente guardado: nunca se
 * deduce del nombre ni del teléfono. Un cliente sin grupo aparece en «Todos» y
 * no se escribe nada en su ficha por el hecho de filtrar.
 */
let posClient={query:'',filter:'all'};
const filterIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
const clientGroupKeys=c=>(Array.isArray(c?.groups)?c.groups:[]).map(g=>String(g).trim().toLocaleLowerCase('es'));
const clientMatches=(c,filter)=>filter==='all'||clientGroupKeys(c).some(g=>g.startsWith(filter==='phyto'?'phytoemagry':'fulltech'));
const clientGroupLabel=c=>{const keys=clientGroupKeys(c);if(keys.some(g=>g.startsWith('phytoemagry')))return 'PHYTOEMAGRY';if(keys.some(g=>g.startsWith('fulltech')))return 'FULLTECH';return '';};
const clientInitials=name=>String(name||'?').trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
function chooseClient(){
  show('Seleccionar cliente',`<div class="pos-client-toolbar"><label class="store-search field"><span class="sr-only">Buscar cliente</span><input class="field__input" type="search" id="pos-client-search" placeholder="Buscar por nombre o teléfono" autocomplete="off" enterkeyhint="search"></label><div class="pos-client-tools"><button type="button" class="pos-client-tool" id="pos-client-filter" aria-label="Filtrar por grupo de negocio" aria-controls="pos-client-chips" aria-expanded="false">${filterIcon}${posClient.filter!=='all'?'<span class="pos-client-tool-dot" aria-hidden="true"></span>':''}</button><button type="button" class="pos-client-tool" id="pos-client-new" aria-label="Agregar cliente" title="Agregar cliente" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div></div><div class="pos-client-chips" id="pos-client-chips" role="group" aria-label="Grupo de negocio" hidden><button type="button" data-client-filter="all" aria-pressed="true">Todos</button><button type="button" data-client-filter="phyto" aria-pressed="false">PHYTOEMAGRY</button><button type="button" data-client-filter="fulltech" aria-pressed="false">FULLTECH</button></div><div class="pos-new-client" hidden><h3>Nuevo cliente</h3><label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" maxlength="120"></label><label class="field"><span class="field__label">Teléfono con código de país</span><input class="field__input" name="phone" type="tel" placeholder="+1 809 555 1234"></label><button class="btn btn--primary" type="submit">Guardar y seleccionar</button></div><div id="pos-customer-results" role="group" aria-label="Clientes"></div>`,null,async form=>{
    if(!String(form.get('phone')||'').trim())throw new Error('Escribe el teléfono del nuevo cliente.');
    await initialize();
    const data=await api('customers',{name:form.get('name'),phone:form.get('phone')});customers.push(data.customer);modal.close();await enterCustomer({customer:data.customer,askOrders:false});
  });
  /*
   * La lista NO se reconstruye al filtrar: se reescribe solo el contenedor de
   * resultados, así el buscador conserva el texto, el foco y el teclado.
   */
  const results=()=>{
    const q=String($('#pos-client-search')?.value||'').trim().toLocaleLowerCase();
    posClient.query=String($('#pos-client-search')?.value||'');
    const rows=customers.filter(c=>clientMatches(c,posClient.filter)&&(String(c.name||'')+' '+String(c.phone_e164||'')).toLocaleLowerCase().includes(q));
    const host=$('#pos-customer-results');
    if(host)host.innerHTML=rows.length?rows.map(c=>{
      const tag=clientGroupLabel(c),current=draft.customer?.id===c.id;
      return `<button type="button" class="pos-customer-row" data-client-choice="${esc(c.id)}" aria-pressed="${current}"><span class="pos-customer-avatar" aria-hidden="true">${esc(clientInitials(c.name))}</span><span class="pos-customer-main"><strong>${esc(c.name||c.phone_e164||'Cliente')}</strong>${c.phone_e164?`<small>${esc(c.phone_e164)}</small>`:''}</span>${tag?`<span class="pos-customer-tag">${esc(tag)}</span>`:''}<span class="pos-customer-check" aria-hidden="true">${current?'✓':''}</span></button>`;
    }).join(''):'<p class="pos-empty">No encontramos clientes con esa búsqueda o filtro.</p>';
  };
  const syncFilters=()=>{
    modal.querySelectorAll('[data-client-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.clientFilter===posClient.filter)));
    const trigger=$('#pos-client-filter');
    if(trigger){trigger.classList.toggle('is-filtered',posClient.filter!=='all');trigger.setAttribute('aria-expanded',String(!$('#pos-client-chips')?.hidden));}
  };
  $('#pos-customer-results').addEventListener('click',e=>{
    const row=e.target.closest('[data-client-choice]');if(!row)return;
    const customer=customers.find(c=>c.id===row.dataset.clientChoice);if(!customer)return;
    modal.close();runAction(()=>enterCustomer({customer}));
  });
  $('#pos-client-filter').addEventListener('click',()=>{const chips=$('#pos-client-chips');if(chips)chips.hidden=!chips.hidden;syncFilters();});
  $('#pos-client-chips').addEventListener('click',e=>{const button=e.target.closest('[data-client-filter]');if(!button)return;posClient.filter=button.dataset.clientFilter||'all';syncFilters();results();});
  $('#pos-client-new').addEventListener('click',()=>{const form=modal.querySelector('.pos-new-client');form.hidden=!form.hidden;$('#pos-client-new').setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)form.querySelector('input').focus();});
  $('#pos-client-search').addEventListener('input',results);
  $('#pos-client-chips').hidden=posClient.filter==='all';
  syncFilters();
  results();
}
function selectClient(customer){draft.customer=customer;draft.conversationId='';draft.location=null;draft.quoteId=null;draft.createdOrderId=null;draft.orderDirty=false;changed();}

/* ------------------------------------------------------------------ *
 * UN CARRITO, UN CLIENTE.
 *
 * El carrito vive en memoria y se guarda en el SERVIDOR como ticket
 * versionado. Al abrir el contexto de otro cliente NUNCA se traspasan sus
 * artículos: el carrito anterior se guarda COMO SUYO y el cliente nuevo abre
 * su propio borrador (el suyo guardado, o uno vacío). La propiedad de un
 * pedido no se cambia de forma implícita en ningún camino.
 * ------------------------------------------------------------------ */
function applyCustomer({customer,conversationId='',location=null}={}){
  const same=Boolean(customer)&&draft.customer?.id===customer.id;
  draft.customer=customer||null;
  draft.conversationId=conversationId||(same?draft.conversationId:'');
  draft.location=location??(same?draft.location:null);
  if(!draft.location&&!same)draft.address='';
  draft.quoteId=null;draft.createdOrderId=null;draft.orderDirty=false;
  changed();
}
async function isolateCartFor(customerId){
  if(!draft.items.length||draft.customer?.id===customerId)return true;
  try{await saveActiveTicket();}
  catch(error){message=`No se pudo guardar el carrito de ${draft.customer?.name||'el cliente anterior'}: ${error.message}`;render();return false;}
  draft=empty();persist();
  return true;
}
async function ticketForCustomer(customerId){
  try{const data=await api('tickets');return (data.tickets||[]).find(t=>(t.draft?.customer?.id||t.draft?.customerId)===customerId&&(!t.status||t.status==='open'))||null;}
  catch{return null;}
}
async function pendingOrders(customerId){
  try{const data=await getAdmin(`/api/admin/pos/context/${encodeURIComponent(customerId)}`);return data.openOrders||[];}
  catch{return [];}
}
async function openCustomerCart({customer,conversationId='',location=null}={}){
  if(!(await isolateCartFor(customer.id)))return;
  if(!draft.items.length){
    const own=await ticketForCustomer(customer.id);
    if(own)draft={...empty(),...own.draft,ticketId:own.id,ticketVersion:own.version,ticketName:own.name,ticketDirty:false};
  }
  applyCustomer({customer,conversationId,location});
}
async function enterCustomer({customer,conversationId='',location=null,askOrders=true}={}){
  if(!customer)return;
  const orders=askOrders?await pendingOrders(customer.id):[];
  if(orders.length){offerPendingOrders({customer,conversationId,location,orders});return;}
  await openCustomerCart({customer,conversationId,location});
}
/*
 * PEDIDOS PENDIENTES DEL PROPIO CLIENTE. Nada se toca hasta que la persona
 * decide: no se fusionan pedidos ni se reasigna la propiedad de ninguno.
 */
function offerPendingOrders({customer,conversationId='',location=null,orders=[],onNew=null}={}){
  const total=orders.length,multiple=total>1;
  /* El total del pedido viene en pesos (no en centavos): no se usa `cash`. */
  const orderState={nuevo:'Nuevo',confirmado:'Confirmado',preparando:'Preparando',en_camino:'En camino',entregado:'Entregado',cancelado:'Cancelado',perdido:'Perdido'};
  const rows=orders.map(o=>{
    const meta=[orderState[o.status]||o.status||'',o.total!=null?new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(o.total)):'',o.items?`${o.items} ${o.items===1?'artículo':'artículos'}`:'',o.created_at?String(o.created_at).slice(0,10):''].filter(Boolean).join(' · ');
    return `<button type="button" class="pos-pending-row" data-pending-order="${esc(o.id)}" aria-pressed="${!multiple&&orders[0].id===o.id}"><span class="pos-pending-main"><strong>${esc(o.number||o.id)}</strong>${meta?`<small>${esc(meta)}</small>`:''}</span><span class="pos-customer-check" aria-hidden="true">${!multiple&&orders[0].id===o.id?'✓':''}</span></button>`;
  }).join('');
  show('Pedido pendiente encontrado',`<p class="pos-muted">${esc(customer?.name||'Este cliente')} ${multiple?`tiene ${total} pedidos abiertos`:'tiene un pedido abierto'}. Elige qué hacer; hasta que decidas no se modifica ninguno.</p><div class="pos-pending-list">${rows}</div><div class="pos-pending-actions"><button type="button" class="btn btn--primary" data-pending-continue>Continuar pedido</button><button type="button" class="btn btn--ghost" data-pending-new>Crear pedido nuevo</button><button type="button" class="btn btn--ghost" data-pending-cancel>Cancelar</button></div>`,null,null);
  let picked=multiple?null:orders[0].id;
  const sync=()=>{
    modal.querySelectorAll('[data-pending-order]').forEach(row=>{const on=row.dataset.pendingOrder===picked;row.setAttribute('aria-pressed',String(on));const check=row.querySelector('.pos-customer-check');if(check)check.textContent=on?'✓':'';});
    const go=modal.querySelector('[data-pending-continue]');if(go)go.disabled=!picked;
  };
  modal.querySelectorAll('[data-pending-order]').forEach(row=>row.addEventListener('click',()=>{picked=row.dataset.pendingOrder;sync();}));
  modal.querySelector('[data-pending-continue]')?.addEventListener('click',()=>{const orderId=picked;modal.close();if(orderId)window.dispatchEvent(new CustomEvent('fulltech:order-edit',{detail:{orderId,customerId:customer?.id||'',conversationId}}));});
  modal.querySelector('[data-pending-new]')?.addEventListener('click',()=>{modal.close();runAction(()=>onNew?onNew():openCustomerCart({customer,conversationId,location}));});
  modal.querySelector('[data-pending-cancel]')?.addEventListener('click',()=>modal.close());
  sync();
}
function editDiscount(index){
  const target=index==='total'?draft:draft.items[Number(index)];if(!target)return;
  show(index==='total'?'Descuento general':'Descuento del artículo',`<label class="field"><span class="field__label">Tipo</span><select class="field__select" name="type"><option value="amount" ${target.discount?.type!=='percent'?'selected':''}>Monto fijo (RD$)</option><option value="percent" ${target.discount?.type==='percent'?'selected':''}>Porcentaje (%)</option></select></label><label class="field"><span class="field__label">Valor</span><input class="field__input" type="number" name="value" min="0" step="0.01" value="${Number(target.discount?.value||0)}" required></label><p class="pos-muted">El monto fijo se aplica a toda la línea. Usa 0 para quitar el descuento.</p>`,'Aplicar',form=>{
    const before=target.discount;target.discount={type:form.get('type'),value:Number(form.get('value'))};
    try{calculateSale(draft.items,products,draft.discount,draft.deliveryFee);}catch(e){target.discount=before;throw e;}
    changed();modal.close();
  });
}
function lineEditor(index){
  const line=draft.items[index];if(!line)return;
  const item=totals().items[index],unit=item?.unit_price_cents||0,type=line.discount?.type==='percent'?'percent':'amount',value=Number(line.discount?.value||0);
  show('Editar artículo',`<div class="pos-line-editor" data-line-index="${index}"><div class="pos-editor-head"><div><strong>${esc(item?.name||'Artículo')}</strong><small>${cash(unit)} c/u</small></div><span id="pos-line-preview">${cash(item?.subtotal_cents||0)}</span></div><div class="pos-editor-section"><span class="pos-editor-label">Cantidad</span><div class="pos-qty-control"><button type="button" data-pos-line-step="-1" aria-label="Disminuir cantidad">−</button><input class="pos-qty-input" name="quantity" type="number" inputmode="numeric" min="1" max="9999" step="1" value="${line.quantity}" aria-label="Cantidad"><button type="button" data-pos-line-step="1" aria-label="Aumentar cantidad">+</button></div></div><div class="pos-editor-section"><span class="pos-editor-label">Descuento</span><div class="pos-discount-grid"><label class="field"><span class="field__label">Tipo</span><select class="field__select" name="type"><option value="amount" ${type==='percent'?'':'selected'}>Monto fijo (RD$)</option><option value="percent" ${type==='percent'?'selected':''}>Porcentaje (%)</option></select></label><label class="field"><span class="field__label">Valor</span><input class="field__input" name="value" type="number" inputmode="decimal" min="0" step="0.01" value="${value}"></label></div><div class="pos-discount-chips" role="group" aria-label="Descuentos rápidos"><button type="button" data-pos-line-discount="0">Sin descuento</button><button type="button" data-pos-line-discount="5">5%</button><button type="button" data-pos-line-discount="10">10%</button><button type="button" data-pos-line-discount="15">15%</button></div><p class="pos-muted">El monto fijo se aplica a toda la línea.</p></div><div class="pos-editor-total"><span>Total de la línea</span><strong id="pos-line-total">${cash(item?.subtotal_cents||0)}</strong></div><button type="button" class="pos-editor-remove" data-pos-line-remove>Quitar artículo</button></div>`,'Aplicar',form=>applyLineEdit(index,form));
  const body=modal.querySelector('.pos-line-editor'),qty=body.querySelector('[name=quantity]'),kind=body.querySelector('[name=type]'),amount=body.querySelector('[name=value]');
  const preview=()=>{
    const quantity=Math.max(0,Math.min(9999,Math.round(Number(qty.value)||0))),raw=Math.max(0,Number(amount.value)||0),gross=unit*quantity;
    const reduction=Math.min(gross,kind.value==='percent'?Math.round(gross*raw/100):Math.round(raw*100)),total=cash(gross-reduction);
    $('#pos-line-preview').textContent=total;$('#pos-line-total').textContent=total;
  };
  body.querySelectorAll('[data-pos-line-step]').forEach(button=>button.addEventListener('click',()=>{qty.value=String(Math.max(1,Math.min(9999,Math.round(Number(qty.value)||1)+Number(button.dataset.posLineStep))));preview();}));
  body.querySelectorAll('[data-pos-line-discount]').forEach(button=>button.addEventListener('click',()=>{const quick=Number(button.dataset.posLineDiscount);kind.value=quick?'percent':'amount';amount.value=String(quick);preview();}));
  qty.addEventListener('input',preview);kind.addEventListener('change',preview);amount.addEventListener('input',preview);preview();
  body.querySelector('[data-pos-line-remove]').addEventListener('click',()=>removeLine(index));
}
function applyLineEdit(index,form){
  const line=draft.items[index];if(!line)throw new Error('Ese artículo ya no está en el carrito.');
  const quantity=Number(form.get('quantity')),raw=Number(form.get('value')||0),type=form.get('type');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>9999)throw new Error('La cantidad debe estar entre 1 y 9999.');
  if(!Number.isFinite(raw)||raw<0)throw new Error('El descuento debe ser positivo.');
  const candidate={...line,quantity,discount:raw>0?{type:type==='percent'?'percent':'amount',value:raw}:{}};
  draft.items[index]=candidate;
  try{calculateSale(draft.items,products,draft.discount,draft.deliveryFee);}catch(error){draft.items[index]=line;throw error;}
  changed();modal.close();
}
function removeLine(index){
  const line=draft.items[index];if(!line)return;
  const name=totals().items[index]?.name||'este artículo';
  show('Quitar artículo',`<p>¿Quitar <strong>${esc(name)}</strong> del carrito?</p><p class="pos-muted">Se eliminarán también su descuento y su cantidad.</p>`,'Quitar',()=>{draft.items.splice(index,1);changed();modal.close();});
  modal.querySelector('[type=submit]')?.classList.add('pos-danger');
}
function notes(){
  show('Nota del pedido',`<label class="field"><span class="field__label">Nota</span><textarea class="field__input" name="notes" maxlength="2000" rows="4" placeholder="Referencia, instrucciones de entrega o cualquier detalle.">${esc(draft.notes)}</textarea></label><p class="pos-muted">Se guardará con el pedido, la cotización o la venta.</p>`,'Guardar nota',form=>{draft.notes=String(form.get('notes')||'').trim();changed();modal.close();});
}
function options(){
  show('Envío y notas',`<label class="field"><span class="field__label">Costo de envío (RD$)</span><input class="field__input" name="deliveryFee" type="number" min="0" step="1" value="${draft.deliveryFee||0}" required></label><label class="field"><span class="field__label">Dirección de entrega</span><input class="field__input" name="address" maxlength="240" value="${esc(draft.address)}"></label><label class="field"><span class="field__label">Notas</span><textarea class="field__input" name="notes" maxlength="2000">${esc(draft.notes)}</textarea></label>${draft.location?'<p>Se conservará la ubicación seleccionada desde el chat.</p>':''}`,'Guardar',form=>{draft.deliveryFee=Number(form.get('deliveryFee'));draft.address=String(form.get('address'));draft.notes=String(form.get('notes'));changed();modal.close();});
}
async function confirmSale(mode){
  const epoch=generation;
  if(!draft.customer){chooseClient();message='Selecciona el cliente y vuelve a pulsar la acción.';render();return;}
  if(!draft.items.length)return;
  const sale=totals();if(sale.error){message=sale.error;render();return;}
  const invoice=mode==='invoice',quote=mode==='quote';
  draft.flow=mode;persist();render();
  let openOrders=[];
  if(!quote){try{busy=true;render();openOrders=(await api('context/'+encodeURIComponent(draft.customer.id))).openOrders||[];}catch(e){if(epoch===generation){message=e.message;render();}return;}finally{if(epoch===generation){busy=false;render();}}}
  if(epoch!==generation)return;
  show(quote?'Confirmar cotización':invoice?'Cobrar venta':'Guardar pedido',`<div class="pos-confirm-total"><small>${esc(draft.customer.name||draft.customer.phone_e164)}</small><strong>${cash(sale.total_cents)}</strong><span>${draft.items.reduce((n,i)=>n+i.quantity,0)} artículos</span></div>${invoice?'<label class="field"><span class="field__label">Forma de pago</span><select class="field__select" name="paymentMethod"><option value="CASH">Efectivo</option><option value="TRANSFER">Transferencia</option></select></label><label class="field"><span class="field__label">Importe recibido / confirmado (RD$)</span><input class="field__input" type="number" name="received" min="0" step="0.01" required></label><p id="pos-change" class="pos-muted"></p><label class="pos-check"><input type="checkbox" name="confirmed" required> Confirmo que recibí el pago y entregué los artículos.</label>':quote?'<p class="pos-muted">Guardarás una cotización. No registra pago ni descuenta inventario.</p>':'<p class="pos-muted">Quedará pendiente en Pedidos, sin registrar una venta ni descontar inventario.</p>'}`,
    quote?'Generar cotización':invoice?'Confirmar cobro':'Guardar pedido',async form=>{
      if(invoice){const received=Math.round(Number(form.get('received'))*100);if(!Number.isSafeInteger(received)||received<sale.total_cents)throw new Error('El importe recibido no cubre el total.');if(form.get('paymentMethod')==='TRANSFER'&&received!==sale.total_cents)throw new Error('Confirma el importe exacto de la transferencia.');}
      await complete(mode,String(form.get('paymentMethod')||'CASH'),form.get('acknowledgeOpen')==='on');
    });
  if(openOrders.length){const warning=document.createElement('label');warning.className='pos-check pos-open-warning';warning.innerHTML=`<input type="checkbox" name="acknowledgeOpen" required><span>El cliente ya tiene ${openOrders.length} pedido(s) sin cerrar (${openOrders.slice(0,3).map(o=>esc(o.number)).join(', ')+(openOrders.length>3?' y '+(openOrders.length-3)+' más':'')}). Confirmo que esta es una venta nueva.</span>`;modal.querySelector('.pos-modal-body').prepend(warning);}
  modal.querySelector('[name=received]')?.addEventListener('input',e=>{const value=Math.round(Number(e.target.value)*100)-sale.total_cents;$('#pos-change').textContent=value>=0?`Cambio: ${cash(value)}`:`Faltan ${cash(-value)}`;});
}
async function complete(mode,paymentMethod,acknowledgeOpen=false,options={}){
  const sale=totals();if(sale.error)throw new Error(sale.error);
  const prefsSnapshot=mode==='order'&&draft.customer?.id&&draft.saveOrderPrefs!==false&&draft.items[0]?{
    customerId:draft.customer.id,
    orderPrefs:{variantId:draft.items[0].variantId,quantity:Math.max(1,Number(draft.items[0].quantity)||1),paymentMethod:paymentMethod||'CASH',locationId:draft.location?.id??null,note:draft.notes||null},
  }:null;
  if(operation&&operation.mode!==mode)throw new Error('Primero revisa el resultado de la operación anterior.');
  if(!operation&&draft.ticketId)await saveActiveTicket();
  operation ||= {mode,payload:{requestId:crypto.randomUUID(),mode,customerId:draft.customer.id,conversationId:draft.conversationId,
    items:structuredClone(draft.items),discount:draft.discount,deliveryFee:draft.deliveryFee,address:draft.address,notes:draft.notes,location:draft.location,
    deliveryMethod:draft.deliveryMethod==='pickup'?'pickup':'delivery',scheduledAt:draft.scheduledAt||'',deliveryNotes:draft.deliveryNotes||'',
    deliveryReference:draft.deliveryReference||'',
    deliveryAgentId:String(draft.deliveryAssignee||'').startsWith('user:')?draft.deliveryAssignee.slice(5):'',
    deliveryContact:String(draft.deliveryAssignee||'').startsWith('contact:')?{name:'',phone:draft.deliveryAssignee.slice(8)}:null,
    paymentStatus:mode==='invoice'?'paid':(draft.paymentStatus==='paid'?'paid':'pending'),guided:draft.guidedFlow===true,
    ...(typeof options.needsDelivery==='boolean'?{needsDelivery:options.needsDelivery}:{}),
    quoteId:mode==='quote'?null:draft.quoteId,ticketId:draft.ticketId,ticketVersion:draft.ticketVersion,expectedTotal:sale.total_cents,paymentMethod,acknowledgeOpen}};
  busy=true;persist();render();const epoch=generation;
  try{
    const result=await api(mode==='quote'?'quotes':'checkout',operation.payload);if(epoch!==generation)return;
    if(prefsSnapshot&&!result.pending){
      try{await fetch(`/api/admin/customers/${encodeURIComponent(prefsSnapshot.customerId)}`,{method:'PATCH',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({orderPrefs:prefsSnapshot.orderPrefs})});}catch{}
    }
    const label=result.pending?'Guardado en este dispositivo':mode==='quote'?'Cotización guardada':mode==='order'?'Pedido guardado':'Venta cobrada';
    if(options.keepDraft){
      /*
       * EL PEDIDO YA EXISTE: se conserva el borrador para poder confirmarlo o
       * asignarle reparto acto seguido sin volver a crearlo. El ticket se cierra
       * (el servidor ya lo cerró) y queda anotado el id del pedido real.
       */
      operation=null;draft.ticketId=null;draft.ticketVersion=null;draft.ticketDirty=false;
      if(result.orderId)draft.createdOrderId=result.orderId;
    }else{
      draft=empty();operation=null;expanded=false;
    }
    persist();message=label;render();
    if(!options.silent){
      if(mode==='quote'){
        modal.close();const id=result.document?.id||result.quoteId;openQuote(id);notifyQuote(id,label);
      }else show(label,`<p class="pos-confirm-total"><strong>${cash(sale.total_cents)}</strong><span>${esc(result.number||'')}</span></p><a class="btn btn--primary" href="${esc(mode==='invoice'?`/admin/receipt-viewer.html?pdf=${encodeURIComponent(result.receiptUrl)}`:result.receiptUrl)}" target="_blank" rel="noopener">${mode==='invoice'?'Ver factura en PDF':'Ver comprobante / PDF'}</a>${mode==='order'?`<button class="btn btn--ghost" type="button" data-pos-delivery="${esc(result.orderId)}">Continuar entrega</button>`:''}<p class="pos-muted">${mode==='order'?'El pedido está pendiente. Puedes asignar su entrega ahora o desde Pedidos.':mode==='invoice'?'La venta quedó registrada en Pedidos con su factura vinculada.':'Documento comercial guardado.'}</p>`,null);
    }
    window.dispatchEvent(new Event('fulltech:pos-saved'));window.dispatchEvent(new Event('fulltech:catalog-updated'));
    return result;
  }catch(e){
    if(epoch!==generation)return;
    if(e.data&&!e.data.operationPending&&e.data.error!=='operation_pending')operation=null;
    persist();throw e;
  }finally{if(epoch===generation){busy=false;render();}}
}
// Búsqueda en la cabecera; se reutiliza el mismo control y el mismo filtro.
let searchOpen=false,searchBar=null;
function syncSearchBar(){
  searchBar=$('#store-catalogo .store-search-line')||$('#pos-search-host .store-search-line')||searchBar;
  const host=$('#pos-search-host'),detail=new URLSearchParams(location.search).has('product');
  /*
   * TECLADO MÓVIL. `append` de un nodo que ya está en su sitio lo DESMONTA y lo
   * vuelve a insertar, y al desmontarse el campo pierde el foco: en Android/iOS
   * eso cierra el teclado después de la PRIMERA letra. Solo se mueve de verdad
   * cuando el buscador está en otro contenedor.
   */
  if(host&&searchBar&&!detail&&searchBar.parentElement!==host)host.append(searchBar);
  $('.pos-appbar')?.classList.toggle('pos-search-open',searchOpen&&!detail);
  $('[data-pos-search-open]')?.classList.toggle('pos-search-filtered',!!searchBar?.querySelector('input')?.value||!!searchBar?.querySelector('.store-filter-dot'));
}
function setSearchOpen(value){searchOpen=value;syncSearchBar();if(value)$('#store-search')?.focus({preventScroll:true});else $('[data-pos-search-open]')?.focus({preventScroll:true});}

// Tickets: guardado optimista por versión, antes de cambiar de venta.
let ticketSaveTimer=null,ticketSaveTail=Promise.resolve();
function packedDraft(){return {...structuredClone(draft),customerId:draft.customer?.id||''};}
function scheduleTicketSave(){clearTimeout(ticketSaveTimer);ticketSaveTimer=setTimeout(()=>saveActiveTicket().catch(e=>{message=e.message;render();}),650);}
function saveActiveTicket(){
  clearTimeout(ticketSaveTimer);
  ticketSaveTail=ticketSaveTail.catch(()=>{}).then(async()=>{
    if(operation)throw new Error('Revisa la operación anterior antes de cambiar de ticket.');
    if(!draft.items.length&&!draft.ticketId)return null;
    if(draft.ticketId&&!draft.ticketDirty)return null;
    const epoch=generation,id=draft.ticketId,snapshot=packedDraft();
    const result=await api(id?'tickets/'+id:'tickets',{requestId:crypto.randomUUID(),version:draft.ticketVersion,name:draft.ticketName,draft:snapshot});
    if(epoch!==generation)return;
    const t=result.ticket;if(!t)throw new Error('No se pudo guardar el ticket.');
    if(!id||draft.ticketId===id){
      const unchanged=JSON.stringify(packedDraft())===JSON.stringify(snapshot);
      draft.ticketId=t.id;draft.ticketVersion=t.version;draft.ticketName=t.name;draft.ticketDirty=!unchanged;persist();render();
    }
    return t;
  });return ticketSaveTail;
}
function useTicket(ticket){
  draft={...empty(),...ticket.draft,ticketId:ticket.id,ticketVersion:ticket.version,ticketName:ticket.name,ticketDirty:false};
  operation=null;expanded=!!draft.items.length;persist();render();modal.close();
  window.dispatchEvent(new CustomEvent('fulltech:pos-navigate',{detail:{tab:'catalogo'}}));
}
async function newTicket(){
  await saveActiveTicket();const result=await api('tickets',{requestId:crypto.randomUUID(),draft:empty()});useTicket(result.ticket);
}
function ticketTotal(t){try{return cash(calculateSale(t.draft.items,products,t.draft.discount,t.draft.deliveryFee).total_cents);}catch{return 'Revisar artículos';}}
async function ticketList(){
  await saveActiveTicket();const data=await api('tickets');
  const active=data.tickets.filter(t=>['open','processing'].includes(t.status));
  show('Tickets',`<div class="pos-ticket-list" role="list">${active.map(t=>`<article class="pos-ticket-row" role="listitem"><button class="pos-ticket-open" type="button" data-pos-ticket="${esc(t.id)}" ${t.status!=='open'?'disabled':''}><span><strong>${esc(t.name||'Ticket sin nombre')}</strong><small>${esc(t.draft.customer?.name||'Sin cliente')} · ${t.draft.items.reduce((n,i)=>n+i.quantity,0)} artículos${t.status==='processing'?' · En revisión':''}</small></span><strong>${ticketTotal(t)}</strong></button>${t.status==='open'?`<button class="pos-ticket-more" type="button" data-pos-ticket-menu="${esc(t.id)}" aria-label="Opciones de ${esc(t.name||'ticket')}" aria-haspopup="menu" aria-expanded="false">${actionIcon('more')}</button><div class="pos-ticket-menu" role="menu" aria-label="Acciones de ${esc(t.name||'ticket')}" data-ticket-menu="${esc(t.id)}" hidden><button type="button" role="menuitem" data-pos-ticket-rename="${esc(t.id)}">Editar ticket</button><button type="button" role="menuitem" class="pos-ticket-danger" data-pos-ticket-discard="${esc(t.id)}">Eliminar ticket</button></div>`:''}</article>`).join('')||'<p class="pos-empty">No tienes tickets pendientes.</p>'}</div><details class="pos-ticket-history"><summary>Tickets finalizados</summary>${data.tickets.filter(t=>t.status==='completed').map(t=>`<p>${esc(t.name)} <a class="pos-text" href="${esc(t.result?.receiptUrl||'#')}" target="_blank" rel="noopener">Ver documento</a></p>`).join('')||'<p>Todavía no hay tickets finalizados.</p>'}</details>`,null);
  const add=document.createElement('button');add.type='button';add.className='pos-text pos-ticket-new';add.dataset.posNewTicket='';add.innerHTML=`${actionIcon('ticket')}Nuevo`;add.setAttribute('aria-label','Nuevo ticket');modal.querySelector('header h2').after(add);
}
async function openTicket(id){
  await saveActiveTicket();const {ticket}=await api('tickets/'+id);
  if(ticket.status!=='open')throw new Error('Este ticket ya se procesó o necesita revisión.');useTicket(ticket);
}
async function renameTicket(id){
  await saveActiveTicket();const {ticket}=await api('tickets/'+id);
  const saveName=async value=>{
    const name=String(value||'').trim();if(!name)throw new Error('Escribe un nombre para el ticket.');
    if(name===ticket.name)return;
    const result=await api('tickets/'+id,{version:ticket.version,name,draft:ticket.draft});
    if(draft.ticketId===id){draft.ticketName=result.ticket.name;draft.ticketVersion=result.ticket.version;persist();render();}
  };
  show('Editar ticket',`<label class="field"><span class="field__label">Nombre del ticket</span><input class="field__input" name="name" maxlength="80" value="${esc(ticket.name)}" required></label><button class="btn btn--ghost btn--block" type="button" data-ticket-edit-lines>Editar productos y cliente</button>`,'Guardar nombre',async form=>{await saveName(form.get('name'));await ticketList();});
  modal.querySelector('[data-ticket-edit-lines]').addEventListener('click',()=>runAction(async()=>{await saveName(modal.querySelector('[name=name]').value);await openTicket(id);}));
}
async function discardTicket(id){
  const {ticket}=await api('tickets/'+id);
  show('Eliminar ticket',`<p>¿Eliminar ${esc(ticket.name)} de los tickets pendientes?</p>`,'Eliminar',async()=>{
    await api('tickets/'+id+'/discard',{version:ticket.version});if(draft.ticketId===id){draft=empty();persist();render();}await ticketList();
  });
}
function elegirTienda(p){
  if(!suppliers.length){message='Este artículo se compra en una tienda. Crea primero la tienda proveedora.';render();return;}
  const opciones=suppliers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}${s.location_status==='pending'?' · ubicación pendiente':''}</option>`).join('');
  show('¿Dónde se compra?',`<p class="pos-muted">${esc(p.name)} · elige la tienda donde se recogerá. Las líneas de la misma tienda se agrupan en una sola recogida.</p><label class="field"><span class="field__label">Tienda</span><select class="field__select" name="supplier" required>${opciones}</select></label>`,'Agregar',form=>{
    const tienda=suppliers.find(s=>s.id===String(form.get('supplier')));if(!tienda)return;
    const existente=draft.items.find(i=>i.variantId===p.id&&i.supplierId===tienda.id);
    if(existente){existente.quantity=Math.min(9999,existente.quantity+1);}else{draft.items.push({variantId:p.id,quantity:1,discount:{},supplierId:tienda.id,supplierName:tienda.name});}
    changed();modal.close();
  });
}
function manualSale(){
  const tiendas=suppliers.length?`<label class="field"><span class="field__label">Tienda donde se compra (opcional)</span><select class="field__select" name="supplier"><option value="">Sin tienda</option>${suppliers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>`:'';
  show('Venta fuera de inventario',`<label class="field"><span class="field__label">Descripción</span><input class="field__input" name="name" maxlength="150" required placeholder="Artículo o servicio ocasional"></label><label class="field"><span class="field__label">Tipo</span><select class="field__select" name="kind"><option value="product">Producto fuera de inventario</option><option value="service">Servicio ocasional</option></select></label><div class="pos-manual-grid"><label class="field"><span class="field__label">Cantidad</span><input class="field__input" name="quantity" type="number" min="1" max="9999" step="1" value="1" required></label><label class="field"><span class="field__label">Precio unitario (RD$)</span><input class="field__input" name="price" type="number" min="0" step="0.01" required></label></div><label class="field"><span class="field__label">Costo unitario (RD$)</span><input class="field__input" name="cost" type="number" min="0" step="0.01" value="0" required></label>${tiendas}<p class="pos-muted">Aparecerá en el comprobante sin crear un producto ni modificar existencias.</p>`,'Agregar al ticket',form=>{
    const tienda=suppliers.find(s=>s.id===String(form.get('supplier')||''));
    const item={variantId:'manual_'+crypto.randomUUID(),quantity:Number(form.get('quantity')),discount:{},manual:{name:String(form.get('name')).trim(),kind:form.get('kind'),price:Number(form.get('price')),cost:Number(form.get('cost'))},...(tienda?{supplierId:tienda.id,supplierName:tienda.name,supplierCostCents:Math.round(Number(form.get('cost'))*100)}:{})};
    calculateSale([item],products);draft.items.push(item);changed();modal.close();
  });
}
function actions(){
  if(busy||modal.open)return;
  window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
  actionsDrawer.innerHTML=`<header><strong>Acciones</strong><button class="pos-icon" type="button" data-actions-close aria-label="Cerrar acciones">×</button></header><nav class="pos-action-menu" aria-label="Acciones de venta"><span class="pos-action-section">Ventas</span><button type="button" data-pos-manual>${actionIcon('quick')}<span>Venta rápida<small>Fuera de inventario</small></span></button><button type="button" data-pos-new-ticket>${actionIcon('ticket')}<span>Nuevo ticket</span></button><button type="button" data-pos-note>${actionIcon('note')}<span>Agregar nota<small>${draft.notes?'Nota guardada':'Instrucciones del pedido'}</small></span></button>${isAdmin?`<span class="pos-action-section">Catálogo</span><button type="button" data-pos-stock>${actionIcon('stock')}<span>Agregar stock</span></button><button type="button" data-pos-create-product>${actionIcon('product')}<span>Nuevo producto<small>Producto o servicio</small></span></button>`:''}</nav>`;
  document.body.dataset.posActions='open';document.querySelectorAll('[data-pos-actions]').forEach(b=>b.setAttribute('aria-expanded','true'));actionsDrawer.showModal();
}
window.addEventListener('fulltech:close-actions',closeActions);

// Solo los gestos iniciados en un borde abren un menú; el centro conserva su scroll.
const edgeZones=['left','right'].map(side=>{const zone=document.createElement('div');zone.className='pos-edge-zone pos-edge-zone--'+side;zone.setAttribute('aria-hidden','true');document.body.append(zone);return zone;});
let edgeGesture=null;
document.addEventListener('pointerdown',e=>{
  if(!['touch','pen'].includes(e.pointerType)||e.isPrimary===false||window.innerWidth>979||$('#app')?.hidden!==false||busy)return;
  if(modal.open||document.querySelector('dialog[open]:not(.pos-actions-drawer)')||$('#sheet')?.hidden===false)return;
  /*
   * EL MENÚ PRINCIPAL SOLO SE ABRE DESDE «HOY».
   *
   * Antes bastaba con empezar el gesto en los 20 px del borde izquierdo, en
   * CUALQUIER pestaña: dentro de un chat, deslizar de izquierda a derecha abría
   * el menú general en vez de la columna de respuestas rápidas. En el chat manda
   * el gesto del propio chat (app.js); aquí solo cuenta la portada.
   */
  const enPortada=document.body.dataset.tab==='hoy';
  /*
   * En FACTURACIÓN el borde izquierdo abre el SELECTOR DE CLIENTE (nunca el
   * menú general, que sigue limitado a la portada).
   */
  const mode=actionsDrawer.open?'close-actions':document.body.dataset.drawer==='open'?'close-main':e.clientX<=20&&enPortada?'main':e.clientX<=20&&document.body.dataset.tab==='catalogo'?'client':e.clientX>=window.innerWidth-20&&document.body.dataset.tab==='catalogo'?'actions':null;
  if(!mode||e.target.closest('input,textarea,select,[contenteditable=true]'))return;
  edgeGesture={id:e.pointerId,x:e.clientX,y:e.clientY,at:Date.now(),mode};
  if(edgeZones.includes(e.target))e.target.setPointerCapture?.(e.pointerId);
},{passive:true});
document.addEventListener('pointermove',e=>{
  if(!edgeGesture||edgeGesture.id!==e.pointerId)return;
  const dx=e.clientX-edgeGesture.x,dy=e.clientY-edgeGesture.y;
  if(Math.abs(dy)>20&&Math.abs(dy)>Math.abs(dx)){edgeGesture=null;return;}
  if(Math.abs(dx)>25&&Math.abs(dx)>Math.abs(dy)*1.5&&e.cancelable)e.preventDefault();
},{passive:false});
document.addEventListener('pointerup',e=>{
  const gesture=edgeGesture;edgeGesture=null;if(!gesture||gesture.id!==e.pointerId)return;
  const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
  if(Date.now()-gesture.at>900||Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.5)return;
  if(gesture.mode==='main'&&dx>0)window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:true}}));
  if(gesture.mode==='client'&&dx>0)chooseClient();
  if(gesture.mode==='actions'&&dx<0)actions();
  if(gesture.mode==='close-actions'&&dx>0)closeActions();
  if(gesture.mode==='close-main'&&dx<0)window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
});
document.addEventListener('pointercancel',()=>{edgeGesture=null;});

function closeTicketMenus(){modal.querySelectorAll('[data-ticket-menu]').forEach(n=>n.hidden=true);modal.querySelectorAll('[data-pos-ticket-menu]').forEach(n=>n.setAttribute('aria-expanded','false'));}
document.addEventListener('click',e=>{
  const toggle=e.target.closest('[data-pos-ticket-menu]');
  if(toggle){
    const id=toggle.dataset.posTicketMenu,menu=[...modal.querySelectorAll('[data-ticket-menu]')].find(n=>n.dataset.ticketMenu===id),wasOpen=menu&&!menu.hidden;
    closeTicketMenus();if(menu&&!wasOpen){menu.classList.toggle('pos-ticket-menu--above',modal.getBoundingClientRect().bottom-toggle.getBoundingClientRect().bottom<115);menu.hidden=false;toggle.setAttribute('aria-expanded','true');menu.querySelector('button')?.focus();}return;
  }
  if(!e.target.closest('.pos-ticket-menu'))closeTicketMenus();
});
modal.addEventListener('keydown',e=>{
  const menu=modal.querySelector('[data-ticket-menu]:not([hidden])');if(!menu)return;
  const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  if(e.key==='Escape'){e.preventDefault();const id=menu.dataset.ticketMenu;closeTicketMenus();[...modal.querySelectorAll('[data-pos-ticket-menu]')].find(n=>n.dataset.posTicketMenu===id)?.focus();}
});

// Las cotizaciones tienen página y detalle propios, separados de la venta activa.
let quotesEpoch=0,quoteQuery='',quoteRows=[],quoteStatus='todas',quoteRange='todas',quoteSearchOpen=false,quoteFiltersOpen=false;
const quotesPage=()=>$('#pos-quotes-page');
function openQuote(id){
  if(!id)return;modal.close();const url=new URL(location.href);url.searchParams.set('v','cotizaciones');url.searchParams.set('quote',id);url.searchParams.delete('ticket');url.searchParams.delete('product');
  if(url.href!==location.href)history.pushState({posQuote:true,posQuoteFromList:new URLSearchParams(location.search).get('v')==='cotizaciones'&&!new URLSearchParams(location.search).has('quote')},'',url);window.dispatchEvent(new CustomEvent('fulltech:pos-navigate',{detail:{tab:'cotizaciones'}}));renderQuotesPage();
}
function notifyQuote(id,text){
  document.querySelector('.pos-document-toast')?.remove();const toast=document.createElement('div');toast.className='pos-document-toast';toast.setAttribute('role','status');
  toast.innerHTML=`<span>${esc(text)}</span><button type="button" data-pos-open-quote="${esc(id)}">Ver cotización</button>`;document.body.append(toast);setTimeout(()=>toast.remove(),15000);
}
/* ---------------------------------------------------------------------------
 * COTIZACIONES: lista, búsqueda y filtros.
 *
 * La lupa y el filtro viven en la barra de arriba (los pinta app.js); aquí se
 * decide qué se ve: texto (cliente, número o teléfono), estado (abiertas /
 * facturadas) y periodo (hoy, 7 o 30 días). El panel de filtros se abre pegado
 * a la barra para no sacar a nadie de la pantalla.
 * ------------------------------------------------------------------------- */
const QUOTE_STATUSES=[['todas','Todas'],['abiertas','Abiertas'],['facturadas','Facturadas']];
const QUOTE_RANGES=[['todas','Todas'],['hoy','Hoy'],['7d','7 días'],['30d','30 días']];
function quoteTone(id){let h=0;for(const c of String(id||''))h=(h*31+c.charCodeAt(0))%360;return `hsl(${h} 58% 42%)`;}
function quoteInitials(name){return String(name||'?').trim().split(/\s+/).slice(0,2).map(parte=>parte[0]).join('').toUpperCase();}
function quoteDate(iso){
  const fecha=new Date(iso);if(Number.isNaN(fecha.getTime()))return '';
  const hoy=new Date();
  if(fecha.toDateString()===hoy.toDateString())return `Hoy, ${fecha.toLocaleTimeString('es-DO',{hour:'numeric',minute:'2-digit'})}`;
  return fecha.toLocaleDateString('es-DO',{day:'numeric',month:'short',year:fecha.getFullYear()===hoy.getFullYear()?undefined:'numeric'});
}
const quoteTotal=d=>Number(d?.sale?.total_cents||0);
const quoteItems=d=>d?.sale?.items||[];
function hasQuoteFilters(){return quoteStatus!=='todas'||quoteRange!=='todas'||Boolean(quoteQuery.trim());}
function quoteMatches(d){
  const q=quoteQuery.trim().toLocaleLowerCase();
  if(q&&!`${d.number||''} ${d.customer?.name||''} ${d.customer?.phone_e164||''}`.toLocaleLowerCase().includes(q))return false;
  if(quoteStatus==='abiertas'&&d.status==='converted')return false;
  if(quoteStatus==='facturadas'&&d.status!=='converted')return false;
  if(quoteRange!=='todas'){
    const fecha=new Date(d.created_at);if(Number.isNaN(fecha.getTime()))return false;
    const ahora=new Date();
    if(quoteRange==='hoy'&&fecha.toDateString()!==ahora.toDateString())return false;
    const dias=(ahora-fecha)/86400000;
    if(quoteRange==='7d'&&dias>7)return false;
    if(quoteRange==='30d'&&dias>30)return false;
  }
  return true;
}
function quoteFiltersInner(){
  const abiertas=quoteRows.filter(d=>d.status!=='converted').length;
  const cuentas={todas:quoteRows.length,abiertas,facturadas:quoteRows.length-abiertas};
  return `<header class="pos-quote-filters__head"><strong>Filtros</strong><button class="pos-text" type="button" data-quote-filters-clear ${hasQuoteFilters()?'':'hidden'}>Limpiar</button></header>
    <div class="pos-quote-filters__group"><p class="pos-quote-filters__label">Estado</p><div class="pos-quote-filters__chips">${QUOTE_STATUSES.map(([key,label])=>`<button class="chip" type="button" data-quote-status="${key}" aria-pressed="${quoteStatus===key}">${label} <span>${cuentas[key]}</span></button>`).join('')}</div></div>
    <div class="pos-quote-filters__group"><p class="pos-quote-filters__label">Periodo</p><div class="pos-quote-filters__chips">${QUOTE_RANGES.map(([key,label])=>`<button class="chip" type="button" data-quote-range="${key}" aria-pressed="${quoteRange===key}">${label}</button>`).join('')}</div></div>`;
}
function quoteFiltersPanel(){return `<section class="pos-quote-filters" id="pos-quote-filters" aria-label="Filtros de cotizaciones">${quoteFiltersInner()}</section>`;}
function syncQuotesAppbar(){
  const d=doc();if(!d?.body)return;
  d.body.dataset.quoteSearch=quoteSearchOpen?'open':'closed';
  d.body.dataset.quoteFilters=quoteFiltersOpen?'open':'closed';
  const input=$('#quote-appbar-search');
  if(input&&input.value!==quoteQuery)input.value=quoteQuery;
  const boton=d.querySelector('[data-quote-filter-open]');
  if(boton){boton.setAttribute('aria-expanded',String(quoteFiltersOpen));boton.classList.toggle('is-on',hasQuoteFilters());}
  const panel=$('#pos-quote-filters');
  if(panel)panel.hidden=!quoteFiltersOpen;
}
function quoteCard(d){
  const facturada=d.status==='converted';
  const nombre=d.customer?.name||d.customer?.phone_e164||'Cliente';
  // «Phytoemagry · 10 cápsulas» → «10 cápsulas»: la marca se repite en cada línea.
  const articulo=i=>String(i.name||'').replace(/^\s*phytoemagry\s*[·-]\s*/i,'');
  const detalle=quoteItems(d).map(i=>`${articulo(i)} ×${i.quantity}`).join(' · ');
  const descuento=Number(d.sale?.discount_cents||0);
  // La referencia corta sirve para reconocer la cotización de un vistazo; el
  // número completo sigue estando en el detalle y en la búsqueda.
  const referencia=`#${String(d.number||'').replace(/^COT-?/,'').slice(-8)}`;
  return `<button class="pos-quote-card${facturada?' pos-quote-card--converted':''}" type="button" data-pos-open-quote="${esc(d.id)}">
    <span class="pos-quote-card__avatar" style="--tone:${quoteTone(d.id)}" aria-hidden="true">${esc(quoteInitials(nombre))}</span>
    <span class="pos-quote-card__body">
      <span class="pos-quote-card__top"><strong>${esc(nombre)}</strong><span class="pos-quote-pill">${facturada?'Facturada':'Abierta'}</span></span>
      <span class="pos-quote-card__meta"><span>${esc(quoteDate(d.created_at))}</span><span aria-hidden="true">·</span><span class="pos-quote-card__ref">${esc(referencia)}</span></span>
      ${detalle?`<span class="pos-quote-card__items">${esc(detalle)}</span>`:''}
    </span>
    <span class="pos-quote-card__amount"><strong>${cash(quoteTotal(d))}</strong><small>${descuento?`−${cash(descuento)}`:'Total'}</small></span>
    <span class="pos-quote-card__go" aria-hidden="true">›</span>
  </button>`;
}
function quoteListRows(){
  const list=$('#pos-quote-list');if(!list)return;
  const rows=quoteRows.filter(quoteMatches);
  const abiertas=rows.filter(d=>d.status!=='converted').length;
  const total=rows.reduce((n,d)=>n+quoteTotal(d),0);
  const resumen=$('#pos-quotes-summary');
  if(resumen)resumen.textContent=rows.length?`${rows.length} cotización${rows.length===1?'':'es'} · ${abiertas} abierta${abiertas===1?'':'s'} · ${cash(total)}`:'';
  list.innerHTML=rows.length?rows.map(quoteCard).join(''):`<div class="pos-quotes-empty"><span class="pos-quotes-empty__icon">${quotesIcon}</span><strong>${hasQuoteFilters()?'No hay cotizaciones con estos filtros':'Todavía no hay cotizaciones'}</strong><p>${hasQuoteFilters()?'Prueba con otro estado, otro periodo o sin búsqueda.':'Se crean desde Facturación con el botón «Cotizar»; aquí quedan guardadas para enviarlas o pasarlas a ticket.'}</p>${hasQuoteFilters()?'<button class="btn btn--ghost" type="button" data-quote-filters-clear>Quitar filtros</button>':''}</div>`;
  syncQuotesAppbar();
}
function renderQuoteFilters(){
  const panel=$('#pos-quote-filters');
  if(panel)panel.innerHTML=quoteFiltersInner();
  quoteListRows();
}
function resetQuoteFilters(){
  quoteStatus='todas';quoteRange='todas';quoteQuery='';quoteSearchOpen=false;
  renderQuoteFilters();
}
async function renderQuotesPage(){
  const box=quotesPage();if(!box)return;const request=++quotesEpoch,epoch=generation;
  try{
    const id=new URLSearchParams(location.search).get('quote');
    document.body.dataset.quoteDetail=id?'true':'false';
    if(!id){
      const data=await api('quotes');if(request!==quotesEpoch||epoch!==generation)return;quoteRows=data.quotes||[];
      box.innerHTML=`<p class="pos-quotes-summary" id="pos-quotes-summary"></p>${quoteFiltersPanel()}<div class="pos-quote-list" id="pos-quote-list"></div>`;
      syncQuotesAppbar();quoteListRows();return;
    }
    const {document:q}=await api('quotes/'+encodeURIComponent(id));if(request!==quotesEpoch||epoch!==generation)return;
    box.innerHTML=`<div class="pos-quote-detail"><button class="pos-quote-back" type="button" data-pos-quotes-list aria-label="Volver a cotizaciones"><span aria-hidden="true">←</span> Cotizaciones</button><header><span class="pos-document-icon">${quotesIcon}</span><div><small>${esc(q.number)}</small><h2>${esc(q.customer.name||q.customer.phone_e164)}</h2><p>${esc(q.customer.phone_e164)} · ${esc(new Date(q.created_at).toLocaleDateString('es-DO'))}</p></div></header><div class="pos-quote-detail-lines">${q.sale.items.map(i=>`<div><span><strong>${esc(i.name)}</strong><small>${i.quantity} × ${cash(i.unit_price_cents)}${i.discount_cents?' · −'+cash(i.discount_cents):''}</small></span><strong>${cash(i.subtotal_cents)}</strong></div>`).join('')}</div><div class="pos-quote-detail-total"><small>Descuento general ${cash(q.sale.discount_cents)} · Envío ${cash(q.sale.delivery_cents)}</small><strong>${cash(q.sale.total_cents)}</strong></div>${q.input.notes?`<p class="pos-muted">${esc(q.input.notes)}</p>`:''}<div class="pos-quote-detail-actions"><a class="btn btn--ghost" href="/admin/receipt-viewer.html?pdf=${encodeURIComponent(`/api/admin/pos/quotes/${q.id}/pdf`)}&amp;quote=${encodeURIComponent(q.id)}" target="_blank" rel="noopener">Ver PDF</a><button class="btn btn--primary" type="button" data-pos-quote-send="${esc(q.id)}">Enviar al cliente</button>${q.status==='converted'?`<a class="btn btn--ghost" href="/api/admin/orders/${esc(q.order_id)}/receipt" target="_blank" rel="noopener">Ver venta</a>`:`<button class="btn btn--ghost" type="button" data-pos-quote-ticket="${esc(q.id)}">Pasar a ticket</button>`}</div><p class="pos-muted">Cotización comercial. No registra pago ni reserva inventario.</p></div>`;
    if(new URLSearchParams(location.search).get('ticket')==='1'){
      const url=new URL(location.href);url.searchParams.delete('ticket');history.replaceState(history.state,'',url);
      if(q.status!=='converted')await quoteToTicket(q.id);
    }
  }catch(e){if(request===quotesEpoch&&epoch===generation)box.innerHTML=`<p role="alert">${esc(e.message)}</p>`;}
}
async function sendQuoteToCustomer(id,button){
  if(!id||busy||!button||button.disabled)return;
  if(!window.confirm('¿Enviar esta cotización al cliente por WhatsApp? Sale por el número del negocio y queda escrita en el CRM.'))return;
  const original=button.textContent;button.disabled=true;button.textContent='Enviando…';
  try{
    const data=await api(`quotes/${encodeURIComponent(id)}/send-whatsapp`,{idempotencyKey:crypto.randomUUID()});
    toast(`Cotización enviada a ${data.customer?.name||'el cliente'} por WhatsApp`);
    button.textContent='Enviado';
  }catch(error){
    button.disabled=false;button.textContent=original;
    actionError(error.message||'No se pudo enviar la cotización.');
  }
}
async function quoteToTicket(id){await initialize();await saveActiveTicket();const {ticket}=await api('tickets',{requestId:crypto.randomUUID(),quoteId:id});if(ticket.status!=='open')throw new Error('El ticket de esta cotización ya está procesado o en revisión.');useTicket(ticket);}
function quotesList(){if(history.state?.posQuoteFromList){history.back();return;}const url=new URL(location.href);url.searchParams.delete('quote');url.searchParams.delete('ticket');history.replaceState({tab:'cotizaciones'},'',url);renderQuotesPage();}function actionError(text){const guiado=modal.open?modal.querySelector('#pos-order-error'):null;if(guiado){guiado.textContent=text;return;}const error=modal.open?modal.querySelector('.pos-modal-error'):null;if(error)error.textContent=text;else if(document.body.dataset.tab==='cotizaciones'){let note=$('#pos-documents-error');if(!note){note=document.createElement('p');note.id='pos-documents-error';note.setAttribute('role','alert');quotesPage()?.prepend(note);}note.textContent=text;}else{message=text;render();}}
async function runAction(action){if(busy)return;try{busy=true;await action();}catch(e){actionError(e.message);}finally{busy=false;render();if(modal.open&&modal.classList.contains('pos-order-dialog'))refreshOrderCompletion();}}

document.addEventListener('click',e=>{
  if(operation&&e.target.closest('[data-pos-new-ticket],[data-pos-note],[data-pos-manual],[data-pos-ticket],[data-pos-quote-ticket]')){actionError('Revisa la operación anterior antes de cambiar la venta.');return;}
  // Cotizaciones: la barra de arriba lleva la lupa y el filtro.
  if(e.target.closest('[data-quote-search-open]')){quoteSearchOpen=true;quoteFiltersOpen=false;syncQuotesAppbar();requestAnimationFrame(()=>$('#quote-appbar-search')?.focus());return;}
  if(e.target.closest('[data-quote-search-close]')||e.target.closest('[data-quote-search-clear]')){quoteSearchOpen=false;quoteQuery='';syncQuotesAppbar();if($('#pos-quote-list'))quoteListRows();return;}
  if(e.target.closest('[data-quote-filter-open]')){quoteFiltersOpen=!quoteFiltersOpen;quoteSearchOpen=false;syncQuotesAppbar();return;}
  const quoteStatusChip=e.target.closest('[data-quote-status]');
  if(quoteStatusChip){quoteStatus=quoteStatusChip.dataset.quoteStatus;renderQuoteFilters();return;}
  const quoteRangeChip=e.target.closest('[data-quote-range]');
  if(quoteRangeChip){quoteRange=quoteRangeChip.dataset.quoteRange;renderQuoteFilters();return;}
  if(e.target.closest('[data-quote-filters-clear]')){resetQuoteFilters();return;}
  const quoteSend=e.target.closest('[data-pos-quote-send]');
  if(quoteSend){sendQuoteToCustomer(quoteSend.dataset.posQuoteSend,quoteSend);return;}
  if(e.target.closest('[data-pos-search-open]'))setSearchOpen(true);
  if(e.target.closest('[data-pos-search-close]'))setSearchOpen(false);
  if(e.target.closest('[data-pos-actions]'))actions();
  if(e.target.closest('[data-pos-new-ticket]'))runAction(newTicket);
  if(e.target.closest('[data-pos-tickets]'))runAction(ticketList);
  if(e.target.closest('[data-pos-manual]'))manualSale();
  if(e.target.closest('[data-pos-create-product]')){modal.close();window.dispatchEvent(new Event('fulltech:store-create'));}
  if(e.target.closest('[data-pos-stock]')){modal.close();window.dispatchEvent(new CustomEvent('fulltech:pos-navigate',{detail:{tab:'inventario'}}));}
  const ticket=e.target.closest('[data-pos-ticket]');if(ticket)runAction(()=>openTicket(ticket.dataset.posTicket));
  const rename=e.target.closest('[data-pos-ticket-rename]');if(rename)runAction(()=>renameTicket(rename.dataset.posTicketRename));
  const discard=e.target.closest('[data-pos-ticket-discard]');if(discard)runAction(()=>discardTicket(discard.dataset.posTicketDiscard));
  const quote=e.target.closest('[data-pos-open-quote]');if(quote)openQuote(quote.dataset.posOpenQuote);
  const quoteTicket=e.target.closest('[data-pos-quote-ticket]');if(quoteTicket)runAction(()=>quoteToTicket(quoteTicket.dataset.posQuoteTicket));
  if(e.target.closest('[data-pos-quotes-list]')){document.body.dataset.quoteDetail='false';quotesList();}
  // Un clic fuera del panel de filtros lo cierra, sin perder lo elegido.
  if(quoteFiltersOpen&&!e.target.closest('#pos-quote-filters')&&!e.target.closest('[data-quote-filter-open]')){quoteFiltersOpen=false;syncQuotesAppbar();}
});
window.addEventListener('fulltech:pos-appbar',syncSearchBar);
window.addEventListener('fulltech:pos-render',syncSearchBar);
window.addEventListener('fulltech:pos-navigate',()=>{if(document.body.dataset.tab==='cotizaciones')syncQuotesAppbar();});
document.addEventListener('input',e=>{if(e.target.id==='quote-appbar-search'){quoteQuery=e.target.value;if(document.body.dataset.tab==='cotizaciones'&&$('#pos-quote-list'))quoteListRows();}});
/*
 * DENTRO DEL DETALLE, LA FLECHA DE ARRIBA VUELVE A LA LISTA.
 * Se atiende antes que el manejador general del panel (fase de captura) para
 * que no se salga de la pestaña por el historial. Fuera del detalle no cambia
 * nada: la flecha sigue haciendo lo de siempre.
 */
document.addEventListener('click',e=>{
  if(!e.target.closest('.quotes-appbar [data-simple-back]'))return;
  if(document.body.dataset.quoteDetail!=='true')return;
  e.preventDefault();e.stopPropagation();
  document.body.dataset.quoteDetail='false';
  quotesList();
},true);
window.addEventListener('popstate',()=>{if(document.body.dataset.tab==='cotizaciones')renderQuotesPage();else syncSearchBar();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&(quoteSearchOpen||quoteFiltersOpen)&&document.body.dataset.tab==='cotizaciones'){
    // Si se cierra la barra de búsqueda, el texto deja de filtrar: si no, la
    // lista quedaría vacía sin que se vea por qué.
    quoteSearchOpen=false;quoteFiltersOpen=false;quoteQuery='';syncQuotesAppbar();
    if($('#pos-quote-list'))quoteListRows();
    e.preventDefault();return;
  }
  if(e.key==='Escape'&&searchOpen&&!modal.open&&!actionsDrawer.open){setSearchOpen(false);e.preventDefault();}
});

document.addEventListener('click',e=>{
  const mutation=e.target.closest('[data-pos-add],[data-pos-client],[data-pos-remove-client],[data-pos-customer],[data-pos-edit],[data-pos-quantity],[data-pos-discount],[data-pos-options],[data-pos-note],[data-pos-clear]');
  if(operation&&!busy&&mutation){show('Revisar operación anterior','<p>Hay una operación sin confirmar. Vuelve a pulsar Cotizar, Cobrar o Guardar pedido para consultar su resultado con el mismo identificador. Antes de iniciar otra venta, comprueba el resultado en Pedidos.</p><label class="pos-check"><input type="checkbox" required> Revisé Pedidos y continuaré con una operación nueva.</label>','Continuar',()=>{operation=null;persist();modal.close();});return;}
  const add=e.target.closest('[data-pos-add]');if(add&&!busy){
    if(!canCreate){message='No tienes permiso para crear ventas.';render();return;}
    const id=add.dataset.posAdd,p=products.find(p=>p.id===id);if(!p?.active)return;
    /*
     * PRODUCTO DE TERCEROS: antes de meterlo al carrito hay que decir EN QUÉ
     * TIENDA se compra. Esa elección viaja con la línea y es lo que permite
     * agrupar las recogidas del pedido por establecimiento.
     */
    if(p.product_type==='third_party'){elegirTienda(p);return;}
    let line=draft.items.find(i=>i.variantId===id&&!i.supplierId);
    if(line?.quantity>=9999){message='Cantidad máxima: 9999.';render();return;}
    if(line)line.quantity++;else draft.items.push({variantId:id,quantity:1,discount:{}});
    changed();return;
  }
  if(busy)return;
  const delivery=e.target.closest('[data-pos-delivery]');if(delivery){modal.close();window.dispatchEvent(new CustomEvent('fulltech:pos-delivery',{detail:{orderId:delivery.dataset.posDelivery}}));return;}
  if(e.target.closest('[data-pos-client]'))chooseClient();
  if(e.target.closest('[data-pos-remove-client]'))selectClient(null);
  const picked=e.target.closest('[data-pos-customer]');if(picked){selectClient(customers.find(c=>c.id===picked.dataset.posCustomer));modal.close();}
  if(e.target.closest('[data-pos-close]'))modal.close();
  if(e.target.closest('[data-pos-expand]')){if(dragged){dragged=false;return;}expanded=!expanded;render();}
  const editLine=e.target.closest('[data-pos-edit],[data-pos-quantity]');
  if(editLine){lineEditor(Number(editLine.dataset.posEdit??editLine.dataset.posQuantity));return;}
  const discount=e.target.closest('[data-pos-discount]');if(discount)editDiscount(discount.dataset.posDiscount);
  if(e.target.closest('[data-pos-options]'))options();
  if(e.target.closest('[data-pos-note]'))notes();
  if(e.target.closest('[data-pos-quote]'))confirmSale('quote');
  if(e.target.closest('[data-pos-pay]')){if(orderFromChat())openOrderCompletion();else confirmSale('invoice');}
  if(e.target.closest('[data-pos-pending]'))confirmSale('order');
  if(e.target.closest('[data-pos-clear]'))show('Vaciar carrito','<p>Se quitarán los artículos y descuentos del carrito.</p>','Vaciar',()=>{draft.items=[];draft.discount={};if(!draft.ticketId)draft.quoteId=null;changed();modal.close();});
});
/* ------------------------------------------------------------------ *
 * PEDIDO GUIADO (desde una conversación)
 * Productos → Datos y entrega → Revisar → Confirmar / Asignar / Enviar
 *
 * El borrador se guarda en el SERVIDOR (tickets versionados con requestId):
 * si se cierra la app, se recarga o se cambia de conversación, se retoma sin
 * duplicar pedidos. El catálogo y los precios siguen siendo los del CRM.
 * ------------------------------------------------------------------ */
let deliveryAgents=null,orderOpenOrders=[];
function orderFromChat(){return draft.flow==='order'&&Boolean(draft.conversationId);}
function orderIsPickup(){return draft.deliveryMethod==='pickup';}
function orderHasCoords(){const l=draft.location||null;return Boolean(l)&&Number.isFinite(Number(l.latitude))&&Number.isFinite(Number(l.longitude));}
function orderAddress(){return String(draft.address||draft.location?.address||'').trim();}
function orderDraftState(){return draft.ticketId?'Guardado':'Sin guardar';}
let assigneesCache=null;
async function loadAssignees(){
  if(assigneesCache)return assigneesCache;
  assigneesCache={users:[],contacts:[],canAssignInternal:false,canAssignExternal:true};
  try{
    const response=await fetch('/api/admin/pos/assignees',{credentials:'same-origin',cache:'no-store'});
    if(response.ok){const data=await response.json();assigneesCache={users:data.users||[],contacts:data.contacts||[],canAssignInternal:data.canAssignInternal===true,canAssignExternal:data.canAssignExternal!==false};}
  }catch{assigneesCache={users:[],contacts:[],canAssignInternal:false,canAssignExternal:true};}
  return assigneesCache;
}
/*
 * QUÉ FALTA PARA PODER GUARDAR EL PEDIDO.
 *
 * La ubicación NO está aquí: solo se exige cuando el pedido va a salir con un
 * mensajero (`orderRequirements({delivery:true})`). Un retiro en tienda y un
 * pedido que solo se confirma se guardan sin dirección, que es la verdad y evita
 * inventar datos para poder avanzar.
 */
function orderRequirements({delivery=false}={}){
  const faltas=[];
  if(!draft.customer?.id)faltas.push({texto:'Elige el cliente del pedido.'});
  else if(!String(draft.customer.phone_e164||'').trim())faltas.push({texto:'El cliente no tiene teléfono válido.'});
  if(!draft.items.length)faltas.push({texto:'Agrega al menos un artículo.'});
  if(delivery&&!orderIsPickup()&&!orderHasCoords())faltas.push({texto:'Falta la ubicación de entrega para enviarlo con un mensajero.'});
  if(draft.scheduledAt){
    const cuando=new Date(draft.scheduledAt);
    if(Number.isNaN(cuando.getTime()))faltas.push({texto:'La fecha de entrega no es válida.'});
    else if(cuando.getTime()<Date.now()-300000)faltas.push({texto:'La fecha de entrega ya pasó.'});
  }
  const sale=totals();
  if(sale.error)faltas.push({texto:sale.error});
  if(orderOpenOrders.length&&!draft.openAck)faltas.push({texto:'Marca que es un pedido nuevo.',visible:false});
  return faltas;
}
function orderLinesHtml(){
  const sale=totals();
  return `<ul class="pos-order-lines">${sale.items.map(l=>`<li><span>${l.quantity}× ${esc(l.name)}</span><strong>${cash(l.subtotal_cents)}</strong></li>`).join('')}</ul>`;
}
function orderTotalsHtml(){
  const sale=totals();
  return `<dl class="pos-order-totals">${sale.discount_cents?`<div><dt>Descuento</dt><dd>−${cash(sale.discount_cents)}</dd></div>`:''}<div class="total"><dt>Total</dt><dd>${cash(sale.total_cents)}</dd></div></dl>`;
}
function orderMissingHtml(faltas){
  const visibles=faltas.filter(f=>f.visible!==false);
  return visibles.length?`<ul class="pos-order-missing">${visibles.map(f=>`<li>${esc(f.texto)}</li>`).join('')}</ul>`:'';
}
function refreshOrderCompletion(){
  const faltas=orderRequirements();
  const paraDelivery=orderRequirements({delivery:true});
  const check=$('#pos-order-check');if(check)check.innerHTML=orderMissingHtml(faltas);
  const hint=$('#pos-order-delivery-hint');
  if(hint){
    const faltaUbicacion=paraDelivery.find(f=>f.texto.includes('ubicación de entrega'));
    hint.hidden=!faltaUbicacion;
    hint.textContent=faltaUbicacion?`Para enviarlo con un mensajero: ${faltaUbicacion.texto.toLowerCase()}`:'';
  }
  const totales=$('#pos-order-totals');if(totales)totales.innerHTML=orderTotalsHtml();
  const lineas=$('#pos-order-lines');if(lineas)lineas.innerHTML=orderLinesHtml();
  const cuenta=$('#pos-order-count');
  if(cuenta){const n=draft.items.reduce((a,i)=>a+i.quantity,0);cuenta.textContent=`${n} ${n===1?'artículo':'artículos'} · ${cash(totals().total_cents)}`;}
  const estado=$('#pos-order-draft-state');if(estado)estado.textContent=orderDraftState();
  document.querySelectorAll('[data-order-confirm],[data-order-request]').forEach(b=>{b.disabled=faltas.length>0||busy;});
  document.querySelectorAll('[data-order-confirm-delivery]').forEach(b=>{b.disabled=paraDelivery.length>0||busy;});
}
async function openOrderCompletion(){
  await initialize();
  if(!draft.customer?.id){chooseClient();message='Elige el cliente y vuelve a pulsar Continuar.';render();return;}
  if(!draft.items.length){message='Agrega al menos un artículo para continuar.';render();return;}
  draft.guidedFlow=true;
  /*
   * AQUÍ NO SE PREGUNTA QUIÉN ENTREGA. El mensajero se elige en la acción
   * «Confirmar + delivery», que es donde de verdad se asigna. Pedirlo dos veces
   * solo llenaba la pantalla de detalles con un dato que todavía no toca.
   */
  orderOpenOrders=[];
  try{orderOpenOrders=(await api('context/'+encodeURIComponent(draft.customer.id))).openOrders||[];}catch{orderOpenOrders=[];}
  const agentesHtml='';
  const faltas=orderRequirements();
  const acuse=faltas.length?`<button type="button" class="pos-order-ai" data-order-ask-ai>Pedir estos datos al cliente</button>`:'';
  const ackHtml=orderOpenOrders.length?`<label class="pos-check pos-open-warning"><input type="checkbox" data-order-open-ack ${draft.openAck?'checked':''}><span>Ya tiene ${orderOpenOrders.length} ${orderOpenOrders.length===1?'pedido':'pedidos'} sin cerrar. Es un pedido nuevo.</span></label>`:'';
  closeActions();modal.className='pos-order-dialog';
  modal.innerHTML=`<div class="pos-order-sheet">
    <header class="pos-order-head">
      <button class="pos-icon" type="button" data-order-close aria-label="Volver al carrito">‹</button>
      <div class="pos-order-title"><strong>Pedido</strong><small>${esc(draft.customer.name||'Cliente')} · ${esc(draft.customer.phone_e164||'sin teléfono')}</small></div>
      <span class="pos-order-draft" id="pos-order-draft-state">${orderDraftState()}</span>
    </header>
    <div class="pos-order-body">
      <section class="pos-order-block">
        <div id="pos-order-where"></div>
        <input class="field__input" data-order-field="deliveryReference" maxlength="240" value="${esc(draft.deliveryReference||'')}" placeholder="Referencia de entrega (opcional)" aria-label="Referencia de entrega">
      </section>
      <section class="pos-order-block">
        <div class="pos-order-row">
          <div class="pos-order-seg" role="group" aria-label="Entrega o retiro"><button type="button" data-order-method="delivery" aria-pressed="${orderIsPickup()?'false':'true'}">Delivery</button><button type="button" data-order-method="pickup" aria-pressed="${orderIsPickup()?'true':'false'}">Retiro</button></div>
          ${orderIsPickup()?'':`<label class="pos-order-fee"><span>Envío</span><input class="field__input" type="number" min="0" step="1" inputmode="numeric" data-order-field="deliveryFee" value="${Number(draft.deliveryFee||0)}" aria-label="Costo de envío en pesos"></label>`}
        </div>
        <div class="pos-order-row">
          <div class="pos-order-seg" role="group" aria-label="Cuándo"><button type="button" data-order-when="now" aria-pressed="${draft.scheduledAt?'false':'true'}">Ahora</button><button type="button" data-order-when="scheduled" aria-pressed="${draft.scheduledAt?'true':'false'}">Programado</button></div>
          <input class="field__input" id="pos-order-schedule" type="datetime-local" data-order-field="scheduledAt" value="${esc(draft.scheduledAt?String(draft.scheduledAt).slice(0,16):'')}" ${draft.scheduledAt?'':'hidden'} aria-label="Fecha y hora de entrega">
        </div>
        <input class="field__input" data-order-field="notes" maxlength="2000" value="${esc(draft.notes||'')}" placeholder="Observaciones del pedido (opcional)" aria-label="Observaciones del pedido">
      </section>
      <section class="pos-order-block">
        <button type="button" class="pos-order-toggle" data-order-lines aria-expanded="false"><span id="pos-order-count"></span><span aria-hidden="true">⌄</span></button>
        <div id="pos-order-lines" class="pos-order-detail" hidden>${orderLinesHtml()}</div>
        <div id="pos-order-totals">${orderTotalsHtml()}</div>
        <label class="pos-order-inline"><span>Forma de pago</span><select class="field__select" data-order-field="paymentMethod"><option value="CASH" ${draft.paymentMethod==='TRANSFER'?'':'selected'}>Efectivo</option><option value="TRANSFER" ${draft.paymentMethod==='TRANSFER'?'selected':''}>Transferencia</option></select></label>
        <label class="pos-order-inline"><span>Estado del cobro</span><select class="field__select" data-order-field="paymentStatus"><option value="pending" ${draft.paymentStatus==='paid'?'':'selected'}>Pendiente</option><option value="paid" ${draft.paymentStatus==='paid'?'selected':''}>Pagado</option></select></label>
        <label class="pos-order-prefs"><input type="checkbox" data-order-save-prefs ${draft.saveOrderPrefs===false?'':'checked'}><span><strong>Lo de siempre</strong><small>Guardar este pedido como preferencia del cliente</small></span></label>
        <div id="pos-order-check">${orderMissingHtml(faltas)}</div>
        <p class="pos-order-hint" id="pos-order-delivery-hint" hidden></p>
        ${acuse}${ackHtml}
      </section>
    </div>
    <p class="pos-order-error" id="pos-order-error" role="alert"></p>
    <!--
      LAS TRES ACCIONES DEL PEDIDO. Nada más en esta barra:
        1. Pedir confirmación  → guarda pendiente y deja el mensaje escrito en el chat.
        2. Confirmar + delivery → confirma y asigna mensajero en un solo paso.
        3. Solo confirmar       → confirma sin crear entrega ni asignar a nadie.
    -->
    <footer class="pos-order-foot">
      <button type="button" class="btn btn--primary" data-order-request ${faltas.length||busy?'disabled':''}>Pedir confirmación</button>
      <button type="button" class="btn btn--ghost" data-order-confirm-delivery ${orderRequirements({delivery:true}).length||busy?'disabled':''}>Confirmar + delivery</button>
      <button type="button" class="btn btn--ghost" data-order-confirm ${faltas.length||busy?'disabled':''}>Solo confirmar</button>
    </footer>
  </div>`;
  if(!modal.open)modal.showModal();
  modal.setAttribute('aria-label','Datos y entrega del pedido');
  refreshOrderCompletion();
  // Dónde se entrega: la ubicación del chat o las guardadas del cliente.
  try{
    const list=await fetch(`/api/admin/customers/${encodeURIComponent(draft.customer.id)}/locations`,{credentials:'same-origin',cache:'no-store'}).then(r=>r.json());
    const filas=(Array.isArray(list.locations)?list.locations:[]).filter(l=>Number.isFinite(Number(l.latitude)));
    if(draft.location&&!filas.some(l=>l.id===draft.location.id))filas.unshift(draft.location);
    renderOrderWhere(filas);
  }catch{renderOrderWhere(draft.location?[draft.location]:[]);}
}
function renderOrderWhere(filas){
  const caja=$('#pos-order-where');if(!caja)return;
  if(orderIsPickup()){
    caja.innerHTML='<p class="pos-order-where"><strong>Retiro</strong><span>El cliente recoge el pedido.</span></p>';
    return;
  }
  if(!filas.length){
    caja.innerHTML='<p class="pos-order-where pos-order-where--miss"><strong>Falta la ubicación de entrega</strong></p>';
    return;
  }
  if(filas.length===1){
    const l=filas[0];
    caja.innerHTML=`<p class="pos-order-where"><strong>${esc(l.address||l.label||'Ubicación del cliente')}</strong><span>Se entregará aquí</span></p>`;
    return;
  }
  caja.innerHTML=`<label class="pos-order-inline"><span>Entregar en</span><select class="field__select" data-order-location-select>${filas.map(l=>`<option value="${esc(l.id)}" ${draft.location?.id===l.id?'selected':''}>${esc(l.address||l.label||'Ubicación')}</option>`).join('')}</select></label>`;
  const select=$('[data-order-location-select]');if(select)select.dataset.locations=JSON.stringify(filas);
}
function orderMissingForAI(){
  const faltan=[];
  if(!draft.customer?.id)faltan.push('el nombre y el teléfono del cliente');
  else if(!String(draft.customer.phone_e164||'').trim())faltan.push('el teléfono');
  if(!draft.items.length)faltan.push('los artículos del pedido');
  if(!orderIsPickup()&&!orderHasCoords())faltan.push('la ubicación de entrega');
  return faltan;
}
async function pedirDatosAlCliente(){
  if(!draft.conversationId){message='Abre el chat del cliente para escribirle.';render();return;}
  const sale=totals();
  const respuesta=await fetch('/api/admin/ai/order-message',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:draft.conversationId,missing:orderMissingForAI(),total:sale.total_cents/100})});
  const data=await respuesta.json().catch(()=>({}));
  if(!respuesta.ok||!data.ok)throw new Error(data.message||'No se pudo preparar el mensaje.');
  const texto=String(data.text||'').trim();
  if(!texto)throw new Error('No se pudo preparar el mensaje.');
  modal.close();
  message='Mensaje listo en el chat: solo falta enviarlo.';
  render();
  window.dispatchEvent(new CustomEvent('fulltech:wa-compose',{detail:{conversationId:draft.conversationId,customerId:draft.customer?.id,text:texto}}));
}
async function postAdmin(path,body,method='POST'){
  const response=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok)throw new Error(data.message||'No se pudo completar la acción.');
  return data;
}
async function getAdmin(path){
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok)throw new Error(data.message||'No se pudo completar la acción.');
  return data;
}

/*
 * EL PEDIDO EXISTE UNA SOLA VEZ.
 *
 * Las tres acciones necesitan un pedido guardado. La primera que se pulsa lo
 * crea (idempotente por `requestId` en el servidor) y las demás REUTILIZAN ese
 * mismo id: dos toques, un reintento o una red lenta no pueden crear dos pedidos.
 * Si el borrador cambió después de guardarlo, se ACTUALIZA el pedido pendiente en
 * vez de crear otro.
 */
async function ensureOrderSaved({needsDelivery=false}={}){
  if(draft.createdOrderId){
    if(draft.orderDirty)await updateSavedOrder(draft.createdOrderId);
    return draft.createdOrderId;
  }
  const snapshot=structuredClone(draft);
  const result=await complete('order',snapshot.paymentMethod||'CASH',Boolean(snapshot.openAck)||!orderOpenOrders.length,{silent:true,keepDraft:true,needsDelivery});
  const orderId=result?.orderId||draft.createdOrderId;
  if(!orderId)throw new Error('No se pudo guardar el pedido.');
  draft.createdOrderId=orderId;draft.orderDirty=false;persist();
  return orderId;
}
async function updateSavedOrder(orderId){
  const sale=totals();if(sale.error)throw new Error(sale.error);
  await postAdmin(`/api/admin/orders/${encodeURIComponent(orderId)}`,{
    items:sale.items.map(i=>({variantId:i.variantId,quantity:i.quantity,unitPrice:i.unit_price_cents/100,lineDiscountCents:i.discount_cents})),
    discount:sale.discount_cents/100,
    deliveryFee:Math.max(0,Math.round(Number(draft.deliveryFee)||0)),
    notes:draft.notes||'',
    paymentMethod:draft.paymentMethod||'CASH',
    delivery:{method:orderIsPickup()?'pickup':'delivery',note:draft.deliveryNotes||'',reference:draft.deliveryReference||'',scheduledAt:draft.scheduledAt||''},
  },'PATCH');
  draft.orderDirty=false;persist();
}

/* ACCIÓN 1 — PEDIR CONFIRMACIÓN: guarda pendiente y deja el mensaje EN EL CHAT. */
async function requestOrderConfirmation(){
  const faltas=orderRequirements();
  if(faltas.length){actionError(faltas[0].texto);return;}
  const orderId=await ensureOrderSaved();
  const data=await getAdmin(`/api/admin/orders/${encodeURIComponent(orderId)}/confirmation-message`);
  const conversationId=data.conversationId||draft.conversationId||'';
  const texto=String(data.text||'').trim();
  if(data.sendable===false||!conversationId||!texto){
    modal.close();
    message=data.message||'Pedido guardado como pendiente. Ábrele el chat al cliente para pedirle confirmación.';
    render();
    window.dispatchEvent(new Event('fulltech:pos-saved'));
    return;
  }
  modal.close();
  message='Pedido pendiente de confirmación. El mensaje está escrito en el chat: revísalo y pulsa Enviar.';
  render();
  window.dispatchEvent(new Event('fulltech:pos-saved'));
  window.dispatchEvent(new CustomEvent('fulltech:wa-compose',{detail:{conversationId,customerId:draft.customer?.id,text:texto}}));
}

/* ACCIÓN 3 — SOLO CONFIRMAR: confirma sin mensajero, sin entrega y sin cobro. */
async function confirmOrderOnly(){
  const faltas=orderRequirements();
  if(faltas.length){actionError(faltas[0].texto);return;}
  const sale=totals();
  const orderId=await ensureOrderSaved();
  const data=await postAdmin(`/api/admin/orders/${encodeURIComponent(orderId)}/confirm`,{fulfillment:orderIsPickup()?'pickup':'delivery'});
  draft=empty();operation=null;expanded=false;persist();message='Pedido confirmado';
  render();
  window.dispatchEvent(new Event('fulltech:pos-saved'));window.dispatchEvent(new Event('fulltech:catalog-updated'));
  show('Pedido guardado y confirmado',`<p class="pos-confirm-total"><strong>${cash(sale.total_cents)}</strong><span>${esc(data.order?.order_number||'')}</span></p><p class="pos-muted">Quedó confirmado sin mensajero y sin crear una entrega. Tampoco se registró ningún cobro.</p><a class="btn btn--ghost" href="${esc(`/admin/receipt-viewer.html?pdf=${encodeURIComponent(`/api/admin/orders/${orderId}/receipt.pdf`)}`)}" target="_blank" rel="noopener">Ver comprobante</a>`,null);
}

/* ACCIÓN 2 — CONFIRMAR Y PASAR A DELIVERY: mensajero + nota + resumen. */
async function openAssignDelivery(){
  const faltas=orderRequirements({delivery:true});
  if(faltas.length){actionError(faltas[0].texto);refreshOrderCompletion();return;}
  const {users,contacts,canAssignInternal,canAssignExternal}=await loadAssignees();
  const internos=canAssignInternal?users:[];
  const externos=canAssignExternal?contacts:[];
  if(!internos.length&&!externos.length){
    actionError(canAssignInternal
      ?'No hay repartidores ni agentes disponibles para asignar.'
      :'No tienes autorización para asignar repartidores del equipo y no hay contactos de reparto guardados.');
    return;
  }
  const sale=totals();
  const opciones=[
    ...internos.map(u=>`<option value="user:${esc(u.id)}" ${draft.deliveryAssignee===`user:${u.id}`?'selected':''}>${esc(u.name)}${u.role==='DELIVERY'?' · repartidor':' · agente'}</option>`),
    ...externos.map(c=>`<option value="contact:${esc(c.phone)}" ${draft.deliveryAssignee===`contact:${c.phone}`?'selected':''}>${esc(c.name)} · externo</option>`),
  ].join('');
  const direccion=orderIsPickup()?'Retiro en tienda':(orderAddress()||'Sin dirección registrada');
  const envio=Math.max(0,Math.round(Number(draft.deliveryFee)||0));
  show('Confirmar y asignar reparto',`<p class="pos-confirm-total"><strong>${cash(sale.total_cents)}</strong><span>${esc(draft.customer?.name||'Cliente')}</span></p><div class="pos-order-where"><strong>${esc(direccion)}</strong><span>Envío: ${cash(envio*100)}${orderIsPickup()?' · el cliente recoge':''}</span></div><label class="field"><span class="field__label">Quién lo lleva</span><select class="field__select" name="assignee" required><option value="">Elige un mensajero</option>${opciones}</select></label><label class="field"><span class="field__label">Nota para el mensajero (opcional)</span><textarea class="field__input" name="note" maxlength="600" rows="2" placeholder="Portal, horario, cómo entrar…"></textarea></label><p class="pos-muted">Se confirma el pedido y se le asigna la entrega en un solo paso. El cliente no recibe ningún WhatsApp automático.</p>`,'Confirmar y asignar',async form=>{
    const value=String(form.get('assignee')||'');
    if(!value)throw new Error('Elige quién lleva el pedido.');
    const note=String(form.get('note')||'').trim().slice(0,600);
    const fulfillment=orderIsPickup()?'pickup':'delivery';
    const orderId=await ensureOrderSaved({needsDelivery:!orderIsPickup()});
    const payload=value.startsWith('user:')
      ?{deliveryUserId:value.slice(5),deliveryNote:note,fulfillment}
      :{deliveryContactPhone:value.slice(8),deliveryNote:note,fulfillment};
    const data=await postAdmin(`/api/admin/orders/${encodeURIComponent(orderId)}/confirm`,payload);
    const asignacion=data.assignment||{};
    if(asignacion.attempted&&asignacion.ok===false){
      // El pedido SÍ quedó confirmado; la asignación no. Se dice tal cual.
      throw new Error(asignacion.message||'El pedido quedó confirmado, pero no se pudo asignar el mensajero. Asígnalo desde Pedidos.');
    }
    const quien=value.startsWith('user:')?internos.find(u=>u.id===value.slice(5))?.name:externos.find(c=>c.phone===value.slice(8))?.name;
    draft=empty();operation=null;expanded=false;persist();message='Pedido confirmado y asignado';render();
    window.dispatchEvent(new Event('fulltech:pos-saved'));window.dispatchEvent(new Event('fulltech:catalog-updated'));
    show('Pedido confirmado y asignado',`<p class="pos-confirm-total"><strong>${cash(sale.total_cents)}</strong><span>${esc(data.order?.order_number||'')}</span></p><p class="pos-muted">Quedó confirmado y asignado${quien?` a ${esc(quien)}`:''}. Se avisó por el canal interno de reparto; no se envió nada al cliente.</p>`,null);
  });
}
document.addEventListener('click',e=>{
  if(!modal.open||!modal.classList.contains('pos-order-dialog'))return;
  if(e.target.closest('[data-order-close]')){modal.close();render();return;}
  const lineas=e.target.closest('[data-order-lines]');
  if(lineas){const detalle=$('#pos-order-lines');if(detalle){detalle.hidden=!detalle.hidden;lineas.setAttribute('aria-expanded',String(!detalle.hidden));}return;}
  if(e.target.closest('[data-order-ask-location]')||e.target.closest('[data-order-ask-ai]')){runAction(()=>pedirDatosAlCliente());return;}
  const metodo=e.target.closest('[data-order-method]');
  if(metodo){draft.deliveryMethod=metodo.dataset.orderMethod==='pickup'?'pickup':'delivery';if(orderIsPickup())draft.deliveryFee=0;draft.feeReviewed=true;persist();runAction(()=>openOrderCompletion());return;}
  const cuando=e.target.closest('[data-order-when]');
  if(cuando){
    if(cuando.dataset.orderWhen==='now')draft.scheduledAt='';
    else if(!draft.scheduledAt){const d=new Date(Date.now()+3600000);draft.scheduledAt=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
    persist();runAction(()=>openOrderCompletion());return;
  }
  if(e.target.closest('[data-order-request]')){runAction(requestOrderConfirmation);return;}
  if(e.target.closest('[data-order-confirm-delivery]')){runAction(openAssignDelivery);return;}
  if(e.target.closest('[data-order-confirm]')){runAction(confirmOrderOnly);return;}
});
document.addEventListener('input',e=>{
  const campo=e.target.closest('[data-order-field]');if(!campo)return;
  const key=campo.dataset.orderField;
  if(key==='deliveryFee'){draft.deliveryFee=Math.max(0,Math.round(Number(campo.value)||0));draft.feeReviewed=true;}
  else if(key==='scheduledAt'){draft.scheduledAt=campo.value?new Date(campo.value).toISOString():'';}
  else draft[key]=campo.value;
  // Si el pedido ya está guardado, este cambio se aplicará a ESE pedido.
  if(draft.createdOrderId)draft.orderDirty=true;
  persist();refreshOrderCompletion();scheduleTicketSave();
});
document.addEventListener('change',e=>{
  const campo=e.target.closest('[data-order-field]');if(campo&&campo.tagName==='SELECT'){const key=campo.dataset.orderField;draft[key]=campo.value;if(draft.createdOrderId)draft.orderDirty=true;persist();refreshOrderCompletion();scheduleTicketSave();return;}
  const ack=e.target.closest('[data-order-open-ack]');if(ack){draft.openAck=ack.checked;persist();refreshOrderCompletion();return;}
  const savePrefs=e.target.closest('[data-order-save-prefs]');if(savePrefs){draft.saveOrderPrefs=savePrefs.checked;persist();return;}
  const ubicacion=e.target.closest('[data-order-location-select]');
  if(ubicacion){
    const filas=JSON.parse(ubicacion.dataset.locations||'[]');
    const elegida=filas.find(l=>l.id===ubicacion.value)||null;
    draft.location=elegida;draft.address=elegida?.address||draft.address;
    persist();refreshOrderCompletion();scheduleTicketSave();
  }
});

window.addEventListener('fulltech:pos-products',e=>{products=e.detail.products;render();initialize();});window.addEventListener('fulltech:pos-render',()=>{updateBadges();});
window.addEventListener('fulltech:offline-synced',async e=>{const mapping=e.detail.mapping;if(draft.customer&&mapping[draft.customer.id])draft.customer.id=mapping[draft.customer.id];if(mapping[draft.ticketId])draft.ticketId=mapping[draft.ticketId];if(mapping[draft.quoteId])draft.quoteId=mapping[draft.quoteId];persist();loaded=false;await initialize();render();});
window.addEventListener('fulltech:tab',e=>{closeActions();edgeGesture=null;if(e.detail.tab==='catalogo'){initialize();render();syncSearchBar();}else{searchOpen=false;modal.close();if(e.detail.tab==='cotizaciones'){quoteSearchOpen=false;quoteFiltersOpen=false;initialize().then(()=>{renderQuotesPage();syncQuotesAppbar();});}else{document.body.dataset.quoteSearch='closed';document.body.dataset.quoteFilters='closed';delete document.body.dataset.quoteDetail;}}});
window.addEventListener('fulltech:pos-context',async e=>{
  const epoch=generation;await initialize();if(epoch!==generation)return;const context=e.detail;
  if(operation){message='Revisa el resultado de la operación anterior antes de iniciar otro pedido.';render();return;}
  const targetId=context.customerId;
  const apply=async()=>{
    /*
     * AISLAMIENTO: si en pantalla está el carrito de OTRO cliente, se guarda
     * COMO SUYO (ticket) y este cliente abre SU propio contexto. Antes se
     * ofrecía «cambiar el cliente del carrito», que traspasaba artículos de un
     * cliente a otro; eso ya no ocurre nunca.
     */
    if(!(await isolateCartFor(targetId)))return;
    const listedCustomer=customers.find(c=>c.id===targetId);
    const customer=context.customer?.id===targetId?{...listedCustomer,...context.customer}:listedCustomer||null;
    const prefs=customer?.orderPrefs??customer?.order_prefs??null;
    /* Su propio borrador guardado, si lo tiene: se retoma tal cual. */
    if(!draft.items.length){
      const own=await ticketForCustomer(targetId);
      if(own)draft={...empty(),...own.draft,ticketId:own.id,ticketVersion:own.version,ticketName:own.name,ticketDirty:false};
    }
    draft.customer=customer;draft.conversationId=context.conversationId||'';draft.location=context.location||draft.location||null;draft.quoteId=null;draft.flow='order';
    // Pedido nuevo: nunca se reutiliza el id de un pedido anterior.
    draft.createdOrderId=null;draft.orderDirty=false;
    if(!draft.items.length&&prefs){
      const variantId=prefs.variantId??prefs.variant_id;
      const quantity=Math.max(1,Math.min(9999,Number(prefs.quantity)||1));
      if(products.some(product=>product.id===variantId))draft.items=[{variantId,quantity,discount:{}}];
      const paymentMethod=prefs.paymentMethod??prefs.payment_method;
      if(['CASH','TRANSFER'].includes(paymentMethod))draft.paymentMethod=paymentMethod;
      if(!draft.notes)draft.notes=String(prefs.note??'').slice(0,2000);
      draft.orderPrefs=structuredClone(prefs);
      const locationId=prefs.locationId??prefs.location_id;
      if(locationId){
        try{const response=await fetch(`/api/admin/customers/${encodeURIComponent(context.customerId)}/locations`,{credentials:'same-origin',cache:'no-store'});const data=await response.json();const saved=(data.locations||[]).find(location=>location.id===locationId);if(saved)draft.location=saved;}catch{}
      }
    }
    changed();
  };
  const listed=customers.find(c=>c.id===targetId)||null;
  const customer=context.customer?.id===targetId?{...listed,...context.customer}:listed;
  const openOrders=await pendingOrders(targetId);
  if(openOrders.length)offerPendingOrders({customer,conversationId:context.conversationId||'',location:context.location||null,orders:openOrders,onNew:apply});
  else await apply();
});
window.addEventListener('fulltech:back',e=>{if(actionsDrawer.open){closeActions();e.preventDefault();}else if(modal.open){modal.close();e.preventDefault();}else if(document.body.dataset.tab==='cotizaciones'&&new URLSearchParams(location.search).has('quote')){if(history.state?.posQuote)history.back();else quotesList();e.preventDefault();}else if(document.body.dataset.tab==='catalogo'&&searchOpen){setSearchOpen(false);e.preventDefault();}});
window.addEventListener('phyto:calling-logout',()=>{generation++;quotesEpoch++;closeActions();actionsDrawer.innerHTML='';edgeGesture=null;clearTimeout(ticketSaveTimer);searchOpen=false;searchBar=null;quotesPage()?.replaceChildren();document.querySelector('.pos-document-toast')?.remove();loaded=false;draft=empty();products=[];customers=[];isAdmin=false;canCreate=false;operation=null;busy=false;modal.close();modal.innerHTML='';root?.replaceChildren();client.replaceChildren();try{if(draftKey)sessionStorage.removeItem(draftKey);}catch{}draftKey=null;});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
if(document.body.dataset.tab==='catalogo')initialize();
if(document.body.dataset.tab==='cotizaciones')initialize().then(renderQuotesPage);
if(window.ResizeObserver&&root)new ResizeObserver(()=>root.parentElement.style.setProperty('--pos-height',root.offsetHeight+'px')).observe(root);
const updateBar=$('#update-bar');
if(updateBar){
  const measure=()=>document.body.style.setProperty('--pos-update-height',(updateBar.classList.contains('update-bar--show')?updateBar.getBoundingClientRect().height:0)+'px');
  if(window.ResizeObserver)new ResizeObserver(measure).observe(updateBar);
  new MutationObserver(measure).observe(updateBar,{attributes:true,attributeFilter:['class']});measure();
}
