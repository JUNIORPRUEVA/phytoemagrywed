const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = p => new Intl.NumberFormat('es-DO',{style:'currency',currency:p.currency||'DOP',maximumFractionDigits:0}).format(Number(p.price||0));
const AVAIL_LABEL = { AVAILABLE_NOW: 'Disponible para entrega', ON_REQUEST: 'Disponible bajo pedido', UNAVAILABLE: 'No disponible' };
const avail = p => AVAIL_LABEL[p.availabilityState] || (p.kind === 'service' ? 'Servicio' : 'Consultar disponibilidad');
const canBuy = p => p.purchaseable === true;
const requestHref = p => `${href('request')}?title=${encodeURIComponent(p.name)}&details=${encodeURIComponent(`Producto: ${p.name}${p.category ? ` (${p.category})` : ''}`)}`;
const main = $('#main'), drawer = $('#drawer'), bottom = $('#bottom-nav');

/*
 * CARRITO PERSISTENTE (localStorage). Guarda solo id + cantidad: el precio y la
 * disponibilidad SIEMPRE se vuelven a pedir al servidor. El servidor valida
 * otra vez justo antes de crear el pedido.
 */
const CART_KEY = 'fulltech_cart_v1';
function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(r => r && typeof r.id === 'string' && Number.isInteger(r.quantity) && r.quantity > 0 && r.quantity <= 99)
      .map(r => ({ id: r.id, quantity: r.quantity }));
  } catch { return []; }
}
function writeCart(rows) {
  localStorage.setItem(CART_KEY, JSON.stringify(rows));
  updateCartBadge();
}
function cartCount() { return readCart().reduce((n, r) => n + r.quantity, 0); }
function addToCart(id, quantity = 1) {
  const rows = readCart();
  const found = rows.find(r => r.id === id);
  if (found) found.quantity = Math.min(99, found.quantity + quantity);
  else rows.push({ id, quantity: Math.min(99, quantity) });
  writeCart(rows);
}
function setCartQuantity(id, quantity) {
  const rows = readCart().map(r => r.id === id ? { ...r, quantity } : r).filter(r => r.quantity > 0);
  writeCart(rows);
}
function removeFromCart(id) { writeCart(readCart().filter(r => r.id !== id)); }
function updateCartBadge() {
  const n = cartCount();
  document.querySelectorAll('[data-cart-badge]').forEach(badge => { badge.textContent = n ? String(n) : ''; badge.hidden = !n; });
  const shortcut = document.querySelector('.cart-shortcut');
  if (shortcut) shortcut.setAttribute('aria-label', n ? `Carrito (${n})` : 'Carrito');
}
let homeData = null, catalogState = {kind:'all',category:'',q:'',page:1,pages:1}, searchTimer;
const session = { loaded:false, account:null, providers:{password:true,google:false,apple:false} };
async function apiPost(path, body, method='POST'){const r=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok){const error=new Error(d.message||'No pudimos completar la operación.');error.code=d.error||'';throw error;}return d}
async function ensureSession(force=false){if(session.loaded&&!force)return session.account;try{const d=await api('/api/store/account/me');session.account=d.account}catch{session.account=null}session.loaded=true;return session.account}
async function ensureProviders(){try{const d=await api('/api/store/account/providers');session.providers={password:true,google:false,apple:false,...(d.providers||{})}}catch{}return session.providers}
const initials = value => String(value||'F').trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();
const orderStatus = {nuevo:'Recibido',confirmado:'Confirmado',en_preparacion:'En preparación',enviado:'En camino',entregado:'Entregado',cancelado:'Cancelado',perdido:'No disponible'};
const requestStatus = {nuevo:'Recibida',en_revision:'En revisión',cotizado:'Cotizada',aprobado:'Aprobada',anticipo_pendiente:'Anticipo pendiente',en_proceso:'En proceso',completado:'Completada',rechazado:'No disponible',cancelado:'Cancelada'};
const dateText = value => value?new Intl.DateTimeFormat('es-DO',{dateStyle:'medium'}).format(new Date(value)):'';
const GOOGLE_ICON = '<svg class="google-g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.6h12c-.2 1.9-1.5 4.8-4.4 6.7l6.7 5.2c3.9-3.6 6.8-8.9 6.8-15.5z"/><path fill="#34A853" d="M24 47c6.5 0 11.9-2.1 15.8-5.9l-7.5-5.8c-2 1.4-4.7 2.4-8.3 2.4-6.2 0-11.5-4.1-13.4-9.8l-7.8 6C6.6 41.8 14.6 47 24 47z"/><path fill="#FBBC05" d="M10.6 27.9c-.5-1.4-.8-2.9-.8-4.4s.3-3 .7-4.4l-7.8-6C1.7 16.3 1 20 1 23.5s.7 7.2 1.9 10.4l7.7-6z"/><path fill="#EA4335" d="M24 9.9c3.5 0 6.6 1.2 9 3.5l6.7-6.5C35.9 3.1 30.5 1 24 1 14.6 1 6.6 6.2 2.8 13.1l7.8 6C12.5 13.6 17.8 9.9 24 9.9z"/></svg>'
/*
 * «Continuar con Google»: solo se enlaza cuando el servidor confirma que el
 * proveedor está configurado. Si no lo está, el botón queda desactivado: nunca
 * se simula un acceso ni se manda al cliente a una pantalla que falla.
 */
