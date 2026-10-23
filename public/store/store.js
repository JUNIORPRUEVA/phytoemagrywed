const $ = (s, root = document) => root.querySelector(s);
import { hydrateIcons, hydrateMaterialIcons, paintMaterialIcon, materialIcon } from './custom-icons.js?v=1';
import {galleryMarkup,mountGallery,mountCardImageFallbacks} from './product-gallery.js?v=4';
/* Cabecera y barra inferior usan la familia Material Symbols Rounded ya descargada. */
hydrateMaterialIcons();
hydrateIcons();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = p => new Intl.NumberFormat('es-DO',{style:'currency',currency:p.currency||'DOP',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(p.price||0));
const AVAIL_LABEL = { AVAILABLE_NOW: 'Disponible para entrega', ON_REQUEST: 'Disponible bajo pedido', UNAVAILABLE: 'No disponible' };
const avail = p => AVAIL_LABEL[p.availabilityState] || (p.kind === 'service' ? 'Servicio' : 'Consultar disponibilidad');
const canBuy = p => p.purchaseable === true;
const requestHref = p => `${href('request')}?title=${encodeURIComponent(p.name)}&details=${encodeURIComponent(`Producto: ${p.name}${p.category ? ` (${p.category})` : ''}`)}`;
const main = $('#main'), drawer = $('#drawer'), bottom = $('#bottom-nav');
mountCardImageFallbacks(main);
let deferredInstallPrompt=null,installReminderTimer;
const installButton=$('#install-app');
const standaloneMode=()=>window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone===true;
function syncInstallButton(){if(!installButton)return;installButton.hidden=standaloneMode()}
function remindInstall(){if(!installButton||installButton.hidden)return;installButton.classList.remove('is-reminded');void installButton.offsetWidth;installButton.classList.add('is-reminded');clearTimeout(installReminderTimer);installReminderTimer=setTimeout(()=>installButton.classList.remove('is-reminded'),4200)}
async function promptInstall(){
  if(standaloneMode()){syncInstallButton();return}
  if(!deferredInstallPrompt){favoriteMessage('Para instalar, abre el menú del navegador y elige «Instalar FULLTECH Store».');remindInstall();return}
  const prompt=deferredInstallPrompt;deferredInstallPrompt=null;syncInstallButton();
  try{await prompt.prompt();await prompt.userChoice}catch{/* The browser owns the install dialog; no error is shown in the store. */}
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;syncInstallButton()});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;syncInstallButton();syncAnnouncement()});
installButton?.addEventListener('click',promptInstall);
syncInstallButton();setInterval(()=>{remindInstall();rotateAnnouncement()},10000);
if('serviceWorker' in navigator){navigator.serviceWorker.register('/store/sw.js',{scope:'/store/'}).catch(()=>{})}

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
let previousCartCount=null,cartPulseTimer;
const addFeedback=new WeakMap();
function confirmAdded(button){
  if(!button)return;
  let state=addFeedback.get(button);
  if(!state){state={html:button.innerHTML};addFeedback.set(button,state)}
  clearTimeout(state.timer);
  button.innerHTML=materialIcon('cart',{size:18})+'<span>Agregado</span>';button.setAttribute('title','Agregado al carrito');
  button.classList.add('is-added');
  const status=document.getElementById('cart-feedback-status');
  if(status)status.textContent=`Producto agregado. ${cartCount()} artículos en el carrito.`;
  state.timer=setTimeout(()=>{if(button.isConnected){button.innerHTML=state.html;button.classList.remove('is-added')}addFeedback.delete(button)},1200);
}
function updateCartBadge() {
  const n = cartCount();
  document.querySelectorAll('[data-cart-badge]').forEach(badge => { badge.textContent = n ? String(n) : ''; badge.hidden = !n; });
  const shortcut = document.querySelector('.cart-shortcut');
  if (shortcut) {
    shortcut.hidden = n === 0;
    shortcut.setAttribute('aria-label', n ? `Carrito (${n})` : 'Carrito');
    shortcut.classList.toggle('has-items',n>0);
    if(previousCartCount!==null&&n!==previousCartCount&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      shortcut.classList.remove('cart-feedback');void shortcut.offsetWidth;shortcut.classList.add('cart-feedback');
      clearTimeout(cartPulseTimer);cartPulseTimer=setTimeout(()=>shortcut.classList.remove('cart-feedback'),420);
    }
  }
  document.querySelector('.ft-nav__item[data-route=cart]')?.classList.toggle('has-items',n>0);
  previousCartCount=n;
}
let homeData = null, catalogState = {kind:'all',category:'',q:'',page:1,pages:1}, searchTimer;
const session = { loaded:false, account:null, providers:{password:true,google:false,apple:false}, providersReady:false };
let announcementIndex=0;
const announcementNode=()=>$('#hero-promo');
function announcementItems(){
  const items=[{key:'request',label:'Lo conseguimos por ti',cta:'Solicitar',href:href('request')}];
  if(!session.account)items.push({key:'register',label:'Regístrate ahora',cta:'Crear cuenta',href:href('account/register')});
  if(!standaloneMode())items.push({key:'install',label:'Instala nuestra app',cta:'Instalar',href:'#'});
  return items;
}
function syncAnnouncement(){
  const node=announcementNode();
  if(!node)return;
  const key=location.hash||'';
  const hidden=/^#\/?(?:account|checkout|request|favorites)/.test(key);
  if(hidden){node.hidden=true;return}
  const items=announcementItems();
  if(!items.length){node.hidden=true;return}
  announcementIndex%=items.length;const item=items[announcementIndex];
  const icon=item.key==='request'?materialIcon('search',{size:16}):item.key==='register'?materialIcon('account',{size:16}):'<span class="ft-announcement-install-icon" aria-hidden="true"></span>';
  node.dataset.announcement=item.key;node.href=item.href;node.setAttribute('aria-label',`${item.label}. ${item.cta}`);
  node.innerHTML=`<span class="ft-announcement__copy">${icon}<span>${item.label}</span></span><strong>${item.cta}</strong>`;
  node.hidden=false;node.classList.remove('is-switching');void node.offsetWidth;node.classList.add('is-switching');
  node.onclick=event=>{if(node.dataset.announcement==='install'){event.preventDefault();promptInstall()}};
}
function rotateAnnouncement(){
  const node=announcementNode();
  if(!node||node.hidden)return;
  const items=announcementItems();if(!items.length)return;announcementIndex=(announcementIndex+1)%items.length;syncAnnouncement();
}
let favoriteIds=new Set(),favoriteOwner=null,favoriteToastTimer;
const favoriteBusy=new Set();
function favoriteButton(p){const active=favoriteOwner===session.account?.id&&favoriteIds.has(p.id);return `<button class="ft-favorite${active?' is-favorite':''}" type="button" data-favorite="${esc(p.id)}" data-favorite-name="${esc(p.name)}" aria-pressed="${active}" aria-label="${active?'Quitar de':'Guardar en'} favoritos: ${esc(p.name)}"><span class="ft-favorite__icon" aria-hidden="true"></span></button>`}
function syncFavoriteButtons(){document.querySelectorAll('[data-favorite]').forEach(button=>{
  const active=favoriteOwner===session.account?.id&&favoriteIds.has(button.dataset.favorite);
  button.classList.toggle('is-favorite',active);button.setAttribute('aria-pressed',String(active));
  button.setAttribute('aria-label',`${active?'Quitar de':'Guardar en'} favoritos: ${button.dataset.favoriteName}`);
  button.disabled=favoriteBusy.has(button.dataset.favorite);
})}
function favoriteMessage(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');clearTimeout(favoriteToastTimer);favoriteToastTimer=setTimeout(()=>toast.classList.remove('show'),3500)}
async function refreshFavoriteState(){
  const owner=session.account?.id;
  if(!owner){favoriteOwner=null;favoriteIds.clear();syncFavoriteButtons();return}
  try{const data=await api('/api/store/account/favorites?ids=1');if(session.account?.id!==owner)return;favoriteOwner=owner;favoriteIds=new Set(data.ids||[]);syncFavoriteButtons()}catch{/* Saving retries against the authenticated API; never claim a failed save succeeded. */}
}
async function renderFavorites(){
  setNav('favorites');main.innerHTML='<p class="ft-section">Cargando favoritos…</p>';
  await ensureSession(true);
  if(location.hash.split('?')[0]!=='#/favorites')return;
  if(!session.account){
    main.innerHTML=`${authHead('Mis favoritos')}<section class="account-card"><h2>Guarda lo que te gusta</h2><p>Crea tu cuenta o inicia sesión para guardar productos y encontrarlos cuando quieras comprar.</p><div class="account-actions"><a class="button" data-favorite-auth href="${href('account/register')}">Crear cuenta</a><a class="button button-outline" data-favorite-auth href="${href('account/login')}">Iniciar sesión</a></div></section>${footer()}`;
    bindAuthBack();document.querySelectorAll('[data-favorite-auth]').forEach(a=>a.onclick=()=>{try{sessionStorage.setItem('fulltech_auth_return','/favorites')}catch{}});return;
  }
  const owner=session.account.id;
  try{
    let pending='';try{pending=sessionStorage.getItem('fulltech_pending_favorite')||''}catch{}
    if(pending){
      try{await apiPost(`/api/store/account/favorites/${encodeURIComponent(pending)}`,{},'POST');sessionStorage.removeItem('fulltech_pending_favorite')}
      catch(error){if(error.status===404)try{sessionStorage.removeItem('fulltech_pending_favorite')}catch{};throw error}
    }
    const data=await api('/api/store/account/favorites');
    if(location.hash.split('?')[0]!=='#/favorites'||session.account?.id!==owner)return;
    favoriteOwner=owner;favoriteIds=new Set(data.ids||[]);
    main.innerHTML=`${authHead('Mis favoritos')}<p class="ft-favorites-intro">Tus productos guardados, listos para cuando quieras comprar.</p>${data.products?.length?`<div class="ft-grid ft-favorites-grid">${data.products.map(homeCard).join('')}</div>`:`<section class="empty"><h3>Aún no tienes favoritos disponibles</h3><p>Toca la estrella de un producto para guardarlo aquí.</p><a class="button" href="${href('catalog')}">Explorar catálogo</a></section>`}${(data.ids?.length||0)>(data.products?.length||0)?'<p class="ft-favorites-intro">Algunos productos guardados ya no están publicados.</p>':''}${footer()}`;
    bindAuthBack();
  }catch{if(location.hash.split('?')[0]==='#/favorites'){main.innerHTML=`<section class="state-error"><h1>No pudimos cargar tus favoritos</h1><button class="button" id="retry-favorites">Reintentar</button></section>`;$('#retry-favorites').onclick=renderFavorites}}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-favorite]');if(!button)return;
  event.preventDefault();const id=button.dataset.favorite;if(favoriteBusy.has(id))return;
  favoriteBusy.add(id);syncFavoriteButtons();
  try{
    await ensureSession(true);
    if(!session.account){try{sessionStorage.setItem('fulltech_pending_favorite',id)}catch{};favoriteMessage('Crea tu cuenta o inicia sesión para guardar favoritos.');location.hash='/favorites';return}
    const owner=session.account.id;
    const active=button.getAttribute('aria-pressed')==='true';
    const data=await apiPost(`/api/store/account/favorites/${encodeURIComponent(id)}`,{},active?'DELETE':'POST');
    if(session.account?.id!==owner)return;
    favoriteOwner=owner;favoriteIds=new Set(data.ids||[]);favoriteMessage(active?'Producto quitado de favoritos.':'Producto guardado en favoritos.');
    if(location.hash.split('?')[0]==='#/favorites')await renderFavorites();
  }catch(error){favoriteMessage(error.status===401?'Tu sesión terminó. Inicia sesión para guardar favoritos.':error.message||'No pudimos guardar el favorito. Intenta de nuevo.')}
  finally{favoriteBusy.delete(id);syncFavoriteButtons()}
});
async function apiPost(path, body, method='POST'){const r=await fetch(path,{method,credentials:'same-origin',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok){const error=new Error(d.message||'No pudimos completar la operación.');error.code=d.error||'';error.status=r.status;throw error;}return d}
async function ensureSession(force=false){if(session.loaded&&!force)return session.account;try{const d=await api('/api/store/account/me');session.account=d.account}catch{session.account=null}session.loaded=true;return session.account}
async function ensureProviders(){try{const d=await api('/api/store/account/providers');session.providers={password:true,google:false,apple:false,...(d.providers||{})};session.providersReady=true}catch{session.providersReady=false}return session.providers}
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
  if(session.providers.google===true)return `<a class="button button-outline button-block auth-google" href="/api/store/account/auth/google/start">${inner}</a>`;
  /*
   * Si el servidor no ofrece Google NO se dice «muy pronto» (era mentira y no
   * caducaba nunca): se dice exactamente lo que pasa y se mantiene el acceso por
   * correo, que funciona igual. Nunca se simula un acceso.
   */
  const hint=navigator.onLine===false
    ? 'Sin conexión. Conéctate a internet para entrar con Google.'
    : session.providersReady
      ? 'El acceso con Google no está disponible ahora mismo. Entra con tu correo y contraseña.'
      : 'Comprobando el acceso con Google…';
  return `<button class="button button-outline button-block auth-google" type="button" disabled>${inner}</button><small class="auth-hint">${esc(hint)}</small>`;
}
function authHead(title){return `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>${esc(title)}</h1></div>`}
async function api(path){const r=await fetch(path,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}
const href = route => `/store/#/${route}`;
/*
 * OFERTAS: solo existen si el servidor envía un precio anterior MAYOR y el
 * porcentaje ya calculado. Aquí no se inventa ni se recalcula nada.
 */
const hasOffer = p => Number(p?.discountPercent) > 0 && Number(p?.compareAtPrice) > Number(p?.price);
const offerBadge = (p, extra = '') => hasOffer(p)
  ? `<span class="ft-badge${extra}" aria-label="Oferta ${Number(p.discountPercent)} por ciento">-${Number(p.discountPercent)}%</span>`
  : '';
const priceRow = (p, cls = 'ft-card__price') => hasOffer(p)
  ? `<span class="ft-card__price-row"><span class="${cls}">${money(p)}</span><span class="ft-card__price--old">${money({ ...p, price: p.compareAtPrice })}</span></span>`
  : `<span class="${cls}">${money(p)}</span>`;
function cardSummary(p){
  const text=String(p.shortDescription||p.description||'').replace(/\s+/g,' ').trim();
  const chars=Array.from(text);
  return text?`<p class="ft-card__summary">${esc(chars.slice(0,84).join(''))}${chars.length>84?'…':''}</p>`:'';
}
function productCard(p){
  return `<article class="product-card">
    ${offerBadge(p)}
    ${favoriteButton(p)}
    <a href="${href(`product/${encodeURIComponent(p.id)}`)}" class="product-link" aria-label="Ver ${esc(p.name)}">
      <div class="product-image">${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" width="480" height="480" loading="lazy" decoding="async">`:'<span class="image-fallback" aria-hidden="true">◈</span>'}</div>
      <div class="product-info">
        <span class="ft-card__category">${esc(p.category||'Catálogo')}</span>
        <h3 class="product-name">${esc(p.name)}</h3>
        ${cardSummary(p)}
        <div class="product-bottom">${priceRow(p, 'price')}<span class="card-arrow" aria-hidden="true">›</span></div>
        <span class="availability ${p.availabilityState==='UNAVAILABLE'?'out':''}">${avail(p)}</span>
      </div>
    </a>
    <div class="card-actions">${canBuy(p)?`<button class="button ft-cart-icon" type="button" data-add-cart="${esc(p.id)}" aria-label="Agregar ${esc(p.name)} al carrito">${materialIcon('cart',{size:22})}<span>Agregar</span></button>`:`<a class="button button-outline button-block" href="${requestHref(p)}">Solicitar producto</a>`}</div>
  </article>`
}
function searchMarkup(value=''){return `<label class="ft-search"><input id="store-search" type="search" value="${esc(value)}" placeholder="¿Qué buscas hoy?" aria-label="Buscar productos" autocomplete="off"><span class="ft-search-tile">${materialIcon('search',{size:25})}</span></label>`}
/* Portada: el buscador es una puerta de entrada a la pantalla de búsqueda real. */
function searchEntryMarkup(){return `<a class="ft-search ft-search--entry" href="${href('search')}" aria-label="Buscar productos"><span class="ft-search-tile">${materialIcon('search',{size:29})}</span><span class="ft-search__placeholder">¿Qué buscas hoy?</span></a>`}
function footer(){return `<footer class="footer">FULLTECH Store · República Dominicana</footer>`}
/*
 * Buscador: en el catálogo filtra EN EL SITIO (sin re-renderizar la pantalla, así
 * no se pierde el foco ni el scroll) y refleja el estado en el hash. En el resto
 * de pantallas lleva al catálogo conservando categoría, ofertas y orden.
 */
function bindSearch(inputId='store-search'){
  const input=$(`#${inputId}`);
  if(!input)return;
  input.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{
      const q=input.value.trim();
      if($('#catalog-result')){catalogState.q=q;catalogState.page=1;syncCatalogHash();paintCatalogApplied();loadCatalog();return}
      const p=new URLSearchParams();
      if(q)p.set('q',q);
      if(catalogState.category)p.set('category',catalogState.category);
      if(catalogState.sort&&catalogState.sort!=='relevance')p.set('sort',catalogState.sort);
      if(catalogState.offers)p.set('offers','1');
      if(catalogState.featured)p.set('featured','true');
      const qs=p.toString();
      location.hash=`/catalog${qs?`?${qs}`:''}`;
    },240);
  });
}
function setNav(route){
  /* La barra inferior es fija: se ve en todas las pantallas y marca la activa.
     El ítem activo usa la variante FILLED; el resto, OUTLINE. */
  document.querySelectorAll('.ft-nav__item').forEach(node=>{
    const match=node.dataset.route===route;
    node.classList.toggle('active',match);
    if(match)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');
    paintMaterialIcon(node.querySelector('[data-msr]'),node.dataset.route==='request'?'search':node.dataset.route,{variant:match?'filled':'outline'});
  });
}
/* Portada comercial: buscador, héroe, confianza, categorías con imagen,
   destacados, ofertas reales, novedades, descubrir más y entrada a «Nosotros».
   Nada inventado: todo sale de /api/store/home y de las mismas reglas de
   publicación del catálogo. */
