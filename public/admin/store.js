/* Catálogo Fulltech. Operaciones de stock en línea, con historial en el servidor. */
(() => {
  'use strict';
  const pages=['catalogo','inventario','recuento'];
  let page='',products=[],categoryRows=[],movements=[],canManage=false,loading=false,query='',kind='all',epoch=0;
  let category='',layout='grid',signature='',source=null,poll=null,pending=false,authenticated=false;
  try {layout=localStorage.getItem('fulltech.catalog.layout')==='list'?'list':'grid';}catch{}
  const categoryName=p=>String(p.category||'').trim().replace(/\s+/g,' ')||'Sin categoría';
  const categoryKey=p=>categoryName(p).toLocaleLowerCase('es');
  const icon=name=>({grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',arrow:'<path d="m14 7-5 5 5 5"/>',plus:'<path d="M12 5v14M5 12h14"/>',filter:'<path d="M4 7h16M7 12h10M10 17h4"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'}[name]||'');
  const svg=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icon(name)}</svg>`;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cash=c=>new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(c||0)/100);
  const root=()=>document.getElementById(`store-${page}`);
  const notice=text=>{const box=document.getElementById('store-notice');if(box)box.textContent=text;};
  async function request(path,body,method='POST') {
    const generation=epoch,wasAuthenticated=authenticated;
    const r=await fetch(`/api/admin/store/${path}`,{credentials:'same-origin',cache:'no-store',
      method:body?method:'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(r.status===401){if(generation===epoch&&wasAuthenticated)window.dispatchEvent(new Event('fulltech:session-expired'));throw new Error('Tu sesión terminó. Vuelve a entrar.');}
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.message||'No se pudo completar la operación. Actualiza y vuelve a intentarlo.');
    return data;
  }
  async function load(force=false) {
    if(loading){pending=true;return;}loading=true;const generation=epoch;
    try { const data=await request('products');if(generation!==epoch)return;
      const nextSignature=JSON.stringify(data);
      const changed=signature!==nextSignature;signature=nextSignature;
      products=data.products;categoryRows=data.categories||[];movements=data.movements;canManage=data.canManage;authenticated=true;
      if(changed||force)window.dispatchEvent(new CustomEvent('fulltech:pos-products',{detail:{products,canManage}}));
      if(force)render();else if(changed)renderPreservingInput();
      if(changed)window.dispatchEvent(new Event('fulltech:catalog-updated'));
    }catch(e){notice(e.message);}finally{loading=false;if(pending){pending=false;load();}}
  }
  function renderPreservingInput() {
    const listScroll=document.getElementById('store-product-grid')?.scrollTop||0;
    const form=document.getElementById('store-stock-form');
    const draft=form?{values:Object.fromEntries(new FormData(form)),...form.dataset}:null;
    const active=document.activeElement,focusId=active?.id,focusName=form?.contains(active)?active.name:null,start=active?.selectionStart,end=active?.selectionEnd;
    render();
    const list=document.getElementById('store-product-grid');if(list)list.scrollTop=listScroll;
    const next=document.getElementById('store-stock-form');
    if(draft&&next&&draft.count===next.dataset.count){
      Object.entries(draft.values).forEach(([key,value])=>{if(next.elements[key])next.elements[key].value=value;});
      if(draft.expected!==undefined)next.dataset.expected=draft.expected;
      if(draft.requestId)next.dataset.requestId=draft.requestId;
      updateCount();
    }
    const node=focusId?document.getElementById(focusId):focusName?next?.elements.namedItem(focusName):null;
    node?.focus({preventScroll:true});if(node?.setSelectionRange&&start!==null)try{node.setSelectionRange(start,end);}catch{}
  }
  function head() {return '<p id="store-notice" class="store-notice" role="status" aria-live="polite"></p>';}
  function photo(p){return p.image_url?`<img class="store-photo" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" width="96" height="96">`:'<div class="store-photo store-photo--empty" aria-label="Servicio">Servicio</div>';}
  function stockLabel(p){return p.kind==='service'?'Sin stock':p.quantity===null?'Sin inventario inicial':`${p.quantity} ${p.quantity===1?'unidad':'unidades'}${p.legacy?' disponibles':''}`;}
  function cards() {
    const search=query.toLocaleLowerCase();
    const rows=products.filter(p=>(kind==='all'||p.kind===kind)&&(!category||categoryKey(p)===category)&&(p.name+' '+p.sku+' '+(p.category||'')).toLocaleLowerCase().includes(search));
    const box=document.getElementById('store-product-grid');if(!box)return;
    box.dataset.layout=layout;
    box.innerHTML=rows.length?`<div class="store-items">${rows.map(p=>`<article class="store-product${p.active?'':' store-product--inactive'}" data-product-id="${esc(p.id)}">
      <a class="store-product__visual" href="/admin/?v=catalogo&amp;product=${encodeURIComponent(p.id)}" data-store-detail="${esc(p.id)}" aria-label="Ver detalle de ${esc(p.name)}">${photo(p)}${!p.active?'<span class="store-product__badge">Inactivo</span>':p.track_stock&&p.quantity===0?'<span class="store-product__badge">Agotado</span>':''}</a>
      <button type="button" class="store-product__body pos-add" data-pos-add="${esc(p.id)}" ${!p.active?'disabled':''} aria-label="Agregar ${esc(p.name)} al carrito"><h4>${esc(p.name)}</h4><strong class="store-price">${cash(p.price_cents)}</strong><span class="pos-card-plus" aria-hidden="true">+</span><span class="pos-card-quantity" hidden></span></button></article>`).join('')}</div>`:'<div class="store-empty"><h3>No encontramos artículos</h3><p>Prueba otra búsqueda o categoría.</p><button class="btn btn--ghost" type="button" data-store-clear>Mostrar todos</button></div>';
    window.dispatchEvent(new Event('fulltech:pos-render'));

  }
  function detailId(){return new URLSearchParams(location.search).get('product');}
  function navigateProduct(id){
    if(!id&&detailId()&&history.state?.storeProduct){history.back();return;}
    const url=new URL(location.href);url.searchParams.set('v','catalogo');if(id)url.searchParams.set('product',id);else url.searchParams.delete('product');
    history[id?'pushState':'replaceState']({storeProduct:id||null},'',url);render();
    document.querySelector('#store-detail-title,#store-search')?.focus({preventScroll:true});document.getElementById('view-catalogo')?.scrollIntoView({block:'start'});
  }
  function detail(p) {
    if(!p)return `<div class="store-empty"><h2 id="store-detail-title" tabindex="-1">Artículo no encontrado</h2><p>Puede que ya no esté disponible para tu cuenta.</p></div>`;
    return `<article class="store-detail"><div class="store-detail__image">${photo(p)}</div><div class="store-detail__content"><div class="store-detail__eyebrow">${p.kind==='service'?'Servicio':'Producto'}<span class="store-status${p.active?' store-status--active':''}">${p.active?'Activo':'Inactivo'}</span></div>
      <h2 id="store-detail-title" tabindex="-1">${esc(p.name)}</h2><p class="store-muted">${esc(p.sku)}</p><strong class="store-detail__price">${cash(p.price_cents)}</strong><p class="store-muted">Precio de venta</p>
      <dl class="store-detail-facts"><div><dt>Categoría</dt><dd>${esc(categoryName(p))}</dd></div>${canManage?`<div><dt>Costo ${p.kind==='service'?'del servicio':'por unidad'}</dt><dd>${cash(p.cost_cents)}</dd></div>`:''}<div><dt>${p.kind==='service'?'Inventario':'Existencias'}</dt><dd>${esc(p.kind==='service'?'No aplica a servicios':stockLabel(p))}</dd></div>${p.kind==='product'&&!p.legacy?`<div><dt>Stock mínimo</dt><dd>${p.min_stock} unidades</dd></div>`:''}</dl>
      ${p.legacy?'<p class="store-detail-note">Estas presentaciones comparten el mismo inventario de cápsulas de Phytoemagry.</p>':''}<div class="store-actions">${canManage?`<button class="btn btn--primary" type="button" data-store-edit="${esc(p.id)}">Editar artículo</button>`:''}${p.track_stock?`<button class="btn btn--ghost" type="button" data-tab="${p.legacy?'productos':'inventario'}">Ver stock</button>`:''}</div></div>
      <section class="store-detail-description"><h3>Descripción</h3><p>${esc(p.description||'Este artículo todavía no tiene descripción.')}</p></section></article>`;
  }
  function render() {
    const box=root();if(!box)return;
    pages.filter(p=>p!==page).forEach(p=>document.getElementById(`store-${p}`)?.replaceChildren());
    const legacy=products.find(p=>p.legacy);
    const tracked=products.filter(p=>p.track_stock&&!p.legacy);
    if(page==='catalogo') {
      const selected=detailId();document.getElementById('view-catalogo')?.classList.toggle('store-is-detail',!!selected);
      if(selected){box.innerHTML=head()+detail(products.find(p=>p.id===selected));window.dispatchEvent(new Event('fulltech:catalog-view'));return;}
      document.querySelector('#pos-search-host .store-search-line')?.remove();
      box.innerHTML=head()+`<div class="store-search-line"><label class="store-search field">${svg('search')}<span class="sr-only">Buscar producto, código o categoría</span><input class="field__input" type="search" id="store-search" placeholder="Buscar productos y servicios" value="${esc(query)}"></label><button type="button" class="store-filter-trigger" data-store-filters aria-label="Filtros del catálogo" aria-haspopup="dialog">${svg('filter')}${category||kind!=='all'?'<span class="store-filter-dot"></span>':''}</button></div>
      <div id="store-product-grid"></div>${`<button class="store-fab pos-actions-fab" type="button" data-pos-actions aria-label="Acciones de facturación" title="Acciones"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`}`;
      cards();window.dispatchEvent(new Event('fulltech:catalog-view'));
    }else {
      box.innerHTML=head()+`<div class="store-workspace">${canManage?movementForm(page==='recuento'):'<p class="store-empty">Solo administración puede registrar ajustes y recuentos.</p>'}
        ${legacy?`<div class="store-capsule-link"><div><strong>Phytoemagry</strong><small>${esc(legacy.base_quantity??'Sin inicializar')} cápsulas · saldo compartido</small></div><button class="btn btn--ghost" type="button" data-tab="productos">${page==='recuento'?'Contar cápsulas':'Gestionar'}</button></div>`:''}
        <details class="store-disclosure"><summary>Existencias por producto <span>${tracked.length}</span></summary><div class="store-stock-list">${tracked.map(p=>`<div><span><strong>${esc(p.name)}</strong><small>${esc(p.sku)} · Mínimo ${p.min_stock}</small></span><span class="${p.quantity<=p.min_stock?'store-low-stock':''}">${p.quantity}<small>unidades</small></span></div>`).join('')||'<p>Los nuevos productos aparecerán aquí.</p>'}</div></details>
        <details class="store-disclosure"><summary>Movimientos recientes <span>${movements.length}</span></summary><div class="store-stock-list">${movements.map(m=>`<div><span><strong>${esc(m.product_name)}</strong><small>${esc(({INITIAL:'Inicial',RESTOCK:'Entrada',SALE:'Venta',SALE_REVERSAL:'Devolución',COUNT:'Recuento',ADJUSTMENT_OUT:'Salida'})[m.type]||m.type)} · ${esc(new Date(m.created_at).toLocaleString('es-DO'))}</small><small>${esc(m.reason)} · ${esc(m.actor)}</small></span><span>${m.quantity_delta>0?'+':''}${m.quantity_delta}<small>Saldo ${m.quantity_after}</small></span></div>`).join('')||'<p>No hay movimientos todavía.</p>'}</div></details></div>`;
    }
    updateCount();
  }
  function movementForm(count) {
    const rows=products.filter(p=>p.track_stock&&!p.legacy);
    if(!rows.length)return '<div class="card"><p>Crea un producto para registrar sus existencias. Los servicios no llevan stock.</p><button class="btn btn--ghost" type="button" data-tab="catalogo">Ir al catálogo</button></div>';
    return `<form class="store-stock-form" id="store-stock-form" data-count="${count}"><p class="store-form-caption">${count?'Compara las unidades contadas con el saldo registrado.':'Registra una entrada o salida de mercancía.'}</p>
      <label class="field"><span class="field__label">Producto</span><select class="field__select" name="productId">${rows.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('')}</select></label>
      ${count?'':'<label class="field"><span class="field__label">Movimiento</span><select class="field__select" name="type"><option value="in">Entrada de mercancía</option><option value="out">Salida / ajuste</option></select></label>'}
      <label class="field"><span class="field__label">${count?'Unidades contadas':'Cantidad de unidades'}</span><input class="field__input" name="quantity" type="number" min="${count?'0':'1'}" step="1" required></label>
      <div id="store-stock-preview" class="store-stock-preview" aria-live="polite"></div>
      <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" maxlength="300" required placeholder="${count?'Recuento físico':'Compra, devolución o motivo del ajuste'}"></label>
      <p class="store-form-error" role="alert"></p><button class="btn btn--primary" type="submit">${count?'Guardar recuento':'Guardar ajuste'}</button></form>`;
  }
  function updateCount() {
    const form=document.getElementById('store-stock-form');if(!form)return;
    const p=products.find(p=>p.id===form.elements.productId.value);if(!p)return;
    const count=form.dataset.count==='true';
    form.dataset.expected ||= String(p.quantity);
    const baseline=count?Number(form.dataset.expected):p.quantity;
    const qty=form.elements.quantity.value;
    const delta=qty===''?null:count?Number(qty)-baseline:Number(qty)*(form.elements.type.value==='out'?-1:1);
    document.getElementById('store-stock-preview').innerHTML=`<div><small>Stock registrado</small><strong>${baseline}</strong></div><div><small>${count?'Diferencia':'Ajuste'}</small><strong>${delta===null?'—':(delta>0?'+':'')+delta}</strong></div><div><small>Quedará</small><strong>${delta===null?'—':baseline+delta}</strong></div>${count&&baseline!==p.quantity?'<p>El stock cambió. Vuelve a abrir Recuento antes de guardar.</p>':''}`;

  }
  const filterDrawer=document.createElement('dialog');filterDrawer.className='store-filter-drawer';filterDrawer.setAttribute('aria-label','Filtros del catálogo');document.body.append(filterDrawer);
  const categoryDialog=document.createElement('dialog');categoryDialog.className='store-dialog store-category-dialog';categoryDialog.setAttribute('aria-label','Nueva categoría');document.body.append(categoryDialog);
  const dialog=document.createElement('dialog');dialog.className='store-dialog store-product-dialog';dialog.setAttribute('aria-label','Producto o servicio');document.body.append(dialog);
  function categoryOptions(selected='') {
    return '<option value="">Sin categoría</option>'+categoryRows.map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join('');
  }
  function openFilters(){
    const rows=new Map(categoryRows.map(c=>[categoryKey({category:c.name}),{...c,count:0}]));
    for(const p of products){const key=categoryKey(p);if(!rows.has(key))rows.set(key,{name:categoryName(p),count:0});rows.get(key).count++;}
    filterDrawer.innerHTML=`<div class="store-drawer-head"><h2>Filtros</h2><button class="store-icon-button" type="button" data-filter-close aria-label="Cerrar filtros">${svg('close')}</button></div><div class="store-drawer-body">
      <fieldset><legend>Tipo de artículo</legend><div class="store-segmented">${[['all','Todos'],['product','Productos'],['service','Servicios']].map(([value,name])=>`<label><input type="radio" name="kind" value="${value}" ${kind===value?'checked':''}><span>${name}</span></label>`).join('')}</div></fieldset>
      <fieldset><legend>Categoría</legend><div class="store-category-choices"><label><input type="radio" name="category" value="" ${!category?'checked':''}><span class="store-category-thumb">⊞</span><span>Todas las categorías</span><small>${products.length}</small></label>${[...rows.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,'es')).map(([key,c])=>`<label><input type="radio" name="category" value="${esc(key)}" ${category===key?'checked':''}>${c.image_url?`<img class="store-category-thumb" src="${esc(c.image_url)}" alt="">`:`<span class="store-category-thumb">${esc(c.name[0])}</span>`}<span>${esc(c.name)}</span><small>${c.count}</small></label>`).join('')}</div>${canManage?`<button type="button" class="store-text-button" data-category-new>${svg('plus')}Nueva categoría</button>`:''}</fieldset>
      <fieldset><legend>Presentación</legend><div class="store-layout-switch" role="group" aria-label="Vista del catálogo"><button type="button" data-store-layout="grid" aria-label="Vista de cuadrícula" aria-pressed="${layout==='grid'}">${svg('grid')}<span>Cuadrícula</span></button><button type="button" data-store-layout="list" aria-label="Vista de lista" aria-pressed="${layout==='list'}">${svg('list')}<span>Lista</span></button></div></fieldset></div>
      <div class="store-drawer-footer"><button class="btn btn--ghost" type="button" data-filter-reset>Restablecer</button><button class="btn btn--primary" type="button" data-filter-close>Ver resultados</button></div>`;
    if(!filterDrawer.open)filterDrawer.showModal();
  }
  filterDrawer.addEventListener('change',e=>{if(e.target.name==='kind')kind=e.target.value;if(e.target.name==='category')category=e.target.value;render();});
  filterDrawer.addEventListener('click',e=>{
    if(e.target.closest('[data-filter-close]'))filterDrawer.close();
    if(e.target.closest('[data-filter-reset]')){kind='all';category='';render();openFilters();}
    if(e.target.closest('[data-category-new]'))openCategory();
    const b=e.target.closest('[data-store-layout]');if(b){layout=b.dataset.storeLayout;try{localStorage.setItem('fulltech.catalog.layout',layout);}catch{}cards();filterDrawer.querySelectorAll('[data-store-layout]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.storeLayout===layout)));}
  });
  let categoryImage=null;
  function openCategory(){
    categoryImage=null;
    categoryDialog.innerHTML=`<form id="store-category-form"><div class="store-toolbar"><h2>Nueva categoría</h2><button class="store-icon-button" type="button" data-category-close aria-label="Cerrar categoría">${svg('close')}</button></div><div class="store-form-body"><label class="field"><span class="field__label">Nombre de la categoría</span><input class="field__input" name="name" maxlength="100" required placeholder="Ej. Accesorios"></label><label class="field"><span class="field__label">Imagen de la categoría</span><input class="field__input" name="image" type="file" accept="image/jpeg,image/png,image/webp"></label><div id="store-category-image-preview" class="store-category-image-preview">Imagen opcional</div><p class="store-form-error" role="alert"></p></div><div class="store-form-footer"><button class="btn btn--primary btn--block" type="submit">Crear categoría</button></div></form>`;
    categoryDialog.showModal();
  }
  categoryDialog.addEventListener('click',e=>{if(e.target.closest('[data-category-close]'))categoryDialog.close();});
  categoryDialog.addEventListener('change',async e=>{
    if(e.target.name!=='image'||!e.target.files[0])return;
    const button=categoryDialog.querySelector('[type=submit]');button.disabled=true;
    try{const data=await imageFile(e.target.files[0]);if(!categoryDialog.open||!e.target.isConnected)return;categoryImage=data;categoryDialog.querySelector('#store-category-image-preview').innerHTML=`<img class="store-photo" src="${categoryImage}" alt="Vista previa de la categoría">`;}
    catch(err){if(!e.target.isConnected)return;categoryImage=null;categoryDialog.querySelector('[role=alert]').textContent=err.message;categoryDialog.querySelector('#store-category-image-preview').textContent='Imagen opcional';e.target.value='';}finally{button.disabled=false;}
  });
  categoryDialog.addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');button.disabled=true;form.querySelector('[role=alert]').textContent='';const generation=epoch;
    try{
      const result=await request('categories',{name:form.elements.name.value,...(categoryImage?{image:categoryImage}:{})});if(generation!==epoch)return;
      if(!categoryRows.some(c=>c.id===result.category.id))categoryRows.push(result.category);
      const select=dialog.querySelector('[name=category_id]');if(select)select.innerHTML=categoryOptions(result.category.id);
      categoryDialog.close();if(filterDrawer.open)openFilters();await load();
    }catch(err){form.querySelector('[role=alert]').textContent=err.message;}finally{button.disabled=false;}
  });
  let editing=null,imageData=null;
  function edit(id) {
    editing=products.find(p=>p.id===id)||null;imageData=null;const p=editing||{};
    dialog.innerHTML=`<form id="store-product-form"><div class="store-toolbar"><h2>${editing?'Editar artículo':'Crear producto o servicio'}</h2><button type="button" class="store-icon-button" data-store-close aria-label="Cerrar formulario">${svg('close')}</button></div><div class="store-form-body">
    <label class="field"><span class="field__label">Tipo</span><select class="field__select" name="kind" ${editing?'disabled':''}><option value="product">Producto</option><option value="service">Servicio</option></select></label>
    <label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" value="${esc(p.name)}" maxlength="160" required></label>
    <div class="store-form-grid"><label class="field"><span class="field__label">Código / SKU</span><input class="field__input" name="sku" value="${esc(p.sku)}" maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required placeholder="Ej. CAM-001"></label>
    <div class="field"><label class="field__label" for="store-product-category">Categoría</label><div class="store-category-input"><select class="field__select" name="category_id" id="store-product-category">${categoryOptions(p.category_id||categoryRows.find(c=>c.name===p.category)?.id||'')}</select><button class="store-icon-button" type="button" data-category-new aria-label="Agregar categoría">${svg('plus')}</button></div></div></div>

    <label class="field"><span class="field__label">Descripción</span><textarea class="field__input" name="description" maxlength="2000">${esc(p.description)}</textarea></label>
    <label class="field"><span class="field__label">Imagen del producto</span><input class="field__input" name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <div id="store-image-preview">${p.image_url?photo(p):''}</div><p id="store-image-help"></p>
    <div class="store-form-grid"><label class="field"><span class="field__label">Precio de venta (RD$)</span><input class="field__input" name="price" type="number" min="0" step="0.01" required value="${p.price_cents!==undefined?(p.price_cents/100).toFixed(2):''}"></label>
    <label class="field"><span class="field__label">${p.legacy?'Costo por cápsulas (RD$)':'Costo unitario (RD$)'}</span><input class="field__input" name="cost" type="number" min="0" step="0.01" required ${p.legacy?'readonly':''} value="${p.cost_cents!==undefined?(p.cost_cents/100).toFixed(2):''}"></label></div>
    ${!editing?'<label class="field" data-stock-field><span class="field__label">Cantidad inicial</span><input class="field__input" name="quantity" type="number" min="0" step="1" value="0" required></label>':''}
    ${!p.legacy?`<label class="field" data-stock-field><span class="field__label">Stock mínimo</span><input class="field__input" name="min_stock" type="number" min="0" step="1" value="${p.min_stock||0}" required></label>`:'<p>El costo y las cápsulas se administran desde Inventario → Gestionar cápsulas.</p>'}
    <label class="store-check"><input name="active" type="checkbox" ${p.active!==false?'checked':''}> Disponible para nuevas ventas</label>
    <p class="store-form-error" role="alert"></p></div><div class="store-form-footer"><button class="btn btn--primary btn--block" type="submit">Guardar artículo</button></div></form>`;
    dialog.querySelector('[name=kind]').value=p.kind||'product';toggleKind();dialog.showModal();
  }
  function toggleKind(){const service=dialog.querySelector('[name=kind]')?.value==='service';dialog.querySelectorAll('[data-stock-field]').forEach(e=>e.hidden=service);dialog.querySelector('#store-image-help').textContent=service?'La imagen es opcional para servicios.':'Selecciona una imagen. Obligatoria para productos.';}
  async function imageFile(file) {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024)throw new Error('Selecciona una imagen JPG, PNG o WebP de hasta 12 MB.');
    const url=URL.createObjectURL(file);
    try{
      const img=new Image();img.src=url;await img.decode();
      const scale=Math.min(1,1200/Math.max(img.width,img.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',0.82);if(data.length>1400000)throw new Error('La imagen sigue siendo muy grande. Elige una más pequeña.');return data;
    }finally{URL.revokeObjectURL(url);}
  }
  dialog.addEventListener('change',async e=>{
    if(e.target.name==='kind')toggleKind();
    if(e.target.name==='image'&&e.target.files[0]) {
      const button=dialog.querySelector('[type=submit]');button.disabled=true;const error=dialog.querySelector('[role=alert]');error.textContent='';
      try {const data=await imageFile(e.target.files[0]);if(!dialog.open||!e.target.isConnected)return;imageData=data;document.getElementById('store-image-preview').innerHTML=`<img src="${imageData}" alt="Vista previa de la imagen" class="store-photo">`;}
      catch(err){if(!e.target.isConnected)return;imageData=null;error.textContent=err.message;document.getElementById('store-image-preview').innerHTML=editing?.image_url?photo(editing):'';e.target.value='';}finally{button.disabled=false;}
    }
  });
  dialog.addEventListener('click',e=>{if(e.target.closest('[data-store-close]'))dialog.close();if(e.target.closest('[data-category-new]'))openCategory();});
  dialog.addEventListener('submit',async e=>{
    if(e.target.id!=='store-product-form')return;e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');
    button.disabled=true;form.querySelector('[role=alert]').textContent='';
    const data=Object.fromEntries(new FormData(form));data.kind=editing?.kind||data.kind;data.active=form.elements.active.checked;
    delete data.image;if(imageData)data.image=imageData;if(editing)data.version=editing.version;
    try {await request(`products${editing?'/'+encodeURIComponent(editing.id):''}`,data,editing?'PATCH':'POST');dialog.close();await load(true);notice('Artículo guardado.');}
    catch(err){form.querySelector('[role=alert]').textContent=err.message;}finally{button.disabled=false;}
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('#view-catalogo,#view-inventario,#view-recuento'))return;
    const link=e.target.closest('[data-store-detail]');
    if(link&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.button===0){e.preventDefault();navigateProduct(link.dataset.storeDetail||null);return;}
    if(e.target.closest('[data-store-filters]')){openFilters();return;}
    const layoutButton=e.target.closest('[data-store-layout]');if(layoutButton){layout=layoutButton.dataset.storeLayout;try{localStorage.setItem('fulltech.catalog.layout',layout);}catch{}render();document.querySelector(`[data-store-layout="${layout}"]`)?.focus({preventScroll:true});return;}
    if(e.target.closest('[data-store-clear]')){query='';kind='all';category='';render();return;}
    if(e.target.closest('[data-store-new]'))edit();
    const editButton=e.target.closest('[data-store-edit]');if(editButton)edit(editButton.dataset.storeEdit);
  });
  document.addEventListener('input',e=>{if(e.target.id==='store-search'){query=e.target.value;cards();}if(e.target.closest('#store-stock-form'))updateCount();});
  document.addEventListener('change',e=>{if(e.target.id==='store-kind'){kind=e.target.value;cards();}if(e.target.closest('#store-stock-form')){if(e.target.name==='productId'){delete e.target.form.dataset.expected;delete e.target.form.dataset.requestId;}updateCount();}});
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='store-stock-form')return;e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');button.disabled=true;
    const data=Object.fromEntries(new FormData(form));const p=products.find(p=>p.id===data.productId);
    data.type=form.dataset.count==='true'?'count':data.type;data.expected=Number(form.dataset.expected??p.quantity);
    form.dataset.requestId ||= crypto.randomUUID();data.requestId=form.dataset.requestId;
    try{await request(`products/${encodeURIComponent(p.id)}/stock`,data);form.reset();delete form.dataset.expected;delete form.dataset.requestId;await load(true);notice('Inventario actualizado.');}
    catch(err){form.querySelector('[role=alert]').textContent=err.message;button.disabled=false;}
  });
  function stopLive(){source?.close();source=null;if(poll)clearInterval(poll);poll=null;}
  function startLive(){
    if(!pages.includes(page)||!authenticated||document.hidden)return;
    if(!source&&typeof EventSource==='function'){
      source=new EventSource('/api/admin/store/events');
      source.addEventListener('catalog.changed',()=>load());
      source.addEventListener('ready',()=>load());
    }
    // Respaldo para reconexiones, navegadores sin SSE y otras instancias del servidor.
    poll ||= setInterval(()=>{if(!document.hidden&&pages.includes(page))load();},5000);
  }
  function closeEditors(){filterDrawer.close();categoryDialog.close();dialog.close();}
  window.addEventListener('fulltech:tab',e=>{if(page!==e.detail.tab)closeEditors();page=e.detail.tab;stopLive();if(pages.includes(page)){render();load().then(startLive);}});
  window.addEventListener('fulltech:store-create',()=>{if(canManage)edit();});
  window.addEventListener('fulltech:store-filters',openFilters);
  window.addEventListener('popstate',()=>{closeEditors();if(page==='catalogo')render();});
  window.addEventListener('fulltech:back',e=>{
    if(categoryDialog.open){categoryDialog.close();e.preventDefault();}
    else if(filterDrawer.open){filterDrawer.close();e.preventDefault();}
    else if(dialog.open){dialog.close();e.preventDefault();}
    else if(page==='catalogo'&&detailId()){navigateProduct(null);e.preventDefault();}
  });
  window.addEventListener('online',()=>{if(pages.includes(page)){load().then(startLive);}});
  window.addEventListener('focus',()=>{if(pages.includes(page)&&authenticated)load();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopLive();else if(pages.includes(page)&&authenticated)load().then(startLive);});
  window.addEventListener('pagehide',stopLive);
  window.addEventListener('pageshow',()=>{if(pages.includes(page)&&authenticated)load().then(startLive);});
  window.addEventListener('phyto:calling-logout',()=>{epoch++;pending=false;authenticated=false;signature='';stopLive();products=[];categoryRows=[];movements=[];canManage=false;filterDrawer.close();categoryDialog.close();dialog.close();dialog.innerHTML='';pages.forEach(p=>{document.getElementById(`store-${p}`)?.replaceChildren();});});
  if(pages.includes(document.body.dataset.tab)){page=document.body.dataset.tab;render();load().then(startLive);}
})();