function googleOption(label='Continuar con Google'){
  const inner=`${GOOGLE_ICON}<span>${esc(label)}</span>`;
  return session.providers.google===true
    ? `<a class="button button-outline button-block auth-google" href="/api/store/account/auth/google/start">${inner}</a>`
    : `<button class="button button-outline button-block auth-google" type="button" disabled>${inner}</button><small class="auth-hint">Google estará disponible muy pronto.</small>`;
}
function authHead(title){return `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>${esc(title)}</h1></div>`}
async function api(path){const r=await fetch(path,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
const href = route => `/store/#/${route}`;
function productCard(p){return `<article class="product-card"><a href="${href(`product/${encodeURIComponent(p.id)}`)}" class="product-link" aria-label="Ver ${esc(p.name)}"><div class="product-image">${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy">`:'<span class="image-fallback" aria-hidden="true">◈</span>'}</div><div class="product-info"><h3 class="product-name">${esc(p.name)}</h3><div class="product-bottom"><span class="price">${money(p)}</span><span class="card-arrow" aria-hidden="true">›</span></div><span class="availability ${p.availabilityState==='UNAVAILABLE'?'out':''}">${avail(p)}</span></div></a><div class="card-actions">${canBuy(p)?`<button class="button button-block" type="button" data-add-cart="${esc(p.id)}">Agregar</button>`:`<a class="button button-outline button-block" href="${requestHref(p)}">Solicitar producto</a>`}</div></article>`}
function searchMarkup(value=''){return `<label class="search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg><input id="store-search" type="search" value="${esc(value)}" placeholder="¿Qué estás buscando?" aria-label="Buscar productos y servicios" autocomplete="off"></label>`}
function footer(){return `<footer class="footer">FULLTECH Store · República Dominicana</footer>`}
function bindSearch(inputId='store-search'){const input=$(`#${inputId}`);if(input)input.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const q=input.value.trim();location.hash=`/catalog?kind=${catalogState.kind}&q=${encodeURIComponent(q)}`},240)})}
function setNav(route){bottom.hidden=route!=='home';document.querySelectorAll('.nav-item').forEach(a=>a.classList.toggle('active',a.dataset.route===route))}
async function renderHome(){setNav('home');main.innerHTML=`${searchMarkup()}<div class="loading-cards"><div class="skeleton"></div><div class="skeleton"></div></div>`;bindSearch();try{homeData=await api('/api/store/home');const products=homeData.products||[],featured=products.filter(p=>p.featured),cats=homeData.categories||[],total=products.length;const rail=featured.length?`<section class="rail-section"><div class="section-head"><div><h2>Destacados</h2></div><a class="text-link" href="${href('catalog')}">Ver todo</a></div><div class="rail">${featured.map(p=>`<a class="rail-card" href="${href('product/'+encodeURIComponent(p.id))}"><div class="rail-image">${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy">`:''}</div><div class="rail-body"><strong>${esc(p.name)}</strong><span class="price">${money(p)}</span><span class="availability ${p.availabilityState==='UNAVAILABLE'?'out':''}">${avail(p)}</span></div></a>`).join('')}</div></section>`:'';main.innerHTML=`${searchMarkup()}<section class="hero"><div class="hero-content"><span class="eyebrow">FULLTECH STORE</span><h1>Lo que buscas, listo para ti.</h1><p>Productos disponibles con entrega a domicilio o recogida coordinada.</p><div class="hero-actions"><a class="button button-light" href="${href('catalog')}">Ver catálogo</a><a class="button button-outline" href="${href('request')}">Lo conseguimos por ti</a></div></div></section><section class="request-banner request-banner--top"><div><h2>¿No lo encuentras?</h2><p>Cuéntanos qué necesitas y lo buscamos por ti.</p></div><a class="button" href="${href('request')}">Solicitar producto</a></section>${rail}${cats.length?`<section><div class="section-head"><div><h2>Categorías</h2></div></div><div class="categories">${cats.map(c=>`<a class="chip" href="${href(`catalog?category=${encodeURIComponent(c)}`)}">${esc(c)}</a>`).join('')}</div></section>`:''}<section><div class="section-head"><div><h2>Productos</h2><p>${total} producto${total===1?'':'s'} disponible${total===1?'':'s'}.</p></div><a class="text-link" href="${href('catalog')}">Ver catálogo completo</a></div>${products.length?`<div class="product-grid">${products.map(productCard).join('')}</div>`:`<div class="empty"><h3>Aún no hay productos publicados</h3><p>Estamos preparando el catálogo. Vuelve pronto.</p></div>`}</section><section class="store-info"><div><strong>Entrega a domicilio</strong><small>Confirmamos costo y tiempo antes de aceptar tu pedido.</small></div><div><strong>Recogida coordinada</strong><small>Te avisamos cuándo está listo para retirar.</small></div></section>${footer()}`;bindSearch()}catch{main.innerHTML=`<div class="state-error"><h1>No pudimos cargar la tienda</h1><p>Revisa tu conexión e inténtalo de nuevo.</p><button class="button" id="retry-home">Intentar de nuevo</button></div>${footer()}`;$('#retry-home').onclick=renderHome}}
async function renderCatalog(params){setNav('catalog');catalogState={kind:'product',category:params.get('category')||'',q:params.get('q')||'',page:1,pages:1};main.innerHTML=`${searchMarkup(catalogState.q)}<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Catálogo</h1></div><div class="catalog-controls"><div class="categories" id="kind-tabs"><span class="chip active" aria-current="true">Productos</span></div><select id="category-filter" aria-label="Filtrar por categoría"><option value="">Todas las categorías</option></select></div><div id="catalog-result" aria-live="polite"></div>${footer()}`;bindSearch();$('[data-back]').onclick=()=>history.back();$('#kind-tabs').onclick=e=>{const b=e.target.closest('[data-kind]');if(b)location.hash=`/catalog?kind=${b.dataset.kind}`};try{const c=await api('/api/store/categories');$('#category-filter').innerHTML+= (c.categories||[]).map(v=>`<option value="${esc(v)}" ${v===catalogState.category?'selected':''}>${esc(v)}</option>`).join('')}catch{}$('#category-filter').onchange=e=>{catalogState.category=e.target.value;catalogState.page=1;loadCatalog()};await loadCatalog()}
async function loadCatalog(append=false){const out=$('#catalog-result');if(!out)return;if(!append)out.innerHTML='<div class="loading-cards"><div class="skeleton"></div><div class="skeleton"></div></div>';const q=$('#store-search')?.value.trim()||catalogState.q;catalogState.q=q;const p=new URLSearchParams({page:String(catalogState.page),limit:'24',kind:'product'});if(q)p.set('q',q);if(catalogState.category)p.set('category',catalogState.category);try{const d=await api(`/api/store/catalog?${p}`);catalogState.pages=d.pagination?.pages||0;const items=d.products||[];const content=items.length?`<div class="product-grid">${items.map(productCard).join('')}</div>${catalogState.page<catalogState.pages?'<div class="more-wrap"><button class="button button-outline" id="load-more">Ver más</button></div>':''}`:`<div class="empty"><h3>${q?'No encontramos resultados':'Aún no hay '+(catalogState.kind==='service'?'servicios':catalogState.kind==='product'?'productos':'artículos')+' publicados'}</h3><p>${q?'Prueba con otro nombre o categoría.':'El catálogo se actualizará cuando haya contenido disponible.'}</p></div>`;out.innerHTML=append?out.innerHTML.replace(/<div class="more-wrap">[\s\S]*?<\/div>$/,'')+content:content;$('#load-more')?.addEventListener('click',()=>{catalogState.page++;loadCatalog(true)})}catch{out.innerHTML=`<div class="state-error"><h2>No pudimos cargar el catálogo</h2><p>Comprueba la conexión y vuelve a intentarlo.</p><button class="button" id="retry-catalog">Intentar de nuevo</button></div>`;$('#retry-catalog').onclick=()=>loadCatalog()}}
function warrantyBlock(w){if(!w||!w.available&&!w.conditions&&!w.coverage&&!w.exclusions&&!w.claim)return '';const details=(w.coverage||w.exclusions||w.conditions||w.claim)?`<details class="warranty"><summary>Consulta las condiciones de garantía</summary>${w.coverage?`<p><strong>Qué cubre:</strong> ${esc(w.coverage)}</p>`:''}${w.exclusions?`<p><strong>Qué no cubre:</strong> ${esc(w.exclusions)}</p>`:''}${w.conditions?`<p>${esc(w.conditions)}</p>`:''}${w.claim?`<p><strong>Cómo reclamar:</strong> ${esc(w.claim)}</p>`:''}</details>`:'';return `<div class="product-warranty"><span class="warranty-label">${esc(w.label)}</span>${w.notes?`<small>${esc(w.notes)}</small>`:''}${details}</div>`}
async function renderProduct(id){setNav('product');main.innerHTML='<div class="loading-cards"><div class="skeleton"></div></div>';try{const {product:p}=await api(`/api/store/products/${encodeURIComponent(id)}`);const consultar=`#/request?title=${encodeURIComponent(p.name)}&details=${encodeURIComponent(`Consulta por: ${p.name}${p.category?` (${p.category})`:''}`)}`;main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button></div><article class="detail"><div class="detail-image">${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}">`:''}</div><div class="detail-copy"><span class="product-category">${esc(p.category||'FULLTECH')}${p.brand?` · ${esc(p.brand)}`:''}</span><h1>${esc(p.name)}</h1><p class="price">${money(p)}</p><p>${esc(p.description||p.shortDescription||'')}</p><span class="availability">${avail(p)}</span><div class="detail-actions">${canBuy(p)?`<button class="button" type="button" id="add-to-cart">Agregar al carrito</button>`:`<a class="button" href="${consultar}">Solicitar producto</a>`}<button class="button button-outline" id="share-product">Compartir</button></div>${warrantyBlock(p.warranty)}</div></article>${footer()}`;$('[data-back]').onclick=()=>history.back();$('#add-to-cart')?.addEventListener('click',()=>{addToCart(p.id,1);const b=$('#add-to-cart');if(b){b.textContent='Agregado ✓';setTimeout(()=>{if(b.isConnected)b.textContent='Agregar al carrito'},1400)}});$('#share-product').onclick=async()=>{try{await navigator.share({title:p.name,url:location.href})}catch{await navigator.clipboard?.writeText(location.href);$('#share-product').textContent='Enlace copiado'}}}catch{main.innerHTML=`<div class="state-error"><h1>Producto no disponible</h1><p>Este artículo no aparece en el catálogo público.</p><a class="button" href="${href('catalog')}">Volver al catálogo</a></div>`}}
/* ---------------------------------------------------------------- CARRITO */
async function cartCatalog() {
  const d = await api('/api/store/catalog?limit=60');
  return new Map((d.products || []).map(p => [p.id, p]));
}

async function renderCart() {
  setNav('cart');
  const rows = readCart();
  if (!rows.length) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Tu carrito</h1></div><div class="empty"><h3>Tu carrito está vacío</h3><p>Agrega productos del catálogo para hacer tu pedido.</p></div><a class="button button-block" href="${href('catalog')}">Ver catálogo</a>${footer()}`;
    $('[data-back]').onclick = () => history.back();
    return;
  }
  main.innerHTML = '<div class="loading-cards"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let byId = new Map();
  try { byId = await cartCatalog(); } catch { /* sin red: se muestra lo guardado */ }
  const items = [];
  const problemas = [];
  for (const row of rows) {
    const p = byId.get(row.id);
    if (p && canBuy(p)) items.push({ ...row, product: p });
    else problemas.push({ ...row, product: p ?? null });
  }
  const total = items.reduce((n, r) => n + r.product.price * r.quantity, 0);
  main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Tu carrito</h1></div>
    ${items.length ? `<ul class="cart-list">${items.map(r => `<li class="cart-item"><div class="cart-item__info"><strong>${esc(r.product.name)}</strong><small>${money(r.product)} c/u · ${esc(avail(r.product))}</small></div><div class="cart-qty"><button type="button" data-cart-minus="${esc(r.id)}" aria-label="Quitar uno">−</button><span>${r.quantity}</span><button type="button" data-cart-plus="${esc(r.id)}" aria-label="Agregar uno">+</button></div><div class="cart-item__total">${money({ price: r.product.price * r.quantity, currency: r.product.currency })}</div><button class="cart-remove" type="button" data-cart-remove="${esc(r.id)}" aria-label="Quitar del carrito">✕</button></li>`).join('')}</ul><p class="cart-total"><span>Total</span><strong>${money({ price: total, currency: 'DOP' })}</strong></p>` : ''}
    ${problemas.length ? `<section class="cart-problems"><h2>Algo cambió</h2>${problemas.map(r => `<div class="cart-problem"><p><strong>${esc(r.product?.name || 'Un producto')}</strong> no está disponible para compra directa.</p><div class="cart-problem__actions">${r.product ? `<a class="button button-outline" href="${requestHref(r.product)}">Quiero que me lo consigan</a>` : ''}<button class="button button-ghost" type="button" data-cart-remove="${esc(r.id)}">Quitar del carrito</button></div></div>`).join('')}</section>` : ''}
    <div class="cart-actions">${items.length ? `<a class="button button-block" href="${href('checkout')}">Continuar con el pedido</a>` : ''}<a class="button button-outline button-block" href="${href('catalog')}">Seguir comprando</a></div>${footer()}`;
  $('[data-back]').onclick = () => history.back();
}

async function renderCheckout() {
  setNav('checkout');
  const rows = readCart();
  if (!rows.length) { location.hash = '#/cart'; return; }
  await ensureSession(true);
  if (!session.account) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Finalizar pedido</h1></div><section class="account-card auth-required"><h2>Entra para completar tu pedido</h2><p>Necesitamos identificarte para enviarte el pedido y avisarte del estado.</p><div class="account-actions"><a class="button" href="#/account/login">Entrar</a><a class="button button-outline" href="#/account/register">Crear cuenta</a></div></section>${footer()}`;
    $('[data-back]').onclick = () => history.back();
    return;
  }
  let byId = new Map();
  try { byId = await cartCatalog(); } catch { /* se valida igual en el servidor */ }
  /*
   * TELÉFONO VERIFICADO: el carrito NO se pierde. Se muestra el paso de
   * confirmación y, al volver, el cliente sigue exactamente donde estaba.
   */
  if (session.account.phone_saved === false) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Agrega tu número</h1></div><section class="account-card"><h2>Un paso más y sigues</h2><p>Necesitamos tu número de teléfono para coordinar la entrega. Tu carrito queda guardado.</p><div class="account-actions"><a class="button" href="/store/verify/?next=%2Fstore%2F%23%2Fcheckout">Agregar número</a><a class="button button-outline" href="#/cart">Volver al carrito</a></div></section>${footer()}`;
    $('[data-back]').onclick = () => history.back();
    return;
  }
  const total = rows.reduce((n, r) => n + (byId.get(r.id)?.price ?? 0) * r.quantity, 0);
  const requestKey = `store_${(crypto.randomUUID?.() || String(Date.now())).replaceAll('-', '')}`;
  main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Finalizar pedido</h1></div>
    <p class="page-intro">${rows.length} artículo${rows.length === 1 ? '' : 's'} · <strong>${money({ price: total, currency: 'DOP' })}</strong></p>
    <form id="checkout-form" class="request-form">
      <fieldset class="checkout-methods"><legend>¿Cómo lo quieres recibir?</legend>
        <label class="checkout-method"><input type="radio" name="fulfillment" value="delivery" checked> <span><strong>Entrega a domicilio</strong><small>Te confirmamos el costo y el tiempo antes de aceptar el pedido.</small></span></label>
        <label class="checkout-method"><input type="radio" name="fulfillment" value="pickup"> <span><strong>Recogida coordinada</strong><small>Te confirmamos disponibilidad, lugar y hora antes de que pases.</small></span></label>
      </fieldset>
      <div id="checkout-address"><label class="field"><span class="field__label">Dirección de entrega</span><textarea class="field__input" name="address" rows="2" maxlength="240" placeholder="Calle, número, sector, referencia"></textarea></label></div>
      <label class="field"><span class="field__label">Indicaciones (opcional)</span><input class="field__input" name="notes" maxlength="500" placeholder="Horario, referencia o cualquier detalle"></label>
      <p class="form-error" id="checkout-error" role="alert"></p>
      <button class="button button-block" type="submit">Realizar pedido</button>
    </form>
    <p class="checkout-note">Tu pedido queda <strong>pendiente de confirmación</strong>. No se cobra nada ahora ni se reserva el inventario hasta que el equipo lo confirme.</p>${footer()}`;
  $('[data-back]').onclick = () => history.back();
  const form = $('#checkout-form');
  const toggleAddress = () => { $('#checkout-address').hidden = form.fulfillment.value !== 'delivery'; };
  form.fulfillment.forEach(radio => radio.addEventListener('change', toggleAddress));
  toggleAddress();
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    $('#checkout-error').textContent = '';
    try {
      const data = await apiPost('/api/store/orders', {
        items: readCart().map(r => ({ id: r.id, quantity: r.quantity })),
        fulfillment: form.fulfillment.value,
        address: form.address.value.trim(),
        notes: form.notes.value.trim(),
        requestKey,
      });
      writeCart([]);
      main.innerHTML = `<div class="state-success"><h1>Recibimos tu pedido</h1><p>Te confirmaremos los detalles pronto.</p>${data.order?.number ? `<p class="order-number">Pedido <strong>${esc(data.order.number)}</strong></p>` : ''}<p class="muted">Queda pendiente de confirmación.</p><a class="button button-block" href="${href('orders')}">Ver mis pedidos</a><a class="button button-outline button-block" href="/store/">Volver al inicio</a></div>${footer()}`;
    } catch (error) {
      $('#checkout-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

document.addEventListener('click', event => {
  const add = event.target.closest('[data-add-cart]');
  if (add) {
    event.preventDefault();
    addToCart(add.dataset.addCart, 1);
    const original = add.textContent;
    add.textContent = 'Agregado ✓';
    setTimeout(() => { if (add.isConnected) add.textContent = original; }, 1400);
    return;
  }
  const plus = event.target.closest('[data-cart-plus]');
  if (plus) {
    const row = readCart().find(r => r.id === plus.dataset.cartPlus);
    setCartQuantity(plus.dataset.cartPlus, Math.min(99, (row?.quantity || 0) + 1));
    if (location.hash.includes('/cart')) renderCart();
    return;
  }
  const minus = event.target.closest('[data-cart-minus]');
  if (minus) {
    const row = readCart().find(r => r.id === minus.dataset.cartMinus);
    setCartQuantity(minus.dataset.cartMinus, (row?.quantity || 0) - 1);
    if (location.hash.includes('/cart')) renderCart();
    return;
  }
  const remove = event.target.closest('[data-cart-remove]');
  if (remove) {
    removeFromCart(remove.dataset.cartRemove);
    if (location.hash.includes('/cart')) renderCart();
  }
});

function renderRequestError(message){const box=$('#request-error');if(box)box.textContent=message||''}
function compressImage(file){return new Promise((resolve,reject)=>{if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){reject(new Error('Usa una imagen JPG, PNG o WebP de hasta 8 MB.'));return}const reader=new FileReader();reader.onerror=()=>reject(new Error('No pudimos leer la imagen.'));reader.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,1200/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',0.82);data.length>1350000?reject(new Error('La imagen sigue siendo muy grande. Elige una más pequeña.')):resolve(data)};img.onerror=()=>reject(new Error('Esa imagen no se pudo abrir.'));img.src=String(reader.result)};reader.readAsDataURL(file)})}
async function renderRequest(params = new URLSearchParams()){
  setNav('request');
  await ensureSession(true);
  if(!session.account){
    main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Lo conseguimos por ti</h1></div><section class="account-card auth-required"><span class="eyebrow">LO CONSEGUIMOS POR TI</span><h2>Cuéntanos qué necesitas</h2><p>Entra o crea tu cuenta para guardar la solicitud y seguir su estado.</p><div class="account-actions"><a class="button" href="#/account/login">Entrar</a><a class="button button-outline" href="#/account/register">Crear cuenta</a></div></section>${footer()}`;
    $('[data-back]').onclick=()=>history.back();
    return;
  }
  let requestKind='product',images=[];
  const requestKey=`req_${(crypto.randomUUID?.()||String(Date.now())).replaceAll('-','')}`;
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Lo conseguimos por ti</h1></div><p class="page-intro">Descríbenos el producto o servicio. Te responderemos con una cotización.</p><form id="request-form" class="request-form"><div class="categories" id="request-kind"><button type="button" class="chip active" data-kind="product">Producto</button><button type="button" class="chip" data-kind="service">Servicio</button></div><label class="field"><span class="field__label">¿Qué necesitas?</span><input class="field__input" name="title" maxlength="120" required placeholder="Ej. Router de doble banda" value="${esc(params.get('title') || '')}"></label><label class="field"><span class="field__label">Detalles (opcional)</span><textarea class="field__input" name="details" maxlength="2000" rows="3" placeholder="Marca, modelo, cantidad o cualquier detalle útil">${esc(params.get('details') || '')}</textarea></label><label class="field"><span class="field__label">Enlace (opcional)</span><input class="field__input" name="referenceUrl" type="url" maxlength="500" inputmode="url" placeholder="https://..."></label><label class="field"><span class="field__label">Fotos (opcional, hasta 3)</span><input class="field__input" id="request-images" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><div class="photo-grid" id="request-previews"></div><p class="form-error" id="request-error" role="alert"></p><button class="button button-block" type="submit">Enviar solicitud</button></form>${footer()}`;
  $('[data-back]').onclick=()=>history.back();
  $('#request-kind').onclick=event=>{const button=event.target.closest('[data-kind]');if(!button)return;requestKind=button.dataset.kind;$('#request-kind').querySelectorAll('[data-kind]').forEach(node=>node.classList.toggle('active',node===button));};
  $('#request-images').onchange=async event=>{renderRequestError('');const files=[...event.target.files].slice(0,3);if(event.target.files.length>3)renderRequestError('Puedes adjuntar hasta 3 fotos.');try{images=await Promise.all(files.map(compressImage));$('#request-previews').innerHTML=images.map(src=>`<img src="${src}" alt="Vista previa de la foto">`).join('');}catch(error){images=[];$('#request-previews').innerHTML='';renderRequestError(error.message);event.target.value='';}};
  $('#request-form').onsubmit=async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;renderRequestError('');
    try{
      const data=await apiPost('/api/store/requests',{kind:requestKind,title:form.title.value.trim(),details:form.details.value.trim(),referenceUrl:form.referenceUrl.value.trim(),images,requestKey});
      const duplicate=Boolean(data.duplicate);
      main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>${duplicate?'Solicitud ya registrada':'Solicitud recibida'}</h1></div><section class="success-card"><span class="success-icon" aria-hidden="true">✓</span><h2>${duplicate?'Ya teníamos tu solicitud':'Gracias, la tenemos'}</h2><p>${duplicate?'No creamos otra igual. Puedes seguir su estado en tu cuenta.':'Te responderemos aquí con el estado y la cotización.'}</p><span class="request-code">${esc(String(data.request.id).slice(-8).toUpperCase())}</span><div class="account-actions"><a class="button" href="#/account/requests">Ver mis solicitudes</a><a class="button button-outline" href="/store/">Seguir explorando</a></div></section>${footer()}`;
      $('[data-back]').onclick=()=>history.back();
    }catch(error){renderRequestError(error.message);button.disabled=false;}
  };
}
/* Tras entrar: si había algo en el carrito, se vuelve al pedido (no se pierde). */
function afterAuth(){location.hash=readCart().length?'/checkout':'/account'}

/* -------------------------------------------------------------- INICIAR SESIÓN */
async function renderLogin(message=''){
  setNav('account');await ensureProviders();
  main.innerHTML=`${authHead('Iniciar sesión')}
    <section class="auth-panel">
      ${message?`<p class="auth-note">${esc(message)}</p>`:''}
      <form id="login-form" class="auth-form" novalidate>
        <label class="field"><span class="field__label">Correo electrónico</span><input class="field__input" name="identifier" type="email" autocomplete="username" inputmode="email" placeholder="tucorreo@dominio.com" required></label>
        <label class="field"><span class="field__label">Contraseña</span><input class="field__input" name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" id="auth-error" role="alert"></p>
        <button class="button button-block" type="submit">Entrar</button>
      </form>
      <a class="auth-link" href="#/account/recover">¿Olvidaste tu contraseña?</a>
      <div class="auth-divider"><span>o</span></div>
      ${googleOption()}
      <p class="auth-alt">¿No tienes cuenta? <a href="#/account/register">Crear cuenta</a></p>
    </section>${footer()}`;
  bindAuthBack();
  $('#login-form').onsubmit=async event=>{event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;$('#auth-error').textContent='';try{const data=await apiPost('/api/store/account/login',{identifier:form.identifier.value.trim(),password:form.password.value});session.account=data.account;session.loaded=true;afterAuth();}catch(error){$('#auth-error').textContent=error.message;button.disabled=false;}};
}

/* --------------------------------------------------- CREAR CUENTA (elegir vía) */
async function renderRegister(){
  setNav('account');await ensureProviders();
  main.innerHTML=`${authHead('Crear cuenta')}
    <section class="auth-panel auth-panel--choice">
      <p class="auth-sub auth-sub--center">Elige cómo quieres crear tu cuenta.</p>
      <div class="auth-stack">
        ${googleOption()}
        <a class="button button-outline button-block" href="#/account/register/manual">Crear cuenta manual</a>
      </div>
    </section>${footer()}`;
  bindAuthBack();
}

/*
 * REGISTRO MANUAL EN DOS PASOS: primero los datos y después el teléfono, en una
 * pantalla aparte. El servidor recibe UNA sola petición al final, así que el
 * contrato de `/api/store/account/register` no cambia.
 */
const manualSignup={name:'',surname:'',email:'',password:''};
async function renderRegisterManual(params=new URLSearchParams()){
  setNav('account');
  if(params.get('step')==='phone'){
    main.innerHTML=`${authHead('Tu número de teléfono')}
      <section class="auth-panel">
        <p class="auth-sub">Lo usamos para coordinar la entrega de tu pedido.</p>
        <form id="phone-step" class="auth-form" novalidate>
          <label class="field"><span class="field__label">Tu número de teléfono</span><input class="field__input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="809 000 0000" required></label>
          <p class="form-error" id="auth-error" role="alert"></p>
          <button class="button button-block" type="submit">Guardar y continuar</button>
        </form>
        <a class="auth-link auth-link--left" href="#/account/register/manual">Volver</a>
      </section>${footer()}`;
    bindAuthBack();
    $('#phone-step').onsubmit=async event=>{
      event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;$('#auth-error').textContent='';
      try{
        const data=await apiPost('/api/store/account/register',{name:`${manualSignup.name} ${manualSignup.surname}`.trim(),phone:form.phone.value.trim(),email:manualSignup.email,password:manualSignup.password});
        Object.assign(manualSignup,{name:'',surname:'',email:'',password:''});
        session.account=data.account;session.loaded=true;afterAuth();
      }catch(error){$('#auth-error').textContent=error.message;button.disabled=false;}
    };
    return;
  }
  main.innerHTML=`${authHead('Crear cuenta')}
    <section class="auth-panel">
      <form id="manual-form" class="auth-form" novalidate>
        <label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" autocomplete="given-name" maxlength="60" value="${esc(manualSignup.name)}" required></label>
        <label class="field"><span class="field__label">Apellido</span><input class="field__input" name="surname" autocomplete="family-name" maxlength="60" value="${esc(manualSignup.surname)}" required></label>
        <label class="field"><span class="field__label">Correo electrónico</span><input class="field__input" name="email" type="email" autocomplete="email" inputmode="email" maxlength="160" placeholder="tucorreo@dominio.com" value="${esc(manualSignup.email)}" required></label>
        <label class="field"><span class="field__label">Contraseña</span><input class="field__input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="field"><span class="field__label">Confirmar contraseña</span><input class="field__input" name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
        <p class="form-error" id="auth-error" role="alert"></p>
        <button class="button button-block" type="submit">Continuar</button>
      </form>
      <p class="auth-alt">¿Ya tienes cuenta? <a href="#/account/login">Iniciar sesión</a></p>
    </section>${footer()}`;
  bindAuthBack();
  $('#manual-form').onsubmit=event=>{
    event.preventDefault();const form=event.target,error=$('#auth-error');
    const name=form.name.value.trim(),surname=form.surname.value.trim(),email=form.email.value.trim(),password=form.password.value,confirm=form.confirm.value;
    error.textContent='';
    if(name.length<2){error.textContent='Escribe tu nombre.';return}
    if(surname.length<2){error.textContent='Escribe tu apellido.';return}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){error.textContent='Escribe un correo válido.';return}
    if(password.length<8){error.textContent='La contraseña necesita al menos 8 caracteres.';return}
    if(password!==confirm){error.textContent='Las contraseñas no coinciden.';return}
    Object.assign(manualSignup,{name,surname,email,password});
    location.hash='/account/register/manual?step=phone';
  };
}