async function renderHome(){
  setNav('home');
  main.innerHTML=`${searchEntryMarkup()}<div class="loading-cards"><div class="skeleton"></div><div class="skeleton"></div></div>`;
  try{
    homeData=await api('/api/store/home');
    const products=homeData.products||[];
    const sections=homeData.sections||{};
    const tiles=(homeData.categoryCards||[]).filter(t=>t&&t.name);
    const total=Number(homeData.total||products.length);
    const seen=new Set();
    const unique=items=>items.filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true});
    const offers=unique((sections.offers||[]).filter(hasOffer));
    const featured=unique(sections.featured?.length?sections.featured:products.filter(p=>p.featured));
    const nuevos=unique(sections.newArrivals||[]);
    const descubrir=unique(sections.discover||[]);
    const algunaCosa=featured.length||offers.length||nuevos.length||descubrir.length;
    const dailyOffers=(homeData.dailyOffers||[]).filter(hasOffer).slice(0,2);
    const heroOfferCard=p=>`<a class="ft-hero-offer" href="${href(`product/${encodeURIComponent(p.id)}`)}" aria-label="Ver oferta de ${esc(p.name)}">
      <img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" width="180" height="104" loading="eager" decoding="async">
      <span class="ft-hero-offer__shade"><span class="ft-hero-offer__discount">-${Number(p.discountPercent)}%</span><strong>${esc(p.name)}</strong><span class="ft-hero-offer__prices">${money(p)} <del>${money({price:p.compareAtPrice,currency:p.currency})}</del></span></span>
    </a>`;
    const heroPlaceholder=(label='Ofertas diarias')=>`<span class="ft-hero-offer-placeholder">${label}<br><small>Vuelve pronto para descubrirlas</small></span>`;
    const heroOffers=dailyOffers.length===2
      ? dailyOffers.map(heroOfferCard).join('')
      : dailyOffers.length===1
        ? heroOfferCard(dailyOffers[0])+heroPlaceholder('Otra oferta pronto')
        : heroPlaceholder()+heroPlaceholder('Próxima oferta');

    const hero=`<section class="ft-hero">
      <div class="ft-hero__copy">
        <span class="ft-hero__eyebrow">${materialIcon('security',{size:14})} ENCUENTRA TU PRÓXIMO FAVORITO</span>
        <h1>Todo lo que necesitas,<br>en un solo lugar</h1>
        <p>Tecnología, hogar y seguridad para tu día a día.</p>
        <a id="hero-promo" class="ft-hero-promo" href="${href('request')}" aria-live="polite" hidden></a>
      </div>
      <div class="ft-hero__art ft-hero__duo" aria-label="Ofertas diarias">
        ${heroOffers}
      </div>
    </section>`;

    /* Solo promesas verificadas: exactamente lo que el checkout dice al cliente. */
    const benefits=`<section class="ft-benefits" aria-label="Ventajas de comprar en FULLTECH Store">
      <article class="ft-benefit"><span class="ft-benefit__icon">${materialIcon('truck',{size:16})}</span><strong>Entrega coordinada</strong></article>
      <article class="ft-benefit"><span class="ft-benefit__icon">${materialIcon('security',{size:16})}</span><strong>Compra segura</strong></article>
      <article class="ft-benefit"><span class="ft-benefit__icon">${materialIcon('package',{size:16})}</span><strong>Garantía según ficha</strong></article>
    </section>`;

    const catStrip=tiles.length?`<section class="ft-cats" aria-label="Explorar por categoría">
      <div class="ft-section__head" style="margin-inline:var(--ft-pad)"><h2>Explora por categoría</h2><a href="${href('catalog')}">Ver catálogo ${materialIcon('chevron-right',{size:16})}</a></div>
      <div class="ft-catstrip">${tiles.map(tile=>`<a class="ft-cattile" href="${href(`catalog?category=${encodeURIComponent(tile.name)}`)}">
        ${tile.imageUrl?`<img src="${esc(tile.imageUrl)}" alt="" width="320" height="240" loading="lazy" decoding="async">`:`<span class="ft-cattile__fallback">${materialIcon('categories',{size:22})}</span>`}
        <span class="ft-cattile__body"><span class="ft-cattile__name">${esc(tile.name)}</span><span class="ft-cattile__count">${tile.count} producto${Number(tile.count)===1?'':'s'}</span></span>
      </a>`).join('')}<a class="ft-cattile ft-cattile--all" href="${href('catalog')}">
        <span class="ft-cattile__body"><span class="ft-cattile__name">Todo el catálogo</span><span class="ft-cattile__count">${total} productos</span></span>
      </a></div>
    </section>`:'';

    const block=(titulo,items,opciones={})=>items.length?`<section class="ft-section${opciones.cls?' '+opciones.cls:''}">
      <div class="ft-section__head"><h2>${titulo}</h2>${opciones.link?`<a href="${opciones.link}">${opciones.linkLabel||'Ver todo'} ${materialIcon('chevron-right',{size:16})}</a>`:''}</div>
      <div class="ft-grid">${items.map(homeCard).join('')}</div>
    </section>`:'';

    const aboutEntry=`<a class="ft-about-entry" href="${href('nosotros')}">
      <span class="ft-about-entry__icon">${materialIcon('support',{size:18})}</span>
      <span class="ft-about-entry__copy"><strong>Conoce FULLTECH</strong><small>Quiénes somos y cómo te acompañamos antes y después de comprar.</small></span>
      <span class="ft-about-entry__arrow" aria-hidden="true">${materialIcon('chevron-right',{size:18})}</span>
    </a>`;

    const vacio=`<div class="empty"><h3>Aún no hay productos publicados</h3><p>Estamos preparando el catálogo. Vuelve pronto.</p></div>`;

    main.innerHTML=`<section class="ft-discovery" aria-label="Descubre FULLTECH"><div class="ft-home-search-slot"><div class="ft-home-search">${searchEntryMarkup()}</div></div>${hero}${benefits}${catStrip}</section>${algunaCosa?`
      ${block('Destacados',featured,{link:href('catalog?featured=true'),linkLabel:'Ver más'})}
      ${block('Ofertas',offers,{link:href('catalog?offers=1'),linkLabel:'Ver ofertas',cls:'ft-section--offers'})}
      ${block('Novedades',nuevos,{link:href('catalog?sort=recent'),linkLabel:'Ver todo'})}
      ${block('Descubrir más',descubrir,{link:href('catalog'),linkLabel:'Ver catálogo'})}
      <p class="ft-section__note" style="margin-inline:var(--ft-pad)">${total} producto${total===1?'':'s'} publicado${total===1?'':'s'} · precios en RD$</p>
    `:`<div class="ft-section">${vacio}</div>`}${aboutEntry}${footer()}`;
    syncHomeSearch();
  }catch{
    main.innerHTML=`<div class="state-error"><h1>No pudimos cargar la tienda</h1><p>Revisa tu conexión e inténtalo de nuevo.</p><button class="button" id="retry-home">Intentar de nuevo</button></div>${footer()}`;
    $('#retry-home').onclick=renderHome;
  }
}

