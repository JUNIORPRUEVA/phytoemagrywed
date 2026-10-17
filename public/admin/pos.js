import {calculateSale} from './pos-math.js';

const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=c=>new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(c||0)/100);
const empty=()=>({items:[],discount:{},customer:null,conversationId:'',location:null,deliveryFee:0,address:'',notes:'',quoteId:null,flow:'order',ticketId:null,ticketVersion:null,ticketName:''});
const personIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg>';
const quotesIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"/></svg>';
const actionIcon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({quick:'<path d="m13 2-9 12h7l-1 8 10-13h-8z"/>',ticket:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4zM15 5v3m0 3v2m0 3v3"/>',save:'<path d="M5 3h12l4 4v14H3V3h2zm2 0v6h10V3M7 21v-8h10v8"/>',stock:'<path d="m3 7 9-4 9 4v12l-9 3-9-3zM3 7l9 4 9-4M12 11v11M16 3v6M13 6h6"/>',product:'<path d="M4 5h16v15H4zM4 10h16M12 13v5m-2.5-2.5h5"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'})[name]||''}</svg>`;
let draft=empty(),products=[],customers=[],isAdmin=false,canCreate=false,expanded=false,busy=false,loaded=false,generation=0,operation=null,message='',initializing=null,dragged=false,draftKey=null;
const root=$('#pos-root'),client=document.createElement('div');client.id='pos-client';root?.parentElement.prepend(client);
const modal=document.createElement('dialog');modal.className='pos-dialog';document.body.append(modal);
const actionsDrawer=document.createElement('dialog');actionsDrawer.className='pos-actions-drawer';actionsDrawer.setAttribute('aria-label','Acciones de facturación');document.body.append(actionsDrawer);
function closeActions(){actionsDrawer.close();delete document.body.dataset.posActions;document.querySelectorAll('[data-pos-actions]').forEach(b=>b.setAttribute('aria-expanded','false'));}
actionsDrawer.addEventListener('cancel',e=>{e.preventDefault();closeActions();});
actionsDrawer.addEventListener('click',e=>{
  if(e.target===actionsDrawer){const r=actionsDrawer.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right)closeActions();}
  if(e.target.closest('button'))closeActions();
});
function persist(){try{if(draftKey)sessionStorage.setItem(draftKey,JSON.stringify({draft,operation}));}catch{}}
function changed(){operation=null;message='';draft.ticketDirty=true;persist();render();if(draft.ticketId)scheduleTicketSave();}
async function api(path,body){
  const epoch=generation;
  if(body&&!navigator.onLine)throw new Error('Conéctate a internet para guardar o cobrar. Tu carrito sigue disponible.');
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
  document.querySelectorAll('[data-product-id]').forEach(card=>{const n=draft.items.filter(i=>i.variantId===card.dataset.productId).reduce((s,i)=>s+i.quantity,0),badge=card.querySelector('.pos-card-quantity');if(badge){badge.hidden=!n;badge.textContent=n;card.classList.toggle('pos-in-cart',!!n);}});
}
function render(){
  if(!root)return;
  const sale=totals(),quantity=draft.items.reduce((n,i)=>n+i.quantity,0),disabled=!draft.items.length||!!sale.error||!canCreate||busy;
  const wide=window.matchMedia?.('(min-width:900px)').matches;
  client.innerHTML=`<button type="button" class="pos-client-button" data-pos-client><span class="pos-client-icon">${personIcon}</span><strong>${esc(draft.customer?.name||'Selecciona cliente')}</strong><span class="pos-client-chevron" aria-hidden="true">⌄</span></button>${draft.customer?'<button class="pos-icon" type="button" data-pos-remove-client aria-label="Quitar cliente">×</button>':''}<button class="pos-tickets-trigger" type="button" data-pos-tickets aria-haspopup="dialog">${actionIcon('ticket')}<span>Tickets</span></button>`;
  root.classList.toggle('pos-expanded',expanded);
  root.innerHTML=`<section class="pos-cart" aria-label="Carrito de venta"><button class="pos-cart-handle" type="button" data-pos-expand aria-expanded="${expanded||wide}" ${wide?'disabled':''} aria-label="${expanded||wide?'Contraer':'Expandir'} carrito"><span class="pos-grip"></span><span>Carrito <small>${quantity} ${quantity===1?'artículo':'artículos'}</small></span><span>${expanded?'⌄':'⌃'}</span></button><div class="pos-cart-lines" ${expanded?'':'inert'}>${sale.items.length?sale.items.map((line,index)=>`<article class="pos-cart-line"><div class="pos-line-name"><strong>${esc(line.name)}</strong><small>${cash(line.unit_price_cents)} c/u</small><button type="button" class="pos-text" data-pos-discount="${index}">${line.discount_cents?`−${cash(line.discount_cents)}`:'Descuento'}</button></div><div class="pos-stepper"><button type="button" data-pos-minus="${index}" aria-label="Disminuir ${esc(line.name)}">−</button><button type="button" data-pos-quantity="${index}" aria-label="Cantidad de ${esc(line.name)}">${line.quantity}</button><button type="button" data-pos-plus="${index}" aria-label="Aumentar ${esc(line.name)}">+</button></div><div class="pos-line-total"><strong>${cash(line.subtotal_cents)}</strong><button class="pos-text" type="button" data-pos-delete="${index}" aria-label="Eliminar ${esc(line.name)}">Quitar</button></div></article>`).join(''):'<p class="pos-empty">Toca + en un artículo para comenzar.</p>'}</div><div class="pos-cart-tools" ${expanded?'':'hidden'}><button type="button" class="pos-text" data-pos-options>Envío y notas</button><button type="button" class="pos-text" data-pos-pending ${disabled?'disabled':''}>Guardar pedido</button><button type="button" class="pos-text" data-pos-clear ${!draft.items.length||busy?'disabled':''}>Vaciar</button></div></section><div class="pos-feedback" role="status" aria-live="polite">${esc(message||sale.error||'')}</div><section class="pos-summary" aria-label="Resumen de venta"><div class="pos-summary-values">${isAdmin?`<div class="pos-profit"><small>Ganancia</small><strong>${sale.profit_cents===undefined?'—':cash(sale.profit_cents)}</strong></div>`:'<span></span>'}<button type="button" class="pos-discount-total" data-pos-discount="total"><small>Descuento</small><strong>${cash(sale.discount_cents)}</strong></button><div class="pos-total"><small>Total</small><strong>${cash(sale.total_cents)}</strong></div></div><div class="pos-actions"><button type="button" class="btn btn--ghost" data-pos-quote ${disabled?'disabled':''}>Cotizar</button><button type="button" class="btn btn--primary" data-pos-pay ${disabled?'disabled':''}>${busy?'Guardando…':'Cobrar'}</button></div></section>`;
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
    try{const saved=JSON.parse(sessionStorage.getItem(draftKey));if(saved?.draft?.items){draft=saved.draft;operation=saved.operation;}}catch{}
    if(!products.length){const response=await fetch('/api/admin/store/products',{credentials:'same-origin',cache:'no-store'});const catalog=await response.json();if(epoch!==generation)return;products=catalog.products||[];}
    render();
  }catch(e){if(epoch===generation){message=e.message;render();}}finally{initializing=null;}
  })();return initializing;
}
function show(title,body,submitText,onSubmit){
  closeActions();modal.classList.toggle('pos-tickets-dialog',title==='Tickets');
  modal.innerHTML=`<form class="pos-modal-form"><header><h2>${esc(title)}</h2><button class="pos-icon" type="button" data-pos-close aria-label="Cerrar">×</button></header><div class="pos-modal-body">${body}<p class="pos-modal-error" role="alert"></p></div>${submitText?`<footer><button class="btn btn--primary" type="submit">${esc(submitText)}</button></footer>`:''}</form>`;
  modal.setAttribute('aria-label',title);if(!modal.open)modal.showModal();
  modal.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const epoch=generation,button=modal.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;try{await onSubmit(new FormData(e.target));}catch(err){const error=modal.querySelector('.pos-modal-error');if(error&&epoch===generation)error.textContent=err.message;}finally{button.disabled=false;}});
}
function chooseClient(){
  show('Seleccionar cliente',`<label class="field"><span class="field__label">Buscar por nombre o teléfono</span><input class="field__input" type="search" id="pos-client-search" autocomplete="off"></label><div id="pos-customer-results"></div><details class="pos-new-client"><summary>Agregar cliente</summary><label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" maxlength="120"></label><label class="field"><span class="field__label">Teléfono con código de país</span><input class="field__input" name="phone" type="tel" placeholder="+1 809 555 1234"></label></details>`,'Guardar cliente',async form=>{
    if(!String(form.get('phone')||'').trim())throw new Error('Elige un cliente de la lista o escribe su teléfono.');
    const data=await api('customers',{name:form.get('name'),phone:form.get('phone')});customers.push(data.customer);selectClient(data.customer);modal.close();
  });
  const results=()=>{const q=$('#pos-client-search').value.toLocaleLowerCase();$('#pos-customer-results').innerHTML=customers.filter(c=>(c.name+' '+c.phone_e164).toLocaleLowerCase().includes(q)).slice(0,40).map(c=>`<button type="button" class="pos-customer-row" data-pos-customer="${esc(c.id)}"><strong>${esc(c.name||c.phone_e164)}</strong><small>${esc(c.phone_e164)}</small></button>`).join('')||'<p>No encontramos clientes.</p>';};
  $('#pos-client-search').addEventListener('input',results);results();
}
function selectClient(customer){draft.customer=customer;draft.conversationId='';draft.location=null;draft.quoteId=null;changed();}
function editDiscount(index){
  const target=index==='total'?draft:draft.items[Number(index)];if(!target)return;
  show(index==='total'?'Descuento general':'Descuento del artículo',`<label class="field"><span class="field__label">Tipo</span><select class="field__select" name="type"><option value="amount" ${target.discount?.type!=='percent'?'selected':''}>Monto fijo (RD$)</option><option value="percent" ${target.discount?.type==='percent'?'selected':''}>Porcentaje (%)</option></select></label><label class="field"><span class="field__label">Valor</span><input class="field__input" type="number" name="value" min="0" step="0.01" value="${Number(target.discount?.value||0)}" required></label><p class="pos-muted">El monto fijo se aplica a toda la línea. Usa 0 para quitar el descuento.</p>`,'Aplicar',form=>{
    const before=target.discount;target.discount={type:form.get('type'),value:Number(form.get('value'))};
    try{calculateSale(draft.items,products,draft.discount,draft.deliveryFee);}catch(e){target.discount=before;throw e;}
    changed();modal.close();
  });
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
async function complete(mode,paymentMethod,acknowledgeOpen=false){
  const sale=totals();if(sale.error)throw new Error(sale.error);
  if(operation&&operation.mode!==mode)throw new Error('Primero revisa el resultado de la operación anterior.');
  if(!operation&&draft.ticketId)await saveActiveTicket();
  operation ||= {mode,payload:{requestId:crypto.randomUUID(),mode,customerId:draft.customer.id,conversationId:draft.conversationId,
    items:structuredClone(draft.items),discount:draft.discount,deliveryFee:draft.deliveryFee,address:draft.address,notes:draft.notes,location:draft.location,
    quoteId:mode==='quote'?null:draft.quoteId,ticketId:draft.ticketId,ticketVersion:draft.ticketVersion,expectedTotal:sale.total_cents,paymentMethod,acknowledgeOpen}};
  busy=true;persist();render();const epoch=generation;
  try{
    const result=await api(mode==='quote'?'quotes':'checkout',operation.payload);if(epoch!==generation)return;
    const label=mode==='quote'?'Cotización guardada':mode==='order'?'Pedido guardado':'Venta cobrada';
    draft=empty();operation=null;expanded=false;persist();message=label;render();
    if(mode==='quote'){
      modal.close();const id=result.document?.id||result.quoteId;openQuote(id);notifyQuote(id,label);
    }else show(label,`<p class="pos-confirm-total"><strong>${cash(sale.total_cents)}</strong><span>${esc(result.number||'')}</span></p><a class="btn btn--primary" href="${esc(result.receiptUrl)}" target="_blank" rel="noopener">Ver comprobante / PDF</a>${mode==='order'?`<button class="btn btn--ghost" type="button" data-pos-delivery="${esc(result.orderId)}">Continuar entrega</button>`:''}<p class="pos-muted">${mode==='order'?'El pedido está pendiente. Puedes asignar su entrega ahora o desde Pedidos.':'Documento comercial guardado.'}</p>`,null);
    window.dispatchEvent(new Event('fulltech:pos-saved'));window.dispatchEvent(new Event('fulltech:catalog-updated'));
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
  if(host&&searchBar&&!detail)host.append(searchBar);
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
function manualSale(){
  show('Venta fuera de inventario',`<label class="field"><span class="field__label">Descripción</span><input class="field__input" name="name" maxlength="150" required placeholder="Artículo o servicio ocasional"></label><label class="field"><span class="field__label">Tipo</span><select class="field__select" name="kind"><option value="product">Producto fuera de inventario</option><option value="service">Servicio ocasional</option></select></label><div class="pos-manual-grid"><label class="field"><span class="field__label">Cantidad</span><input class="field__input" name="quantity" type="number" min="1" max="9999" step="1" value="1" required></label><label class="field"><span class="field__label">Precio unitario (RD$)</span><input class="field__input" name="price" type="number" min="0" step="0.01" required></label></div><label class="field"><span class="field__label">Costo unitario (RD$)</span><input class="field__input" name="cost" type="number" min="0" step="0.01" value="0" required></label><p class="pos-muted">Aparecerá en el comprobante sin crear un producto ni modificar existencias.</p>`,'Agregar al ticket',form=>{
    const item={variantId:'manual_'+crypto.randomUUID(),quantity:Number(form.get('quantity')),discount:{},manual:{name:String(form.get('name')).trim(),kind:form.get('kind'),price:Number(form.get('price')),cost:Number(form.get('cost'))}};
    calculateSale([item],products);draft.items.push(item);changed();modal.close();
  });
}
function actions(){
  if(busy||modal.open)return;
  window.dispatchEvent(new CustomEvent('fulltech:main-drawer',{detail:{open:false}}));
  actionsDrawer.innerHTML=`<header><strong>Acciones</strong><button class="pos-icon" type="button" data-actions-close aria-label="Cerrar acciones">×</button></header><nav class="pos-action-menu" aria-label="Acciones de venta"><span class="pos-action-section">Ventas</span><button type="button" data-pos-manual>${actionIcon('quick')}<span>Venta rápida<small>Fuera de inventario</small></span></button><button type="button" data-pos-new-ticket>${actionIcon('ticket')}<span>Nuevo ticket</span></button><button type="button" data-pos-save-ticket ${!draft.items.length?'disabled':''}>${actionIcon('save')}<span>Guardar ticket</span></button>${isAdmin?`<span class="pos-action-section">Catálogo</span><button type="button" data-pos-stock>${actionIcon('stock')}<span>Agregar stock</span></button><button type="button" data-pos-create-product>${actionIcon('product')}<span>Nuevo producto<small>Producto o servicio</small></span></button>`:''}</nav>`;
  document.body.dataset.posActions='open';document.querySelectorAll('[data-pos-actions]').forEach(b=>b.setAttribute('aria-expanded','true'));actionsDrawer.showModal();
}
window.addEventListener('fulltech:close-actions',closeActions);

// Solo los gestos iniciados en un borde abren un menú; el centro conserva su scroll.
const edgeZones=['left','right'].map(side=>{const zone=document.createElement('div');zone.className='pos-edge-zone pos-edge-zone--'+side;zone.setAttribute('aria-hidden','true');document.body.append(zone);return zone;});
let edgeGesture=null;
document.addEventListener('pointerdown',e=>{
  if(!['touch','pen'].includes(e.pointerType)||e.isPrimary===false||window.innerWidth>979||$('#app')?.hidden!==false||busy)return;
  if(modal.open||document.querySelector('dialog[open]:not(.pos-actions-drawer)')||$('#sheet')?.hidden===false)return;
  const mode=actionsDrawer.open?'close-actions':document.body.dataset.drawer==='open'?'close-main':e.clientX<=20?'main':e.clientX>=window.innerWidth-20&&document.body.dataset.tab==='catalogo'?'actions':null;
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
let quotesEpoch=0,quoteQuery='',quoteRows=[];
const quotesPage=()=>$('#pos-quotes-page');
function openQuote(id){
  if(!id)return;modal.close();const url=new URL(location.href);url.searchParams.set('v','cotizaciones');url.searchParams.set('quote',id);url.searchParams.delete('ticket');url.searchParams.delete('product');
  if(url.href!==location.href)history.pushState({posQuote:true,posQuoteFromList:new URLSearchParams(location.search).get('v')==='cotizaciones'&&!new URLSearchParams(location.search).has('quote')},'',url);window.dispatchEvent(new CustomEvent('fulltech:pos-navigate',{detail:{tab:'cotizaciones'}}));renderQuotesPage();
}
function notifyQuote(id,text){
  document.querySelector('.pos-document-toast')?.remove();const toast=document.createElement('div');toast.className='pos-document-toast';toast.setAttribute('role','status');
  toast.innerHTML=`<span>${esc(text)}</span><button type="button" data-pos-open-quote="${esc(id)}">Ver cotización</button>`;document.body.append(toast);setTimeout(()=>toast.remove(),15000);
}
function quoteListRows(){
  const list=$('#pos-quote-list');if(!list)return;
  const q=quoteQuery.toLocaleLowerCase();const rows=quoteRows.filter(d=>(d.number+' '+d.customer.name+' '+d.customer.phone_e164).toLocaleLowerCase().includes(q));
  list.innerHTML=rows.map(d=>`<button class="pos-quote-row" type="button" data-pos-open-quote="${esc(d.id)}"><span class="pos-document-icon">${quotesIcon}</span><span><strong>${esc(d.customer.name||d.customer.phone_e164)}</strong><small>${esc(d.number)} · ${esc(new Date(d.created_at).toLocaleDateString('es-DO'))}</small></span><span><strong>${cash(d.sale.total_cents)}</strong><small>${d.status==='converted'?'Facturada / pedido':'Cotización'}</small></span></button>`).join('')||'<div class="pos-empty">No hay cotizaciones para mostrar.</div>';
}
async function renderQuotesPage(){
  const box=quotesPage();if(!box)return;const request=++quotesEpoch,epoch=generation;
  try{
    const id=new URLSearchParams(location.search).get('quote');
    if(!id){
      const data=await api('quotes');if(request!==quotesEpoch||epoch!==generation)return;quoteRows=data.quotes;
      box.innerHTML=`<label class="field pos-document-search"><span class="sr-only">Buscar cotizaciones</span><input class="field__input" type="search" id="pos-quote-search" placeholder="Buscar cliente o cotización" value="${esc(quoteQuery)}"></label><div id="pos-quote-list"></div>`;
      $('#pos-quote-search').addEventListener('input',e=>{quoteQuery=e.target.value;quoteListRows();});quoteListRows();return;
    }
    const {document:q}=await api('quotes/'+encodeURIComponent(id));if(request!==quotesEpoch||epoch!==generation)return;
    box.innerHTML=`<div class="pos-quote-detail"><button class="pos-text" type="button" data-pos-quotes-list>‹ Todas las cotizaciones</button><header><span class="pos-document-icon">${quotesIcon}</span><div><small>${esc(q.number)}</small><h2>${esc(q.customer.name||q.customer.phone_e164)}</h2><p>${esc(q.customer.phone_e164)} · ${esc(new Date(q.created_at).toLocaleDateString('es-DO'))}</p></div></header><div class="pos-quote-detail-lines">${q.sale.items.map(i=>`<div><span><strong>${esc(i.name)}</strong><small>${i.quantity} × ${cash(i.unit_price_cents)}${i.discount_cents?' · −'+cash(i.discount_cents):''}</small></span><strong>${cash(i.subtotal_cents)}</strong></div>`).join('')}</div><div class="pos-quote-detail-total"><small>Descuento general ${cash(q.sale.discount_cents)} · Envío ${cash(q.sale.delivery_cents)}</small><strong>${cash(q.sale.total_cents)}</strong></div>${q.input.notes?`<p class="pos-muted">${esc(q.input.notes)}</p>`:''}<div class="pos-quote-detail-actions"><a class="btn btn--ghost" href="/api/admin/pos/quotes/${esc(q.id)}/receipt" target="_blank" rel="noopener">Ver PDF / compartir</a>${q.status==='converted'?`<a class="btn btn--primary" href="/api/admin/orders/${esc(q.order_id)}/receipt" target="_blank" rel="noopener">Ver venta</a>`:`<button class="btn btn--primary" type="button" data-pos-quote-ticket="${esc(q.id)}">Pasar a ticket</button>`}</div><p class="pos-muted">Cotización comercial. No registra pago ni reserva inventario.</p></div>`;
    if(new URLSearchParams(location.search).get('ticket')==='1'){
      const url=new URL(location.href);url.searchParams.delete('ticket');history.replaceState(history.state,'',url);
      if(q.status!=='converted')await quoteToTicket(q.id);
    }
  }catch(e){if(request===quotesEpoch&&epoch===generation)box.innerHTML=`<p role="alert">${esc(e.message)}</p>`;}
}
async function quoteToTicket(id){await initialize();await saveActiveTicket();const {ticket}=await api('tickets',{requestId:crypto.randomUUID(),quoteId:id});if(ticket.status!=='open')throw new Error('El ticket de esta cotización ya está procesado o en revisión.');useTicket(ticket);}
function quotesList(){if(history.state?.posQuoteFromList){history.back();return;}const url=new URL(location.href);url.searchParams.delete('quote');url.searchParams.delete('ticket');history.replaceState({tab:'cotizaciones'},'',url);renderQuotesPage();}
function actionError(text){const error=modal.open?modal.querySelector('.pos-modal-error'):null;if(error)error.textContent=text;else if(document.body.dataset.tab==='cotizaciones'){let note=$('#pos-documents-error');if(!note){note=document.createElement('p');note.id='pos-documents-error';note.setAttribute('role','alert');quotesPage()?.prepend(note);}note.textContent=text;}else{message=text;render();}}
async function runAction(action){if(busy)return;try{busy=true;await action();}catch(e){actionError(e.message);}finally{busy=false;render();}}

document.addEventListener('click',e=>{
  if(operation&&e.target.closest('[data-pos-new-ticket],[data-pos-save-ticket],[data-pos-manual],[data-pos-ticket],[data-pos-quote-ticket]')){actionError('Revisa la operación anterior antes de cambiar la venta.');return;}
  if(e.target.closest('[data-pos-search-open]'))setSearchOpen(true);
  if(e.target.closest('[data-pos-search-close]'))setSearchOpen(false);
  if(e.target.closest('[data-pos-actions]'))actions();
  if(e.target.closest('[data-pos-new-ticket]'))runAction(newTicket);
  if(e.target.closest('[data-pos-save-ticket]'))runAction(async()=>{await saveActiveTicket();modal.close();message='Ticket guardado';render();});
  if(e.target.closest('[data-pos-tickets]'))runAction(ticketList);
  if(e.target.closest('[data-pos-manual]'))manualSale();
  if(e.target.closest('[data-pos-create-product]')){modal.close();window.dispatchEvent(new Event('fulltech:store-create'));}
  if(e.target.closest('[data-pos-stock]')){modal.close();window.dispatchEvent(new CustomEvent('fulltech:pos-navigate',{detail:{tab:'inventario'}}));}
  const ticket=e.target.closest('[data-pos-ticket]');if(ticket)runAction(()=>openTicket(ticket.dataset.posTicket));
  const rename=e.target.closest('[data-pos-ticket-rename]');if(rename)runAction(()=>renameTicket(rename.dataset.posTicketRename));
  const discard=e.target.closest('[data-pos-ticket-discard]');if(discard)runAction(()=>discardTicket(discard.dataset.posTicketDiscard));
  const quote=e.target.closest('[data-pos-open-quote]');if(quote)openQuote(quote.dataset.posOpenQuote);
  const quoteTicket=e.target.closest('[data-pos-quote-ticket]');if(quoteTicket)runAction(()=>quoteToTicket(quoteTicket.dataset.posQuoteTicket));
  if(e.target.closest('[data-pos-quotes-list]'))quotesList();
});
window.addEventListener('fulltech:pos-appbar',syncSearchBar);
window.addEventListener('fulltech:pos-render',syncSearchBar);
window.addEventListener('popstate',()=>{if(document.body.dataset.tab==='cotizaciones')renderQuotesPage();else syncSearchBar();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&searchOpen&&!modal.open&&!actionsDrawer.open){setSearchOpen(false);e.preventDefault();}});

document.addEventListener('click',e=>{
  const mutation=e.target.closest('[data-pos-add],[data-pos-client],[data-pos-remove-client],[data-pos-customer],[data-pos-plus],[data-pos-minus],[data-pos-delete],[data-pos-quantity],[data-pos-discount],[data-pos-options],[data-pos-clear]');
  if(operation&&!busy&&mutation){show('Revisar operación anterior','<p>Hay una operación sin confirmar. Vuelve a pulsar Cotizar, Cobrar o Guardar pedido para consultar su resultado con el mismo identificador. Antes de iniciar otra venta, comprueba el resultado en Pedidos.</p><label class="pos-check"><input type="checkbox" required> Revisé Pedidos y continuaré con una operación nueva.</label>','Continuar',()=>{operation=null;persist();modal.close();});return;}
  const add=e.target.closest('[data-pos-add]');if(add&&!busy){
    if(!canCreate){message='No tienes permiso para crear ventas.';render();return;}
    const id=add.dataset.posAdd,p=products.find(p=>p.id===id);if(!p?.active)return;
    let line=draft.items.find(i=>i.variantId===id);
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
  const action=e.target.closest('[data-pos-plus],[data-pos-minus],[data-pos-delete],[data-pos-quantity]');
  if(action){const index=Number(action.dataset.posPlus??action.dataset.posMinus??action.dataset.posDelete??action.dataset.posQuantity),line=draft.items[index];if(!line)return;
    if('posQuantity'in action.dataset){show('Cantidad',`<label class="field"><span class="field__label">Unidades</span><input class="field__input" name="quantity" type="number" min="1" max="9999" step="1" required value="${line.quantity}"></label>`,'Aplicar',form=>{const value=Number(form.get('quantity'));if(!Number.isSafeInteger(value)||value<1||value>9999)throw new Error('Cantidad inválida.');line.quantity=value;changed();modal.close();});return;}
    if('posDelete'in action.dataset||('posMinus'in action.dataset&&line.quantity===1))draft.items.splice(index,1);else line.quantity=Math.max(1,Math.min(9999,line.quantity+('posPlus'in action.dataset?1:-1)));changed();
  }
  const discount=e.target.closest('[data-pos-discount]');if(discount)editDiscount(discount.dataset.posDiscount);
  if(e.target.closest('[data-pos-options]'))options();
  if(e.target.closest('[data-pos-quote]'))confirmSale('quote');
  if(e.target.closest('[data-pos-pay]'))confirmSale('invoice');
  if(e.target.closest('[data-pos-pending]'))confirmSale('order');
  if(e.target.closest('[data-pos-clear]'))show('Vaciar carrito','<p>Se quitarán los artículos y descuentos del carrito.</p>','Vaciar',()=>{draft.items=[];draft.discount={};if(!draft.ticketId)draft.quoteId=null;changed();modal.close();});
});
window.addEventListener('fulltech:pos-products',e=>{products=e.detail.products;render();initialize();});
window.addEventListener('fulltech:pos-render',()=>{updateBadges();});
window.addEventListener('fulltech:tab',e=>{closeActions();edgeGesture=null;if(e.detail.tab==='catalogo'){initialize();render();syncSearchBar();}else{searchOpen=false;modal.close();if(e.detail.tab==='cotizaciones')initialize().then(renderQuotesPage);}});
window.addEventListener('fulltech:pos-context',async e=>{
  const epoch=generation;await initialize();if(epoch!==generation)return;const context=e.detail;
  if(operation){message='Revisa el resultado de la operación anterior antes de iniciar otro pedido.';render();return;}
  const apply=()=>{draft.customer=customers.find(c=>c.id===context.customerId)||(context.customer?.id===context.customerId?context.customer:null);draft.conversationId=context.conversationId||'';draft.location=context.location||null;draft.quoteId=null;draft.flow='order';changed();};
  if(draft.items.length&&draft.customer?.id!==context.customerId)show('Cambiar cliente del carrito','<p>Se conservarán los artículos y se asignarán al cliente seleccionado.</p>','Continuar',()=>{apply();modal.close();});else apply();
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
