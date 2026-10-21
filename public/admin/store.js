/* Catálogo Fulltech. Operaciones de stock en línea, con historial en el servidor. */
(() => {
  'use strict';
  /*
   * Sin documento no hay nada que pintar.
   *
   * Un sondeo (o una promesa) puede resolverse DESPUÉS de cerrar la pestaña o la
   * ventana de un UAT. Antes eso terminaba en «Cannot read properties of
   * undefined (reading 'getElementById')» dentro de un callback asíncrono, que en
   * las pruebas aparecía como excepción sin dueño.
   */
  const doc=()=>(typeof document==='undefined'||!document?null:document);
  const pages=['catalogo','inventario','recuento'];
  let page='',products=[],categoryRows=[],movements=[],canManage=false,loading=false,query='',kind='all',productType='all',epoch=0,businessGroup='';
  let category='',layout='grid',signature='',source=null,poll=null,pending=false,authenticated=false;
  try {layout=localStorage.getItem('fulltech.catalog.layout')==='list'?'list':'grid';}catch{}
  const categoryName=p=>String(p.category||'').trim().replace(/\s+/g,' ')||'Sin categoría';
  const categoryKey=p=>categoryName(p).toLocaleLowerCase('es');
  const icon=name=>({grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',arrow:'<path d="m14 7-5 5 5 5"/>',plus:'<path d="M12 5v14M5 12h14"/>',filter:'<path d="M4 7h16M7 12h10M10 17h4"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'}[name]||'');
  const svg=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icon(name)}</svg>`;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cash=c=>new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(c||0)/100);
  const root=()=>doc()?.getElementById(`store-${page}`)??null;
  /*
   * EL AVISO SOBREVIVE AL REPINTADO.
   *
   * El tiempo real (SSE) vuelve a pintar el inventario justo después de guardar
   * y borraba el mensaje: la operación se había guardado y la persona no veía
   * confirmación. El texto vive en una variable y se repone en cada render.
   */
  let stockNotice='';
  const notice=text=>{stockNotice=String(text??'');const box=doc()?.getElementById('store-notice');if(box)box.textContent=stockNotice;};
  async function request(path,body,method) {
    const generation=epoch,wasAuthenticated=authenticated,verb=method||(body?'POST':'GET');
    const r=await fetch(`/api/admin/store/${path}`,{credentials:'same-origin',cache:'no-store',
      method:verb,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(r.status===401){if(generation===epoch&&wasAuthenticated)window.dispatchEvent(new Event('fulltech:session-expired'));throw new Error('Tu sesión terminó. Vuelve a entrar.');}
    const data=await r.json();
    if(!r.ok||!data.ok)throw Object.assign(new Error(data.message||'No se pudo completar la operación. Actualiza y vuelve a intentarlo.'),{code:data.error});
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
    // La búsqueda y la categoría no van por `name` (no se envían al servidor),
    // así que se guardan aparte: si no, cada sincronía borraría el filtro.
    const stockSearch=document.getElementById('stock-search')?.value??'';
    const stockCategory=document.getElementById('stock-category')?.value??'';
    const active=document.activeElement,focusId=active?.id,focusName=form?.contains(active)?active.name:null,start=active?.selectionStart,end=active?.selectionEnd;
    render();
    const list=document.getElementById('store-product-grid');if(list)list.scrollTop=listScroll;
    const next=document.getElementById('store-stock-form');
    if(draft&&next&&draft.count===next.dataset.count){
      Object.entries(draft.values).forEach(([key,value])=>{if(next.elements[key])next.elements[key].value=value;});
      if(draft.expected!==undefined)next.dataset.expected=draft.expected;
      if(draft.requestId)next.dataset.requestId=draft.requestId;
      const search=document.getElementById('stock-search');if(search)search.value=stockSearch;
      const categorySelect=document.getElementById('stock-category');if(categorySelect)categorySelect.value=stockCategory;
    }
    const node=focusId?document.getElementById(focusId):focusName?next?.elements.namedItem(focusName):null;
    node?.focus({preventScroll:true});if(node?.setSelectionRange&&start!==null)try{node.setSelectionRange(start,end);}catch{}
  }
  function head() {return '<p id="store-notice" class="store-notice" role="status" aria-live="polite"></p>';}
  function photo(p){return p.image_url?`<img class="store-photo" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" width="96" height="96">`:'<div class="store-photo store-photo--empty" aria-label="Sin imagen">Sin imagen</div>';}
  document.addEventListener('click',event=>{const thumb=event.target.closest('[data-detail-image]');if(!thumb)return;const detail=thumb.closest('.product-details'),image=detail.querySelector('.product-summary__image img');if(image){image.src=thumb.dataset.detailImage;detail.querySelectorAll('[data-detail-image]').forEach(button=>button.setAttribute('aria-pressed',String(button===thumb)));}});
  /*
   * CÓMO SE LEE EL STOCK. «Sin control de inventario» NO es «Agotado»: un
   * artículo que se compra al proveedor cuando lo piden no tiene existencias que
   * contar, y decir que está agotado sería mentira. Se distinguen los tres casos
   * posibles: servicio, sin control de inventario y con existencias reales.
   */
  function stockLabel(p){
    if(p.kind==='service')return 'No aplica a servicios';
    if(p.track_stock===false)return 'Sin control de inventario';
    if(p.quantity===null)return 'Sin inventario inicial';
    return `${p.quantity} ${p.quantity===1?'unidad':'unidades'}${p.legacy?' disponibles':''}`;
  }
  const sinControl=(p)=>p.kind==='product'&&p.track_stock===false;
  /*
   * PROCEDENCIA DEL ARTÍCULO.
   *   own         → está en el almacén (descuenta existencias).
   *   third_party → se compra en una tienda; no descuenta stock propio.
   * Si la ficha aún no lo dice, se deduce de la política de inventario y del
   * origen: los PHYTOEMAGRY son propios por definición. Sin dato NO se inventa
   * nada más (el informe `scripts/classify-products.mjs` sirve para revisarlo).
   */
  const procedencia=(p)=>p.product_type??(p.legacy?'own':(p.track_stock===false?'third_party':'own'));
  const etiquetaProcedencia=(p)=>procedencia(p)==='third_party'?'De terceros':'Propio';
  const gruposNegocio=()=>[...new Set(products.map(p=>p.business_group).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  function cards() {
    const search=query.toLocaleLowerCase();
    const rows=products.filter(p=>(kind==='all'||p.kind===kind)&&(productType==='all'||procedencia(p)===productType)&&(!category||categoryKey(p)===category)&&(!businessGroup||p.business_group===businessGroup)&&(p.name+' '+p.sku+' '+(p.category||'')).toLocaleLowerCase().includes(search));
    const box=document.getElementById('store-product-grid');if(!box)return;
    box.dataset.layout=layout;
    box.innerHTML=rows.length?`<div class="store-items">${rows.map(p=>`<article class="store-product${p.active?'':' store-product--inactive'}" data-product-id="${esc(p.id)}">
      <a class="store-product__visual" href="/admin/?v=catalogo&amp;product=${encodeURIComponent(p.id)}" data-store-detail="${esc(p.id)}" aria-label="Ver detalle de ${esc(p.name)}">${photo(p)}${!p.active?'<span class="store-product__badge">Inactivo</span>':p.track_stock&&p.quantity===0?'<span class="store-product__badge">Agotado</span>':''}</a>
      <button type="button" class="store-product__body pos-add" data-pos-add="${esc(p.id)}" ${!p.active?'disabled':''} aria-label="Agregar ${esc(p.name)} al carrito"><h4>${esc(p.name)}</h4><strong class="store-price">${cash(p.price_cents)}</strong><span class="pos-card-plus" aria-hidden="true">${svg('plus')}</span><span class="pos-card-quantity" hidden></span></button></article>`).join('')}</div>`:'<div class="store-empty"><h3>No encontramos artículos</h3><p>Prueba otra búsqueda o categoría.</p><button class="btn btn--ghost" type="button" data-store-clear>Mostrar todos</button></div>';
    window.dispatchEvent(new Event('fulltech:pos-render'));

  }
  function detailId(){return new URLSearchParams(location.search).get('product');}
  /* Llamadas al API del panel (las tiendas no cuelgan de /store/). */
  async function apiAdmin(path,body,method='POST'){
    const r=await fetch(path,{credentials:'same-origin',cache:'no-store',method:body?method:'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.ok)throw new Error(data.message||'No se pudo completar la operación.');
    return data;
  }
  /** Vincula una tienda al producto con su costo en ESA tienda. */
  async function agregarTienda(productId){
    try{
      const {suppliers=[]}=await apiAdmin('/api/admin/suppliers');
      const activas=suppliers.filter(s=>s.active!==false);
      if(!activas.length){notice('Crea primero una tienda en Sistema → Tiendas proveedoras.');return;}
      const opciones=activas.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}${s.location_status==='pending'?' · ubicación pendiente':''}</option>`).join('');
      supplierDialog.innerHTML=`<form id="store-supplier-form" data-product="${esc(productId)}"><div class="store-toolbar"><h2>Agregar tienda</h2><button class="store-icon-button" type="button" data-supplier-close aria-label="Cerrar">${svg('close')}</button></div><div class="store-form-body"><label class="field"><span class="field__label">Tienda</span><select class="field__input" name="supplier_id" required>${opciones}</select></label><label class="field"><span class="field__label">Costo en esa tienda (opcional)</span><input class="field__input" name="cost" inputmode="decimal" placeholder="0.00"></label><label class="field"><span class="field__label">Tiempo de recogida (min, opcional)</span><input class="field__input" name="eta" type="number" min="0" step="5" inputmode="numeric"></label><label class="field"><span class="field__label">Código del proveedor (opcional)</span><input class="field__input" name="code" maxlength="80"></label><label class="field"><span class="field__label">Disponibilidad</span><select class="field__input" name="availability"><option value="unknown">Sin confirmar</option><option value="available">Confirmada hoy</option><option value="unavailable">No disponible</option></select></label><p class="store-form-error" role="alert"></p></div><div class="store-form-footer"><button class="btn btn--primary btn--block" type="submit">Guardar tienda</button></div></form>`;
      supplierDialog.showModal();
      supplierDialog.querySelector('[data-supplier-close]').addEventListener('click',()=>supplierDialog.close());
      const form=supplierDialog.querySelector('form');
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        const boton=form.querySelector('[type=submit]');boton.disabled=true;
        const campo=form.querySelector('.store-form-error');campo.textContent='';
        const datos=new FormData(form);
        const costo=String(datos.get('cost')??'').trim();
        const availability=String(datos.get('availability')||'unknown');
        const eta=String(datos.get('eta')??'').trim();
        try{
          await apiAdmin(`/api/admin/products/${encodeURIComponent(productId)}/suppliers`,{
            supplier_id:String(datos.get('supplier_id')),
            cost_cents:costo?Math.round(Number(costo)*100):null,
            pickup_eta_minutes:eta?Number(eta):null,
            supplier_code:String(datos.get('code')||''),
            availability,
            verified_at:availability==='available'?new Date().toISOString():null,
          });
          supplierDialog.close();
          await cargarTiendas(productId);
        }catch(error){campo.textContent=error.message;}finally{boton.disabled=false;}
      });
    }catch(error){notice(error.message);}
  }
  /**
   * «TIENDAS DISPONIBLES» de la ficha.
   *
   * Se pide al abrir el detalle (no viaja en el catálogo entero) y muestra el
   * costo en ESA tienda y si la disponibilidad está confirmada. Sin fecha de
   * verificación se dice «sin confirmar»: no se supone que haya unidades.
   */
  async function cargarTiendas(productId){
    const host=document.getElementById('store-suppliers');
    if(!host)return;
    const disponible={available:'Disponible',unavailable:'No disponible',unknown:'Sin confirmar'};
    try{
      const [enlaces,tiendas]=await Promise.all([apiAdmin(`/api/admin/products/${encodeURIComponent(productId)}/suppliers`),apiAdmin('/api/admin/suppliers')]);
      const links=enlaces.links||[], suppliers=(tiendas.suppliers||[]).filter(s=>s.active!==false);
      host.innerHTML=`<h3>Tiendas disponibles</h3>`+(links.length
        ?`<ul class="store-supplier-list">${links.map(l=>{const s=suppliers.find(x=>x.id===l.supplier_id);return `<li><strong>${esc(l.supplier_name||s?.name||'Tienda')}</strong><span class="store-supplier-meta">${esc(disponible[l.availability]||'Sin confirmar')}${l.cost_cents!=null?` · ${cash(l.cost_cents)}`:''}${l.pickup_eta_minutes?` · ${l.pickup_eta_minutes} min`:''}</span>${s&&s.location_status==='pending'?'<span class="store-supplier-warn">Ubicación pendiente</span>':''}${l.supplier_code?`<small>${esc(l.supplier_code)}</small>`:''}</li>`}).join('')}</ul>`
        :'<p class="store-muted">Todavía no hay tiendas para este artículo.</p>')
        +(canManage&&suppliers.length?`<button class="btn btn--ghost btn--sm" type="button" data-supplier-add="${esc(productId)}">Agregar tienda</button>`:'')
        +(canManage&&!suppliers.length?'<p class="store-muted">Crea primero una tienda en Sistema → Tiendas proveedoras.</p>':'');
    }catch(error){host.innerHTML=`<h3>Tiendas disponibles</h3><p class="store-muted">${esc(error.message)}</p>`;}
  }
  function navigateProduct(id){
    if(!id&&detailId()&&history.state?.storeProduct){history.back();return;}
    const url=new URL(location.href);url.searchParams.set('v','catalogo');if(id)url.searchParams.set('product',id);else url.searchParams.delete('product');
    history[id?'pushState':'replaceState']({storeProduct:id||null},'',url);render();
    document.querySelector('#store-detail-title,#store-search')?.focus({preventScroll:true});document.getElementById('view-catalogo')?.scrollIntoView({block:'start'});
  }
  function detail(p) {
    if(!p)return `<div class="store-empty"><h2 id="store-detail-title" tabindex="-1">Artículo no encontrado</h2><p>Puede que ya no esté disponible para tu cuenta.</p></div>`;
    const service=p.kind==='service',published=p.store_publication?.status==='published';
    const fact=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const text=(label,value)=>value?`<div class="product-description"><h3>${esc(label)}</h3><p>${esc(value)}</p></div>`:'';
    return `<article class="store-detail product-details">
      <header class="product-summary">
        <div class="product-summary__image">${photo(p)}</div>
        <div class="product-summary__identity"><h2 id="store-detail-title" tabindex="-1">${esc(p.name)}</h2><p>${esc(p.sku)} · ${service?'Servicio':'Producto'} · <span>${p.active?'Activo':'Inactivo'}</span></p></div>
        ${canManage?`<button class="btn btn--ghost btn--sm" type="button" data-store-edit="${esc(p.id)}" aria-label="Editar artículo">Editar</button>`:''}
      </header>
      ${p.images?.length>1?`<nav class="product-detail-thumbs" aria-label="Imágenes del producto">${p.images.map((entry,i)=>`<button type="button" data-detail-image="${esc(entry.url)}" aria-label="Ver imagen ${i+1}" aria-pressed="${i===0}"><img src="${esc(entry.url)}" alt="Imagen ${i+1}" width="48" height="48"></button>`).join('')}</nav>`:''}
      <dl class="store-detail-facts product-facts">
        ${fact('Precio de venta',cash(p.price_cents))}
        ${canManage?fact(service?'Costo del servicio':'Costo unitario',cash(p.cost_cents))+fact('Ganancia por unidad',cash(p.price_cents-p.cost_cents)):''}
        ${fact('Inventario',esc(stockLabel(p)))}${fact('Categoría',esc(categoryName(p)))}${fact('Procedencia',esc(etiquetaProcedencia(p)))}
        ${p.business_group?fact('Grupo de negocio',esc(p.business_group)):''}
      </dl>
      <details class="product-accordion product-detail-inventory"><summary>Inventario y acciones</summary><div class="product-accordion-body">
        ${p.kind==='product'&&!p.legacy&&!sinControl(p)?`<p class="store-muted">Stock mínimo: ${Number(p.min_stock||0)} unidades</p>`:''}
        ${p.legacy?'<p class="store-detail-note">Estas presentaciones comparten el inventario de cápsulas de Phytoemagry. El costo se administra desde Gestionar cápsulas.</p>':''}
        <div class="store-actions">${p.track_stock?`<button class="btn btn--ghost btn--sm" type="button" data-tab="${p.legacy?'productos':'inventario'}">Ver stock</button>`:''}${canManage&&!p.legacy?`<button class="btn btn--ghost btn--sm" type="button" data-store-archive="${esc(p.id)}">Archivar artículo</button>`:''}</div>
      </div></details>
      <details class="product-accordion"><summary>Descripciones y atributos</summary><div class="product-accordion-body">
        ${text('Descripción interna',p.description||'Sin descripción interna.')}${text('Marca',p.store_brand)}
      </div></details>
      <details class="product-accordion"><summary>Tienda en línea <small>${published?'Publicado':'Oculto'}</small></summary><div class="product-accordion-body">
        ${text('Nombre público',p.store_public_name)}${text('Descripción corta',p.store_short_description)}${text('Descripción pública',p.store_public_description)}
        <p class="store-muted">${({AVAILABLE_NOW:'Disponible para entrega',ON_REQUEST:'Disponible bajo pedido',UNAVAILABLE:'No disponible'})[p.store_availability]||'Disponibilidad según inventario'}${p.store_publication?.featured?' · Destacado':''}</p>
        ${canManage?`<div class="store-actions"><button class="btn btn--ghost btn--sm" type="button" data-store-publication="${esc(p.id)}" data-next-status="${published?'unpublished':'published'}" ${!published&&!p.active?'disabled':''}>${published?'Retirar de la tienda':'Publicar en FULLTECH Store'}</button><button class="btn btn--ghost btn--sm" type="button" data-store-featured="${esc(p.id)}" data-next-featured="${!p.store_publication?.featured}" ${!published?'disabled':''}>${p.store_publication?.featured?'Quitar destacado':'Destacar en inicio'}</button></div>${!p.active&&!published?'<p class="store-muted">Activa el artículo para publicarlo.</p>':''}`:''}
      </div></details>
      <details class="product-accordion"><summary>Garantía comercial</summary><div class="product-accordion-body">
        ${p.warranty_available?`<p class="store-muted">${Number(p.warranty_months||0)} meses · ${esc(({FULLTECH:'FULLTECH',manufacturer:'Fabricante',other:'Otro'})[p.warranty_provider]||'Sin proveedor indicado')}</p>${text('Cobertura',p.warranty_coverage)}${text('Exclusiones',p.warranty_exclusions)}${text('Condiciones',p.warranty_conditions)}${text('Cómo reclamar',p.warranty_claim)}${text('Nota pública',p.warranty_public_notes)}`:'<p class="store-muted">Sin garantía comercial registrada.</p>'}
        ${canManage?text('Notas internas',p.warranty_private_notes):''}
      </div></details>
      <details class="product-accordion"><summary>Tiendas disponibles</summary><div class="product-accordion-body"><section class="store-suppliers" id="store-suppliers" data-product="${esc(p.id)}"><p class="store-muted">Cargando tiendas…</p></section></div></details>
    </article>`;
  }
  function render() {
    const box=root();if(!box)return;
    const d=doc();if(!d)return;
    pages.filter(p=>p!==page).forEach(p=>d.getElementById(`store-${p}`)?.replaceChildren());
    const legacy=products.find(p=>p.legacy);
    const tracked=products.filter(p=>p.track_stock&&!p.legacy);
    if(page==='catalogo') {
      const selected=detailId();d.getElementById('view-catalogo')?.classList.toggle('store-is-detail',!!selected);
      if(selected){box.innerHTML=head()+detail(products.find(p=>p.id===selected));window.dispatchEvent(new Event('fulltech:catalog-view'));cargarTiendas(selected);return;}
      d.querySelector('#pos-search-host .store-search-line')?.remove();
      box.innerHTML=head()+`<div class="store-search-line"><label class="store-search field">${svg('search')}<span class="sr-only">Buscar producto, código o categoría</span><input class="field__input" type="search" id="store-search" placeholder="Buscar productos y servicios" value="${esc(query)}" autocomplete="off" enterkeyhint="done"></label>${canManage?`<button type="button" class="store-filter-trigger" data-store-archived aria-label="Artículos archivados" title="Archivados"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M6 7v12h12V7M9 4h6l1 3H8l1-3Z"/></svg></button>`:''}<button type="button" class="store-filter-trigger" data-store-filters aria-label="Filtros del catálogo" aria-haspopup="dialog">${svg('filter')}${category||kind!=='all'||businessGroup?'<span class="store-filter-dot"></span>':''}</button></div>
      <div id="store-product-grid"></div>${`<button class="store-fab pos-actions-fab" type="button" data-pos-actions aria-label="Acciones de facturación" title="Acciones"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`}`;
      cards();window.dispatchEvent(new Event('fulltech:catalog-view'));
    }else {
      /*
       * TRES ZONAS Y NADA MÁS: buscar arriba, el ajuste debajo y la lista al
       * final. Sin párrafos explicativos ni bloques plegables: la pantalla se
       * entiende sola y la lista es la única que se desplaza.
       */
      box.innerHTML=head()+`<div class="stock-workspace">${canManage?movementForm(page==='recuento'):'<p class="store-empty">Solo administración puede registrar ajustes y recuentos.</p>'}</div>`;
    }
    updateCount();
    // La lista de productos se pinta con el mismo filtro que haya puesto la persona.
    filterStock();
    // El aviso de la última operación se repone despuÃ©s de repintar.
    if(stockNotice){const caja=d.getElementById('store-notice');if(caja)caja.textContent=stockNotice;}
  }

  /*
   * CUÁNTO HAY INVERTIDO, GENERAL Y POR CATEGORÍA.
   *
   * Se cuenta solo lo que lleva existencias de verdad (los servicios no) y se
   * valora con el costo unitario guardado en cada artículo. Las presentaciones
   * antiguas de Phytoemagry comparten el saldo de cápsulas, así que se valoran
   * con ese saldo y su costo por cápsula: si no, el total mentiría.
   */
  function stockValue(rows) {
    let units=0,value=0;
    const byCategory=new Map(),vistos=new Set();
    for(const p of rows){
      /*
       * Las presentaciones antiguas de Phytoemagry comparten UN mismo saldo de
       * cápsulas: contarlas una por una multiplicaría el valor por siete.
       */
      const clave=p.legacy?'__capsulas__':p.id;
      if(vistos.has(clave))continue;vistos.add(clave);
      const quantity=Number(p.legacy?p.base_quantity:p.quantity)||0;
      /*
       * En las presentaciones antiguas el costo guardado es el de la PRESENTACIÓN
       * entera (costo por cápsula × cápsulas). El saldo, en cambio, está en
       * cápsulas: hay que valorarlo por unidad o el total sale multiplicado.
       */
      const cost=p.legacy?(Number(p.cost_cents)||0)/Math.max(1,Number(p.capsules)||1):Number(p.cost_cents)||0;
      const amount=Math.max(0,quantity)*Math.max(0,cost);
      units+=Math.max(0,quantity);value+=amount;
      const name=categoryName(p)||'Sin categoría';
      const entry=byCategory.get(name)??{units:0,value:0,items:0};
      entry.units+=Math.max(0,quantity);entry.value+=amount;entry.items+=1;
      byCategory.set(name,entry);
    }
    return {units,value,byCategory:[...byCategory.entries()].sort((a,b)=>b[1].value-a[1].value||a[0].localeCompare(b[0],'es'))};
  }

  function stockSummary(rows) {
    const {units,value,byCategory}=stockValue(rows);
    const share=item=>value?Math.round((item.value/value)*100):0;
    return `<section class="stock-summary" aria-label="Valor del inventario">
      <div class="stock-summary__total">
        <div><small>Invertido en inventario</small><strong>${cash(value)}</strong></div>
        <div class="stock-summary__meta"><span>${units.toLocaleString('es-DO')} unidades</span><span>${rows.length} artículos</span></div>
      </div>
      <div class="stock-summary__cats">
        <p class="stock-summary__title">Por categoría</p>
        <ul>${byCategory.map(([name,item])=>`<li><span class="stock-summary__name">${esc(name)}</span><span class="stock-summary__units">${item.units.toLocaleString('es-DO')} u.</span><strong>${cash(item.value)}</strong><span class="stock-summary__share">${share(item)}%</span></li>`).join('')||'<li><span class="stock-summary__name">Sin artículos</span></li>'}</ul>
      </div>
    </section>`;
  }

  function productStock(p) {
    return Number(p.legacy?p.base_quantity:p.quantity)||0;
  }

  function movementForm(count) {
    const rows=products.filter(p=>p.track_stock&&(!count||!p.legacy));
    const valorables=products.filter(p=>p.track_stock);
    if(!rows.length){
      // Sin artículos con control: las cifras y una salida clara, sin discursos.
      const capsulas=products.find(p=>p.legacy);
      return `<form class="stock-form store-stock-form" id="store-stock-form" data-count="${count}">
        ${count?stockSummary(valorables):''}
        <p class="stock-empty">${capsulas?`Cápsulas de Phytoemagry: <strong>${capsulas.base_quantity??0}</strong>`:'Ningún artículo lleva control de inventario.'}</p>
        <button class="btn btn--ghost btn--block" type="button" data-tab="${capsulas?'productos':'catalogo'}">${capsulas?(count?'Contar cápsulas':'Gestionar cápsulas'):'Ir al catálogo'}</button>
      </form>`;
    }
    const categorias=[...new Set(rows.map(categoryName).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
    return `<form class="stock-form store-stock-form" id="store-stock-form" data-count="${count}">
      ${count?stockSummary(valorables):''}
      <div class="stock-find">
        <input class="field__input" type="search" id="stock-search" placeholder="Buscar producto…" aria-label="Buscar producto por nombre o código" autocomplete="off" enterkeyhint="search">
        <select class="field__select" id="stock-category" aria-label="Filtrar por categoría"><option value="">Todas</option>${categorias.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
      </div>
      <div class="stock-adjust" id="stock-adjust" hidden>
        <div class="stock-selected" id="stock-selected"></div>
        <div class="stock-row2">
          ${count?'':'<label class="field"><span class="field__label">Movimiento</span><select class="field__select" name="type"><option value="in">Entrada (+)</option><option value="out">Salida (−)</option></select></label>'}
          <label class="field"><span class="field__label" id="stock-quantity-label">${count?'Contadas':'Cantidad'}</span><input class="field__input" name="quantity" type="number" min="${count?'0':'1'}" step="1" value="${count?'':'1'}" inputmode="numeric" required></label>
        </div>
        <div id="store-stock-preview" class="store-stock-preview" aria-live="polite"></div>
        <input class="field__input" name="reason" maxlength="300" aria-label="Motivo del ajuste (opcional)" placeholder="Motivo (opcional)">
        <p class="store-form-error" role="alert"></p>
        <button class="btn btn--primary btn--block" type="submit">${count?'Guardar recuento':'Guardar ajuste'}</button>
      </div>
      <div class="stock-results" id="stock-results" role="listbox" aria-label="Productos con existencias"></div>
      <select name="productId" hidden aria-hidden="true" tabindex="-1">${rows.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('')}</select>
    </form>`;
  }

  /** Una fila por producto: se toca y queda elegido (sin desplegables largos). */
  /*
   * CADA FILA, CON TODO LO QUE HACE FALTA PARA DECIDIR.
   *
   * Nombre · código · categoría · grupo de negocio, y a la derecha las
   * existencias con su valor y el mínimo. Sin abrir nada se sabe qué hay, cuánto
   * vale y si está por debajo del mínimo; el ajuste se hace tocando la fila.
   */
  function stockRow(p, selected) {
    const quantity=productStock(p), minimo=Number(p.min_stock||0);
    const low=!p.legacy&&quantity<=minimo;
    const porUnidad=p.legacy?(Number(p.cost_cents)||0)/Math.max(1,Number(p.capsules)||1):Number(p.cost_cents)||0;
    const valor=Math.max(0,quantity)*porUnidad;
    const etiqueta=p.legacy?'cáps.':'u.';
    const meta=[p.sku,categoryName(p),p.business_group].filter(Boolean).map(esc).join(' · ');
    return `<button class="stock-pick" type="button" role="option" aria-selected="${selected}" data-stock-pick="${esc(p.id)}">
      <span class="stock-pick__main">
        <span class="stock-pick__name">${esc(p.name)}</span>
        <span class="stock-pick__meta">${meta}</span>
        <span class="stock-pick__extra">${p.legacy?'Saldo compartido de cápsulas':`Mínimo ${minimo} ${etiqueta}`}${p.kind==='service'?' · Servicio':''}${p.track_stock===false?' · Sin control':''}</span>
      </span>
      <span class="stock-pick__side">
        <span class="stock-pick__qty ${low?'stock-pick__qty--low':''}">${quantity}<small>${etiqueta}</small></span>
        <span class="stock-pick__value">${cash(valor)}</span>
        ${low?'<span class="stock-pick__low">Bajo mínimo</span>':''}
      </span>
    </button>`;
  }

  function renderStockResults(rows) {
    const form=document.getElementById('store-stock-form'),box=document.getElementById('stock-results'),select=form?.elements?.productId;
    if(!form||!box||!select)return;
    const selected=select.value;
    box.innerHTML=rows.map(p=>stockRow(p,p.id===selected)).join('')||'<p class="stock-empty">Sin resultados.</p>';
    form.querySelector('[type=submit]').disabled=!rows.length;
    document.getElementById('stock-adjust').hidden=!rows.length;
  }

  function updateCount() {
    const form=document.getElementById('store-stock-form');if(!form)return;
    // Sin lista de artículos (recuento de un negocio solo de cápsulas) no hay nada que calcular aquí.
    if(!form.elements.productId)return;
    const p=products.find(p=>p.id===form.elements.productId.value);if(!p)return;
    const count=form.dataset.count==='true';
    document.getElementById('stock-quantity-label').textContent=p.legacy?'Cantidad de cápsulas':count?'Unidades contadas':'Cantidad de unidades';
    form.dataset.expected ||= String(p.quantity);
    const baseline=count?Number(form.dataset.expected):(p.legacy?p.base_quantity:p.quantity);
    const qty=form.elements.quantity.value;
    const delta=qty===''?null:count?Number(qty)-baseline:Number(qty)*(form.elements.type.value==='out'?-1:1);
    /*
     * Solo las tres cifras: registrado · ajuste · quedará. El aviso de «saldo
     * compartido» ya lo dice la ficha del artículo (costo por cápsula), así que
     * repetirlo aquí era ruido.
     */
    document.getElementById('store-stock-preview').innerHTML=`<div><small>Registrado</small><strong>${baseline}</strong></div><div><small>${count?'Diferencia':'Ajuste'}</small><strong>${delta===null?'—':(delta>0?'+':'')+delta}</strong></div><div><small>Quedará</small><strong>${delta===null?'—':baseline+delta}</strong></div>${count&&baseline!==p.quantity?'<p class="stock-warn">El stock cambió: vuelve a abrir Recuento.</p>':''}`;
    /*
     * Ficha del artículo elegido: nombre, dónde está, cuánto hay y cuánto vale.
     * Es el contexto necesario para decidir la cantidad, sin más.
     */
    const ficha=document.getElementById('stock-selected');
    if(ficha){
      const existencias=productStock(p);
      const porUnidad=p.legacy?(Number(p.cost_cents)||0)/Math.max(1,Number(p.capsules)||1):Number(p.cost_cents)||0;
      ficha.innerHTML=`<div class="stock-selected__info"><strong>${esc(p.name)}</strong><small>${esc(p.sku)} · ${esc(categoryName(p))}</small></div>
        <div class="stock-selected__facts"><div><small>Hay</small><strong>${existencias}${p.legacy?' cáps.':''}</strong></div><div><small>${p.legacy?'Costo/cáps.':'Costo'}</small><strong>${cash(porUnidad)}</strong></div><div><small>Valor</small><strong>${cash(Math.max(0,existencias)*porUnidad)}</strong></div></div>`;
    }
    const adjust=document.getElementById('stock-adjust');
    if(adjust)adjust.hidden=false;
  }
  const filterDrawer=document.createElement('dialog');filterDrawer.className='store-filter-drawer';filterDrawer.setAttribute('aria-label','Filtros del catálogo');document.body.append(filterDrawer);
  const categoryDialog=document.createElement('dialog');categoryDialog.className='store-dialog store-category-dialog';categoryDialog.setAttribute('aria-label','Nueva categoría');document.body.append(categoryDialog);
  const dialog=document.createElement('dialog');dialog.className='store-dialog store-product-dialog';dialog.setAttribute('aria-label','Producto o servicio');document.body.append(dialog);
  const supplierDialog=document.createElement('dialog');supplierDialog.className='store-dialog store-supplier-dialog';supplierDialog.setAttribute('aria-label','Agregar tienda');document.body.append(supplierDialog);
  function categoryOptions(selected='') {
    return '<option value="">Sin categoría</option>'+categoryRows.map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join('');
  }
  function openFilters(){
    const rows=new Map(categoryRows.map(c=>[categoryKey({category:c.name}),{...c,count:0}]));
    for(const p of products){const key=categoryKey(p);if(!rows.has(key))rows.set(key,{name:categoryName(p),count:0});rows.get(key).count++;}
    filterDrawer.innerHTML=`<div class="store-drawer-head"><h2>Filtros</h2><button class="store-icon-button" type="button" data-filter-close aria-label="Cerrar filtros">${svg('close')}</button></div><div class="store-drawer-body">
      <fieldset><legend>Tipo de artículo</legend><div class="store-segmented">${[['all','Todos'],['product','Productos'],['service','Servicios']].map(([value,name])=>`<label><input type="radio" name="kind" value="${value}" ${kind===value?'checked':''}><span>${name}</span></label>`).join('')}</div></fieldset>
      <fieldset><legend>Procedencia</legend><div class="store-segmented">${[['all','Todos'],['own','Propios'],['third_party','De terceros']].map(([value,name])=>`<label><input type="radio" name="productType" value="${value}" ${productType===value?'checked':''}><span>${name}</span></label>`).join('')}</div></fieldset>
      <fieldset><legend>Grupo de negocio</legend><div class="store-category-choices"><label><input type="radio" name="businessGroup" value="" ${!businessGroup?'checked':''}><span class="store-category-thumb">⊞</span><span>Todos los grupos</span><small>${products.length}</small></label>${gruposNegocio().map(g=>`<label><input type="radio" name="businessGroup" value="${esc(g)}" ${businessGroup===g?'checked':''}><span class="store-category-thumb">${esc(g[0])}</span><span>${esc(g)}</span><small>${products.filter(p=>p.business_group===g).length}</small></label>`).join('')}</div></fieldset>
      <fieldset><legend>Categoría</legend><div class="store-category-choices"><label><input type="radio" name="category" value="" ${!category?'checked':''}><span class="store-category-thumb">⊞</span><span>Todas las categorías</span><small>${products.length}</small></label>${[...rows.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,'es')).map(([key,c])=>`<label><input type="radio" name="category" value="${esc(key)}" ${category===key?'checked':''}>${c.image_url?`<img class="store-category-thumb" src="${esc(c.image_url)}" alt="">`:`<span class="store-category-thumb">${esc(c.name[0])}</span>`}<span>${esc(c.name)}</span><small>${c.count}</small></label>`).join('')}</div>${canManage?`<button type="button" class="store-text-button" data-category-new>${svg('plus')}Nueva categoría</button>`:''}</fieldset>
      <fieldset><legend>Presentación</legend><div class="store-layout-switch" role="group" aria-label="Vista del catálogo"><button type="button" data-store-layout="grid" aria-label="Vista de cuadrícula" aria-pressed="${layout==='grid'}">${svg('grid')}<span>Cuadrícula</span></button><button type="button" data-store-layout="list" aria-label="Vista de lista" aria-pressed="${layout==='list'}">${svg('list')}<span>Lista</span></button></div></fieldset></div>
      <div class="store-drawer-footer"><button class="btn btn--ghost" type="button" data-filter-reset>Restablecer</button><button class="btn btn--primary" type="button" data-filter-close>Ver resultados</button></div>`;
    if(!filterDrawer.open)filterDrawer.showModal();
  }
  filterDrawer.addEventListener('change',e=>{if(e.target.name==='kind')kind=e.target.value;if(e.target.name==='productType')productType=e.target.value;if(e.target.name==='category')category=e.target.value;if(e.target.name==='businessGroup')businessGroup=e.target.value;render();});
  filterDrawer.addEventListener('click',e=>{
    if(e.target.closest('[data-filter-close]'))filterDrawer.close();
    if(e.target.closest('[data-filter-reset]')){kind='all';productType='all';category='';businessGroup='';render();openFilters();}
    if(e.target.closest('[data-category-new]'))openCategory();
    const b=e.target.closest('[data-store-layout]');if(b){layout=b.dataset.storeLayout;try{localStorage.setItem('fulltech.catalog.layout',layout);}catch{}cards();filterDrawer.querySelectorAll('[data-store-layout]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.storeLayout===layout)));}
  });
  let categoryImage=null;
  async function openArchived(){
    dialog.innerHTML=`<div class="store-toolbar"><h2>Artículos archivados</h2><button type="button" class="store-icon-button" data-store-close aria-label="Cerrar archivados">${svg('close')}</button></div><div class="store-form-body"><p class="store-muted">Conservan su código, movimientos, pedidos y facturas. Al restaurar quedan inactivos y sin publicar.</p><div id="store-archived-list" class="store-archived-list">Cargando…</div><p class="store-form-error" role="alert"></p></div>`;
    dialog.showModal();
    try{
      const data=await request('products?archived=1');
      const rows=data.products||[];
      const host=dialog.querySelector('#store-archived-list');
      if(host)host.innerHTML=rows.length?rows.map(p=>`<div class="store-archived-row"><div><strong>${esc(p.store_public_name||p.name)}</strong><small>${esc(p.sku)} · ${esc(categoryName(p))}</small></div><button class="btn btn--ghost btn--sm" type="button" data-store-restore="${esc(p.id)}">Restaurar</button></div>`).join(''):'<p class="store-muted">No hay artículos archivados.</p>';
    }catch(error){const host=dialog.querySelector('#store-archived-list');if(host)host.innerHTML=`<p class="store-muted">${esc(error.message)}</p>`;}
  }
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
  let editing=null,productSaving=false,imageLoading=false,gallery=[],galleryDirty=false,replaceImage=null,gallerySession=0;
  function edit(id) {
    editing=products.find(p=>p.id===id)||null;productSaving=false;imageLoading=false;galleryDirty=false;replaceImage=null;gallerySession++;const p=editing||{};
    gallery=(p.images??(p.image_url?[{id:p.id,url:p.image_url}]:[])).map(e=>({...e}));
    dialog.innerHTML=`<form id="store-product-form" class="product-editor"><div class="store-toolbar"><h2 id="product-editor-title">${editing?'Editar artículo':'Crear producto'}</h2><button type="button" class="store-icon-button" data-store-close aria-label="Cerrar formulario">${svg('close')}</button></div>
    <div class="store-form-body">
      <div class="product-essential">
        <div class="store-form-grid product-type-code">
          <label class="field"><span class="field__label">Tipo</span><select class="field__select" name="kind" ${editing?'disabled':''}><option value="product">Producto</option><option value="service">Servicio</option></select></label>
          <label class="field"><span class="field__label">Código / SKU</span><input class="field__input" name="sku" value="${esc(p.sku)}" maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required placeholder="Ej. CAM-001" autocapitalize="characters" spellcheck="false"><small class="product-code-full" hidden></small></label>
        </div>
        <label class="field"><span class="field__label">Nombre</span><textarea class="field__input product-name-input" name="name" rows="1" maxlength="160" required autocomplete="off">${esc(p.name)}</textarea></label>
    <div class="store-form-grid"><label class="field"><span class="field__label">Precio de venta (RD$)</span><input class="field__input" name="price" type="number" min="0" step="0.01" required value="${p.price_cents!==undefined?(p.price_cents/100).toFixed(2):''}"></label>
    <label class="field"><span class="field__label">${p.legacy?'Costo por cápsulas (RD$)':'Costo unitario (RD$)'}</span><input class="field__input" name="cost" type="number" min="0" step="0.01" required ${p.legacy?'readonly':''} value="${p.cost_cents!==undefined?(p.cost_cents/100).toFixed(2):''}"></label></div>
        <div class="field"><label class="field__label" for="store-product-category">Categoría</label><div class="store-category-input"><select class="field__select" name="category_id" id="store-product-category">${categoryOptions(p.category_id||categoryRows.find(c=>c.name===p.category)?.id||'')}</select><button class="store-icon-button" type="button" data-category-new aria-label="Agregar categoría">${svg('plus')}</button></div></div>
    ${!editing?'<label class="field" data-stock-field><span class="field__label">Cantidad inicial</span><input class="field__input" name="quantity" type="number" min="0" step="1" value="0" required></label>':''}
        <div class="product-image-field product-gallery-editor">
          <div class="product-gallery-heading"><span class="field__label">Imágenes <small>Opcionales al guardar</small></span><span id="product-image-counter" aria-live="polite"></span></div>
          <div id="store-image-preview" class="product-image-slots"></div>
          <label class="product-image-picker"><span class="sr-only">Seleccionar imágenes</span><input name="image" type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="Seleccionar imágenes" aria-describedby="store-image-help"></label><small id="store-image-help">Hasta 3 fotos · JPG, PNG o WebP · 12 MB por archivo.</small><p id="product-image-progress" role="status" aria-live="polite"></p>
        </div>
      </div>
      <details class="product-accordion" data-product-section="information"><summary>Información adicional</summary><div class="product-accordion-body">
        <label class="field"><span class="field__label">Marca</span><input class="field__input" name="store_brand" maxlength="100" value="${esc(p.store_brand)}"></label>
        <label class="field"><span class="field__label">Descripción interna</span><textarea class="field__input" name="description" maxlength="2000" rows="2">${esc(p.description)}</textarea><small>Solo para el equipo.</small></label>
      </div></details>
      <details class="product-accordion" data-product-section="inventory" data-stock-field><summary>Configuración de inventario</summary><div class="product-accordion-body">
    ${!p.legacy?`<label class="store-check"><input name="track_stock" type="checkbox" ${p.track_stock!==false?'checked':''}> Controlar existencias <small>Si se desmarca, se vende sin control de inventario (se compra al proveedor cuando lo piden)</small></label>`:''}
    ${!p.legacy?`<label class="field" data-stock-field><span class="field__label">Stock mínimo</span><input class="field__input" name="min_stock" type="number" min="0" step="1" value="${p.min_stock||0}" required></label>`:'<p>El costo y las cápsulas se administran desde Inventario → Gestionar cápsulas.</p>'}
      </div></details>
      <details class="product-accordion" data-product-section="store"><summary>Información de la tienda</summary><div class="product-accordion-body"><div class="product-service-image-host"></div>
        <p class="product-form-note">${editing?'La edición conserva el estado de publicación.':'Se guarda oculto. Puedes publicarlo desde la ficha.'}</p>
      <label class="field"><span class="field__label">Nombre público (opcional)</span><input class="field__input" name="store_public_name" maxlength="160" value="${esc(p.store_public_name)}" placeholder="Usar el nombre del artículo"></label>
      <label class="field"><span class="field__label">Descripción corta</span><input class="field__input" name="store_short_description" maxlength="240" value="${esc(p.store_short_description)}"></label>
      <label class="field"><span class="field__label">Descripción pública (opcional)</span><textarea class="field__input" name="store_public_description" maxlength="2000">${esc(p.store_public_description)}</textarea></label>

      <label class="field"><span class="field__label">¿Se puede comprar?</span><select class="field__select" name="store_availability"><option value="AVAILABLE_NOW">Disponible para entrega</option><option value="ON_REQUEST">Disponible bajo pedido</option><option value="UNAVAILABLE">No disponible</option></select><small>Si lleva control de existencias y llega a cero, la compra se bloquea aunque esté marcado como disponible.</small></label>

      </div></details>
      <details class="product-accordion" data-product-section="warranty"><summary>Garantía comercial</summary><div class="product-accordion-body">
      <label class="store-check"><input name="warranty_available" type="checkbox" ${p.warranty_available ? 'checked' : ''}> Ofrecer garantía comercial</label>
      <div class="store-form-grid"><label class="field"><span class="field__label">Duración (meses)</span><input class="field__input" name="warranty_months" type="number" min="0" max="120" value="${Number(p.warranty_months) || 0}"></label>
      <label class="field"><span class="field__label">Quién la ofrece</span><select class="field__select" name="warranty_provider"><option value="FULLTECH">FULLTECH</option><option value="manufacturer">Fabricante</option><option value="other">Otro</option></select></label></div>
      <label class="field"><span class="field__label">Qué cubre (público)</span><textarea class="field__input" name="warranty_coverage" maxlength="1000" rows="2">${esc(p.warranty_coverage)}</textarea></label>
      <label class="field"><span class="field__label">Qué no cubre (público)</span><textarea class="field__input" name="warranty_exclusions" maxlength="1000" rows="2">${esc(p.warranty_exclusions)}</textarea></label>
      <label class="field"><span class="field__label">Condiciones (público)</span><textarea class="field__input" name="warranty_conditions" maxlength="2000" rows="3">${esc(p.warranty_conditions)}</textarea></label>
      <label class="field"><span class="field__label">Cómo reclamar (público)</span><textarea class="field__input" name="warranty_claim" maxlength="1000" rows="2">${esc(p.warranty_claim)}</textarea></label>
      <label class="field"><span class="field__label">Nota pública breve</span><input class="field__input" name="warranty_public_notes" maxlength="500" value="${esc(p.warranty_public_notes)}"></label>
      <label class="field"><span class="field__label">Notas internas (no se publican)</span><textarea class="field__input" name="warranty_private_notes" maxlength="1000" rows="2">${esc(p.warranty_private_notes)}</textarea></label>

      </div></details>
      <details class="product-accordion" data-product-section="settings"><summary>Configuración adicional</summary><div class="product-accordion-body">
        <label class="store-check"><input name="active" type="checkbox" ${p.active!==false?'checked':''}> Disponible para nuevas ventas</label>
      </div></details>
    </div><div class="store-form-footer"><p class="store-form-error" role="alert" aria-live="polite"></p><button class="btn btn--primary btn--block" type="submit">Guardar producto</button></div></form>`;
    dialog.querySelector('[name=kind]').value=p.kind||'product';toggleKind();renderGallery();dialog.showModal();syncProductViewport();sizeProductName();window.requestAnimationFrame?.(sizeProductName);
    const availabilitySelect=dialog.querySelector('[name=store_availability]');if(availabilitySelect)availabilitySelect.value=p.store_availability||(p.track_stock===false?'ON_REQUEST':'AVAILABLE_NOW');
    const providerSelect=dialog.querySelector('[name=warranty_provider]');if(providerSelect)providerSelect.value=p.warranty_provider||'FULLTECH';
  }
  function toggleKind(){
    const form=dialog.querySelector('#store-product-form');if(!form)return;
    const service=form.elements.kind.value==='service';
    const tracked=!service&&(editing?.legacy||form.elements.track_stock?.checked!==false);
    form.querySelectorAll('[data-stock-field]').forEach(node=>{node.hidden=service;});
    for(const name of ['quantity','min_stock']){
      const input=form.elements[name];if(!input)continue;
      input.disabled=!tracked;input.closest('.field').hidden=!tracked;
    }
    if(form.elements.track_stock)form.elements.track_stock.disabled=service;
    form.elements.image.required=false;
    form.querySelector('[type=submit]').textContent=`Guardar ${service?'servicio':'producto'}`;
    form.querySelector('#product-editor-title').textContent=editing?`Editar ${service?'servicio':'producto'}`:`Crear ${service?'servicio':'producto'}`;
    if(!editing?.legacy)form.elements.cost.closest('.field').querySelector('.field__label').textContent=service?'Costo del servicio (RD$)':'Costo unitario (RD$)';
  }
  function renderGallery(){
    const host=dialog.querySelector('#store-image-preview');if(!host)return;
    dialog.querySelector('#product-image-counter').textContent=`${gallery.length}/3`;
    host.innerHTML=Array.from({length:3},(_,i)=>{const entry=gallery[i];return entry?`<div class="product-image-slot ${i===0?'is-primary':''}"><img src="${esc(entry.data||entry.url)}" alt="${i===0?'Imagen principal':`Imagen ${i+1}`}" width="100" height="88"><span class="product-image-tag">${i===0?'Principal':`Foto ${i+1}`}</span><div class="product-image-tools"><button type="button" data-gallery-replace="${i}" aria-label="Reemplazar imagen ${i+1}" title="Reemplazar">↻</button>${i?`<button type="button" data-gallery-primary="${i}" aria-label="Usar imagen ${i+1} como principal" title="Usar como principal">☆</button><button type="button" data-gallery-move="${i}" aria-label="Mover imagen ${i+1} a la izquierda" title="Mover a la izquierda">←</button>`:''}<button type="button" data-gallery-remove="${i}" aria-label="Quitar imagen ${i+1}" title="Quitar">×</button></div></div>`:`<button type="button" class="product-image-slot product-image-add" data-gallery-add ${imageLoading||productSaving?'disabled':''} aria-label="Agregar imagen ${i+1}"><span>＋</span><small>${i===0?'Agregar foto':'Opcional'}</small></button>`;}).join('');
    host.querySelectorAll('button').forEach(button=>{button.disabled=imageLoading||productSaving;});
    dialog.querySelector('[name=image]').disabled=imageLoading||productSaving||gallery.length===3&&replaceImage===null;
  }
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-gallery-add],[data-gallery-replace],[data-gallery-primary],[data-gallery-move],[data-gallery-remove]');if(!action||imageLoading||productSaving)return;
    const input=dialog.querySelector('[name=image]'),error=dialog.querySelector('[role=alert]');error.textContent='';
    if(action.hasAttribute('data-gallery-add')||action.hasAttribute('data-gallery-replace')){
      replaceImage=action.hasAttribute('data-gallery-replace')?Number(action.dataset.galleryReplace):null;
      input.disabled=false;input.multiple=replaceImage===null;input.value='';input.click();return;
    }
    const index=Number(action.dataset.galleryRemove??action.dataset.galleryPrimary??action.dataset.galleryMove);
    if(action.hasAttribute('data-gallery-remove')){
      if(gallery.length===1&&editing?.store_publication?.status==='published'){error.textContent='Retira primero el artículo de la tienda para quitar la última imagen.';return;}
      gallery.splice(index,1);
    }else{const entry=gallery.splice(index,1)[0];gallery.splice(action.hasAttribute('data-gallery-primary')?0:index-1,0,entry);}
    galleryDirty=true;replaceImage=null;renderGallery();
  });
  function sizeProductName(){
    const field=dialog.querySelector('.product-name-input');if(field){field.style.height='auto';field.style.height=`${Math.max(42,field.scrollHeight+4)}px`;}
    const code=dialog.querySelector('[name=sku]'),row=dialog.querySelector('.product-type-code'),preview=dialog.querySelector('.product-code-full');
    if(code&&row){row.dataset.longCode=String(code.value.length>18);if(preview){preview.textContent=code.value;preview.hidden=code.value.length<=38;}}
  }
  dialog.addEventListener('input',event=>{if(event.target.classList.contains('product-name-input')||event.target.name==='sku')sizeProductName();});
  function syncProductViewport(){
    if(!dialog.open)return;
    sizeProductName();
    const viewport=window.visualViewport;
    if(viewport&&window.matchMedia?.('(max-width:640px)').matches){
      dialog.style.setProperty('--product-editor-height',`${viewport.height}px`);
      dialog.style.setProperty('--product-editor-top',`${viewport.offsetTop}px`);
    }else{
      dialog.style.removeProperty('--product-editor-height');dialog.style.removeProperty('--product-editor-top');
    }
  }
  window.visualViewport?.addEventListener('resize',syncProductViewport);
  window.visualViewport?.addEventListener('scroll',syncProductViewport);
  window.addEventListener('resize',syncProductViewport);
  function revealProductField(field){
    if(!field)return;
    let parent=field.parentElement;
    while(parent&&parent!==dialog){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}
    field.focus({preventScroll:true});field.scrollIntoView?.({block:'nearest'});
  }
  dialog.addEventListener('invalid',event=>revealProductField(event.target),true);
  async function imageFile(file) {
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024)throw new Error('Selecciona una imagen JPG, PNG o WebP de hasta 12 MB.');
    const url=URL.createObjectURL(file);
    try{
      const img=new Image();img.src=url;await img.decode();
      const scale=Math.min(1,1200/Math.max(img.width,img.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const data=canvas.toDataURL('image/jpeg',0.82);if(data.length>1350000)throw new Error('La imagen sigue siendo muy grande. Elige una más pequeña.');return data;
    }finally{URL.revokeObjectURL(url);}
  }
  dialog.addEventListener('change',async e=>{
    if(e.target.name==='kind'||e.target.name==='track_stock')toggleKind();
    if(e.target.name==='image'&&e.target.files[0]) {
      if(imageLoading||productSaving)return;
      const button=dialog.querySelector('[type=submit]'),files=[...e.target.files],session=gallerySession,target=replaceImage,progress=dialog.querySelector('#product-image-progress');imageLoading=true;button.disabled=true;renderGallery();const error=dialog.querySelector('[role=alert]');error.textContent='';
      try {
        if(files.length>(target===null?3-gallery.length:1))throw new Error('Puedes guardar un máximo de 3 imágenes.');
        const additions=[];
        for(let i=0;i<files.length;i++){progress.textContent=`Preparando imagen ${i+1} de ${files.length}…`;const data=await imageFile(files[i]);if(additions.some(e=>e.data===data)||gallery.some((e,j)=>j!==target&&e.data===data))throw new Error('Esta imagen ya está seleccionada.');additions.push({data});}
        if(!dialog.open||session!==gallerySession)return;
        if(target===null)gallery.push(...additions);else gallery.splice(target,1,...additions);
        galleryDirty=true;
      }catch(err){if(session===gallerySession)error.textContent=err.message;}
      finally{if(session===gallerySession){imageLoading=false;replaceImage=null;progress.textContent='';e.target.value='';button.disabled=productSaving;renderGallery();}}
    }
  });
  dialog.addEventListener('cancel',event=>{if(event.target.name==='image'){replaceImage=null;renderGallery();}},true);
  dialog.addEventListener('click',e=>{if(e.target.closest('[data-store-close]'))dialog.close();if(e.target.closest('[data-category-new]'))openCategory();const restoreButton=e.target.closest('[data-store-restore]');if(restoreButton){restoreButton.disabled=true;const error=dialog.querySelector('[role=alert]');if(error)error.textContent='';request(`products/${encodeURIComponent(restoreButton.dataset.storeRestore)}/restore`,undefined,'POST').then(async()=>{await load(true);await openArchived();notice('Artículo restaurado. Actívalo y publícalo cuando corresponda.');}).catch(err=>{restoreButton.disabled=false;if(error)error.textContent=err.message;});}})
  dialog.addEventListener('submit',async e=>{
    if(e.target.id!=='store-product-form')return;
    e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');
    if(productSaving||imageLoading)return;
    if(!form.checkValidity()){form.reportValidity();return;}
    productSaving=true;button.disabled=true;button.textContent='Guardando…';button.setAttribute('aria-busy','true');form.querySelector('[role=alert]').textContent='';
    const data=Object.fromEntries(new FormData(form));data.kind=editing?.kind||data.kind;data.active=form.elements.active.checked;
    if(form.elements.track_stock)data.track_stock=data.kind==='product'&&form.elements.track_stock.checked;
    data.warranty_available=form.elements.warranty_available.checked;
    delete data.image;if(galleryDirty)data.images=gallery.map(entry=>entry.data?{data:entry.data}:{id:entry.id});if(editing)data.version=editing.version;
    try {await request(`products${editing?'/'+encodeURIComponent(editing.id):''}`,data,editing?'PATCH':'POST');dialog.close();await load(true);notice(`${data.kind==='service'?'Servicio':'Producto'} guardado.`);}
    catch(err){
      form.querySelector('[role=alert]').textContent=err.message;
      const field={duplicate_sku:'sku',invalid_product:'sku',category_not_found:'category_id',invalid_quantity:'min_stock',policy_locked:'track_stock',invalid_money:'price'}[err.code];
      if(['image_required','invalid_image','image_limit'].includes(err.code))revealProductField(form.querySelector('.product-image-slots button'));
      else if(field)revealProductField(form.elements[field]);
    }finally{productSaving=false;button.disabled=imageLoading;button.removeAttribute('aria-busy');button.textContent=`Guardar ${data.kind==='service'?'servicio':'producto'}`;}
  });
  document.addEventListener('click',e=>{
    // La barra de búsqueda del catálogo se mueve a la cabecera del POS
    // (`#pos-search-host`), que está FUERA de las vistas: si no se incluye,
    // el botón «Filtros» no abría nada cuando el catálogo va con el POS.
    if(!e.target.closest('#view-catalogo,#view-inventario,#view-recuento,#pos-search-host'))return;
    const stockPick=e.target.closest('[data-stock-pick]');
    if(stockPick){
      const form=document.getElementById('store-stock-form');
      if(form){
        form.elements.productId.value=stockPick.dataset.stockPick;
        delete form.dataset.expected;delete form.dataset.requestId;
        document.querySelectorAll('[data-stock-pick]').forEach(n=>n.setAttribute('aria-selected',String(n===stockPick)));
        updateCount();
        form.elements.quantity?.focus({preventScroll:true});
      }
      return;
    }
    const link=e.target.closest('[data-store-detail]');
    if(link&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&e.button===0){e.preventDefault();navigateProduct(link.dataset.storeDetail||null);return;}
    const archiveButton=e.target.closest('[data-store-archive]');
    if(archiveButton){
      if(!window.confirm('¿Archivar este artículo? Dejará de venderse y desaparecerá de la tienda, pero sus pedidos, facturas e historial de inventario se conservan.'))return;
      const id=archiveButton.dataset.storeArchive;archiveButton.disabled=true;
      request(`products/${encodeURIComponent(id)}`,undefined,'DELETE')
        .then(async()=>{await load(true);if(detailId()===id)navigateProduct(null);notice('Artículo archivado. Su historial se conserva.');})
        .catch(error=>{archiveButton.disabled=false;notice(error.message);});
      return;
    }
    const publicationButton=e.target.closest('[data-store-publication]');
    if(publicationButton){
      publicationButton.disabled=true;
      request(`products/${encodeURIComponent(publicationButton.dataset.storePublication)}/publication`,{status:publicationButton.dataset.nextStatus,featured:Boolean(products.find(p=>p.id===publicationButton.dataset.storePublication)?.store_publication?.featured),sort_order:Number(products.find(p=>p.id===publicationButton.dataset.storePublication)?.store_publication?.sort_order||0)})
        .then(async()=>{await load(true);notice(publicationButton.dataset.nextStatus==='published'?'Artículo publicado en FULLTECH Store.':'Artículo retirado de FULLTECH Store.');})
        .catch(error=>{publicationButton.disabled=false;notice(error.message);});
      return;
    }
    const featuredButton=e.target.closest('[data-store-featured]');
    if(featuredButton){
      featuredButton.disabled=true;
      const publication=products.find(p=>p.id===featuredButton.dataset.storeFeatured)?.store_publication||{};
      request(`products/${encodeURIComponent(featuredButton.dataset.storeFeatured)}/publication`,{status:publication.status,featured:featuredButton.dataset.nextFeatured==='true',sort_order:Number(publication.sort_order||0)})
        .then(async()=>{await load(true);notice(featuredButton.dataset.nextFeatured==='true'?'Artículo destacado en FULLTECH Store.':'Se quitó de los destacados.');})
        .catch(error=>{featuredButton.disabled=false;notice(error.message);});
      return;
    }
    if(e.target.closest('[data-store-filters]')){openFilters();return;}
    const layoutButton=e.target.closest('[data-store-layout]');if(layoutButton){layout=layoutButton.dataset.storeLayout;try{localStorage.setItem('fulltech.catalog.layout',layout);}catch{}render();document.querySelector(`[data-store-layout="${layout}"]`)?.focus({preventScroll:true});return;}
    if(e.target.closest('[data-store-clear]')){query='';kind='all';productType='all';category='';businessGroup='';render();return;}
    const addSupplier=e.target.closest('[data-supplier-add]');
    if(addSupplier){agregarTienda(addSupplier.dataset.supplierAdd);return;}
    if(e.target.closest('[data-store-archived]')){openArchived();return;}
    if(e.target.closest('[data-store-new]'))edit();
    const editButton=e.target.closest('[data-store-edit]');if(editButton)edit(editButton.dataset.storeEdit);
  });
  document.addEventListener('input',e=>{if(e.target.id==='store-search'){query=e.target.value;cards();}if(e.target.id==='stock-search')filterStock();if(e.target.closest('#store-stock-form')&&e.target.id!=='stock-search')updateCount();});
  /*
   * TECLADO MÓVIL: la acción «Listo» solo CIERRA el teclado. No cobra, no
   * guarda y no cambia de pantalla; los resultados ya se filtran al escribir.
   */
  document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='store-search'){e.preventDefault();e.target.blur();}});
  document.addEventListener('change',e=>{if(e.target.id==='store-kind'){kind=e.target.value;cards();}if(e.target.closest('#store-stock-form')){if(e.target.name==='productId'){delete e.target.form.dataset.expected;delete e.target.form.dataset.requestId;}updateCount();}});
  function filterStock(){
    const form=document.getElementById('store-stock-form');if(!form)return;
    // El recuento de un negocio que solo vende cápsulas no lleva lista de artículos.
    if(!form.elements.productId)return;
    const q=(document.getElementById('stock-search')?.value??'').trim().toLocaleLowerCase('es'),category=document.getElementById('stock-category')?.value??'',select=form.elements.productId,previous=select.value;
    const rows=products.filter(p=>p.track_stock&&(form.dataset.count!=='true'||!p.legacy)&&(!category||categoryName(p)===category)&&`${p.name} ${p.sku} ${categoryName(p)}`.toLocaleLowerCase('es').includes(q));
    select.innerHTML=rows.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('')||'<option value="">Sin resultados</option>';
    // El primero queda elegido: se ve el saldo sin tener que abrir nada.
    if(!rows.some(p=>p.id===select.value))select.value=rows.length?rows[0].id:'';
    if(select.value!==previous){delete form.dataset.expected;delete form.dataset.requestId;}
    renderStockResults(rows);
    updateCount();
  }
  // El buscador y la categoría van juntos: uno filtra la lista, el otro la acota.
  document.addEventListener('change',e=>{if(e.target.id==='stock-category')filterStock();});
  /*
   * UNA ESCRITURA DE INVENTARIO TIENE TRES RESULTADOS, Y SE DICEN TAL CUAL:
   *
   *   confirmado  → el servidor lo aceptó (200 sin `pending`);
   *   pendiente   → se guardó en el dispositivo y subirá al reconectar (la capa
   *                 offline devuelve `pending:true`);
   *   rechazado   → NO se aplicó, con el motivo real (permisos, conflicto, stock).
   *
   * Nunca un «No se pudo guardar» genérico cuando en realidad se perdió la
   * conexión, y nunca un «Guardado» cuando solo está en la cola.
   */
  function stockRejectionMessage(status, data) {
    const code = String(data?.error ?? '');
    if (code === 'stale_count') return 'Otro usuario cambió el stock mientras contabas. Actualiza y vuelve a contar.';
    if (code === 'insufficient_stock') return data?.message || 'No hay existencias suficientes para esa salida.';
    if (status === 403) return data?.message || 'Tu cuenta no puede cambiar el inventario.';
    if (status === 409) return data?.message || 'El stock cambió mientras guardabas. Actualiza y vuelve a intentarlo.';
    if (status === 422) return data?.message || 'Revisa la cantidad: no es válida.';
    if (status === 429) return 'Demasiados intentos seguidos. Espera unos segundos y reintenta.';
    if (status >= 500) return 'El servidor falló al guardar. El cambio NO se aplicó; vuelve a intentarlo.';
    return data?.message || 'El cambio no se aplicó. Revisa el motivo e inténtalo otra vez.';
  }
  async function writeStock(path, body) {
    const generation = epoch, wasAuthenticated = authenticated;
    let response;
    try {
      response = await fetch(`/api/admin/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      // `fetch` rechazado = no hubo respuesta. Se distingue de un rechazo del servidor.
      return navigator.onLine === false
        ? { kind: 'offline', message: 'Sin conexión: el cambio no se envió. Reintenta cuando tengas internet.' }
        : { kind: 'network', message: 'No se pudo conectar con el servidor (sin respuesta). El cambio NO se aplicó.' };
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      if (generation === epoch && wasAuthenticated) window.dispatchEvent(new Event('fulltech:session-expired'));
      return { kind: 'rejected', status: 401, message: 'Tu sesión terminó. Vuelve a entrar y repite el ajuste.' };
    }
    if (!response.ok || data.ok === false) return { kind: 'rejected', status: response.status, message: stockRejectionMessage(response.status, data) };
    // `x-fulltech-local` = lo contestó la cola del dispositivo, no el servidor.
    const pending = data.pending === true || data.offline === true || response.headers.get('x-fulltech-local') === '1';
    return { kind: pending ? 'pending' : 'confirmed', data };
  }
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='store-stock-form')return;e.preventDefault();
    const form=e.target,button=form.querySelector('[type=submit]'),alertBox=form.querySelector('[role=alert]');
    button.disabled=true;if(alertBox)alertBox.textContent='';notice('');
    const data=Object.fromEntries(new FormData(form));const p=products.find(p=>p.id===data.productId);
    const count=form.dataset.count==='true';
    data.type=count?'count':(data.type||'in');
    data.expected=Number(form.dataset.expected??productStock(p));
    form.dataset.requestId ||= crypto.randomUUID();
    const requestId=form.dataset.requestId;
    try{
      if(!p)throw new Error('Selecciona un producto.');
      /*
       * EL RECUENTO VA POR SU PROPIA RUTA. `/inventory/adjust` solo entiende
       * in/out: mandarle un recuento lo habría convertido en una ENTRADA (contar
       * 120 cápsulas cuando había 100 sumaba 120). Con `/inventory/count` se FIJA
       * el valor contado. Hoy el formulario de recuento no ofrece las cápsulas
       * legacy, pero el camino queda correcto y probado.
       */
      const result = p.legacy
        ? await writeStock(count?'inventory/count':'inventory/adjust', count?{countedQuantity:Number(data.quantity),reason:data.reason,idempotencyKey:requestId}:{direction:data.type,quantity:Number(data.quantity),reason:data.reason,idempotencyKey:requestId})
        : await writeStock(`store/products/${encodeURIComponent(p.id)}/stock`, {type:data.type,quantity:Number(data.quantity),expected:data.expected,reason:data.reason,requestId});
      if(result.kind==='rejected'){if(alertBox)alertBox.textContent=result.message;button.disabled=false;return;}
      form.reset();delete form.dataset.expected;delete form.dataset.requestId;
      await load(true);
      notice(result.kind==='pending'
        ? 'Guardado en el dispositivo · pendiente de sincronizar.'
        : 'Inventario actualizado.');
    }
    catch(err){
      if(alertBox)alertBox.textContent=err?.message||'El cambio no se aplicó.';
      button.disabled=false;
    }
  });
  function stopLive(){source?.close();source=null;if(poll)clearInterval(poll);poll=null;}
  function startLive(){
    if(!pages.includes(page)||!authenticated||!window.document||document.hidden)return;
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