/** Tarjeta de producto de la portada: imagen, nombre, precio y estado reales. */
function homeCard(p){
  const state=p.availabilityState;
  const stateClass=state==='UNAVAILABLE'?'ft-card__state ft-card__state--out':state==='ON_REQUEST'?'ft-card__state ft-card__state--order':'ft-card__state';
  /* Etiqueta corta para la tarjeta: misma verdad que avail(p), sin frases largas. */
  const stateLabel=p.availabilityState==='AVAILABLE_NOW'?'Disponible':p.availabilityState==='ON_REQUEST'?'Bajo pedido':'No disponible';
  const action=canBuy(p)
    ? `<button class="ft-card__cta" type="button" data-add-cart="${esc(p.id)}" aria-label="Agregar ${esc(p.name)} al carrito">${materialIcon('cart',{size:18})}<span>Agregar</span></button>`
    : `<a class="ft-card__cta ft-card__cta--ghost" href="${requestHref(p)}">Solicitar</a>`;
  return `<article class="ft-card" data-product-id="${esc(p.id)}" data-category="${esc(p.category || 'FULLTECH')}">
    ${offerBadge(p)}
    ${favoriteButton(p)}
    <a class="ft-card__media" href="${href('product/'+encodeURIComponent(p.id))}" aria-label="Ver ${esc(p.name)}">
      ${p.imageUrl?`<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" width="480" height="480" loading="lazy" decoding="async">`:`<span class="ft-card__fallback">${materialIcon('categories',{size:28})}<small>${esc(p.category || 'FULLTECH')}</small><small>Imagen no disponible</small></span>`}
    </a>
    <div class="ft-card__body">
      <span class="ft-card__category">${esc(p.category||'Catálogo')}</span>
      <h3 class="ft-card__name"><a href="${href('product/'+encodeURIComponent(p.id))}" style="color:inherit;text-decoration:none">${esc(p.name)}</a></h3>
      ${cardSummary(p)}
      ${priceRow(p)}
      <span class="${stateClass}"><span class="ft-card__dot"></span>${esc(stateLabel)}</span>
      ${action}
    </div>
  </article>`;
}

/*
 * CATÁLOGO: la búsqueda y el filtrado los resuelve SIEMPRE el servidor
 * (/api/store/catalog) con paginación real; la pantalla solo pinta resultados.
 * El estado (búsqueda, categoría, ofertas, orden) vive en el hash para que al
 * volver de una ficha se recupere exactamente lo que el cliente estaba viendo.
 */
let catalogCategoryCards=[];
const SORT_LABELS=[['relevance','Relevancia'],['recent','Más recientes'],['price-asc','Precio: menor a mayor'],['price-desc','Precio: mayor a menor']];
function catalogUrl(){
  const p=new URLSearchParams();
  if(catalogState.q)p.set('q',catalogState.q);
  if(catalogState.page>1)p.set('page',String(catalogState.page));
  if(catalogState.category)p.set('category',catalogState.category);
  if(catalogState.sort&&catalogState.sort!=='relevance')p.set('sort',catalogState.sort);
  if(catalogState.offers)p.set('offers','1');
  if(catalogState.featured)p.set('featured','true');
  const qs=p.toString();
  return `/store/#/catalog${qs?`?${qs}`:''}`;
}
function syncCatalogHash(){try{history.replaceState(null,'',catalogUrl());renderedRoute=location.hash}catch{/* sin historial */}}
function paintCatalogApplied(){
  const title=$('#catalog-title');if(title){title.textContent=catalogState.category || 'Catálogo';title.parentElement.querySelector('.catalog-category-image')?.remove();const category=catalogCategoryCards.find(c=>c.name===catalogState.category);if(category?.imageUrl)title.insertAdjacentHTML('beforebegin',`<img class="catalog-category-image" src="${esc(category.imageUrl)}" width="48" height="48" alt="">`);}
  if(catalogState.category)try{localStorage.setItem('fulltech_last_category',catalogState.category)}catch{}
  const box=$('#catalog-applied');
  if(!box)return;
  const partes=[];
  if(catalogState.q)partes.push(`«${esc(catalogState.q)}»`);
  if(catalogState.category)partes.push(esc(catalogState.category));
  if(catalogState.offers)partes.push('Ofertas');
  if(catalogState.featured)partes.push('Destacados');
  box.innerHTML=partes.length?`<div class="ft-applied"><span>Filtros: ${partes.join(' · ')}</span><button class="ft-applied__clear" type="button" id="clear-filters">Quitar filtros</button></div>`:'';
  const clear=$('#clear-filters');
  if(clear)clear.onclick=()=>{
    catalogState={...catalogState,q:'',category:'',offers:false,featured:false,page:1};
    const input=$('#store-search');if(input)input.value='';
    const select=$('#category-filter');if(select)select.value='';
    $('#catalog-chips')?.querySelectorAll('[data-chip]').forEach(chip=>chip.setAttribute('aria-current',String(chip.dataset.chip==='all')));
    syncCatalogHash();paintCatalogApplied();loadCatalog();
  };
}
async function renderCatalog(params){
  setNav('catalog');
  catalogState={kind:'product',category:params.get('category')||'',q:params.get('q')||'',sort:SORT_LABELS.some(([v])=>v===params.get('sort'))?params.get('sort'):'relevance',offers:params.get('offers')==='1',featured:params.get('featured')==='true',page:1,pages:1};
  main.innerHTML=`${searchMarkup(catalogState.q)}
    <div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1 id="catalog-title">${esc(catalogState.category || 'Catálogo')}</h1></div>
    <div class="ft-toolbar">${materialIcon('filter',{size:20})}
      <select id="category-filter" class="ft-toolbar__select" aria-label="Filtrar por categoría"><option value="">Todas las categorías</option></select>
      <select id="sort-select" class="ft-toolbar__select" aria-label="Ordenar resultados">${SORT_LABELS.map(([value,label])=>`<option value="${value}"${value===catalogState.sort?' selected':''}>${label}</option>`).join('')}</select>
    </div>
    <div class="ft-chips" id="catalog-chips" role="group" aria-label="Filtros rápidos"></div>
    <div id="catalog-applied"></div>
    <div id="catalog-count" class="ft-results-note" aria-live="polite"></div>
    <div id="catalog-result" aria-live="polite"></div>${footer()}`;
  bindSearch();
  $('[data-back]').onclick=()=>history.back();
  $('#sort-select').onchange=e=>{catalogState.sort=e.target.value;catalogState.page=1;syncCatalogHash();loadCatalog()};
  $('#category-filter').onchange=e=>{catalogState.category=e.target.value;catalogState.page=1;syncCatalogHash();paintCatalogApplied();loadCatalog()};
  try{
    const c=await api('/api/store/categories');catalogCategoryCards=c.categoryCards||[];
    $('#category-filter').innerHTML+=(c.categories||[]).map(v=>`<option value="${esc(v)}"${v===catalogState.category?' selected':''}>${esc(v)}</option>`).join('');
    const chips=$('#catalog-chips');
    chips.innerHTML=[
      `<button class="ft-chip" type="button" data-chip="all" aria-current="${!(catalogState.category||catalogState.offers||catalogState.featured)}">Todo</button>`,
      `<button class="ft-chip" type="button" data-chip="offers" aria-current="${catalogState.offers}">Ofertas</button>`,
      `<button class="ft-chip" type="button" data-chip="featured" aria-current="${catalogState.featured}">Destacados</button>`,
      ...(c.categoryCards||[]).map(t=>`<button class="ft-chip" type="button" data-chip="cat" data-category="${esc(t.name)}" aria-current="${catalogState.category===t.name}">${esc(t.name)} <span aria-hidden="true" style="opacity:.6">${t.count}</span></button>`),
    ].join('');
    chips.onclick=e=>{
      const chip=e.target.closest('[data-chip]');
      if(!chip)return;
      const kind=chip.dataset.chip;
      catalogState.category=kind==='cat'?chip.dataset.category:'';
      catalogState.offers=kind==='offers';
      catalogState.featured=kind==='featured';
      catalogState.page=1;
      chips.querySelectorAll('[data-chip]').forEach(node=>node.setAttribute('aria-current',String(node===chip)));
      const select=$('#category-filter');if(select)select.value=catalogState.category;
      syncCatalogHash();paintCatalogApplied();loadCatalog();
    };
  }catch{/* sin categorías: el catálogo sigue funcionando */}
  paintCatalogApplied();
  const targetPage=Math.max(1,Math.min(100,Number.parseInt(params.get('page')||'1',10)||1));
  await loadCatalog();
  while(catalogState.page<Math.min(targetPage,catalogState.pages)&&$('#catalog-result')){catalogState.page++;await loadCatalog(true)}
}
let catalogLoadSequence=0;
async function loadCatalog(append=false){
  const sequence=++catalogLoadSequence;
  const out=$('#catalog-result');
  if(!out)return;
  if(!append)out.innerHTML='<div class="loading-cards"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const q=$('#store-search')?.value.trim()||catalogState.q;
  catalogState.q=q;
  const p=new URLSearchParams({page:String(catalogState.page),limit:'24',kind:'product'});
  if(q)p.set('q',q);
  if(catalogState.category)p.set('category',catalogState.category);
  if(catalogState.sort)p.set('sort',catalogState.sort);
  if(catalogState.offers)p.set('offers','true');
  if(catalogState.featured)p.set('featured','true');
  try{
    const d=await api(`/api/store/catalog?${p}`);
    if(sequence!==catalogLoadSequence||!out.isConnected)return;
    catalogState.pages=d.pagination?.pages||0;
    const items=d.products||[];
    const total=Number(d.pagination?.total??items.length);
    const count=$('#catalog-count');
    if(count)count.textContent=total?`${total} producto${total===1?'':'s'}${q?` para «${q}»`:''}`:'';
    const content=items.length
      ? `<div class="product-grid">${items.map(productCard).join('')}</div>${catalogState.page<catalogState.pages?'<div class="more-wrap"><button class="button button-outline" id="load-more">Ver más</button></div>':''}`
      : `<div class="empty"><h3>${q?`Sin resultados para «${esc(q)}»`:catalogState.category?`No hay productos en «${esc(catalogState.category)}»`:'Aún no hay productos publicados'}</h3><p>${q?'Prueba con otro nombre, otra categoría u otro orden.':catalogState.category?'Esa categoría está vacía ahora mismo.':'El catálogo se actualizará cuando haya contenido disponible.'}</p>${(catalogState.q||catalogState.category||catalogState.offers)?'<button class="button button-outline" type="button" id="empty-clear">Ver todo el catálogo</button>':''}<a class="button button-block" href="${href('request')}" style="margin-top:8px">Pedir que lo consigan</a></div>`;
    out.innerHTML=append?out.innerHTML.replace(/<div class="more-wrap">[\s\S]*?<\/div>$/,'')+content:content;
    $('#load-more')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;catalogState.page++;await loadCatalog(true);syncCatalogHash()});
    $('#empty-clear')?.addEventListener('click',()=>$('#clear-filters')?.click());
  }catch{
    if(sequence!==catalogLoadSequence||!out.isConnected)return;
    out.innerHTML=`<div class="state-error"><h2>No pudimos cargar el catálogo</h2><p>Comprueba la conexión y vuelve a intentarlo.</p><button class="button" id="retry-catalog">Intentar de nuevo</button></div>`;
    $('#retry-catalog').onclick=()=>loadCatalog();
  }
}
function warrantyBlock(w){if(!w||!w.available&&!w.conditions&&!w.coverage&&!w.exclusions&&!w.claim)return '';const details=(w.coverage||w.exclusions||w.conditions||w.claim)?`<details class="warranty"><summary>Consulta las condiciones de garantía</summary>${w.coverage?`<p><strong>Qué cubre:</strong> ${esc(w.coverage)}</p>`:''}${w.exclusions?`<p><strong>Qué no cubre:</strong> ${esc(w.exclusions)}</p>`:''}${w.conditions?`<p>${esc(w.conditions)}</p>`:''}${w.claim?`<p><strong>Cómo reclamar:</strong> ${esc(w.claim)}</p>`:''}</details>`:'';return `<div class="product-warranty"><span class="warranty-label">${esc(w.label)}</span>${w.notes?`<small>${esc(w.notes)}</small>`:''}${details}</div>`}
async function renderProduct(id){
 setNav('product');main.innerHTML='<div class="loading-cards"><div class="skeleton"></div></div>';
 try{const {product:p}=await api(`/api/store/products/${encodeURIComponent(id)}`);
 if(p.category)try{localStorage.setItem('fulltech_last_category',p.category)}catch{}
  main.innerHTML=`<article class="detail detail--product"><div class="detail-visual">${galleryMarkup(p,{controls:true})}</div><div class="detail-copy"><span class="product-category">${esc(p.category||'FULLTECH')}${p.brand?` · ${esc(p.brand)}`:''}</span><h1>${esc(p.name)}</h1><div class="detail-price">${offerBadge(p,' detail-offer')}${priceRow(p,'price')}</div><span class="availability">${avail(p)}</span>
  <div class="detail-actions">${canBuy(p)?`<label class="detail-quantity">Cantidad <input id="product-quantity" type="number" inputmode="numeric" min="1" max="99" value="1" aria-label="Cantidad de producto"></label><button class="button" type="button" id="add-to-cart">${materialIcon('cart',{size:20})}<span>Agregar al carrito</span></button>`:`<a class="button" href="${requestHref(p)}">Solicitar producto</a>`}<span id="share-status" role="status"></span></div>
  <div class="detail-trust" aria-label="Información de compra"><div><span class="detail-trust__icon">${materialIcon('truck',{size:18})}</span><span><strong>Entrega coordinada</strong><small>Confirmamos disponibilidad y entrega contigo.</small></span></div><div><span class="detail-trust__icon">${materialIcon('security',{size:18})}</span><span><strong>Pago seguro</strong><small>Te confirmamos la forma de pago antes de cobrar.</small></span></div></div>
  ${(p.description||p.shortDescription)?`<section class="detail-description"><h2>Descripción</h2><p>${esc(p.description||p.shortDescription)}</p></section>`:''}${warrantyBlock(p.warranty)}<p class="checkout-note">Confirmamos entrega, disponibilidad y forma de pago antes de cobrar.</p></div></article><section class="ft-section" id="related-products"></section>${footer()}`;
 mountGallery(main);const back=$('[data-product-back]');if(back)back.onclick=()=>history.length>1?history.back():location.assign(href('catalog'));const search=$('[data-product-search]');if(search)search.onclick=()=>location.assign(href('search'));$('#add-to-cart')?.addEventListener('click',()=>{const input=$('#product-quantity');if(!input.reportValidity())return;addToCart(p.id,Number(input.value));confirmAdded($('#add-to-cart'))});
 const shareProduct=async()=>{const status=$('#share-status'),url=new URL(href('product/'+encodeURIComponent(p.id)),location.origin).href;try{if(navigator.share){await navigator.share({title:p.name,url});return}if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(url);status.textContent='Enlace copiado';}catch(e){if(e.name!=='AbortError'){status.innerHTML=`<label>Enlace del producto <input readonly value="${esc(url)}" aria-label="Enlace para copiar"></label>`;status.querySelector('input').select();}}};
 $('[data-product-share]')?.addEventListener('click',shareProduct);
 const box=$('#related-products');if(p.category)try{const d=await api(`/api/store/catalog?limit=12&category=${encodeURIComponent(p.category)}`);if(!box.isConnected)return;const related=(d.products||[]).filter(x=>x.id!==p.id).sort((a,b)=>Number(canBuy(b))-Number(canBuy(a)));if(related.length)box.innerHTML=`<div class="ft-section__head"><h2>Más de ${esc(p.category)}</h2><a href="${href('catalog?category='+encodeURIComponent(p.category))}">Ver categoría</a></div><div class="ft-grid">${related.slice(0,6).map(homeCard).join('')}</div>`;}catch{/* optional related products */}
 }catch{main.innerHTML=`<div class="state-error"><h1>Producto no disponible</h1><p>No pudimos cargar su ficha. Revisa la conexión e inténtalo de nuevo.</p><button class="button" id="retry-product">Reintentar</button><a class="button button-outline" href="${href('catalog')}">Volver al catálogo</a></div>`;$('#retry-product').onclick=()=>renderProduct(id)}
}
/* ---------------------------------------------------------------- CARRITO */
async function cartCatalog(rows = readCart()) {
  const d = await api('/api/store/catalog?limit=48');
  const map = new Map((d.products || []).map(p => [p.id, p]));
  /*
   * El catálogo se pide paginado: si el carrito tiene un artículo que no entra
   * en la primera página, se pide SU ficha. Antes, con catálogos grandes, el
   * artículo desaparecía del carrito sin explicación.
   */
  for (const row of rows) {
    if (map.has(row.id)) continue;
    try { const { product } = await api(`/api/store/products/${encodeURIComponent(row.id)}`); if (product) map.set(product.id, product); } catch { /* se muestra lo guardado */ }
  }
  return map;
}

