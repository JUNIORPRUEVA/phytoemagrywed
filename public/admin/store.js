/* Catálogo Fulltech. Operaciones de stock en línea, con historial en el servidor. */
(() => {
  'use strict';
  const pages=['catalogo','inventario','recuento'];
  let page='',products=[],movements=[],canManage=false,loading=false,query='',kind='all',epoch=0;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cash=c=>new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(c||0)/100);
  const root=()=>document.getElementById(`store-${page}`);
  const notice=text=>{const box=document.getElementById('store-notice');if(box)box.textContent=text;};
  async function request(path,body,method='POST') {
    if(body&&!navigator.onLine)throw new Error('Conéctate a internet para guardar productos o movimientos de stock.');
    const r=await fetch(`/api/admin/store/${path}`,{credentials:'same-origin',cache:'no-store',
      method:body?method:'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json();
    if(!r.ok||!data.ok)throw new Error(data.message||'No se pudo completar la operación. Actualiza y vuelve a intentarlo.');
    return data;
  }
  async function load() {
    if(loading)return;loading=true;const generation=epoch;
    try { const data=await request('products');if(generation!==epoch)return;
      products=data.products;movements=data.movements;canManage=data.canManage;render();
    }catch(e){notice(e.message);}finally{loading=false;}
  }
  function head() {return `<div class="store-toolbar"><p>Catálogo de la tienda Fulltech</p><button type="button" class="btn btn--ghost" data-store-refresh>Actualizar</button></div><p id="store-notice" role="status" aria-live="polite"></p>`;}
  function photo(p){return p.image_url?`<img class="store-photo" src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" width="96" height="96">`:'<div class="store-photo store-photo--empty" aria-label="Servicio">Servicio</div>';}
  function stockLabel(p){return p.kind==='service'?'Sin stock':p.quantity===null?'Sin inventario inicial':`${p.quantity} ${p.quantity===1?'unidad':'unidades'}${p.legacy?' disponibles':''}`;}
  function cards() {
    const search=query.toLocaleLowerCase();
    const rows=products.filter(p=>(kind==='all'||p.kind===kind)&&(p.name+' '+p.sku+' '+p.category).toLocaleLowerCase().includes(search));
    const box=document.getElementById('store-product-grid');if(!box)return;
    box.innerHTML=rows.map(p=>`<article class="card store-product${p.active?'':' store-product--inactive'}">
      ${photo(p)}<div class="store-product__body"><span class="store-tag">${p.kind==='service'?'Servicio':'Producto'}${!p.active?' · Inactivo':''}</span>
      <h3>${esc(p.name)}</h3><p class="store-muted">${esc(p.sku)}${p.category?' · '+esc(p.category):''}</p>
      <strong class="store-price">${cash(p.price_cents)}</strong>
      ${canManage?`<p>Costo: ${cash(p.cost_cents)}</p>`:''}<p>${esc(stockLabel(p))}</p>
      ${p.legacy?'<small>Comparte el inventario de cápsulas de Phytoemagry.</small>':''}
      ${canManage?`<button type="button" class="btn btn--ghost" data-store-edit="${esc(p.id)}">Editar</button>`:''}</div></article>`).join('')||'<div class="card"><p>No hay artículos que coincidan con la búsqueda.</p></div>';
  }
  function render() {
    const box=root();if(!box)return;
    pages.filter(p=>p!==page).forEach(p=>document.getElementById(`store-${p}`)?.replaceChildren());
    const legacy=products.find(p=>p.legacy);
    const tracked=products.filter(p=>p.track_stock&&!p.legacy);
    if(page==='catalogo') {
      box.innerHTML=head()+`<div class="store-toolbar"><div class="store-actions">${canManage?'<button class="btn btn--primary" type="button" data-store-new>Crear producto o servicio</button>':''}
      <button class="btn btn--ghost" type="button" data-store-sale>Crear venta</button></div></div>
      <div class="store-filters"><label class="field"><span class="field__label">Buscar producto, código o categoría</span><input class="field__input" type="search" id="store-search" value="${esc(query)}"></label>
      <label class="field"><span class="field__label">Tipo</span><select class="field__select" id="store-kind"><option value="all">Todos</option><option value="product">Productos</option><option value="service">Servicios</option></select></label></div>
      <div class="store-grid" id="store-product-grid"></div>`;
      document.getElementById('store-kind').value=kind;cards();
    }else if(page==='inventario') {
      const value=tracked.reduce((s,p)=>s+p.quantity*(p.cost_cents||0),0)+(legacy?(legacy.base_quantity||0)*((legacy.cost_cents||0)/legacy.capsules):0);
      box.innerHTML=head()+`<div class="store-summary"><div class="card"><span>Artículos con stock propio</span><strong>${tracked.length}</strong></div>
        <div class="card"><span>Con stock bajo</span><strong>${tracked.filter(p=>p.quantity<=p.min_stock).length}</strong></div>
        ${canManage?`<div class="card"><span>Valor del inventario</span><strong>${cash(value)}</strong></div>`:''}</div>
        ${legacy?`<article class="card"><h3>Phytoemagry</h3><p><strong>${esc(legacy.base_quantity)} cápsulas</strong> · inventario compartido entre sus presentaciones.</p><button class="btn btn--ghost" type="button" data-tab="productos">Gestionar cápsulas</button></article>`:''}
        ${canManage?movementForm(false):''}
        <h3>Existencias por producto</h3><div class="store-table-wrap"><table class="store-table"><thead><tr><th>Producto</th><th>Stock</th><th>Mínimo</th><th>Estado</th></tr></thead><tbody>
        ${tracked.map(p=>`<tr><td>${esc(p.name)}<small>${esc(p.sku)}</small></td><td>${p.quantity}</td><td>${p.min_stock}</td><td>${!p.active?'Inactivo':p.quantity===0?'Agotado':p.quantity<=p.min_stock?'Stock bajo':'Disponible'}</td></tr>`).join('')||'<tr><td colspan="4">Los productos nuevos con inventario aparecerán aquí.</td></tr>'}</tbody></table></div>
        <h3>Movimientos recientes</h3><div class="store-table-wrap"><table class="store-table"><thead><tr><th>Fecha / producto</th><th>Movimiento</th><th>Cantidad</th><th>Saldo</th><th>Motivo</th></tr></thead><tbody>
        ${movements.map(m=>`<tr><td>${esc(new Date(m.created_at).toLocaleString('es-DO'))}<small>${esc(m.product_name)}</small></td><td>${esc(({INITIAL:'Inicial',RESTOCK:'Entrada',SALE:'Venta',SALE_REVERSAL:'Devolución',COUNT:'Recuento',ADJUSTMENT_OUT:'Salida'})[m.type]||m.type)}</td><td>${m.quantity_delta>0?'+':''}${m.quantity_delta}</td><td>${m.quantity_after}</td><td>${esc(m.reason)}<small>${esc(m.actor)}</small></td></tr>`).join('')||'<tr><td colspan="5">Todavía no hay movimientos de los productos nuevos.</td></tr>'}</tbody></table></div>`;
    }else {
      box.innerHTML=head()+`<article class="card"><h3>Comparar el inventario físico</h3><p>Elige un producto, cuenta las unidades y registra la cantidad real. El ajuste y su motivo quedan en el historial.</p></article>
        ${canManage?movementForm(true):'<div class="card">Solo administración puede registrar un recuento.</div>'}
        ${legacy?'<article class="card"><h3>Recuento de Phytoemagry</h3><p>Cuenta sus cápsulas una sola vez; todas las presentaciones comparten ese saldo.</p><button class="btn btn--ghost" data-tab="productos" type="button">Contar cápsulas</button></article>':''}`;
    }
    updateCount();
  }
  function movementForm(count) {
    const rows=products.filter(p=>p.track_stock&&!p.legacy);
    if(!rows.length)return '<div class="card"><p>Crea un producto para registrar sus existencias. Los servicios no llevan stock.</p><button class="btn btn--ghost" type="button" data-tab="catalogo">Ir al catálogo</button></div>';
    return `<form class="card store-stock-form" id="store-stock-form" data-count="${count}"><h3>${count?'Registrar recuento':'Entrada o salida de inventario'}</h3>
      <label class="field"><span class="field__label">Producto</span><select class="field__select" name="productId">${rows.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('')}</select></label>
      ${count?'':'<label class="field"><span class="field__label">Movimiento</span><select class="field__select" name="type"><option value="in">Entrada de mercancía</option><option value="out">Salida / ajuste</option></select></label>'}
      <label class="field"><span class="field__label">${count?'Unidades contadas':'Cantidad de unidades'}</span><input class="field__input" name="quantity" type="number" min="${count?'0':'1'}" step="1" required></label>
      <p id="store-stock-preview" class="store-stock-preview" aria-live="polite"></p>
      <label class="field"><span class="field__label">Motivo</span><input class="field__input" name="reason" maxlength="300" required placeholder="${count?'Recuento físico':'Compra, devolución o motivo del ajuste'}"></label>
      <p class="store-form-error" role="alert"></p><button class="btn btn--primary" type="submit">${count?'Guardar recuento':'Registrar movimiento'}</button></form>`;
  }
  function updateCount() {
    const form=document.getElementById('store-stock-form');if(!form)return;
    const p=products.find(p=>p.id===form.elements.productId.value);if(!p)return;
    const count=form.dataset.count==='true';
    const qty=form.elements.quantity.value;
    const delta=qty===''?null:count?Number(qty)-p.quantity:Number(qty)*(form.elements.type.value==='out'?-1:1);
    document.getElementById('store-stock-preview').textContent=`Stock registrado: ${p.quantity} unidades${delta===null?'':` · Diferencia: ${delta>0?'+':''}${delta} · Quedará: ${p.quantity+delta}`}`;
  }
  const dialog=document.createElement('dialog');dialog.className='store-dialog';dialog.setAttribute('aria-label','Producto o servicio');document.body.append(dialog);
  let editing=null,imageData=null;
  function edit(id) {
    editing=products.find(p=>p.id===id)||null;imageData=null;const p=editing||{};
    dialog.innerHTML=`<form id="store-product-form"><div class="store-toolbar"><h2>${editing?'Editar artículo':'Crear producto o servicio'}</h2><button type="button" class="btn btn--ghost" data-store-close>Cerrar</button></div>
    <label class="field"><span class="field__label">Tipo</span><select class="field__select" name="kind" ${editing?'disabled':''}><option value="product">Producto</option><option value="service">Servicio</option></select></label>
    <label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" value="${esc(p.name)}" maxlength="160" required></label>
    <div class="store-form-grid"><label class="field"><span class="field__label">Código / SKU</span><input class="field__input" name="sku" value="${esc(p.sku)}" maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required placeholder="Ej. CAM-001"></label>
    <label class="field"><span class="field__label">Categoría</span><input class="field__input" name="category" value="${esc(p.category)}" maxlength="100" placeholder="Ej. Cámaras, accesorios"></label></div>
    <label class="field"><span class="field__label">Descripción</span><textarea class="field__input" name="description" maxlength="2000">${esc(p.description)}</textarea></label>
    <label class="field"><span class="field__label">Imagen del producto</span><input class="field__input" name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <div id="store-image-preview">${p.image_url?photo(p):''}</div><p id="store-image-help"></p>
    <div class="store-form-grid"><label class="field"><span class="field__label">Precio de venta (RD$)</span><input class="field__input" name="price" type="number" min="0" step="0.01" required value="${p.price_cents!==undefined?(p.price_cents/100).toFixed(2):''}"></label>
    <label class="field"><span class="field__label">${p.legacy?'Costo calculado por cápsulas (RD$)':'Costo por unidad / servicio (RD$)'}</span><input class="field__input" name="cost" type="number" min="0" step="0.01" required ${p.legacy?'readonly':''} value="${p.cost_cents!==undefined?(p.cost_cents/100).toFixed(2):''}"></label></div>
    ${!editing?'<label class="field" data-stock-field><span class="field__label">Cantidad inicial</span><input class="field__input" name="quantity" type="number" min="0" step="1" value="0" required></label>':''}
    ${!p.legacy?`<label class="field" data-stock-field><span class="field__label">Stock mínimo</span><input class="field__input" name="min_stock" type="number" min="0" step="1" value="${p.min_stock||0}" required></label>`:'<p>El costo y las cápsulas se administran desde Inventario → Gestionar cápsulas.</p>'}
    <label class="store-check"><input name="active" type="checkbox" ${p.active!==false?'checked':''}> Disponible para nuevas ventas</label>
    <p class="store-form-error" role="alert"></p><button class="btn btn--primary btn--block" type="submit">Guardar artículo</button></form>`;
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
      try {imageData=await imageFile(e.target.files[0]);document.getElementById('store-image-preview').innerHTML=`<img src="${imageData}" alt="Vista previa de la imagen" class="store-photo">`;}
      catch(err){imageData=null;error.textContent=err.message;e.target.value='';}finally{button.disabled=false;}
    }
  });
  dialog.addEventListener('click',e=>{if(e.target.closest('[data-store-close]'))dialog.close();});
  dialog.addEventListener('submit',async e=>{
    if(e.target.id!=='store-product-form')return;e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');
    button.disabled=true;form.querySelector('[role=alert]').textContent='';
    const data=Object.fromEntries(new FormData(form));data.kind=editing?.kind||data.kind;data.active=form.elements.active.checked;
    delete data.image;if(imageData)data.image=imageData;if(editing)data.version=editing.version;
    try {await request(`products${editing?'/'+encodeURIComponent(editing.id):''}`,data,editing?'PATCH':'POST');dialog.close();await load();window.dispatchEvent(new Event('fulltech:catalog-updated'));notice('Artículo guardado.');}
    catch(err){form.querySelector('[role=alert]').textContent=err.message;}finally{button.disabled=false;}
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('#view-catalogo,#view-inventario,#view-recuento'))return;
    if(e.target.closest('[data-store-new]'))edit();
    const editButton=e.target.closest('[data-store-edit]');if(editButton)edit(editButton.dataset.storeEdit);
    if(e.target.closest('[data-store-refresh]'))load();
    if(e.target.closest('[data-store-sale]'))window.dispatchEvent(new Event('fulltech:new-sale'));
  });
  document.addEventListener('input',e=>{if(e.target.id==='store-search'){query=e.target.value;cards();}if(e.target.closest('#store-stock-form'))updateCount();});
  document.addEventListener('change',e=>{if(e.target.id==='store-kind'){kind=e.target.value;cards();}if(e.target.closest('#store-stock-form'))updateCount();});
  document.addEventListener('submit',async e=>{
    if(e.target.id!=='store-stock-form')return;e.preventDefault();const form=e.target,button=form.querySelector('[type=submit]');button.disabled=true;
    const data=Object.fromEntries(new FormData(form));const p=products.find(p=>p.id===data.productId);
    data.type=form.dataset.count==='true'?'count':data.type;data.expected=p.quantity;
    form.dataset.requestId ||= crypto.randomUUID();data.requestId=form.dataset.requestId;
    try{await request(`products/${encodeURIComponent(p.id)}/stock`,data);await load();notice('Inventario actualizado.');window.dispatchEvent(new Event('fulltech:catalog-updated'));}
    catch(err){form.querySelector('[role=alert]').textContent=err.message;button.disabled=false;}
  });
  window.addEventListener('fulltech:tab',e=>{page=e.detail.tab;if(pages.includes(page)){render();load();}});
  window.addEventListener('phyto:calling-logout',()=>{epoch++;products=[];movements=[];canManage=false;dialog.close();dialog.innerHTML='';pages.forEach(p=>{document.getElementById(`store-${p}`)?.replaceChildren();});});
  if(pages.includes(document.body.dataset.tab)){page=document.body.dataset.tab;render();load();}
})();