/* ------------------------------------------------------ RECUPERAR CONTRASEÑA */
async function renderRecover(){
  setNav('account');
  main.innerHTML=`${authHead('Recuperar acceso')}
    <section class="auth-panel">
      <p class="auth-sub">Escribe tu correo y te enviamos un enlace para crear una contraseña nueva.</p>
      <form id="recover-form" class="auth-form" novalidate>
        <label class="field"><span class="field__label">Correo electrónico</span><input class="field__input" name="identifier" type="email" autocomplete="username" inputmode="email" required></label>
        <p class="form-error" id="auth-error" role="alert"></p>
        <p class="form-ok" id="recover-ok" role="status"></p>
        <button class="button button-block" type="submit">Enviar enlace</button>
      </form>
      <p class="auth-alt"><a href="#/account/login">Volver a iniciar sesión</a></p>
    </section>${footer()}`;
  bindAuthBack();
  $('#recover-form').onsubmit=async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;$('#auth-error').textContent='';$('#recover-ok').textContent='';
    try{const data=await apiPost('/api/store/account/recover',{identifier:form.identifier.value.trim()});$('#recover-ok').textContent=data.message||'Si el dato coincide con una cuenta, te enviamos un enlace para recuperar el acceso.';}
    catch(error){$('#auth-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
}

async function renderComplete(params){
  setNav('account');const token=params.get('token')||'';
  if(!token){
    main.innerHTML=`${authHead('Completa tu cuenta')}<section class="auth-panel"><p class="auth-sub">El enlace caducó. Vuelve a intentarlo.</p><a class="button button-block" href="#/account/login">Volver a iniciar sesión</a></section>${footer()}`;
    bindAuthBack();return;
  }
  /* Solo lo imprescindible: WhatsApp y ciudad. El nombre ya viene de Google. */
  main.innerHTML=`${authHead('Completa tu cuenta')}<p class="auth-sub">Solo faltan tu WhatsApp y tu ciudad.</p><section class="auth-panel">
    <form id="complete-form" class="auth-form" novalidate>
      <label class="field"><span class="field__label">Número de WhatsApp</span><input class="field__input" name="phone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="809 000 0000"></label>
      <label class="field"><span class="field__label">Ciudad</span><input class="field__input" name="city" autocomplete="address-level2" maxlength="80" required placeholder="Santo Domingo"></label>
      <label class="field" id="complete-proof" hidden><span class="field__label">Número de un pedido anterior</span><input class="field__input" name="orderNumber" maxlength="60" placeholder="Ej. PE-123456"><small class="auth-hint">Ese WhatsApp ya compró antes con nosotros.</small></label>
      <p class="form-error" id="auth-error" role="alert"></p>
      <button class="button button-block" type="submit">Terminar mi cuenta</button>
    </form></section>${footer()}`;
  bindAuthBack();
  const form=$('#complete-form'),button=form.querySelector('[type=submit]');
  form.onsubmit=async event=>{
    event.preventDefault();
    button.disabled=true;$('#auth-error').textContent='';
    try{
      const data=await apiPost('/api/store/account/complete',{token,phone:form.phone.value.trim(),city:form.city.value.trim(),orderNumber:(form.orderNumber.value||'').trim()});
      session.account=data.account;session.loaded=true;
      afterAuth();
    }catch(error){
      $('#auth-error').textContent=error.message;
      if(error.code==='verification_required'){$('#complete-proof').hidden=false;form.orderNumber.focus();}
      button.disabled=false;
    }
  };
}
function bindAuthBack(){const back=$('[data-back]');if(back)back.onclick=()=>history.length>1?history.back():location.assign('/store/')}
async function renderAccount(){
  setNav('account');await Promise.all([ensureSession(true),ensureProviders()]);
  if(!session.account){
    main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Mi cuenta</h1></div>
      <section class="auth-hero">
        <span class="auth-hero__mark" aria-hidden="true">F</span>
        <span class="auth-hero__label">TU ESPACIO</span>
        <p>Inicia sesión o crea tu cuenta para ver tus pedidos y solicitudes.</p>
        <div class="auth-stack">
          <a class="button button-light button-block" href="#/account/login">Iniciar sesión</a>
          <a class="button button-outline-light button-block" href="#/account/register">Crear cuenta</a>
        </div>
      </section>${footer()}`;
    bindAuthBack();return;
  }
  let counts={orders_count:0,requests_count:0};try{counts=await api('/api/store/account/me');session.account=counts.account||session.account}catch{}
  const account=session.account;
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Mi cuenta</h1></div><section class="account-hero account-hero--signed"><span class="account-avatar" aria-hidden="true">${esc(initials(account.name))}</span><div><span class="eyebrow">TU CUENTA</span><h2>${esc(account.name||'Mi cuenta')}</h2><p>${esc(account.phone||'')}${account.email?' · '+esc(account.email):''}</p></div></section><div class="account-grid"><a class="account-tile" href="#/orders"><strong>${Number(counts.orders_count)||0}</strong><span>Pedidos</span></a><a class="account-tile" href="#/account/requests"><strong>${Number(counts.requests_count)||0}</strong><span>Solicitudes</span></a></div>${account.phone_saved === false ? `<section class="account-card"><h3>Agrega tu número</h3><p class="auth-note">Lo necesitas para tu próximo pedido o solicitud. No enviamos códigos: solo guardamos el número.</p><a class="button button-outline button-block" href="/store/verify/?next=%2Fstore%2F%23%2Faccount">Agregar número</a></section>` : ''}<section class="account-card"><h3>Preferencias</h3><label class="switch-row"><span>Contactarme por WhatsApp</span><input type="checkbox" id="pref-contact" ${account.preferences?.contact!=='phone'?'checked':''}></label><label class="switch-row"><span>Recibir novedades</span><input type="checkbox" id="pref-marketing" ${account.preferences?.marketing?'checked':''}></label><button class="button button-outline button-block" id="save-preferences">Guardar preferencias</button></section><section class="account-card"><h3>Mis datos</h3><form id="profile-form"><label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" value="${esc(account.name)}" maxlength="120" required></label><label class="field"><span class="field__label">Correo (opcional)</span><input class="field__input" name="email" type="email" value="${esc(account.email||'')}" maxlength="160"></label><p class="form-error" id="profile-error" role="alert"></p><button class="button button-block" type="submit">Guardar datos</button></form></section><button class="button button-ghost button-block" id="logout">Cerrar sesión</button>${footer()}`;
  bindAuthBack();
  $('#save-preferences').onclick=async()=>{const button=$('#save-preferences');button.disabled=true;try{const data=await apiPost('/api/store/account/me',{preferences:{contact:$('#pref-contact').checked?'whatsapp':'phone',marketing:$('#pref-marketing').checked}},'PATCH');session.account=data.account;button.textContent='Preferencias guardadas';}catch(error){button.textContent='No se pudo guardar';}finally{setTimeout(()=>{button.disabled=false;button.textContent='Guardar preferencias'},1400);}};
  $('#profile-form').onsubmit=async event=>{event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;$('#profile-error').textContent='';try{const data=await apiPost('/api/store/account/me',{name:form.name.value.trim(),email:form.email.value.trim()},'PATCH');session.account=data.account;renderAccount();}catch(error){$('#profile-error').textContent=error.message;button.disabled=false;}};
  $('#logout').onclick=async()=>{try{await apiPost('/api/store/account/logout',{})}catch{}session.account=null;session.loaded=true;location.hash='/account';};
}
async function renderOrders(){
  setNav('orders');await ensureSession(true);
  if(!session.account)return renderLogin('Entra para ver tus pedidos.');
  let rows=[];try{rows=(await api('/api/store/account/orders')).orders||[]}catch{}
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Mis pedidos</h1></div>${rows.length?`<div class="order-list">${rows.map(orderCard).join('')}</div>`:'<div class="empty"><h3>Todavía no hay pedidos</h3><p>Cuando compres, tus pedidos aparecerán aquí.</p><a class="button" href="#/catalog">Ver catálogo</a></div>'}${footer()}`;
  bindAuthBack();
}
function orderCard(order){const items=(order.items||[]).map(item=>`${esc(item.name)} × ${item.quantity}`).join(' · ');return `<article class="order-card"><div class="order-head"><strong>${esc(order.order_number)}</strong><span class="status-chip">${esc(orderStatus[order.status]||order.status)}</span></div><p class="order-date">${esc(dateText(order.received_at))}</p><p class="order-items">${items||'—'}</p><div class="order-total">${new Intl.NumberFormat('es-DO',{style:'currency',currency:order.currency||'DOP'}).format(Number(order.total||0))}</div></article>`}
async function renderRequests(){
  setNav('account');await ensureSession(true);
  if(!session.account)return renderLogin('Entra para ver tus solicitudes.');
  let rows=[];try{rows=(await api('/api/store/account/requests')).requests||[]}catch{}
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>Mis solicitudes</h1></div>${rows.length?`<div class="request-list">${rows.map(requestCard).join('')}</div>`:'<div class="empty"><h3>Aún no has pedido nada especial</h3><p>Cuéntanos qué buscas y te conseguimos una cotización.</p><a class="button" href="#/request">Crear solicitud</a></div>'}${footer()}`;
  bindAuthBack();
  main.onclick=async event=>{
    const button=event.target.closest('[data-request-decision]');if(!button)return;
    const decision=button.dataset.requestDecision,id=button.dataset.requestId;button.disabled=true;
    try{await apiPost(`/api/store/requests/${encodeURIComponent(id)}/decision`,{decision});await renderRequests();}catch(error){button.disabled=false;button.textContent=error.message;}
  };
  main.onsubmit=async event=>{
    const form=event.target.closest('[data-request-transfer]');if(!form)return;
    event.preventDefault();
    const id=form.dataset.requestTransfer;const button=form.querySelector('[type=submit]');const error=form.querySelector('[role=alert]');
    button.disabled=true;if(error)error.textContent='';
    try{
      let proof='';
      const file=form.querySelector('input[name=proof]')?.files?.[0];
      if(file)proof=await compressImage(file);
      const amount=String(form.querySelector('input[name=amount]')?.value||'').trim();
      const reference=String(form.querySelector('input[name=reference]')?.value||'').trim();
      await apiPost(`/api/store/requests/${encodeURIComponent(id)}/transfer`,{reference,...(amount?{amount}:{}),...(proof?{proof}:{})});
      await renderRequests();
    }catch(submitError){button.disabled=false;if(error)error.textContent=submitError.message;}
  };
}
function requestCard(request){
  const events=(request.events||[]).slice(-4).map(event=>`<li><span>${esc(requestStatus[event.status]||event.status)}</span><time>${esc(dateText(event.at))}</time></li>`).join('');
  const quote=request.quote?`<div class="request-quote"><span>Propuesta</span><strong>${new Intl.NumberFormat('es-DO',{style:'currency',currency:request.quote.currency||'DOP'}).format(Number(request.quote.amount||0))}</strong>${request.quote.advance_amount>0?`<p>Anticipo ${request.quote.advance_percent}%: ${new Intl.NumberFormat('es-DO',{style:'currency',currency:request.quote.currency||'DOP'}).format(Number(request.quote.advance_amount||0))}</p>`:''}${request.quote.notes?`<p>${esc(request.quote.notes)}</p>`:''}</div>`:'';
  const payment=request.payment?`<div class="request-payment"><span>Anticipo ${request.payment.status==='confirmed'?'confirmado':request.payment.status==='rejected'?'rechazado':'reportado, en verificación'}</span><strong>${new Intl.NumberFormat('es-DO',{style:'currency',currency:'DOP'}).format(Number(request.payment.amount||0))}</strong>${request.payment.reason?`<p>${esc(request.payment.reason)}</p>`:''}</div>`:'';
  const transfer=(request.status==='anticipo_pendiente'||request.status==='aprobado')&&(!request.payment||request.payment.status==='rejected')?`<form class="request-transfer" data-request-transfer="${esc(request.id)}"><label class="field"><span class="field__label">Monto transferido (RD$)</span><input class="field__input" name="amount" inputmode="decimal" value="${Number(request.quote?.advance_amount||0).toFixed(2)}"></label><label class="field"><span class="field__label">Referencia (opcional)</span><input class="field__input" name="reference" maxlength="120" placeholder="Número o nota de la transferencia"></label><label class="field"><span class="field__label">Comprobante (opcional)</span><input class="field__input" type="file" name="proof" accept="image/jpeg,image/png,image/webp"></label><button class="button button-block" type="submit">Reportar transferencia</button><p class="form-error" role="alert"></p><p class="checkout-note">Tu banco confirma el dinero; aquí solo avisas. El equipo verifica el pago antes de continuar.</p></form>`:'';
  const actions=request.status==='cotizado'?`<div class="request-actions"><button class="button" type="button" data-request-decision="accept" data-request-id="${esc(request.id)}">Aceptar</button><button class="button button-outline" type="button" data-request-decision="decline" data-request-id="${esc(request.id)}">Rechazar</button></div>`:'';
  return `<article class="request-card"><div class="request-head"><span class="status-chip status-chip--${esc(request.status)}">${esc(requestStatus[request.status]||request.status)}</span><strong>${esc(request.title)}</strong></div><p class="request-date">${esc(dateText(request.created_at))}${request.images?` · ${request.images} foto${request.images===1?'':'s'}`:''}</p>${quote}${payment}${events?`<ul class="request-timeline">${events}</ul>`:''}${actions}${transfer}</article>`;
}
function renderNotice(title){setNav('');main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">‹</button><h1>${title}</h1></div><div class="empty"><h3>Próximamente</h3><p>Esta función aún no está disponible.</p></div>${footer()}`;$('[data-back]').onclick=()=>history.back()}
async function route(){const raw=location.hash.replace(/^#\/?/,'');const [path,query='']=raw.split('?');const params=new URLSearchParams(query);if(!path)return renderHome();if(path==='catalog')return renderCatalog(params);if(path.startsWith('product/'))return renderProduct(decodeURIComponent(path.slice(8)));if(path==='cart')return renderCart();if(path==='checkout')return renderCheckout();if(path==='request')return renderRequest(params);if(path==='orders')return renderOrders();if(path==='account')return renderAccount();if(path==='account/login')return renderLogin();if(path==='account/register')return renderRegister();if(path==='account/register/manual')return renderRegisterManual(params);if(path==='account/recover')return renderRecover();if(path==='account/complete')return renderComplete(params);if(path==='account/requests')return renderRequests();return renderHome()}
function openDrawer(open){if(!open&&drawer.contains(document.activeElement))$('#menu-button').focus();drawer.classList.toggle('open',open);drawer.setAttribute('aria-hidden',String(!open));drawer.inert=!open;$('#drawer-scrim').hidden=!open;$('#menu-button').setAttribute('aria-expanded',String(open))}
$('#menu-button').onclick=()=>openDrawer(true);$('#close-drawer').onclick=()=>openDrawer(false);$('#drawer-scrim').onclick=()=>openDrawer(false);drawer.addEventListener('click',e=>{if(e.target.closest('a'))openDrawer(false)});document.querySelector('.cart-shortcut')?.addEventListener('click',()=>{location.hash='#/cart'});
updateCartBadge();
/*
 * FRESCURA DE DISPONIBILIDAD: el catálogo visible se vuelve a pedir cada minuto
 * y al volver a la app. El checkout SIEMPRE se valida otra vez en el servidor.
 */
async function refreshVisibleAvailability(){
  if(document.visibilityState!=='visible')return;
  const active=document.activeElement;
  if(active&&active.closest?.('#checkout-form,#request-form'))return;
  if(active&&active.id==='store-search'&&String(active.value||'').trim())return;
  const hash=location.hash||'';
  if(hash&&!hash.includes('/catalog'))return;
  if(!hash||hash==='#/'||hash==='#/catalog'){
    const y=window.scrollY;
    await route();
    window.scrollTo(0,y);
  }
}
setInterval(()=>{if(document.visibilityState!=='visible')return;updateCartBadge();if(location.hash.includes('/cart'))renderCart();refreshVisibleAvailability();},60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;updateCartBadge();if(location.hash.includes('/cart'))renderCart();refreshVisibleAvailability();});window.addEventListener('hashchange',route);window.addEventListener('popstate',route);route();