async function renderCart() {
  setNav('cart');
  const rows = readCart();
  if (!rows.length) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Tu carrito</h1></div><div class="empty"><h3>Tu carrito está vacío</h3><p>Agrega productos del catálogo para hacer tu pedido.</p></div><a class="button button-block" href="${href('catalog')}">Ver catálogo</a>${footer()}`;
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
  main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Tu carrito</h1></div>
    ${items.length ? `<ul class="cart-list">${items.map(r => `<li class="cart-item"><div class="cart-item__info"><strong>${esc(r.product.name)}</strong><small>${money(r.product)} c/u · ${esc(avail(r.product))}</small></div><div class="cart-qty"><button type="button" data-cart-minus="${esc(r.id)}" aria-label="Quitar uno">${materialIcon('down',{size:16})}</button><span>${r.quantity}</span><button type="button" data-cart-plus="${esc(r.id)}" aria-label="Agregar uno">${materialIcon('plus',{size:16})}</button></div><div class="cart-item__total">${money({ price: r.product.price * r.quantity, currency: r.product.currency })}</div><button class="cart-remove" type="button" data-cart-remove="${esc(r.id)}" aria-label="Quitar del carrito">${materialIcon('delete',{size:18})}</button></li>`).join('')}</ul><p class="cart-total"><span>Total</span><strong>${money({ price: total, currency: 'DOP' })}</strong></p>` : ''}
    ${problemas.length ? `<section class="cart-problems"><h2>Algo cambió</h2>${problemas.map(r => `<div class="cart-problem"><p><strong>${esc(r.product?.name || 'Un producto')}</strong> no está disponible para compra directa.</p><div class="cart-problem__actions">${r.product ? `<a class="button button-outline" href="${requestHref(r.product)}">Quiero que me lo consigan</a>` : ''}<button class="button button-ghost" type="button" data-cart-remove="${esc(r.id)}">Quitar del carrito</button></div></div>`).join('')}</section>` : ''}
    <div class="cart-actions">${items.length ? `<a class="button button-block" href="${href('checkout')}">Continuar con el pedido</a>` : ''}<a class="button button-outline button-block" href="${href('catalog')}">Seguir comprando</a></div>${footer()}`;
  $('[data-back]').onclick = () => history.back();
}

async function renderCheckout() {
  setNav('checkout');
  let rows = readCart();
  await ensureSession(true);
  if (!session.account) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Finalizar pedido</h1></div><section class="account-card auth-required"><h2>Entra para completar tu pedido</h2><p>Necesitamos identificarte para enviarte el pedido y avisarte del estado.</p><div class="account-actions"><a class="button" href="#/account/login">Entrar</a><a class="button button-outline" href="#/account/register">Crear cuenta</a></div></section>${footer()}`;
    $('[data-back]').onclick = () => history.back();
    return;
  }
  const draftKey = `fulltech_checkout_v1:${session.account.id}`;
  let draft;
  try { draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch { /* invalid local draft */ }
  if (!draft || typeof draft !== 'object') draft = {};
  const saveDraft = () => sessionStorage.setItem(draftKey, JSON.stringify(draft));
  if (!draft.requestKey) draft.requestKey = `store_${crypto.randomUUID().replaceAll('-', '')}`;
  saveDraft();
  if (draft.pending) rows = draft.pending.items;
  if (!rows.length) { location.hash = '#/cart'; return; }
  let byId = new Map();
  try { byId = await cartCatalog(rows); } catch { /* se valida igual en el servidor */ }
  /*
   * TELÉFONO VERIFICADO: el carrito NO se pierde. Se muestra el paso de
   * confirmación y, al volver, el cliente sigue exactamente donde estaba.
   */
  if (session.account.phone_saved === false) {
    main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Agrega tu número</h1></div><section class="account-card"><h2>Un paso más y sigues</h2><p>Necesitamos tu número de teléfono para coordinar la entrega. Tu carrito queda guardado.</p><div class="account-actions"><a class="button" href="/store/verify/?next=%2Fstore%2F%23%2Fcheckout">Agregar número</a><a class="button button-outline" href="#/cart">Volver al carrito</a></div></section>${footer()}`;
    $('[data-back]').onclick = () => history.back();
    return;
  }
  const total = rows.reduce((n, r) => n + (byId.get(r.id)?.price ?? 0) * r.quantity, 0);
  if (!draft.pending && rows.some(r => !canBuy(byId.get(r.id) || {}))) {
    main.innerHTML = `<section class="empty"><h1>Revisa tu carrito</h1><p>No pudimos confirmar todos los productos. Revisa la disponibilidad o vuelve a intentar cuando tengas conexión.</p><a class="button" href="#/cart">Volver al carrito</a></section>`;
    return;
  }
  main.innerHTML = `<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Finalizar pedido</h1></div>
    <p class="page-intro">${esc(session.account.name)} · ${esc(session.account.phone || '')}</p>
    <section class="account-card checkout-summary" aria-label="Resumen del pedido"><h2>Resumen del pedido</h2>
      ${rows.map(r => `<p>${r.quantity} × ${esc(byId.get(r.id)?.name || 'Producto')} <strong>${money({price:(byId.get(r.id)?.price || 0)*r.quantity})}</strong></p>`).join('')}
      <p>Subtotal de productos: <strong>${money({price:total})}</strong></p>
      <p>Entrega: costo por confirmar. El total final se acuerda contigo antes de aceptar el pedido.</p>
      <p>Pago: a coordinar con el equipo. No se cobra en esta pantalla.</p>
    </section>
    <form id="checkout-form" class="request-form">
      <fieldset class="checkout-methods"><legend>¿Cómo lo quieres recibir?</legend>
        <label class="checkout-method"><input type="radio" name="fulfillment" value="delivery" checked> <span><strong>Entrega a domicilio</strong><small>Te confirmamos el costo y el tiempo antes de aceptar el pedido.</small></span></label>
        <label class="checkout-method"><input type="radio" name="fulfillment" value="pickup"> <span><strong>Recogida coordinada</strong><small>Te confirmamos disponibilidad, lugar y hora antes de que pases.</small></span></label>
      </fieldset>
      <div id="checkout-address"><label class="field"><span class="field__label">Dirección de entrega</span><textarea class="field__input" name="address" autocomplete="street-address" rows="2" minlength="8" maxlength="240" placeholder="Calle, número, sector, referencia"></textarea></label></div>
      <label class="field"><span class="field__label">Indicaciones (opcional)</span><input class="field__input" name="notes" maxlength="500" placeholder="Horario, referencia o cualquier detalle"></label>
      <p class="form-error" id="checkout-error" role="alert"></p>
      <button class="button button-block" type="submit">Solicitar confirmación del pedido</button>
    </form>
    <p class="checkout-note">Tu pedido queda <strong>pendiente de confirmación</strong>. No se cobra nada ahora ni se reserva el inventario hasta que el equipo lo confirme.</p>${footer()}`;
  $('[data-back]').onclick = () => history.back();
  const form = $('#checkout-form');
  form.fulfillment.value = draft.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  form.address.value = draft.address || '';
  form.notes.value = draft.notes || '';
  const toggleAddress = () => { $('#checkout-address').hidden = form.fulfillment.value !== 'delivery'; form.address.required = form.fulfillment.value === 'delivery'; };
  form.addEventListener('input', () => {
    draft.fulfillment = form.fulfillment.value; draft.address = form.address.value; draft.notes = form.notes.value; saveDraft();
  });
  if (draft.pending) {
    form.querySelector('[type=submit]').textContent = 'Comprobar pedido enviado';
    form.querySelectorAll('input,textarea').forEach(input => input.disabled = true);
    $('#checkout-error').textContent = 'El envío anterior no se confirmó. Comprueba su resultado antes de crear otro pedido.';
  }
  let submitting = false;
  form.fulfillment.forEach(radio => radio.addEventListener('change', toggleAddress));
  toggleAddress();
  form.onsubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    $('#checkout-error').textContent = '';
    try {
      if (!draft.pending) {
        draft.pending = { items: rows.map(r => ({id:r.id, quantity:r.quantity})),
          fulfillment: form.fulfillment.value, address: form.address.value.trim(),
          notes: form.notes.value.trim(), requestKey: draft.requestKey };
        saveDraft();
      }
      const data = await apiPost('/api/store/orders', draft.pending);
      sessionStorage.removeItem(draftKey);
      if (JSON.stringify(readCart()) === JSON.stringify(draft.pending.items)) writeCart([]);
      main.innerHTML = `<div class="state-success"><h1>Recibimos tu pedido</h1><p>Te confirmaremos los detalles pronto.</p>${data.order?.number ? `<p class="order-number">Pedido <strong>${esc(data.order.number)}</strong></p>` : ''}<p class="muted">Queda pendiente de confirmación.</p><a class="button button-block" href="${href('orders')}">Ver mis pedidos</a><a class="button button-outline button-block" href="/store/">Volver al inicio</a></div>${footer()}`;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        delete draft.pending; saveDraft();
        form.querySelectorAll('input,textarea').forEach(input => input.disabled = false);
      } else {
        form.querySelectorAll('input,textarea').forEach(input => input.disabled = true);
        button.textContent = 'Comprobar pedido enviado';
      }
      $('#checkout-error').textContent = error.message + (draft.pending ? ' Reintenta para comprobar el mismo pedido; no se enviará uno nuevo.' : '');
    } finally {
      submitting = false;
      button.disabled = false;
    }
  };
}

document.addEventListener('click', event => {
  const add = event.target.closest('[data-add-cart]');
  if (add) {
    event.preventDefault();
    addToCart(add.dataset.addCart, 1);
    confirmAdded(add);
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
    main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Lo conseguimos por ti</h1></div><section class="account-card auth-required"><span class="eyebrow">LO CONSEGUIMOS POR TI</span><h2>Cuéntanos qué necesitas</h2><p>Entra o crea tu cuenta para guardar la solicitud y seguir su estado.</p><div class="account-actions"><a class="button" href="#/account/login">Entrar</a><a class="button button-outline" href="#/account/register">Crear cuenta</a></div></section>${footer()}`;
    $('[data-back]').onclick=()=>history.back();
    return;
  }
  let requestKind='product',images=[];
  const requestKey=`req_${(crypto.randomUUID?.()||String(Date.now())).replaceAll('-','')}`;
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Lo conseguimos por ti</h1></div><p class="page-intro">Descríbenos el producto o servicio. Te responderemos con una cotización.</p><form id="request-form" class="request-form"><div class="categories" id="request-kind"><button type="button" class="chip active" data-kind="product">Producto</button><button type="button" class="chip" data-kind="service">Servicio</button></div><label class="field"><span class="field__label">¿Qué necesitas?</span><input class="field__input" name="title" maxlength="120" required placeholder="Ej. Router de doble banda" value="${esc(params.get('title') || '')}"></label><label class="field"><span class="field__label">Detalles (opcional)</span><textarea class="field__input" name="details" maxlength="2000" rows="3" placeholder="Marca, modelo, cantidad o cualquier detalle útil">${esc(params.get('details') || '')}</textarea></label><label class="field"><span class="field__label">Enlace (opcional)</span><input class="field__input" name="referenceUrl" type="url" maxlength="500" inputmode="url" placeholder="https://..."></label><label class="field"><span class="field__label">Fotos (opcional, hasta 3)</span><input class="field__input" id="request-images" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><div class="photo-grid" id="request-previews"></div><p class="form-error" id="request-error" role="alert"></p><button class="button button-block" type="submit">Enviar solicitud</button></form>${footer()}`;
  $('[data-back]').onclick=()=>history.back();
  $('#request-kind').onclick=event=>{const button=event.target.closest('[data-kind]');if(!button)return;requestKind=button.dataset.kind;$('#request-kind').querySelectorAll('[data-kind]').forEach(node=>node.classList.toggle('active',node===button));};
  $('#request-images').onchange=async event=>{renderRequestError('');const files=[...event.target.files].slice(0,3);if(event.target.files.length>3)renderRequestError('Puedes adjuntar hasta 3 fotos.');try{images=await Promise.all(files.map(compressImage));$('#request-previews').innerHTML=images.map(src=>`<img src="${src}" alt="Vista previa de la foto">`).join('');}catch(error){images=[];$('#request-previews').innerHTML='';renderRequestError(error.message);event.target.value='';}};
  $('#request-form').onsubmit=async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;renderRequestError('');
    try{
      const data=await apiPost('/api/store/requests',{kind:requestKind,title:form.title.value.trim(),details:form.details.value.trim(),referenceUrl:form.referenceUrl.value.trim(),images,requestKey});
      const duplicate=Boolean(data.duplicate);
      main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>${duplicate?'Solicitud ya registrada':'Solicitud recibida'}</h1></div><section class="success-card"><span class="success-icon" aria-hidden="true">✓</span><h2>${duplicate?'Ya teníamos tu solicitud':'Gracias, la tenemos'}</h2><p>${duplicate?'No creamos otra igual. Puedes seguir su estado en tu cuenta.':'Te responderemos aquí con el estado y la cotización.'}</p><span class="request-code">${esc(String(data.request.id).slice(-8).toUpperCase())}</span><div class="account-actions"><a class="button" href="#/account/requests">Ver mis solicitudes</a><a class="button button-outline" href="/store/">Seguir explorando</a></div></section>${footer()}`;
      $('[data-back]').onclick=()=>history.back();
    }catch(error){renderRequestError(error.message);button.disabled=false;}
  };
}
/* Tras entrar: si había algo en el carrito, se vuelve al pedido (no se pierde). */
function afterAuth(){
  let returnTo='';try{returnTo=sessionStorage.getItem('fulltech_auth_return')||'';sessionStorage.removeItem('fulltech_auth_return')}catch{}
  location.hash=returnTo==='/favorites'?returnTo:readCart().length?'/checkout':'/account';
}

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
      <p class="auth-sub auth-sub--center">Continúa de forma rápida y segura.</p>
      <div class="auth-stack">
        ${googleOption()}
        <a class="auth-manual-link" href="#/account/register/manual">Crear cuenta manual</a>
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
  const clave=params.get('modo')==='clave';
  if(!token){
    main.innerHTML=`${authHead('Completa tu cuenta')}<section class="auth-panel"><p class="auth-sub">El enlace caducó. Vuelve a intentarlo.</p><a class="button button-block" href="#/account/login">Volver a iniciar sesión</a></section>${footer()}`;
    bindAuthBack();return;
  }
  /*
   * DOS CAMINOS:
   *  · `modo=clave` — ese correo ya tiene una cuenta con contraseña. Se pide la
   *    contraseña para enlazar Google SIN quitarle el acceso a nadie (antes se
   *    enlazaba solo y cualquiera podía quedarse con la cuenta ajena).
   *  · normal — cuenta nueva: solo faltan WhatsApp y ciudad.
   */
  main.innerHTML=clave
    ? `${authHead('Vincula tu cuenta')}<p class="auth-sub">Ese correo ya tiene una cuenta en la tienda. Escribe su contraseña para vincular Google y conservar tus pedidos.</p><section class="auth-panel">
    <form id="complete-form" class="auth-form" novalidate>
      <label class="field"><span class="field__label">Contraseña de tu cuenta</span><input class="field__input" name="password" type="password" autocomplete="current-password" required></label>
      <p class="form-error" id="auth-error" role="alert"></p>
      <button class="button button-block" type="submit">Vincular y entrar</button>
    </form>
    <a class="auth-link" href="#/account/recover">¿Olvidaste tu contraseña?</a></section>${footer()}`
    : `${authHead('Completa tu cuenta')}<p class="auth-sub">Solo faltan tu WhatsApp y tu ciudad.</p><section class="auth-panel">
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
      const body=clave
        ? {token,password:form.password.value}
        : {token,phone:form.phone.value.trim(),city:form.city.value.trim(),orderNumber:(form.orderNumber.value||'').trim()};
      const data=await apiPost('/api/store/account/complete',body);
      session.account=data.account;session.loaded=true;
      afterAuth();
    }catch(error){
      $('#auth-error').textContent=error.message;
      if(error.code==='verification_required'&&!clave){$('#complete-proof').hidden=false;form.orderNumber.focus();}
      button.disabled=false;
    }
  };
}
function bindAuthBack(){const back=$('[data-back]');if(back)back.onclick=()=>history.length>1?history.back():location.assign('/store/')}
async function renderAccount(){
  setNav('account');await Promise.all([ensureSession(true),ensureProviders()]);
  if(!session.account){
    main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Mi cuenta</h1></div>
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
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Mi cuenta</h1></div><section class="account-hero account-hero--signed"><span class="account-avatar" aria-hidden="true">${esc(initials(account.name))}</span><div><span class="eyebrow">TU CUENTA</span><h2>${esc(account.name||'Mi cuenta')}</h2><p>${esc(account.phone||'')}${account.email?' · '+esc(account.email):''}</p></div></section><div class="account-grid"><a class="account-tile" href="#/orders"><strong>${Number(counts.orders_count)||0}</strong><span>Pedidos</span></a><a class="account-tile" href="#/account/requests"><strong>${Number(counts.requests_count)||0}</strong><span>Solicitudes</span></a></div>${account.phone_saved === false ? `<section class="account-card"><h3>Agrega tu número</h3><p class="auth-note">Lo necesitas para tu próximo pedido o solicitud. No enviamos códigos: solo guardamos el número.</p><a class="button button-outline button-block" href="/store/verify/?next=%2Fstore%2F%23%2Faccount">Agregar número</a></section>` : ''}<section class="account-card"><h3>Preferencias</h3><label class="switch-row"><span>Contactarme por WhatsApp</span><input type="checkbox" id="pref-contact" ${account.preferences?.contact!=='phone'?'checked':''}></label><label class="switch-row"><span>Recibir novedades</span><input type="checkbox" id="pref-marketing" ${account.preferences?.marketing?'checked':''}></label><button class="button button-outline button-block" id="save-preferences">Guardar preferencias</button></section><section class="account-card"><h3>Mis datos</h3><form id="profile-form"><label class="field"><span class="field__label">Nombre</span><input class="field__input" name="name" value="${esc(account.name)}" maxlength="120" required></label><label class="field"><span class="field__label">Correo (opcional)</span><input class="field__input" name="email" type="email" value="${esc(account.email||'')}" maxlength="160"></label><p class="form-error" id="profile-error" role="alert"></p><button class="button button-block" type="submit">Guardar datos</button></form></section><button class="button button-ghost button-block" id="logout">Cerrar sesión</button>${footer()}`;
  bindAuthBack();
  $('#save-preferences').onclick=async()=>{const button=$('#save-preferences');button.disabled=true;try{const data=await apiPost('/api/store/account/me',{preferences:{contact:$('#pref-contact').checked?'whatsapp':'phone',marketing:$('#pref-marketing').checked}},'PATCH');session.account=data.account;button.textContent='Preferencias guardadas';}catch(error){button.textContent='No se pudo guardar';}finally{setTimeout(()=>{button.disabled=false;button.textContent='Guardar preferencias'},1400);}};
  $('#profile-form').onsubmit=async event=>{event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;$('#profile-error').textContent='';try{const data=await apiPost('/api/store/account/me',{name:form.name.value.trim(),email:form.email.value.trim()},'PATCH');session.account=data.account;renderAccount();}catch(error){$('#profile-error').textContent=error.message;button.disabled=false;}};
  $('#logout').onclick=async()=>{try{await apiPost('/api/store/account/logout',{})}catch{}session.account=null;session.loaded=true;location.hash='/account';};
}
async function renderOrders(){
  setNav('orders');await ensureSession(true);
  if(!session.account)return renderLogin('Entra para ver tus pedidos.');
  let rows=[];try{rows=(await api('/api/store/account/orders')).orders||[]}catch{}
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Mis pedidos</h1></div>${rows.length?`<div class="order-list">${rows.map(orderCard).join('')}</div>`:'<div class="empty"><h3>Todavía no hay pedidos</h3><p>Cuando compres, tus pedidos aparecerán aquí.</p><a class="button" href="#/catalog">Ver catálogo</a></div>'}${footer()}`;
  bindAuthBack();
}
function orderCard(order){const items=(order.items||[]).map(item=>`${esc(item.name)} × ${item.quantity}`).join(' · ');return `<article class="order-card"><div class="order-head"><strong>${esc(order.order_number)}</strong><span class="status-chip">${esc(orderStatus[order.status]||order.status)}</span></div><p class="order-date">${esc(dateText(order.received_at))}</p><p class="order-items">${items||'—'}</p><div class="order-total">${new Intl.NumberFormat('es-DO',{style:'currency',currency:order.currency||'DOP'}).format(Number(order.total||0))}</div></article>`}
async function renderRequests(){
  setNav('account');await ensureSession(true);
  if(!session.account)return renderLogin('Entra para ver tus solicitudes.');
  let rows=[];try{rows=(await api('/api/store/account/requests')).requests||[]}catch{}
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Mis solicitudes</h1></div>${rows.length?`<div class="request-list">${rows.map(requestCard).join('')}</div>`:'<div class="empty"><h3>Aún no has pedido nada especial</h3><p>Cuéntanos qué buscas y te conseguimos una cotización.</p><a class="button" href="#/request">Crear solicitud</a></div>'}${footer()}`;
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
function renderNotice(title){setNav('');main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>${title}</h1></div><div class="empty"><h3>Próximamente</h3><p>Esta función aún no está disponible.</p></div>${footer()}`;$('[data-back]').onclick=()=>history.back()}
/* ------------------------------------------------------------- BÚSQUEDA */
/*
 * Pantalla de búsqueda real: el campo se enfoca al entrar, consulta el catálogo
 * público con retardo (220 ms) y muestra resultados con las mismas tarjetas de
 * la portada. No inventa datos: si no hay coincidencias lo dice y ofrece pedir
 * el producto.
 */
async function renderSearch(params){
  setNav('search');
  const initial=params.get('q')||'';
  const idle=`<div class="ft-section__head"><h2>Buscar en la tienda</h2></div><p class="ft-section__note">Escribe el nombre de un producto, marca o categoría.</p><div class="ft-search__idle"><a class="ft-card__cta ft-card__cta--ghost ft-search__idle-cta" href="${href('catalog')}">Ver todo el catálogo ${materialIcon('arrow-right',{size:16})}</a></div>`;
  main.innerHTML=`<div class="ft-searchbar">${searchMarkup(initial)}</div><div id="search-body" aria-live="polite">${idle}</div>${footer()}`;
  const input=$('#store-search');
  const body=$('#search-body');
  let timer=null,seq=0;
  const run=async()=>{
    const q=input.value.trim();
    const mine=++seq;
    history.replaceState(null,'',href('search')+(q?'?q='+encodeURIComponent(q):''));renderedRoute=location.hash;
    if(!q){body.innerHTML=idle;return}
    body.innerHTML=`<p class="ft-section__note">Buscando “${esc(q)}”…</p>`;
    try{
      const d=await api(`/api/store/catalog?limit=12&kind=product&q=${encodeURIComponent(q)}`);
      if(mine!==seq||!body.isConnected)return;
      const items=d.products||[];
      body.innerHTML=items.length
        ?`<div class="ft-section__head"><h2>${d.pagination?.total??items.length} resultado${(d.pagination?.total??items.length)===1?'':'s'}</h2><a class="ft-section__link" href="${href('catalog')}?q=${encodeURIComponent(q)}">Ver en el catálogo ${materialIcon('chevron-right',{size:16})}</a></div><div class="ft-grid">${items.map(homeCard).join('')}</div>`
        :`<div class="empty"><h3>Sin resultados para “${esc(q)}”</h3><p>Prueba con otro nombre o pide que te lo consigamos.</p><a class="button button-outline" href="${href('request')}">Solicitar producto</a></div>`;
    }catch{
      if(mine!==seq||!body.isConnected)return;
      body.innerHTML='<div class="state-error"><h2>No pudimos buscar</h2><p>Comprueba la conexión y vuelve a intentarlo.</p><button class="button" type="button" id="retry-search">Intentar de nuevo</button></div>';
      $('#retry-search')?.addEventListener('click',run);
    }
  };
  input.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(run,220)});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(timer);run()}});
  /* Foco inmediato: la acción «Buscar» de la barra inferior debe dejar el cursor listo. */
  input.focus({preventScroll:true});
  if(initial)await run();
}
/* ----------------------------------------------------------------- NOSOTROS */
/*
 * Página «Nosotros». Solo afirmaciones verificables del propio negocio: lo que el
 * checkout promete (confirmación antes de cobrar, entrega coordinada), la
 * garantía de la ficha de cada producto y el WhatsApp oficial. No se inventan
 * años, premios, cifras de clientes ni coberturas.
 */
const STORE_WHATSAPP = '18494240621';
const STORE_WHATSAPP_TEXT = encodeURIComponent('Hola, soy cliente de FULLTECH Store y quiero hacer una consulta.');
async function renderAbout(){
const presentation=`<section class="ft-intro" aria-labelledby="ft-intro-title">
      <div class="ft-intro-brand" aria-label="FULLTECH"><span>FULL</span>TECH</div>
      <h2 id="ft-intro-title">Tecnología, herramientas y soluciones profesionales.</h2>
      <picture class="ft-intro-visual">
        <img class="ft-intro-photo" src="/store/assets/presentation/fulltech-scene-800.webp"
          srcset="/store/assets/presentation/fulltech-scene-480.webp 480w, /store/assets/presentation/fulltech-scene-800.webp 800w, /store/assets/presentation/fulltech-scene-1200.webp 1200w, /store/assets/presentation/fulltech-scene-1448.webp 1448w"
          sizes="(min-width: 1000px) 650px, (min-width: 768px) 90vw, calc(100vw - 32px)"
          width="1448" height="1086" alt="Computadora, teléfono, accesorios, cámaras y herramientas junto a un portón automatizado en una instalación moderna."
          fetchpriority="high" loading="eager" decoding="async">
      </picture>
      <p class="ft-intro-description">En FULLTECH ofrecemos productos tecnológicos, herramientas, sistemas de cámaras de seguridad y soluciones de automatización de portones para hogares y negocios.</p>
      <div class="ft-intro-actions"><a class="button ft-intro-explore" href="${href('catalog')}">Explorar productos ${materialIcon('arrow-right',{size:18})}</a><button type="button" class="ft-intro-services-link" data-scroll-services>Conoce nuestras soluciones</button></div>
    </section>`;
  const services=`<section class="ft-intro-services" id="fulltech-services" aria-labelledby="ft-services-title">
      <div class="ft-intro-services-copy"><span class="ft-intro-kicker">PARA HOGARES Y NEGOCIOS</span><h2 id="ft-services-title">Soluciones que te acompañan.</h2>
        <p>Estamos ubicados en Higüey, República Dominicana.</p>
        <ul><li>Tecnología y accesorios.</li><li>Herramientas y equipos.</li><li>Cámaras de seguridad.</li><li>Instalación de motores para portones.</li><li>Asesoría y búsqueda de productos por solicitud.</li></ul>
        <a class="button button-outline ft-intro-install" href="https://wa.me/${STORE_WHATSAPP}?text=${encodeURIComponent('Hola FULLTECH, quiero consultar una instalación y solicitar una cotización.')}" target="_blank" rel="noopener">Consultar instalación ${materialIcon('whatsapp',{size:18})}</a>
      </div>
      <div class="ft-intro-sourcing"><span class="ft-intro-kicker">BÚSQUEDA POR SOLICITUD</span><h2>¿No encuentras lo que buscas?</h2><p>¡En FULLTECH te lo conseguimos!</p><a class="button ft-intro-request" href="${href('request')}">Solicitar un producto ${materialIcon('arrow-right',{size:18})}</a></div>
    </section>`;
  setNav('nosotros');
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Nosotros</h1></div><div class="loading-cards"><div class="skeleton"></div></div>`;
  $('[data-back]').onclick=()=>history.back();
  main.innerHTML=`<div class="page-head"><button class="back-button" data-back aria-label="Volver">${materialIcon('back',{size:18})}</button><h1>Nosotros</h1></div>
    ${presentation}${services}
    <section class="about-section">
      <h2>Quiénes somos</h2>
      <p>FULLTECH Store es la tienda en línea de FULLTECH, SRL, una empresa dominicana. Trabajamos con dos tipos de artículos: los que salen de nuestro propio almacén y los que se consiguen con proveedores. En la ficha de cada producto y en el carrito verás siempre cuál es el caso, sin letra pequeña.</p>
    </section>

    <section class="about-section">
      <h2>Qué puedes comprar</h2>
      <ul class="about-list">
        <li>Tecnología y accesorios para el día a día.</li>
        <li>Hogar, electricidad y protección eléctrica.</li>
        <li>Seguridad, cámaras y redes.</li>
        <li>Productos FULLTECH y complementos disponibles en el catálogo.</li>
      </ul>
      <p style="margin-top:8px">¿No aparece lo que buscas? Usa <strong>«Lo conseguimos por ti»</strong> y lo buscamos con nuestros proveedores.</p>
    </section>

    <section class="about-section">
      <h2>Cómo trabajamos</h2>
      <div class="about-values">
        <div class="about-value"><strong>Precio a la vista</strong><small>Lo que ves es el precio vigente del catálogo.</small></div>
        <div class="about-value"><strong>Confirmación antes de cobrar</strong><small>El pedido queda pendiente hasta que el equipo lo confirme.</small></div>
        <div class="about-value"><strong>Disponibilidad real</strong><small>Si no hay existencias, te lo decimos y ofrecemos conseguirlo.</small></div>
        <div class="about-value"><strong>Soporte directo</strong><small>Atendemos dudas por WhatsApp y desde tu cuenta.</small></div>
      </div>
    </section>

    <section class="about-section">
      <h2>Servicios</h2>
      <ul class="about-list">
        <li><strong>Entrega coordinada:</strong> confirmamos costo y tiempo antes de aceptar el pedido.</li>
        <li><strong>Recogida coordinada:</strong> acordamos lugar y hora contigo.</li>
        <li><strong>Solicitudes especiales:</strong> buscamos artículos fuera del catálogo.</li>
        <li><strong>Aviso de transferencia:</strong> reportas el pago desde tu pedido y el equipo lo verifica.</li>
        <li><strong>Garantía:</strong> cuando el producto la ofrece, verás sus condiciones en la ficha.</li>
      </ul>
    </section>

    <section class="about-section">
      <h2>Entrega y cobertura</h2>
      <p>Coordinamos cada entrega contigo y te confirmamos el costo y el tiempo antes de aceptar el pedido. Preferimos decirte la verdad de cada caso antes que prometer plazos que no podamos cumplir.</p>
    </section>

    <section class="about-section">
      <h2>Contacto</h2>
      <p>Escríbenos por WhatsApp al <strong>+1 849-424-0621</strong>. También puedes revisar el estado de tus pedidos y tus solicitudes desde <strong>Mi cuenta</strong>.</p>
    </section>

    <div class="about-actions">
      <a class="button" href="${href('catalog')}">Explorar productos</a>
      <a class="button button-outline" href="https://wa.me/${STORE_WHATSAPP}?text=${STORE_WHATSAPP_TEXT}" target="_blank" rel="noopener">${materialIcon('whatsapp',{size:18})} Escribir por WhatsApp</a>
    </div>
    <p class="about-note">Las condiciones de garantía, plazos de entrega y formas de pago se confirman en cada pedido antes de cobrar.</p>
    ${footer()}`;
  $('[data-scroll-services]')?.addEventListener('click', () => $('#fulltech-services').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'}));
  $('[data-back]').onclick=()=>history.back();
}

async function renderRoute(){const raw=location.hash.replace(/^#\/?/,'');const [path,query='']=raw.split('?');const params=new URLSearchParams(query);if(!path)return renderHome();if(path==='search')return renderSearch(params);if(path==='catalog')return renderCatalog(params);if(path.startsWith('product/'))return renderProduct(decodeURIComponent(path.slice(8)));if(path==='cart')return renderCart();if(path==='checkout')return renderCheckout();if(path==='request')return renderRequest(params);if(path==='orders')return renderOrders();if(path==='account')return renderAccount();if(path==='account/login')return renderLogin();if(path==='account/register')return renderRegister();if(path==='account/register/manual')return renderRegisterManual(params);if(path==='account/recover')return renderRecover();if(path==='account/complete')return renderComplete(params);if(path==='account/requests')return renderRequests();if(path==='nosotros')return renderAbout();return renderHome()}
const routeScroll=new Map();
let renderedRoute=location.hash, routeRun=0;
if('scrollRestoration' in history)history.scrollRestoration='manual';
window.addEventListener('scroll',()=>{routeScroll.set(renderedRoute,window.scrollY)},{passive:true});
async function route(){
  $('#signup-prompt').hidden=true;
  const run=++routeRun;
  routeScroll.set(renderedRoute,window.scrollY);
  const key=location.hash;
  const saved=routeScroll.get(key)||0;
  await (key.replace(/^#\/?/,'').split('?')[0]==='favorites'?renderFavorites():renderRoute());
  if(run!==routeRun||key!==location.hash)return;
  renderedRoute=key;
  window.scrollTo(0,saved);
  await ensureSession();
  if(run===routeRun&&key===location.hash){
    const prompt=$('#signup-prompt');
    prompt.hidden=!!session.account||/^#\/?(?:account|checkout|request|favorites)/.test(key);
    if(!prompt.hidden){
      await ensureProviders();
      if(run!==routeRun||key!==location.hash)return;
      prompt.innerHTML=GOOGLE_ICON+'<span>Regístrate con Google</span><strong>Continuar</strong>';
      prompt.href=session.providers.google?'/api/store/account/auth/google/start':href('account/register');
    }
    syncAnnouncement();
    await refreshFavoriteState();
  }
}
function openDrawer(open){if(!open&&drawer.contains(document.activeElement))$('#menu-button').focus();drawer.classList.toggle('open',open);drawer.setAttribute('aria-hidden',String(!open));drawer.inert=!open;$('#drawer-scrim').hidden=!open;$('#menu-button').setAttribute('aria-expanded',String(open))}
$('#menu-button').onclick=()=>openDrawer(true);$('#close-drawer').onclick=()=>openDrawer(false);$('#drawer-scrim').onclick=()=>openDrawer(false);drawer.addEventListener('click',e=>{if(e.target.closest('a'))openDrawer(false)});document.querySelector('.cart-shortcut')?.addEventListener('click',()=>{location.hash='#/cart'});
function syncHomeSearch(){
  const slot=document.querySelector('.ft-home-search-slot');
  if(!slot)return;
  const bar=slot.firstElementChild,rect=slot.getBoundingClientRect();
  bar.classList.toggle('is-fixed',rect.top<=0);
  bar.style.setProperty('--search-left',`${rect.left}px`);
  bar.style.setProperty('--search-width',`${rect.width}px`);
}
window.addEventListener('scroll',syncHomeSearch,{passive:true});
window.addEventListener('resize',syncHomeSearch,{passive:true});
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
  // Solo el catálogo se refresca al volver a la pestaña: re-renderizar la portada
  // la dejaba en esqueletos si la API tardaba o fallaba (defecto detectado en UAT).
  if(!hash.includes('/catalog'))return;
  const y=window.scrollY;
  await route();
  window.scrollTo(0,y);
}
setInterval(()=>{if(document.visibilityState!=='visible')return;updateCartBadge();if(location.hash.includes('/cart'))renderCart();refreshVisibleAvailability();},60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;updateCartBadge();if(location.hash.includes('/cart'))renderCart();refreshVisibleAvailability();});window.addEventListener('hashchange',route);route();

